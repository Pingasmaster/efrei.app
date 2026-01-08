// Gateway service: handles auth and proxies traffic to the business API.
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const http = require("http");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimitModule = require("express-rate-limit");
const mysql = require("mysql2/promise");
const { createClient: createRedisClient } = require("redis");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
// Runtime configuration (defaults match docker-compose service names/ports).
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "dev-secret";
const businessApiUrl = process.env.BUSINESS_API_URL || "http://api:4000";

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

const rateLimit = typeof rateLimitModule === "function" ? rateLimitModule : rateLimitModule.rateLimit;

const createBackoffLimiter = ({
  name,
  windowMs,
  limit,
  baseDelayMs = 1000,
  maxDelayMs = 5 * 60 * 1000
}) => {
  const penalties = new Map();
  const limiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      const key = `${req.ip}:${name}`;
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
    const key = `${req.ip}:${name}`;
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
  maxDelayMs: 5 * 60 * 1000
});

// Allow browser clients and parse JSON request bodies.
app.use(cors());
app.use(express.json());
app.use(generalLimiter);

// Basic health endpoint used by probes.
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

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

const toPublicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  points: user.points,
  isAdmin: Boolean(user.isAdmin),
  isSuperAdmin: Boolean(user.isSuperAdmin)
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
    console.error("JWT secret lookup failed", error);
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

const issueRefreshToken = async (connection, userId) => {
  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + refreshTokenDays * 24 * 60 * 60 * 1000);
  await connection.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt]
  );
  return refreshToken;
};

const rotateRefreshToken = async (connection, tokenHash) => {
  const [rows] = await connection.query(
    "SELECT id, user_id AS userId, expires_at AS expiresAt, revoked_at AS revokedAt FROM refresh_tokens WHERE token_hash = ? FOR UPDATE",
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
  const newToken = await issueRefreshToken(connection, record.userId);
  return { userId: record.userId, refreshToken: newToken };
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
    "SELECT id, email, name, points, is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned FROM users WHERE id = ?",
    [userId]
  );
  return rows[0] || null;
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
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ ok: false, message: "Admin access required." });
  }
  return next();
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !req.user.isSuperAdmin) {
    return res.status(403).json({ ok: false, message: "Super admin access required." });
  }
  return next();
};

const getCachedUserByEmail = async (email) => {
  if (!redisClient) {
    return null;
  }
  const cacheKey = `auth:user:${email}`;
  const cached = await redisClient.get(cacheKey);
  if (!cached) {
    return null;
  }
  try {
    return JSON.parse(cached);
  } catch (error) {
    return null;
  }
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
      console.warn(`MySQL not ready (attempt ${attempt}/${maxAttempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

};

const initRedis = async () => {
  const client = createRedisClient({ url: `redis://${redisHost}:${redisPort}` });
  client.on("error", (err) => {
    console.error("Redis error", err);
  });
  await client.connect();
  redisClient = client;
};

// Registration endpoint backed by MySQL and cached in Redis.
app.post("/auth/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const trimmedName = String(name || "").trim();
    if (!trimmedName || !normalizedEmail || !password) {
      return res.status(400).json({ ok: false, message: "Name, email, and password are required." });
    }
    if (!isEmailValid(normalizedEmail)) {
      return res.status(400).json({ ok: false, message: "Invalid email format." });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ ok: false, message: "Password must be at least 6 characters." });
    }

    const [existing] = await dbPool.query("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(409).json({ ok: false, message: "Email already registered." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const startingPoints = 1000;
    const [result] = await dbPool.query(
      "INSERT INTO users (email, name, password_hash, points) VALUES (?, ?, ?, ?)",
      [normalizedEmail, trimmedName, passwordHash, startingPoints]
    );

    const isSuperAdmin =
      (adminBootstrapUserId && result.insertId === adminBootstrapUserId) ||
      (adminBootstrapEmail && normalizedEmail === adminBootstrapEmail);
    if (isSuperAdmin) {
      await dbPool.query(
        "UPDATE users SET is_admin = 1, is_super_admin = 1 WHERE id = ?",
        [result.insertId]
      );
    }

    const user = {
      id: result.insertId,
      email: normalizedEmail,
      name: trimmedName,
      passwordHash,
      points: startingPoints,
      isAdmin: isSuperAdmin ? 1 : 0,
      isSuperAdmin
    };

    await setCachedUser(user);

    const token = await signJwt({ sub: String(user.id), email: user.email });
    const refreshToken = await issueRefreshToken(dbPool, user.id);
    await logAudit(dbPool, {
      actorUserId: user.id,
      targetUserId: user.id,
      action: "auth_register",
      reason: "auth_register"
    });
    await logPointChange(dbPool, {
      actorUserId: user.id,
      targetUserId: user.id,
      action: "register_points",
      reason: "initial_points",
      pointsBefore: 0,
      pointsAfter: startingPoints
    });
    return res.status(201).json({ ok: true, user: toPublicUser(user), token, refreshToken });
  } catch (error) {
    if (error && error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Email already registered." });
    }
    console.error("Register error", error);
    return res.status(500).json({ ok: false, message: "Registration failed." });
  }
});

