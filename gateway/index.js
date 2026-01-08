// Gateway service: handles auth and proxies traffic to the business API.
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const http = require("http");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimitModule = require("express-rate-limit");
const { z } = require("zod");
const mysql = require("mysql2/promise");
const { createClient: createRedisClient } = require("redis");
const { createProxyMiddleware } = require("http-proxy-middleware");
const pino = require("pino");
const promClient = require("prom-client");

const app = express();
// Runtime configuration (defaults match docker-compose service names/ports).
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET;
const businessApiUrl = process.env.BUSINESS_API_URL || "http://api:4000";
const logLevel = process.env.LOG_LEVEL || "info";
const trustProxy = process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal";

if (!jwtSecret || jwtSecret === "change-me" || jwtSecret === "dev-secret") {
  throw new Error("JWT_SECRET must be set to a non-default value.");
}

app.set("trust proxy", trustProxy);

// MySQL configuration (consumed from .env / docker-compose).
const dbHost = process.env.DB_HOST || "mysql";
const dbPort = Number(process.env.DB_PORT || 3306);
const dbName = process.env.DB_NAME || "efrei";
const dbUser = process.env.DB_USER || "efrei";
const dbPassword = process.env.DB_PASSWORD || "efrei";
const adminBootstrapEmailRaw = process.env.ADMIN_BOOTSTRAP_EMAIL;
const adminBootstrapUserIdRaw = process.env.ADMIN_BOOTSTRAP_USER_ID;
const refreshTokenDaysRaw = Number(process.env.REFRESH_TOKEN_DAYS || 30);
const refreshTokenDays = Number.isFinite(refreshTokenDaysRaw) && refreshTokenDaysRaw > 0
  ? refreshTokenDaysRaw
  : 30;

// Redis configuration for auth caching.
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const authCacheTtlSecondsRaw = Number(process.env.AUTH_CACHE_TTL_SECONDS || 300);
const authCacheTtlSeconds =
  Number.isFinite(authCacheTtlSecondsRaw) && authCacheTtlSecondsRaw > 0
    ? authCacheTtlSecondsRaw
    : 300;

let dbPool = null;
let redisClient = null;
let jwtSecretsCache = { secrets: null, primary: null, fetchedAt: 0 };

const logger = pino({
  level: logLevel,
  base: { service: "gateway" },
  timestamp: pino.stdTimeFunctions.isoTime
});

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: "gateway_" });

const httpRequestDuration = new promClient.Histogram({
  name: "gateway_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry]
});

const httpRequestsTotal = new promClient.Counter({
  name: "gateway_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry]
});

const authRequestsTotal = new promClient.Counter({
  name: "gateway_auth_requests_total",
  help: "Total auth requests",
  labelNames: ["action", "status"],
  registers: [metricsRegistry]
});

const rateLimit = typeof rateLimitModule === "function" ? rateLimitModule : rateLimitModule.rateLimit;

const createBackoffLimiter = ({
  name,
  windowMs,
  limit,
  baseDelayMs = 1000,
  maxDelayMs = 5 * 60 * 1000,
  getKey = null
}) => {
  const penalties = new Map();
  const limiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      const keySeed = getKey ? getKey(req) : req.ip;
      const key = `${keySeed}:${name}`;
      const now = Date.now();
      const entry = penalties.get(key);
      let strikes = entry?.strikes ?? 0;
      if (entry && now - entry.lastSeen > windowMs) {
        strikes = 0;
      }
      strikes += 1;
      const delay = Math.min(baseDelayMs * 2 ** (strikes - 1), maxDelayMs);
      penalties.set(key, { strikes, blockedUntil: now + delay, lastSeen: now });
      res.set("Retry-After", Math.ceil(delay / 1000));
      return res.status(429).json({ ok: false, message: "Too many requests.", retryAfterMs: delay });
    }
  });

  return (req, res, next) => {
    const keySeed = getKey ? getKey(req) : req.ip;
    const key = `${keySeed}:${name}`;
    const now = Date.now();
    const entry = penalties.get(key);
    if (entry) {
      if (now - entry.lastSeen > windowMs) {
        penalties.delete(key);
      } else if (entry.blockedUntil > now) {
        const remaining = entry.blockedUntil - now;
        res.set("Retry-After", Math.ceil(remaining / 1000));
        return res.status(429).json({ ok: false, message: "Too many requests.", retryAfterMs: remaining });
      }
    }
    return limiter(req, res, next);
  };
};

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const authLimiter = createBackoffLimiter({
  name: "auth",
  windowMs: 10 * 60 * 1000,
  limit: 10,
  baseDelayMs: 2000,
  maxDelayMs: 5 * 60 * 1000,
  getKey: (req) => {
    const email = normalizeEmail(req.body?.email || "");
    return email ? `${req.ip}:${email}` : req.ip;
  }
});

// Allow browser clients and parse JSON request bodies.
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const incomingId = req.headers["x-request-id"];
  const requestId =
    typeof incomingId === "string" && incomingId.trim()
      ? incomingId.trim()
      : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  req.log = logger.child({ requestId });
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const route = req.route?.path
      ? `${req.baseUrl || ""}${req.route.path}`
      : (req.baseUrl || "unmatched");
    const status = String(res.statusCode || 0);
    const method = req.method;
    httpRequestsTotal.inc({ method, route, status });
    httpRequestDuration.observe({ method, route, status }, durationMs / 1000);
    logger.info({
      requestId,
      method,
      route,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      userId: req.user?.id || null,
      ip: req.ip
    }, "http_request");
  });
  next();
});
app.use(generalLimiter);

// Basic health endpoint used by probes.
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const recordAuthMetric = (action, status) => {
  authRequestsTotal.inc({ action, status });
};

const parsePositiveInt = (value) => {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return null;
  }
  return numberValue;
};

const adminBootstrapEmail = adminBootstrapEmailRaw ? normalizeEmail(adminBootstrapEmailRaw) : null;
const adminBootstrapUserId = adminBootstrapUserIdRaw ? parsePositiveInt(adminBootstrapUserIdRaw) : null;

const isEmailValid = (email) => {
  if (!email) {
    return false;
  }
  const trimmed = String(email).trim();
  return trimmed.includes("@") && trimmed.includes(".") && trimmed.length <= 255;
};

const zEmail = z.string().trim().email().max(255);
const zPassword = z.string().min(6).max(200);
const zName = z.string().trim().min(1).max(160);
const zRefreshToken = z.string().min(10).max(500);

const validateRequest = (schema) => (req, res, next) => {
  const parsed = schema.safeParse({ body: req.body, query: req.query, params: req.params });
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Invalid request.",
      issues: parsed.error.issues
    });
  }
  req.body = parsed.data.body;
  req.query = parsed.data.query;
  req.params = parsed.data.params;
  req.validated = parsed.data;
  return next();
};

const toPublicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  points: user.points,
  isAdmin: Boolean(user.isAdmin),
  isSuperAdmin: Boolean(user.isSuperAdmin),
  roles: Array.isArray(user.roles) ? user.roles : [],
  permissions: Array.isArray(user.permissions) ? user.permissions : []
});