// Login endpoint backed by MySQL with Redis caching.
app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      return res.status(400).json({ ok: false, message: "Email and password are required." });
    }

    const [rows] = await dbPool.query(
      "SELECT id, email, name, password_hash AS passwordHash, points, is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned FROM users WHERE email = ?",
      [normalizedEmail]
    );
    if (!rows.length) {
      return res.status(401).json({ ok: false, message: "Invalid credentials." });
    }
    const user = rows[0];
    await setCachedUser(user);

    if (user.isBanned) {
      return res.status(403).json({ ok: false, message: "User is banned." });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ ok: false, message: "Invalid credentials." });
    }

    const token = await signJwt({ sub: String(user.id), email: user.email });
    const refreshToken = await issueRefreshToken(dbPool, user.id);
    await logAudit(dbPool, {
      actorUserId: user.id,
      targetUserId: user.id,
      action: "auth_login",
      reason: "auth_login"
    });
    return res.json({ ok: true, user: toPublicUser(user), token, refreshToken });
  } catch (error) {
    console.error("Login error", error);
    return res.status(500).json({ ok: false, message: "Login failed." });
  }
});

app.post("/auth/refresh", authLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ ok: false, message: "refreshToken is required." });
  }
  const tokenHash = hashToken(refreshToken);
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const rotated = await rotateRefreshToken(connection, tokenHash);
    if (!rotated) {
      await connection.rollback();
      return res.status(401).json({ ok: false, message: "Invalid refresh token." });
    }
    const [userRows] = await connection.query(
      "SELECT id, email, name, points, is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned FROM users WHERE id = ?",
      [rotated.userId]
    );
    if (!userRows.length) {
      await connection.rollback();
      return res.status(401).json({ ok: false, message: "User not found." });
    }
    const user = userRows[0];
    if (user.isBanned) {
      await connection.rollback();
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
    return res.json({ ok: true, user: toPublicUser(user), token, refreshToken: rotated.refreshToken });
  } catch (error) {
    await connection.rollback();
    console.error("Refresh error", error);
    return res.status(500).json({ ok: false, message: "Refresh failed." });
  } finally {
    connection.release();
  }
});

app.post("/auth/logout", authenticateToken, async (req, res) => {
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
    return res.json({ ok: true });
  } catch (error) {
    console.error("Logout error", error);
    return res.status(500).json({ ok: false, message: "Logout failed." });
  }
});

app.post("/admin/auth/rotate-secret", authenticateToken, requireSuperAdmin, async (req, res) => {
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
    console.error("Rotate JWT secret error", error);
    return res.status(500).json({ ok: false, message: "Failed to rotate JWT secret." });
  } finally {
    connection.release();
  }
});

// HTTP proxy that forwards /api/* calls to the business API service.
const apiProxy = createProxyMiddleware({
  target: businessApiUrl,
  changeOrigin: true,
  pathRewrite: { "^/api": "" }
});

// WS proxy for realtime odds (and any other WS endpoints under /ws).
const wsProxy = createProxyMiddleware({
  target: businessApiUrl,
  changeOrigin: true,
  ws: true
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
    await initRedis();
  } catch (error) {
    console.error("Redis unavailable, continuing without cache", error);
    redisClient = null;
  }

  // Start listening for gateway requests.
  server.listen(port, () => {
    console.log(`Gateway listening on ${port}`);
  });
};

start().catch((error) => {
  console.error("Gateway failed to start", error);
  process.exit(1);
});