const logAudit = async (connection, {
  actorUserId = null,
  targetUserId = null,
  action,
  reason = null,
  pointsDelta = null,
  pointsBefore = null,
  pointsAfter = null,
  relatedEntityType = null,
  relatedEntityId = null,
  metadata = null
}) => {
  if (!action) {
    return;
  }
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  await connection.query(
    `INSERT INTO audit_logs (
      actor_user_id,
      target_user_id,
      action,
      reason,
      points_delta,
      points_before,
      points_after,
      related_entity_type,
      related_entity_id,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actorUserId,
      targetUserId,
      action,
      reason,
      pointsDelta,
      pointsBefore,
      pointsAfter,
      relatedEntityType,
      relatedEntityId,
      metadataJson
    ]
  );
};

const logPointChange = async (connection, {
  actorUserId = null,
  targetUserId = null,
  action,
  reason = null,
  pointsBefore,
  pointsAfter,
  relatedEntityType = null,
  relatedEntityId = null,
  metadata = null
}) => {
  const delta = Number(pointsAfter) - Number(pointsBefore);
  await logAudit(connection, {
    actorUserId,
    targetUserId,
    action,
    reason,
    pointsDelta: delta,
    pointsBefore,
    pointsAfter,
    relatedEntityType,
    relatedEntityId,
    metadata
  });
};

const ensureRole = async (name, description = null) => {
  await dbPool.query("INSERT IGNORE INTO roles (name, description) VALUES (?, ?)", [name, description]);
  const [rows] = await dbPool.query("SELECT id FROM roles WHERE name = ?", [name]);
  return rows[0]?.id;
};

const ensurePermission = async (name, description = null) => {
  await dbPool.query("INSERT IGNORE INTO permissions (name, description) VALUES (?, ?)", [name, description]);
  const [rows] = await dbPool.query("SELECT id FROM permissions WHERE name = ?", [name]);
  return rows[0]?.id;
};

const ensureRolePermission = async (roleId, permissionId) => {
  if (!roleId || !permissionId) return;
  await dbPool.query(
    "INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
    [roleId, permissionId]
  );
};

const ensureUserRole = async (userId, roleId, assignedBy = null) => {
  if (!userId || !roleId) return;
  await dbPool.query(
    "INSERT IGNORE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)",
    [userId, roleId, assignedBy]
  );
};

const seedRbac = async () => {
  const adminRoleId = await ensureRole("admin", "Standard admin role");
  const superRoleId = await ensureRole("super_admin", "Super admin role");
  const adminAccessId = await ensurePermission("admin.access", "Access to admin endpoints");
  const superAccessId = await ensurePermission("admin.super", "Super admin access");
  await ensureRolePermission(adminRoleId, adminAccessId);
  await ensureRolePermission(superRoleId, adminAccessId);
  await ensureRolePermission(superRoleId, superAccessId);
};

const fetchUserRoles = async (userId) => {
  const [rows] = await dbPool.query(
    `SELECT r.name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ?`,
    [userId]
  );
  return rows.map((row) => row.name);
};

const fetchUserPermissions = async (userId) => {
  const [rows] = await dbPool.query(
    `SELECT DISTINCT p.name
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = ?`,
    [userId]
  );
  return rows.map((row) => row.name);
};

const enrichUser = async (user) => {
  if (!user) return null;
  const roles = await fetchUserRoles(user.id);
  const permissions = await fetchUserPermissions(user.id);
  return {
    ...user,
    roles,
    permissions,
    isAdmin: permissions.includes("admin.access"),
    isSuperAdmin: permissions.includes("admin.super")
  };
};

const getClientIp = (req) => req.ip;

const getDeviceFingerprint = (req) => {
  const userAgent = req.headers["user-agent"] || "";
  const language = req.headers["accept-language"] || "";
  const ip = getClientIp(req) || "";
  const raw = `${userAgent}|${language}|${ip}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
};

const upsertUserDevice = async (connection, userId, req) => {
  const fingerprint = getDeviceFingerprint(req);
  const userAgent = req.headers["user-agent"] || null;
  const ip = getClientIp(req) || null;
  const [existingRows] = await connection.query(
    "SELECT id, revoked_at AS revokedAt FROM user_devices WHERE user_id = ? AND fingerprint = ? LIMIT 1",
    [userId, fingerprint]
  );
  if (existingRows.length && existingRows[0].revokedAt) {
    return {
      fingerprint,
      isNewDevice: false,
      deviceId: Number(existingRows[0].id),
      isRevoked: true
    };
  }
  const [result] = await connection.query(
    `INSERT INTO user_devices (user_id, fingerprint, user_agent, last_ip)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), last_ip = VALUES(last_ip), user_agent = VALUES(user_agent), last_seen = CURRENT_TIMESTAMP`,
    [userId, fingerprint, userAgent, ip]
  );
  const isNewDevice = result.affectedRows === 1;
  const deviceId = Number(result.insertId);
  if (isNewDevice) {
    await logAudit(connection, {
      actorUserId: userId,
      targetUserId: userId,
      action: "auth_new_device",
      reason: "new_device",
      relatedEntityType: "user_device",
      relatedEntityId: deviceId || null,
      metadata: { fingerprint, ip, userAgent }
    });
  }
  return { fingerprint, isNewDevice, deviceId, isRevoked: false };
};

const loadJwtSecrets = async () => {
  const now = Date.now();
  if (jwtSecretsCache.secrets && now - jwtSecretsCache.fetchedAt < 60 * 1000) {
    return jwtSecretsCache;
  }
  const [rows] = await dbPool.query(
    "SELECT secret, is_primary AS isPrimary, expires_at AS expiresAt FROM auth_secrets"
  );
  const valid = rows
    .filter((row) => !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now())
    .map((row) => ({ secret: row.secret, isPrimary: Boolean(row.isPrimary) }));

  const primary = valid.find((row) => row.isPrimary) || null;
  const secrets = valid.map((row) => row.secret);
  if (jwtSecret && !secrets.includes(jwtSecret)) {
    secrets.push(jwtSecret);
  }
  jwtSecretsCache = { secrets, primary: primary?.secret || null, fetchedAt: now };
  return jwtSecretsCache;
};

const getJwtSecrets = async () => {
  try {
    const { secrets, primary } = await loadJwtSecrets();
    if (secrets && secrets.length > 0) {
      return { secrets, primary: primary || secrets[0] };
    }
  } catch (error) {
    logger.error({ err: error }, "JWT secret lookup failed");
  }
  return { secrets: [jwtSecret], primary: jwtSecret };
};

const signJwt = async (payload) => {
  const { primary } = await getJwtSecrets();
  return jwt.sign(payload, primary, { expiresIn: "1h" });
};

const verifyJwt = async (token) => {
  const { secrets } = await getJwtSecrets();
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      // try next secret
    }
  }
  return null;
};

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const generateRefreshToken = () =>
  crypto.randomBytes(32).toString("base64url");

const issueRefreshToken = async (connection, userId, deviceId = null) => {
  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + refreshTokenDays * 24 * 60 * 60 * 1000);
  await connection.query(
    "INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    [userId, deviceId, tokenHash, expiresAt]
  );
  return refreshToken;
};

const rotateRefreshToken = async (connection, tokenHash) => {
  const [rows] = await connection.query(
    "SELECT id, user_id AS userId, device_id AS deviceId, expires_at AS expiresAt, revoked_at AS revokedAt FROM refresh_tokens WHERE token_hash = ? FOR UPDATE",
    [tokenHash]
  );
  if (!rows.length) {
    return null;
  }
  const record = rows[0];
  if (record.revokedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
    return null;
  }
  await connection.query("UPDATE refresh_tokens SET revoked_at = NOW(), last_used_at = NOW() WHERE id = ?", [
    record.id
  ]);
  const newToken = await issueRefreshToken(connection, record.userId, record.deviceId || null);
  return { userId: record.userId, refreshToken: newToken, deviceId: record.deviceId || null };
};

const rotateJwtSecret = async (connection, newSecret, graceHours = 24) => {
  const now = new Date();
  const graceMs = Math.max(0, Number(graceHours) || 0) * 60 * 60 * 1000;
  const expiresAt = graceMs > 0 ? new Date(now.getTime() + graceMs) : now;

  const [currentRows] = await connection.query(
    "SELECT id, secret FROM auth_secrets WHERE is_primary = 1 ORDER BY id DESC LIMIT 1 FOR UPDATE"
  );
  if (currentRows.length) {
    await connection.query(
      "UPDATE auth_secrets SET is_primary = 0, expires_at = COALESCE(expires_at, ?) WHERE id = ?",
      [expiresAt, currentRows[0].id]
    );
  }

  const [result] = await connection.query(
    "INSERT INTO auth_secrets (secret, is_primary, expires_at) VALUES (?, 1, NULL)",
    [newSecret]
  );
  jwtSecretsCache = { secrets: null, primary: null, fetchedAt: 0 };
  return result.insertId;
};

const fetchUserById = async (userId) => {
  const [rows] = await dbPool.query(
    "SELECT id, email, name, points, is_banned AS isBanned FROM users WHERE id = ?",
    [userId]
  );
  if (!rows.length) {
    return null;
  }
  const baseUser = {
    id: rows[0].id,
    email: rows[0].email,
    name: rows[0].name,
    points: rows[0].points,
    isBanned: Boolean(rows[0].isBanned)
  };
  return enrichUser(baseUser);
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, message: "Missing bearer token." });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  try {
    const payload = await verifyJwt(token);
    if (!payload) {
      return res.status(401).json({ ok: false, message: "Invalid or expired token." });
    }
    const userId = parsePositiveInt(payload?.sub);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Invalid token subject." });
    }
    const user = await fetchUserById(userId);
    if (!user) {
      return res.status(401).json({ ok: false, message: "User not found." });
    }
    if (user.isBanned) {
      return res.status(403).json({ ok: false, message: "User is banned." });
    }
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: "Invalid or expired token." });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || !Array.isArray(req.user.permissions) || !req.user.permissions.includes("admin.access")) {
    return res.status(403).json({ ok: false, message: "Admin access required." });
  }
  return next();
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !Array.isArray(req.user.permissions) || !req.user.permissions.includes("admin.super")) {
    return res.status(403).json({ ok: false, message: "Super admin access required." });
  }
  return next();
};

const setCachedUser = async (user) => {
  if (!redisClient) {
    return;
  }
  const cacheKey = `auth:user:${user.email}`;
  await redisClient.set(cacheKey, JSON.stringify(user), { EX: authCacheTtlSeconds });
};

const initDatabase = async () => {
  dbPool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const connection = await dbPool.getConnection();
      await connection.ping();
      connection.release();
      break;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      logger.warn({ attempt, maxAttempts }, "MySQL not ready, retrying");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

};

const initRedis = async () => {
  const client = createRedisClient({ url: `redis://${redisHost}:${redisPort}` });
  client.on("error", (err) => {
    logger.error({ err }, "Redis error");
  });
  await client.connect();
  redisClient = client;
};

// Registration endpoint backed by MySQL and cached in Redis.
app.post(
  "/auth/register",
  authLimiter,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        name: zName,
        email: zEmail,
        password: zPassword
      })
    })
  ),
  async (req, res) => {
    const connection = await dbPool.getConnection();
    try {
      const { name, email, password } = req.body || {};
      const normalizedEmail = normalizeEmail(email);
      const trimmedName = String(name || "").trim();
      if (!trimmedName || !normalizedEmail || !password) {
        recordAuthMetric("register", "error");
        return res.status(400).json({ ok: false, message: "Name, email, and password are required." });
      }
      if (!isEmailValid(normalizedEmail)) {
        recordAuthMetric("register", "error");
        return res.status(400).json({ ok: false, message: "Invalid email format." });
      }
      if (String(password).length < 6) {
        recordAuthMetric("register", "error");
        return res.status(400).json({ ok: false, message: "Password must be at least 6 characters." });
      }

      await connection.beginTransaction();
      const [existing] = await connection.query("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
      if (existing.length > 0) {
        await connection.rollback();
        recordAuthMetric("register", "error");
        return res.status(409).json({ ok: false, message: "Email already registered." });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const startingPoints = 1000;
      const [result] = await connection.query(
        "INSERT INTO users (email, name, password_hash, points) VALUES (?, ?, ?, ?)",
        [normalizedEmail, trimmedName, passwordHash, startingPoints]
      );

      const isSuperAdmin =
        (adminBootstrapUserId && result.insertId === adminBootstrapUserId) ||
        (adminBootstrapEmail && normalizedEmail === adminBootstrapEmail);
      if (isSuperAdmin) {
        await connection.query(
          "UPDATE users SET is_admin = 1, is_super_admin = 1 WHERE id = ?",
          [result.insertId]
        );
        try {
          await seedRbac();
          const adminRoleId = await ensureRole("admin", "Standard admin role");
          const superRoleId = await ensureRole("super_admin", "Super admin role");
          if (adminRoleId) {
            await ensureUserRole(result.insertId, adminRoleId, result.insertId);
          }
          if (superRoleId) {
            await ensureUserRole(result.insertId, superRoleId, result.insertId);
          }
        } catch (rbacError) {
          logger.warn({ err: rbacError }, "RBAC assignment skipped");
        }
      }

      const baseUser = {
        id: result.insertId,
        email: normalizedEmail,
        name: trimmedName,
        passwordHash,
        points: startingPoints,
        isBanned: false
      };
      const user = await enrichUser(baseUser);

      const deviceInfo = await upsertUserDevice(connection, user.id, req);
      if (deviceInfo.isRevoked) {
        await connection.rollback();
        recordAuthMetric("register", "error");
        logger.warn({ userId: user.id, deviceId: deviceInfo.deviceId }, "register_blocked_device_revoked");
        return res.status(403).json({ ok: false, message: "Device access revoked." });
      }
      const token = await signJwt({ sub: String(user.id), email: user.email });
      const refreshToken = await issueRefreshToken(connection, user.id, deviceInfo.deviceId || null);
      await logAudit(connection, {
        actorUserId: user.id,
        targetUserId: user.id,
        action: "auth_register",
        reason: "auth_register"
      });
      await logPointChange(connection, {
        actorUserId: user.id,
        targetUserId: user.id,
        action: "register_points",
        reason: "initial_points",
        pointsBefore: 0,
        pointsAfter: startingPoints
      });

      await connection.commit();
      await setCachedUser(user);

      recordAuthMetric("register", "success");
      logger.info({
        userId: user.id,
        email: user.email,
        newDevice: deviceInfo.isNewDevice,
        deviceId: deviceInfo.deviceId || null
      }, "auth_register");
      return res.status(201).json({
        ok: true,
        user: toPublicUser(user),
        token,
        refreshToken,
        newDevice: deviceInfo.isNewDevice
      });
    } catch (error) {
      await connection.rollback();
      if (error && error.code === "ER_DUP_ENTRY") {
        recordAuthMetric("register", "error");
        return res.status(409).json({ ok: false, message: "Email already registered." });
      }
      recordAuthMetric("register", "error");
      logger.error({ err: error }, "Register error");
      return res.status(500).json({ ok: false, message: "Registration failed." });
    } finally {
      connection.release();
    }
  }
);

// Login endpoint backed by MySQL with Redis caching.
app.post(
  "/auth/login",
  authLimiter,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        email: zEmail,
        password: zPassword
      })
    })
  ),
  async (req, res) => {
    const connection = await dbPool.getConnection();
    try {
      const { email, password } = req.body || {};
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail || !password) {
        recordAuthMetric("login", "error");
        return res.status(400).json({ ok: false, message: "Email and password are required." });
      }

      const [rows] = await connection.query(
        "SELECT id, email, name, password_hash AS passwordHash, points, is_banned AS isBanned FROM users WHERE email = ?",
        [normalizedEmail]
      );
      if (!rows.length) {
        recordAuthMetric("login", "error");
        return res.status(401).json({ ok: false, message: "Invalid credentials." });
      }
      const baseUser = {
        id: rows[0].id,
        email: rows[0].email,
        name: rows[0].name,
        passwordHash: rows[0].passwordHash,
        points: rows[0].points,
        isBanned: Boolean(rows[0].isBanned)
      };
      const user = await enrichUser(baseUser);

      if (user.isBanned) {
        recordAuthMetric("login", "error");
        return res.status(403).json({ ok: false, message: "User is banned." });
      }

      const matches = await bcrypt.compare(password, user.passwordHash);
      if (!matches) {
        recordAuthMetric("login", "error");
        return res.status(401).json({ ok: false, message: "Invalid credentials." });
      }

      await connection.beginTransaction();
      const deviceInfo = await upsertUserDevice(connection, user.id, req);
      if (deviceInfo.isRevoked) {
        await connection.rollback();
        recordAuthMetric("login", "error");
        logger.warn({ userId: user.id, deviceId: deviceInfo.deviceId }, "login_blocked_device_revoked");
        return res.status(403).json({ ok: false, message: "Device access revoked." });
      }
      const token = await signJwt({ sub: String(user.id), email: user.email });
      const refreshToken = await issueRefreshToken(connection, user.id, deviceInfo.deviceId || null);
      await logAudit(connection, {
        actorUserId: user.id,
        targetUserId: user.id,
        action: "auth_login",
        reason: "auth_login"
      });
      await connection.commit();

      await setCachedUser(user);

      recordAuthMetric("login", "success");
      logger.info({
        userId: user.id,
        email: user.email,
        newDevice: deviceInfo.isNewDevice,
        deviceId: deviceInfo.deviceId || null
      }, "auth_login");
      return res.json({ ok: true, user: toPublicUser(user), token, refreshToken, newDevice: deviceInfo.isNewDevice });
    } catch (error) {
      await connection.rollback();
      recordAuthMetric("login", "error");
      logger.error({ err: error }, "Login error");
      return res.status(500).json({ ok: false, message: "Login failed." });
    } finally {
      connection.release();
    }
  }
);

app.post(
  "/auth/refresh",
  authLimiter,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({ refreshToken: zRefreshToken })
    })
  ),
  async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      recordAuthMetric("refresh", "error");
      return res.status(400).json({ ok: false, message: "refreshToken is required." });
    }
    const tokenHash = hashToken(refreshToken);
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const rotated = await rotateRefreshToken(connection, tokenHash);
      if (!rotated) {
        await connection.rollback();
        recordAuthMetric("refresh", "error");
        return res.status(401).json({ ok: false, message: "Invalid refresh token." });
      }
      const [userRows] = await connection.query(
        "SELECT id, email, name, points, is_banned AS isBanned FROM users WHERE id = ?",
        [rotated.userId]
      );
      if (!userRows.length) {
        await connection.rollback();
        recordAuthMetric("refresh", "error");
        return res.status(401).json({ ok: false, message: "User not found." });
      }
      const baseUser = {
        id: userRows[0].id,
        email: userRows[0].email,
        name: userRows[0].name,
        points: userRows[0].points,
        isBanned: Boolean(userRows[0].isBanned)
      };
      const user = await enrichUser(baseUser);
      if (user.isBanned) {
        await connection.rollback();
        recordAuthMetric("refresh", "error");
        return res.status(403).json({ ok: false, message: "User is banned." });
      }
      const token = await signJwt({ sub: String(user.id), email: user.email });
      await logAudit(connection, {
        actorUserId: user.id,
        targetUserId: user.id,
        action: "auth_refresh",
        reason: "auth_refresh"
      });
      await connection.commit();
      recordAuthMetric("refresh", "success");
      logger.info({ userId: user.id, deviceId: rotated.deviceId || null }, "auth_refresh");
      return res.json({ ok: true, user: toPublicUser(user), token, refreshToken: rotated.refreshToken });
    } catch (error) {
      await connection.rollback();
      recordAuthMetric("refresh", "error");
      logger.error({ err: error }, "Refresh error");
      return res.status(500).json({ ok: false, message: "Refresh failed." });
    } finally {
      connection.release();
    }
  }
);

app.post(
  "/auth/logout",
  authenticateToken,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({ refreshToken: zRefreshToken.optional() }).default({})
    })
  ),
  async (req, res) => {
    try {
      const { refreshToken } = req.body || {};
      if (refreshToken) {
        const tokenHash = hashToken(refreshToken);
        await dbPool.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?", [tokenHash]);
      }
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        action: "auth_logout",
        reason: "auth_logout"
      });
      recordAuthMetric("logout", "success");
      logger.info({ userId: req.user.id }, "auth_logout");
      return res.json({ ok: true });
    } catch (error) {
      recordAuthMetric("logout", "error");
      logger.error({ err: error }, "Logout error");
      return res.status(500).json({ ok: false, message: "Logout failed." });
    }
  }
);

app.post(
  "/admin/auth/rotate-secret",
  authenticateToken,
  requireSuperAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        newSecret: z.string().min(20).max(255).optional(),
        graceHours: z.coerce.number().int().min(0).max(168).optional()
      }).default({})
    })
  ),
  async (req, res) => {
    const { newSecret, graceHours } = req.body || {};
    const secret = newSecret || crypto.randomBytes(48).toString("base64url");
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const secretId = await rotateJwtSecret(connection, secret, graceHours ?? 24);
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        action: "auth_rotate_secret",
        reason: "rotate_jwt_secret",
        relatedEntityType: "auth_secret",
        relatedEntityId: secretId
      });
      await connection.commit();
      return res.json({ ok: true, secretId, graceHours: graceHours ?? 24 });
    } catch (error) {
      await connection.rollback();
      logger.error({ err: error }, "Rotate JWT secret error");
      return res.status(500).json({ ok: false, message: "Failed to rotate JWT secret." });
    } finally {
      connection.release();
    }
  }
);

// HTTP proxy that forwards /api/* calls to the business API service.
const apiProxy = createProxyMiddleware({
  target: businessApiUrl,
  changeOrigin: true,
  xfwd: true,
  pathRewrite: { "^/api": "" },
  onProxyReq: (proxyReq, req) => {
    if (req.requestId) {
      proxyReq.setHeader("X-Request-Id", req.requestId);
    }
  }
});

// WS proxy for realtime odds (and any other WS endpoints under /ws).
const wsProxy = createProxyMiddleware({
  target: businessApiUrl,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  onProxyReqWs: (proxyReq, req) => {
    if (req.requestId) {
      proxyReq.setHeader("X-Request-Id", req.requestId);
    }
  }
});

// Route prefixes for HTTP and WebSocket traffic.
app.use("/api", apiProxy);
app.use("/ws", wsProxy);

// Handle WS upgrades manually to pass the socket to the proxy.
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/ws")) {
    wsProxy.upgrade(req, socket, head);
  }
});

const start = async () => {
  await initDatabase();
  try {
    await seedRbac();
  } catch (error) {
    logger.warn({ err: error }, "RBAC seed skipped");
  }
  try {
    await initRedis();
  } catch (error) {
    logger.error({ err: error }, "Redis unavailable, continuing without cache");
    redisClient = null;
  }

  // Start listening for gateway requests.
  server.listen(port, () => {
    logger.info({ port }, "Gateway listening");
  });
};

start().catch((error) => {
  logger.error({ err: error }, "Gateway failed to start");
  process.exit(1);
});
