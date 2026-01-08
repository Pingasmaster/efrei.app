// API service: exposes REST + WebSocket odds endpoints and business APIs.
const express = require("express");
const cors = require("cors");
const http = require("http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimitModule = require("express-rate-limit");
const { z } = require("zod");
const { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } = require("@asteasolutions/zod-to-openapi");
const swaggerUi = require("swagger-ui-express");
const { WebSocketServer, WebSocket } = require("ws");
const { createClient } = require("redis");
const mysql = require("mysql2/promise");
const pino = require("pino");
const promClient = require("prom-client");

extendZodWithOpenApi(z);

const app = express();
const port = process.env.PORT || 4000;
const jwtSecret = process.env.JWT_SECRET;
const logLevel = process.env.LOG_LEVEL || "info";
const trustProxy = process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal";

if (!jwtSecret || jwtSecret === "change-me" || jwtSecret === "dev-secret") {
  throw new Error("JWT_SECRET must be set to a non-default value.");
}

app.set("trust proxy", trustProxy);

// Redis configuration for realtime odds.
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";
const payoutQueueName = process.env.PAYOUT_QUEUE || "payout_jobs";
const payoutMaxAttemptsRaw = Number(process.env.PAYOUT_MAX_ATTEMPTS || 5);
const payoutMaxAttempts = Number.isFinite(payoutMaxAttemptsRaw) && payoutMaxAttemptsRaw > 0
  ? payoutMaxAttemptsRaw
  : 5;

// MySQL configuration for users, offers, bets, and points.
const dbHost = process.env.DB_HOST || "mysql";
const dbPort = Number(process.env.DB_PORT || 3306);
const dbName = process.env.DB_NAME || "efrei";
const dbUser = process.env.DB_USER || "efrei";
const dbPassword = process.env.DB_PASSWORD || "efrei";

let dbPool = null;
let jwtSecretsCache = { secrets: null, primary: null, fetchedAt: 0 };
let redisQueueClient = null;

const logger = pino({
  level: logLevel,
  base: { service: "api" },
  timestamp: pino.stdTimeFunctions.isoTime
});

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: "api_" });

const httpRequestDuration = new promClient.Histogram({
  name: "api_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry]
});

const httpRequestsTotal = new promClient.Counter({
  name: "api_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry]
});

const pointsOperationsTotal = new promClient.Counter({
  name: "api_points_operations_total",
  help: "Total point operations",
  labelNames: ["action", "kind"],
  registers: [metricsRegistry]
});

const pointsAmountTotal = new promClient.Counter({
  name: "api_points_amount_total",
  help: "Total points moved",
  labelNames: ["action", "kind"],
  registers: [metricsRegistry]
});

const payoutJobsEnqueuedTotal = new promClient.Counter({
  name: "api_payout_jobs_enqueued_total",
  help: "Total payout jobs enqueued",
  labelNames: ["status"],
  registers: [metricsRegistry]
});

// Last known odds payload kept in memory for fast HTTP/WS replies.
let latestOdds = {
  type: "odds",
  updatedAt: new Date().toISOString(),
  events: []
};

// Allow browser calls from the frontend and parse JSON bodies.
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

const rateLimit = typeof rateLimitModule === "function" ? rateLimitModule : rateLimitModule.rateLimit;

const createBackoffLimiter = ({
  name,
  windowMs,
  limit,
  baseDelayMs = 1000,
  maxDelayMs = 60 * 1000
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

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const adminLimiter = createBackoffLimiter({
  name: "admin",
  windowMs: 60 * 1000,
  limit: 120,
  baseDelayMs: 1000,
  maxDelayMs: 60 * 1000
});

app.use(apiLimiter);

const parsePositiveInt = (value) => {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return null;
  }
  return numberValue;
};

const parseOptionalPositiveInt = (value) => {
  if (value === undefined || value === null || value === "") {
    return { value: null, valid: true };
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["inf", "infinite", "infinity"].includes(normalized)) {
      return { value: null, valid: true };
    }
  }
  const parsed = parsePositiveInt(value);
  return { value: parsed, valid: parsed !== null };
};

const parseOdds = (value) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 1.01) {
    return null;
  }
  return Number(numberValue.toFixed(2));
};

const parseFutureDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  if (date.getTime() <= Date.now()) {
    return null;
  }
  return date;
};

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const adminBootstrapEmailRaw = process.env.ADMIN_BOOTSTRAP_EMAIL;
const adminBootstrapUserIdRaw = process.env.ADMIN_BOOTSTRAP_USER_ID;
const adminBootstrapEmail = adminBootstrapEmailRaw ? normalizeEmail(adminBootstrapEmailRaw) : null;
const adminBootstrapUserId = adminBootstrapUserIdRaw ? parsePositiveInt(adminBootstrapUserIdRaw) : null;
let superAdminIdCache = null;
const permissionCache = new Map();

const fetchUserRoles = async (userId, connection = dbPool) => {
  const [rows] = await connection.query(
    `SELECT r.name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ?`,
    [userId]
  );
  return rows.map((row) => row.name);
};

const fetchUserPermissions = async (userId, connection = dbPool) => {
  const cacheKey = `${userId}`;
  const cached = permissionCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 30 * 1000) {
    return cached.permissions;
  }
  const [rows] = await connection.query(
    `SELECT DISTINCT p.name
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = ?`,
    [userId]
  );
  const permissions = rows.map((row) => row.name);
  permissionCache.set(cacheKey, { permissions, fetchedAt: Date.now() });
  return permissions;
};

const clearPermissionCache = (userId) => {
  if (!userId) return;
  permissionCache.delete(`${userId}`);
};

const isUserInRole = async (userId, roleName, connection = dbPool) => {
  const [rows] = await connection.query(
    `SELECT 1
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND r.name = ?
     LIMIT 1`,
    [userId, roleName]
  );
  return rows.length > 0;
};

const registry = new OpenAPIRegistry();

const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  issues: z.array(z.any()).optional()
}).openapi("ErrorResponse");

const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi("OkResponse");
const MetricsResponseSchema = z.string().openapi("MetricsResponse");
const AdminDeviceSchema = z.object({
  id: z.number(),
  fingerprint: z.string(),
  userAgent: z.string().nullable(),
  lastIp: z.string().nullable(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: z.number().nullable(),
  activeSessions: z.number().int()
}).openapi("AdminDevice");
const AdminDeviceListSchema = z.object({
  ok: z.literal(true),
  devices: z.array(AdminDeviceSchema)
}).openapi("AdminDeviceList");
const AdminSessionSchema = z.object({
  id: z.number(),
  deviceId: z.number().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string(),
  isActive: z.boolean(),
  userAgent: z.string().nullable(),
  lastIp: z.string().nullable()
}).openapi("AdminSession");
const AdminSessionListSchema = z.object({
  ok: z.literal(true),
  sessions: z.array(AdminSessionSchema)
}).openapi("AdminSessionList");

registry.register("ErrorResponse", ErrorResponseSchema);
registry.register("OkResponse", OkResponseSchema);
registry.register("MetricsResponse", MetricsResponseSchema);
registry.register("AdminDevice", AdminDeviceSchema);
registry.register("AdminDeviceList", AdminDeviceListSchema);
registry.register("AdminSession", AdminSessionSchema);
registry.register("AdminSessionList", AdminSessionListSchema);

const zId = z.coerce.number().int().positive();
const zOptionalId = zId.optional();
const zLimit = z.coerce.number().int().min(1).max(200).default(50);
const zOffset = z.coerce.number().int().min(0).default(0);
const zLongLimit = z.coerce.number().int().min(1).max(1000).default(200);
const zSortOrder = z.enum(["asc", "desc"]).default("desc");
const zSearch = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .optional();
const zOptionalString = (maxLength) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .transform((value) => (value === "" ? undefined : value));
const zNullableString = (maxLength) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

const zGroupRole = z.string().trim().min(1).max(32);

const zBooleanString = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return value;
}, z.boolean());

const zOptionalPositiveIntOrInfinity = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["inf", "infinite", "infinity"].includes(normalized)) {
      return null;
    }
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}, z.number().int().positive().nullable());

const zOdds = z.coerce.number().min(1.01);
const zPositiveInt = z.coerce.number().int().positive();
const zFutureDate = z
  .coerce
  .date()
  .refine((date) => date.getTime() > Date.now(), { message: "Must be a future date." });

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

const emptyRequestSchema = z.object({
  body: z.object({}).default({}),
  query: z.object({}).default({}),
  params: z.object({}).default({})
});

const registerRoute = ({ method, path, summary, tags, params, query, body, responses }) => {
  registry.registerPath({
    method,
    path,
    summary,
    tags,
    request: {
      params,
      query,
      body: body
        ? {
            content: {
              "application/json": { schema: body }
            }
          }
        : undefined
    },
    responses: responses || {
      200: {
        description: "OK",
        content: { "application/json": { schema: OkResponseSchema } }
      },
      400: {
        description: "Bad Request",
        content: { "application/json": { schema: ErrorResponseSchema } }
      }
    }
  });
};

// Simple health probe for liveness checks.
registerRoute({
  method: "get",
  path: "/health",
  summary: "Health check",
  tags: ["System"],
  params: z.object({}),
  query: z.object({})
});
app.get("/health", validateRequest(emptyRequestSchema), (req, res) => {
  res.json({ status: "ok", service: "api" });
});

registerRoute({
  method: "get",
  path: "/metrics",
  summary: "Prometheus metrics",
  tags: ["System"],
  params: z.object({}),
  query: z.object({}),
  responses: {
    200: {
      description: "Metrics",
      content: { "text/plain": { schema: MetricsResponseSchema } }
    }
  }
});
app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});

// Placeholder endpoint for future business logic.
registerRoute({
  method: "get",
  path: "/absurde",
  summary: "Stub endpoint",
  tags: ["System"],
  params: z.object({}),
  query: z.object({})
});
app.get("/absurde", validateRequest(emptyRequestSchema), (req, res) => {
  res.json({ message: "stub", idea: "replace with your business logic" });
});

// Synchronous REST endpoint that returns the latest odds snapshot.
registerRoute({
  method: "get",
  path: "/odds",
  summary: "Latest odds snapshot",
  tags: ["System"],
  params: z.object({}),
  query: z.object({})
});
app.get("/odds", validateRequest(emptyRequestSchema), (req, res) => {
  res.json(latestOdds);
});

const getIdempotencyKey = (req) => {
  const raw = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
  if (!raw) return null;
  const key = String(raw).trim();
  return key.length ? key.slice(0, 128) : null;
};

const buildIdempotencyHash = (routeKey, req) => {
  const payload = {
    routeKey,
    method: req.method,
    params: req.params,
    query: req.query,
    body: req.body
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};

const withIdempotency = (routeKey, handler) => async (req, res) => {
  const idemKey = getIdempotencyKey(req);
  if (!idemKey) {
    return handler(req, res);
  }
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, message: "Idempotency requires authentication." });
  }
  const userId = req.user.id;
  const requestHash = buildIdempotencyHash(routeKey, req);

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, request_hash AS requestHash, status, response_status AS responseStatus, response_body AS responseBody
       FROM idempotency_keys
       WHERE idem_key = ? AND user_id = ? AND route = ? AND method = ?
       FOR UPDATE`,
      [idemKey, userId, routeKey, req.method]
    );
    if (rows.length) {
      const record = rows[0];
      if (record.requestHash !== requestHash) {
        await connection.rollback();
        return res.status(409).json({ ok: false, message: "Idempotency key already used with different payload." });
      }
      if (record.status === "completed" && record.responseStatus) {
        await connection.rollback();
        let body = record.responseBody;
        try {
          body = typeof body === "string" ? JSON.parse(body) : body;
        } catch (error) {
          body = { ok: false, message: "Failed to decode idempotent response." };
        }
        return res.status(record.responseStatus).json(body);
      }
      if (record.status === "processing") {
        await connection.rollback();
        return res.status(409).json({ ok: false, message: "Request already in progress." });
      }
    }
    await connection.query(
      `INSERT INTO idempotency_keys (idem_key, user_id, route, method, request_hash, status)
       VALUES (?, ?, ?, ?, ?, 'processing')`,
      [idemKey, userId, routeKey, req.method, requestHash]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error("Idempotency check failed", error);
    return res.status(500).json({ ok: false, message: "Idempotency check failed." });
  } finally {
    connection.release();
  }

  let responseBody = null;
  let responseStatus = 200;
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);

  res.status = (code) => {
    responseStatus = code;
    return originalStatus(code);
  };
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  try {
    await handler(req, res);
  } catch (error) {
    console.error("Handler error", error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: "Request failed." });
      responseStatus = 500;
      responseBody = { ok: false, message: "Request failed." };
    }
  } finally {
    const finalize = await dbPool.getConnection();
    try {
      await finalize.query(
        `UPDATE idempotency_keys
         SET status = 'completed', response_status = ?, response_body = ?, completed_at = NOW()
         WHERE idem_key = ? AND user_id = ? AND route = ? AND method = ?`,
        [
          responseStatus,
          responseBody ? JSON.stringify(responseBody) : null,
          idemKey,
          userId,
          routeKey,
          req.method
        ]
      );
    } catch (error) {
      console.error("Failed to finalize idempotency", error);
    } finally {
      finalize.release();
    }
  }
};

const fetchUserById = async (userId, connection = dbPool) => {
  const [rows] = await connection.query(
    `SELECT id, email, name, points,
            is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned,
            profile_description AS profileDescription, profile_visibility AS profileVisibility,
            profile_alias AS profileAlias, profile_quote AS profileQuote,
            created_at AS createdAt
     FROM users
     WHERE id = ?`,
    [userId]
  );
  if (!rows[0]) {
    return null;
  }
  const permissions = await fetchUserPermissions(Number(rows[0].id), connection);
  const isAdmin = permissions.includes("admin.access");
  const isSuperAdmin = permissions.includes("admin.super");
  return {
    id: Number(rows[0].id),
    email: rows[0].email,
    name: rows[0].name,
    points: Number(rows[0].points),
    isAdmin,
    isSuperAdmin,
    isBanned: Boolean(rows[0].isBanned),
    permissions,
    profileDescription: rows[0].profileDescription ?? null,
    profileVisibility: rows[0].profileVisibility || "public",
    profileAlias: rows[0].profileAlias ?? null,
    profileQuote: rows[0].profileQuote ?? null,
    createdAt: rows[0].createdAt
  };
};

const serializeOffer = (offer) => {
  const maxAcceptances =
    offer.max_acceptances === null ? null : Number(offer.max_acceptances);
  const acceptedCount = Number(offer.accepted_count);
  return {
    id: Number(offer.id),
    creatorUserId: Number(offer.creator_user_id),
    groupId: offer.group_id === null ? null : Number(offer.group_id),
    title: offer.title,
    description: offer.description,
    pointsCost: Number(offer.points_cost),
    maxAcceptances,
    acceptedCount,
    remainingAcceptances: maxAcceptances === null ? null : Math.max(maxAcceptances - acceptedCount, 0),
    isActive: Boolean(offer.is_active),
    createdAt: offer.created_at,
    updatedAt: offer.updated_at
  };
};

const serializeBetOption = (option) => ({
  id: Number(option.id),
  betId: Number(option.bet_id),
  label: option.label,
  numericValue: option.numeric_value === null ? null : Number(option.numeric_value),
  odds: Number(option.current_odds),
  createdAt: option.created_at
});

const serializeBet = (bet, options = []) => ({
  id: Number(bet.id),
  creatorUserId: Number(bet.creator_user_id),
  groupId: bet.group_id === null ? null : Number(bet.group_id),
  title: bet.title,
  description: bet.description,
  details: bet.details,
  betType: bet.bet_type,
  status: bet.status,
  closesAt: bet.closes_at instanceof Date ? bet.closes_at.toISOString() : bet.closes_at,
  resolvedAt: bet.resolved_at ? new Date(bet.resolved_at).toISOString() : null,
  resultOptionId: bet.result_option_id ? Number(bet.result_option_id) : null,
  createdAt: bet.created_at,
  updatedAt: bet.updated_at,
  options
});

const profileVisibilityValues = new Set(["public", "private"]);

const normalizeOptionalString = (value, maxLength, fieldName) => {
  if (value === undefined) {
    return { provided: false };
  }
  if (value === null) {
    return { provided: true, value: null };
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return { provided: true, value: null };
  }
  if (trimmed.length > maxLength) {
    return { error: `${fieldName} is too long.` };
  }
  return { provided: true, value: trimmed };
};

const normalizeProfileVisibility = (value) => {
  if (value === undefined) {
    return { provided: false };
  }
  if (value === null) {
    return { error: "profileVisibility cannot be null." };
  }
  const normalized = String(value).trim().toLowerCase();
  if (!profileVisibilityValues.has(normalized)) {
    return { error: "profileVisibility must be public or private." };
  }
  return { provided: true, value: normalized };
};

const serializeProfileForViewer = (user, viewer) => {
  const isSelf = viewer && viewer.id === user.id;
  const isAdmin = viewer && viewer.isAdmin;
  const visibility = user.profileVisibility || "public";
  if (visibility === "private" && !isSelf && !isAdmin) {
    return null;
  }
  const displayName = !isSelf && !isAdmin && user.profileAlias ? user.profileAlias : user.name;
  return {
    id: user.id,
    displayName,
    description: user.profileDescription,
    quote: user.profileQuote,
    visibility,
    alias: user.profileAlias,
    createdAt: user.createdAt
  };
};

const fetchUserGroupIds = async (userId, connection = dbPool) => {
  const [rows] = await connection.query(
    "SELECT group_id AS groupId FROM group_members WHERE user_id = ?",
    [userId]
  );
  return rows.map((row) => Number(row.groupId));
};

const isUserInGroup = async (userId, groupId, connection = dbPool) => {
  const [rows] = await connection.query(
    "SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ? LIMIT 1",
    [userId, groupId]
  );
  return rows.length > 0;
};

const fetchGroupById = async (groupId, connection = dbPool) => {
  const [rows] = await connection.query(
    "SELECT id, name, description, is_private AS isPrivate, created_by AS createdBy, created_at AS createdAt FROM user_groups WHERE id = ?",
    [groupId]
  );
  if (!rows[0]) {
    return null;
  }
  return {
    id: Number(rows[0].id),
    name: rows[0].name,
    description: rows[0].description,
    isPrivate: Boolean(rows[0].isPrivate),
    createdBy: rows[0].createdBy ? Number(rows[0].createdBy) : null,
    createdAt: rows[0].createdAt
  };
};

const buildGroupAccessFilter = (groupIds, columnName = "group_id") => {
  if (!groupIds || groupIds.length === 0) {
    return { clause: `${columnName} IS NULL`, params: [] };
  }
  const placeholders = groupIds.map(() => "?").join(", ");
  return { clause: `${columnName} IS NULL OR ${columnName} IN (${placeholders})`, params: groupIds };
};

const canAccessGroupResource = async (groupId, user, connection = dbPool) => {
  if (!groupId) {
    return true;
  }
  if (!user) {
    return false;
  }
  if (user.isAdmin) {
    return true;
  }
  return isUserInGroup(user.id, groupId, connection);
};

const feeRate = 0.02;
const calculateFee = (amount) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(amount * feeRate));
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
    const { secrets } = await loadJwtSecrets();
    if (secrets && secrets.length > 0) {
      return secrets;
    }
  } catch (error) {
    logger.error({ err: error }, "JWT secret lookup failed");
  }
  return [jwtSecret];
};

const verifyJwtToken = async (token) => {
  const secrets = await getJwtSecrets();
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      // try next secret
    }
  }
  return null;
};

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

const getSuperAdminId = async (connection = dbPool) => {
  if (superAdminIdCache) {
    return superAdminIdCache;
  }
  const [rows] = await connection.query(
    `SELECT ur.user_id AS userId
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE r.name = 'super_admin'
     ORDER BY ur.user_id ASC
     LIMIT 1`
  );
  if (!rows.length) {
    return null;
  }
  superAdminIdCache = Number(rows[0].userId);
  return superAdminIdCache;
};

const requireSuperAdminId = async (connection) => {
  const superAdminId = await getSuperAdminId(connection);
  if (!superAdminId) {
    throw new Error("Super admin not configured");
  }
  return superAdminId;
};

const applyPointsDelta = async (connection, {
  userId,
  delta,
  actorUserId = null,
  action,
  reason = null,
  relatedEntityType = null,
  relatedEntityId = null,
  metadata = null
}) => {
  const [rows] = await connection.query("SELECT points FROM users WHERE id = ? FOR UPDATE", [userId]);
  if (!rows.length) {
    throw new Error("User not found");
  }
  const before = Number(rows[0].points);
  const after = before + Number(delta);
  if (after < 0) {
    throw new Error("Insufficient points");
  }
  await connection.query("UPDATE users SET points = ? WHERE id = ?", [after, userId]);
  await logPointChange(connection, {
    actorUserId,
    targetUserId: userId,
    action,
    reason,
    pointsBefore: before,
    pointsAfter: after,
    relatedEntityType,
    relatedEntityId,
    metadata
  });
  const metricAction = action || "unknown";
  pointsOperationsTotal.inc({ action: metricAction, kind: "delta" });
  pointsAmountTotal.inc({ action: metricAction, kind: "delta" }, Math.abs(Number(delta)));
  logger.info({
    userId,
    actorUserId,
    action: metricAction,
    delta: Number(delta),
    pointsBefore: before,
    pointsAfter: after,
    relatedEntityType,
    relatedEntityId
  }, "points_delta_applied");
  return { before, after };
};

const transferPoints = async (connection, {
  fromUserId,
  toUserId,
  amount,
  actorUserId = null,
  action,
  reason = null,
  relatedEntityType = null,
  relatedEntityId = null,
  metadata = null
}) => {
  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }
  const ids = [fromUserId, toUserId].map(Number).sort((a, b) => a - b);
  const [rows] = await connection.query(
    `SELECT id, points FROM users WHERE id IN (${ids.map(() => "?").join(",")}) FOR UPDATE`,
    ids
  );
  const pointsById = new Map(rows.map((row) => [Number(row.id), Number(row.points)]));
  if (!pointsById.has(fromUserId) || !pointsById.has(toUserId)) {
    throw new Error("User not found");
  }
  const fromBefore = pointsById.get(fromUserId);
  const toBefore = pointsById.get(toUserId);
  const fromAfter = fromBefore - amount;
  const toAfter = toBefore + amount;
  if (fromAfter < 0) {
    throw new Error("Insufficient points");
  }
  await connection.query("UPDATE users SET points = ? WHERE id = ?", [fromAfter, fromUserId]);
  await connection.query("UPDATE users SET points = ? WHERE id = ?", [toAfter, toUserId]);
  await logPointChange(connection, {
    actorUserId,
    targetUserId: fromUserId,
    action: `${action}_debit`,
    reason,
    pointsBefore: fromBefore,
    pointsAfter: fromAfter,
    relatedEntityType,
    relatedEntityId,
    metadata
  });
  await logPointChange(connection, {
    actorUserId,
    targetUserId: toUserId,
    action: `${action}_credit`,
    reason,
    pointsBefore: toBefore,
    pointsAfter: toAfter,
    relatedEntityType,
    relatedEntityId,
    metadata
  });
  const metricAction = action || "unknown";
  pointsOperationsTotal.inc({ action: metricAction, kind: "transfer" });
  pointsAmountTotal.inc({ action: metricAction, kind: "transfer" }, Math.abs(Number(amount)));
  logger.info({
    fromUserId,
    toUserId,
    actorUserId,
    action: metricAction,
    amount: Number(amount),
    fromBefore,
    fromAfter,
    toBefore,
    toAfter,
    relatedEntityType,
    relatedEntityId
  }, "points_transferred");
  return { fromBefore, fromAfter, toBefore, toAfter };
};

const creditFeeToSuperAdmin = async (connection, feePoints, context = {}) => {
  if (!feePoints) {
    return;
  }
  const superAdminId = await requireSuperAdminId(connection);
  await applyPointsDelta(connection, {
    userId: superAdminId,
    delta: Number(feePoints),
    actorUserId: context.actorUserId ?? null,
    action: context.action ?? "fee_credit",
    reason: context.reason ?? "fee_credit",
    relatedEntityType: context.relatedEntityType ?? null,
    relatedEntityId: context.relatedEntityId ?? null,
    metadata: context.metadata ?? { fee: feePoints }
  });
};

const enqueuePayoutJob = async (connection, { betId, resultOptionId, resolvedBy, metadata = null }) => {
  const payload = {
    betId,
    resultOptionId,
    resolvedBy,
    requestedAt: new Date().toISOString(),
    metadata
  };
  const payloadJson = JSON.stringify(payload);
  const [existingRows] = await connection.query(
    "SELECT id, status, attempts FROM payout_jobs WHERE bet_id = ? FOR UPDATE",
    [betId]
  );
  if (existingRows.length) {
    const existing = existingRows[0];
    if (existing.status === "completed") {
      return { jobId: Number(existing.id), alreadyCompleted: true };
    }
    const shouldReset = ["failed", "dead", "retry_wait"].includes(existing.status);
    const nextStatus = shouldReset ? "queued" : existing.status;
    const nextAttempts = shouldReset ? 0 : Number(existing.attempts || 0);
    await connection.query(
      `UPDATE payout_jobs
       SET result_option_id = ?, resolved_by = ?, payload = ?, status = ?, attempts = ?, max_attempts = ?,
           error_message = NULL, next_attempt_at = NULL, dead_at = NULL, updated_at = NOW()
       WHERE id = ?`,
      [resultOptionId, resolvedBy, payloadJson, nextStatus, nextAttempts, payoutMaxAttempts, existing.id]
    );
    if (nextStatus === "queued") {
      payoutJobsEnqueuedTotal.inc({ status: "queued" });
      logger.info({
        jobId: Number(existing.id),
        betId,
        resultOptionId,
        resolvedBy,
        status: "queued",
        existing: true
      }, "payout_job_enqueued");
    }
    if (redisQueueClient && existing.status !== "processing" && nextStatus === "queued") {
      await redisQueueClient.lPush(payoutQueueName, String(existing.id));
    }
    return { jobId: Number(existing.id), existing: true };
  }
  const [result] = await connection.query(
    "INSERT INTO payout_jobs (bet_id, result_option_id, resolved_by, status, payload, max_attempts) VALUES (?, ?, ?, 'queued', ?, ?)",
    [betId, resultOptionId, resolvedBy, payloadJson, payoutMaxAttempts]
  );
  const jobId = Number(result.insertId);
  if (redisQueueClient) {
    await redisQueueClient.lPush(payoutQueueName, String(jobId));
  }
  payoutJobsEnqueuedTotal.inc({ status: "queued" });
  logger.info({
    jobId,
    betId,
    resultOptionId,
    resolvedBy,
    status: "queued",
    existing: false
  }, "payout_job_enqueued");
  return { jobId, existing: false };
};

const isSuperAdminUserId = async (userId, connection = dbPool) => {
  if (!userId) {
    return false;
  }
  if (superAdminIdCache && Number(userId) === superAdminIdCache) {
    return true;
  }
  return isUserInRole(Number(userId), "super_admin", connection);
};

const getUserFromRequest = async (req) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader) {
    return null;
  }
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Invalid bearer token.");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  const payload = await verifyJwtToken(token);
  if (!payload) {
    throw new Error("Invalid or expired token.");
  }
  const userId = parsePositiveInt(payload?.sub);
  if (!userId) {
    throw new Error("Invalid token subject.");
  }
  const user = await fetchUserById(userId);
  if (!user) {
    throw new Error("User not found.");
  }
  return user;
};

const authenticate = async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ ok: false, message: "Missing bearer token." });
    }
    if (user.isBanned) {
      return res.status(403).json({ ok: false, message: "User is banned." });
    }
    req.user = user;
    return next();
  } catch (error) {
    req.user = null;
    return next();
  }
};

const optionalAuthenticate = async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    if (user && user.isBanned) {
      return res.status(403).json({ ok: false, message: "User is banned." });
    }
    req.user = user || null;
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: "Invalid or expired token." });
  }
};

const hasPermission = (user, permission) =>
  Boolean(user && Array.isArray(user.permissions) && user.permissions.includes(permission));

const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({ ok: false, message: "Permission denied." });
  }
  return next();
};

const requireAdmin = requirePermission("admin.access");
const requireSuperAdmin = requirePermission("admin.super");

// User endpoints (points never drop below 0).
registerRoute({
  method: "get",
  path: "/users/{id}",
  summary: "Get user detail (self or admin)",
  tags: ["Users"],
  params: z.object({ id: zId }),
  query: z.object({})
});
app.get("/users/:id", authenticate, validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })), async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }
  if (!req.user.isAdmin && req.user.id !== userId) {
    return res.status(403).json({ ok: false, message: "Access denied." });
  }
  try {
    const user = await fetchUserById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    return res.json({ ok: true, user });
  } catch (error) {
    console.error("Fetch user error", error);
    return res.status(500).json({ ok: false, message: "Failed to fetch user." });
  }
});

registerRoute({
  method: "patch",
  path: "/me/profile",
  summary: "Update profile",
  tags: ["Profiles"],
  body: z.object({
    description: zNullableString(2000),
    quote: zNullableString(280),
    alias: zNullableString(120),
    pseudonym: zNullableString(120),
    visibility: z.enum(["public", "private"]).optional(),
    profileVisibility: z.enum(["public", "private"]).optional(),
    profile_visibility: z.enum(["public", "private"]).optional()
  })
});
app.patch(
  "/me/profile",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        description: zNullableString(2000),
        quote: zNullableString(280),
        alias: zNullableString(120),
        pseudonym: zNullableString(120),
        visibility: z.enum(["public", "private"]).optional(),
        profileVisibility: z.enum(["public", "private"]).optional(),
        profile_visibility: z.enum(["public", "private"]).optional()
      })
    })
  ),
  async (req, res) => {
  const description = normalizeOptionalString(req.body?.description, 2000, "description");
  if (description.error) {
    return res.status(400).json({ ok: false, message: description.error });
  }
  const quote = normalizeOptionalString(req.body?.quote, 280, "quote");
  if (quote.error) {
    return res.status(400).json({ ok: false, message: quote.error });
  }
  const aliasInput = req.body?.alias ?? req.body?.pseudonym;
  const alias = normalizeOptionalString(aliasInput, 120, "alias");
  if (alias.error) {
    return res.status(400).json({ ok: false, message: alias.error });
  }
  const visibilityInput = req.body?.visibility ?? req.body?.profileVisibility ?? req.body?.profile_visibility;
  const visibility = normalizeProfileVisibility(visibilityInput);
  if (visibility.error) {
    return res.status(400).json({ ok: false, message: visibility.error });
  }

  const updates = [];
  const values = [];
  if (description.provided) {
    updates.push("profile_description = ?");
    values.push(description.value);
  }
  if (quote.provided) {
    updates.push("profile_quote = ?");
    values.push(quote.value);
  }
  if (alias.provided) {
    updates.push("profile_alias = ?");
    values.push(alias.value);
  }
  if (visibility.provided) {
    updates.push("profile_visibility = ?");
    values.push(visibility.value);
  }

  if (!updates.length) {
    return res.status(400).json({ ok: false, message: "No profile fields provided." });
  }

  try {
    await dbPool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, [...values, req.user.id]);
    const user = await fetchUserById(req.user.id);
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      targetUserId: req.user.id,
      action: "profile_update",
      reason: "profile_update",
      metadata: { fields: updates }
    });
    return res.json({ ok: true, profile: serializeProfileForViewer(user, req.user) });
  } catch (error) {
    console.error("Update profile error", error);
    return res.status(500).json({ ok: false, message: "Failed to update profile." });
  }
  }
);

registerRoute({
  method: "get",
  path: "/profiles/{id}",
  summary: "Get public profile",
  tags: ["Profiles"],
  params: z.object({ id: zId }),
  query: z.object({})
});
app.get(
  "/profiles/:id",
  optionalAuthenticate,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }
  try {
    const user = await fetchUserById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    const profile = serializeProfileForViewer(user, req.user);
    if (!profile) {
      return res.status(403).json({ ok: false, message: "Profile is private." });
    }
    if (req.user) {
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "profile_view",
        reason: "profile_view"
      });
    }
    return res.json({ ok: true, profile });
  } catch (error) {
    console.error("Fetch profile error", error);
    return res.status(500).json({ ok: false, message: "Failed to fetch profile." });
  }
  }
);

registerRoute({
  method: "get",
  path: "/me/stats",
  summary: "Get personal stats",
  tags: ["Profiles"],
  params: z.object({}),
  query: z.object({})
});
app.get("/me/stats", authenticate, validateRequest(emptyRequestSchema), async (req, res) => {
  try {
    const userId = req.user.id;
    const [[createdBets]] = await dbPool.query(
      "SELECT COUNT(*) AS count FROM bets WHERE creator_user_id = ?",
      [userId]
    );
    const [[positionsSummary]] = await dbPool.query(
      `SELECT COUNT(*) AS positionsCount,
              COALESCE(SUM(stake_points), 0) AS totalStaked,
              COALESCE(SUM(payout_points), 0) AS totalPayout,
              COALESCE(SUM(sold_points), 0) AS totalSold
       FROM bet_positions
       WHERE user_id = ?`,
      [userId]
    );
    const [[participatedBets]] = await dbPool.query(
      "SELECT COUNT(DISTINCT bet_id) AS count FROM bet_positions WHERE user_id = ?",
      [userId]
    );
    const [[offersCreated]] = await dbPool.query(
      "SELECT COUNT(*) AS count FROM offers WHERE creator_user_id = ?",
      [userId]
    );
    const [[offersAccepted]] = await dbPool.query(
      "SELECT COUNT(*) AS count FROM offer_acceptances WHERE accepter_user_id = ?",
      [userId]
    );
    const totalStaked = Number(positionsSummary.totalStaked);
    const totalPayout = Number(positionsSummary.totalPayout);
    const totalSold = Number(positionsSummary.totalSold);
    const netResult = totalPayout + totalSold - totalStaked;

    await logAudit(dbPool, {
      actorUserId: userId,
      action: "user_stats",
      reason: "user_stats"
    });

    return res.json({
      ok: true,
      stats: {
        points: req.user.points,
        betsCreated: Number(createdBets.count),
        betsParticipated: Number(participatedBets.count),
        positionsCount: Number(positionsSummary.positionsCount),
        totalStaked,
        totalPayout,
        totalSold,
        netResult,
        offersCreated: Number(offersCreated.count),
        offersAccepted: Number(offersAccepted.count)
      }
    });
  } catch (error) {
    console.error("Fetch stats error", error);
    return res.status(500).json({ ok: false, message: "Failed to fetch stats." });
  }
});

registerRoute({
  method: "get",
  path: "/me/bets",
  summary: "List personal bets",
  tags: ["Profiles"],
  params: z.object({}),
  query: z.object({})
});
app.get("/me/bets", authenticate, validateRequest(emptyRequestSchema), async (req, res) => {
  try {
    const userId = req.user.id;
    const [createdRows] = await dbPool.query(
      "SELECT id FROM bets WHERE creator_user_id = ?",
      [userId]
    );
    const [positionRows] = await dbPool.query(
      "SELECT DISTINCT bet_id AS betId FROM bet_positions WHERE user_id = ?",
      [userId]
    );
    const createdIds = new Set(createdRows.map((row) => Number(row.id)));
    const participatedIds = new Set(positionRows.map((row) => Number(row.betId)));
    const betIdSet = new Set([...createdIds, ...participatedIds]);
    const betIds = Array.from(betIdSet);

    if (!betIds.length) {
      return res.json({ ok: true, bets: [] });
    }

    const [bets] = await dbPool.query(
      `SELECT * FROM bets WHERE id IN (${betIds.map(() => "?").join(",")}) ORDER BY created_at DESC`,
      betIds
    );
    const [options] = await dbPool.query(
      `SELECT * FROM bet_options WHERE bet_id IN (${betIds.map(() => "?").join(",")})`,
      betIds
    );
    const optionsByBet = new Map();
    for (const option of options) {
      const betId = Number(option.bet_id);
      if (!optionsByBet.has(betId)) {
        optionsByBet.set(betId, []);
      }
      optionsByBet.get(betId).push(serializeBetOption(option));
    }

    await logAudit(dbPool, {
      actorUserId: userId,
      action: "user_list_bets",
      reason: "user_list_bets",
      metadata: { count: bets.length }
    });

    return res.json({
      ok: true,
      bets: bets.map((bet) => {
        const betId = Number(bet.id);
        return {
          ...serializeBet(bet, optionsByBet.get(betId) || []),
          roles: {
            creator: createdIds.has(betId),
            participant: participatedIds.has(betId)
          }
        };
      })
    });
  } catch (error) {
    console.error("List user bets error", error);
    return res.status(500).json({ ok: false, message: "Failed to list user bets." });
  }
});

registerRoute({
  method: "get",
  path: "/me/groups",
  summary: "List user groups",
  tags: ["Groups"],
  params: z.object({}),
  query: z.object({})
});
app.get("/me/groups", authenticate, validateRequest(emptyRequestSchema), async (req, res) => {
  try {
    const [rows] = await dbPool.query(
      `SELECT g.id, g.name, g.description, g.is_private AS isPrivate,
              gm.role, gm.created_at AS joinedAt
       FROM group_members gm
       JOIN user_groups g ON g.id = gm.group_id
       WHERE gm.user_id = ?
       ORDER BY g.name ASC`,
      [req.user.id]
    );
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      action: "user_list_groups",
      reason: "user_list_groups"
    });
    return res.json({ ok: true, groups: rows });
  } catch (error) {
    console.error("List user groups error", error);
    return res.status(500).json({ ok: false, message: "Failed to list groups." });
  }
});

app.use("/admin", adminLimiter);

// Admin: credit/debit points.
registerRoute({
  method: "post",
  path: "/admin/users/{id}/points/credit",
  summary: "Admin credit points",
  tags: ["Admin"],
  params: z.object({ id: zId }),
  body: z.object({ amount: zPositiveInt.optional(), points: zPositiveInt.optional() })
});
app.post(
  "/admin/users/:id/points/credit",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ amount: zPositiveInt.optional(), points: zPositiveInt.optional() })
    })
  ),
  withIdempotency("admin_points_credit", async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    const amount = parsePositiveInt(req.body?.amount ?? req.body?.points);
    if (!userId || !amount) {
      return res.status(400).json({ ok: false, message: "User id and positive amount are required." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      if (!req.user.isSuperAdmin && (await isUserInRole(userId, "super_admin", connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot modify super admin points." });
      }
      const { after } = await applyPointsDelta(connection, {
        userId,
        delta: amount,
        actorUserId: req.user.id,
        action: "admin_points_credit",
        reason: "admin_credit",
        metadata: { amount }
      });
      await connection.commit();
      return res.json({ ok: true, userId, points: after });
    } catch (error) {
      await connection.rollback();
      console.error("Credit points error", error);
      return res.status(500).json({ ok: false, message: "Failed to credit points." });
    } finally {
      connection.release();
    }
  })
);

registerRoute({
  method: "post",
  path: "/admin/users/{id}/points/debit",
  summary: "Admin debit points",
  tags: ["Admin"],
  params: z.object({ id: zId }),
  body: z.object({ amount: zPositiveInt.optional(), points: zPositiveInt.optional() })
});
app.post(
  "/admin/users/:id/points/debit",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ amount: zPositiveInt.optional(), points: zPositiveInt.optional() })
    })
  ),
  withIdempotency("admin_points_debit", async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    const amount = parsePositiveInt(req.body?.amount ?? req.body?.points);
    if (!userId || !amount) {
      return res.status(400).json({ ok: false, message: "User id and positive amount are required." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      if (!req.user.isSuperAdmin && (await isUserInRole(userId, "super_admin", connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot modify super admin points." });
      }
      const { after } = await applyPointsDelta(connection, {
        userId,
        delta: -amount,
        actorUserId: req.user.id,
        action: "admin_points_debit",
        reason: "admin_debit",
        metadata: { amount }
      });
      await connection.commit();
      return res.json({ ok: true, userId, points: after });
    } catch (error) {
      await connection.rollback();
      console.error("Debit points error", error);
      if (error.message === "Insufficient points") {
        return res.status(400).json({ ok: false, message: "Insufficient points." });
      }
      return res.status(500).json({ ok: false, message: "Failed to debit points." });
    } finally {
      connection.release();
    }
  })
);

registerRoute({
  method: "post",
  path: "/admin/users/{id}/promote",
  summary: "Promote user to admin",
  tags: ["Admin"],
  params: z.object({ id: zId })
});
app.post(
  "/admin/users/:id/promote",
  authenticate,
  requireSuperAdmin,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }
    try {
      const isTargetSuper = await isSuperAdminUserId(userId);
      if (isTargetSuper) {
        return res.status(400).json({ ok: false, message: "User is already super admin." });
      }
      const adminRoleId = await ensureRole("admin", "Standard admin role");
      if (!adminRoleId) {
        return res.status(500).json({ ok: false, message: "Admin role not configured." });
      }
      await ensureUserRole(userId, adminRoleId, req.user.id);
      await dbPool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [userId]);
      clearPermissionCache(userId);
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_promote",
        reason: "promote_admin"
      });
      return res.json({ ok: true, userId, isAdmin: true });
    } catch (error) {
      console.error("Promote admin error", error);
      return res.status(500).json({ ok: false, message: "Failed to promote admin." });
    }
  }
);

registerRoute({
  method: "post",
  path: "/admin/users/{id}/demote",
  summary: "Demote admin",
  tags: ["Admin"],
  params: z.object({ id: zId })
});
app.post(
  "/admin/users/:id/demote",
  authenticate,
  requireSuperAdmin,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }
    try {
      const isTargetSuper = await isSuperAdminUserId(userId);
      if (isTargetSuper) {
        return res.status(403).json({ ok: false, message: "Cannot demote super admin." });
      }
      const adminRoleId = await ensureRole("admin", "Standard admin role");
      if (!adminRoleId) {
        return res.status(500).json({ ok: false, message: "Admin role not configured." });
      }
      const [rows] = await dbPool.query(
        `SELECT COUNT(*) AS count
         FROM user_roles ur
         WHERE ur.role_id = ?`,
        [adminRoleId]
      );
      if (Number(rows[0]?.count) <= 1 && req.user.id === userId) {
        return res.status(400).json({ ok: false, message: "Cannot demote the last admin." });
      }
      await dbPool.query("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?", [userId, adminRoleId]);
      await dbPool.query("UPDATE users SET is_admin = 0 WHERE id = ?", [userId]);
      clearPermissionCache(userId);
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_demote",
        reason: "demote_admin"
      });
      return res.json({ ok: true, userId, isAdmin: false });
    } catch (error) {
      console.error("Demote admin error", error);
      return res.status(500).json({ ok: false, message: "Failed to demote admin." });
    }
  }
);

registerRoute({
  method: "post",
  path: "/admin/users/{id}/ban",
  summary: "Ban user",
  tags: ["Admin"],
  params: z.object({ id: zId })
});
app.post(
  "/admin/users/:id/ban",
  authenticate,
  requireAdmin,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  withIdempotency("admin_ban", async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        "SELECT id, points, is_banned AS isBanned FROM users WHERE id = ? FOR UPDATE",
        [userId]
      );
      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "User not found." });
      }
      const target = rows[0];
      if (await isUserInRole(userId, "super_admin", connection)) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot ban super admin." });
      }
      if (await isUserInRole(userId, "admin", connection)) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot ban admins." });
      }
      if (target.isBanned) {
        await connection.rollback();
        return res.json({ ok: true, userId, alreadyBanned: true });
      }

      const superAdminId = await requireSuperAdminId(connection);
      if (Number(superAdminId) === Number(userId)) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot ban super admin." });
      }

      const pointsToTransfer = Number(target.points) || 0;
      if (pointsToTransfer > 0) {
        await transferPoints(connection, {
          fromUserId: userId,
          toUserId: superAdminId,
          amount: pointsToTransfer,
          actorUserId: req.user.id,
          action: "ban_transfer",
          reason: "ban_transfer",
          relatedEntityType: "user",
          relatedEntityId: userId,
          metadata: { transferredPoints: pointsToTransfer }
        });
      }

      await connection.query(
        "UPDATE users SET is_banned = 1, banned_at = NOW() WHERE id = ?",
        [userId]
      );

      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_ban",
        reason: "ban_user",
        relatedEntityType: "user",
        relatedEntityId: userId,
        metadata: { transferredPoints: pointsToTransfer, superAdminId }
      });

      await connection.commit();
      return res.json({
        ok: true,
        userId,
        transferredPoints: pointsToTransfer,
        superAdminId
      });
    } catch (error) {
      await connection.rollback();
      console.error("Ban user error", error);
      return res.status(500).json({ ok: false, message: "Failed to ban user." });
    } finally {
      connection.release();
    }
  })
);

registerRoute({
  method: "post",
  path: "/admin/users/{id}/unban",
  summary: "Unban user",
  tags: ["Admin"],
  params: z.object({ id: zId })
});
app.post(
  "/admin/users/:id/unban",
  authenticate,
  requireAdmin,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        "SELECT id, is_banned AS isBanned FROM users WHERE id = ? FOR UPDATE",
        [userId]
      );
      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "User not found." });
      }
      const target = rows[0];
      if (await isUserInRole(userId, "super_admin", connection)) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Super admin cannot be unbanned." });
      }
      if (!target.isBanned) {
        await connection.rollback();
        return res.json({ ok: true, userId, alreadyUnbanned: true });
      }

      await connection.query(
        "UPDATE users SET is_banned = 0, banned_at = NULL WHERE id = ?",
        [userId]
      );

      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_unban",
        reason: "unban_user",
        relatedEntityType: "user",
        relatedEntityId: userId
      });

      await connection.commit();
      return res.json({ ok: true, userId, isBanned: false });
    } catch (error) {
      await connection.rollback();
      console.error("Unban user error", error);
      return res.status(500).json({ ok: false, message: "Failed to unban user." });
    } finally {
      connection.release();
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/users",
  summary: "List users",
  tags: ["Admin"],
  query: z.object({
    limit: zLongLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["created_at", "points", "email", "name"]).optional(),
    order: zSortOrder.optional(),
    search: zSearch
  })
});
app.get(
  "/admin/users",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLongLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["created_at", "points", "email", "name"]).optional(),
        order: zSortOrder.optional(),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    try {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "created_at";
      const order = req.query.order || "desc";
      const search = req.query.search;
      const sortMap = {
        created_at: "created_at",
        points: "points",
        email: "email",
        name: "name"
      };
      const sortColumn = sortMap[sortKey] || "created_at";
      const orderSql = order === "asc" ? "ASC" : "DESC";

      const clauses = [];
      const params = [];
      if (search) {
        clauses.push("(email LIKE ? OR name LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const [rows] = await dbPool.query(
        `SELECT u.id, u.email, u.name, u.points,
                EXISTS(
                  SELECT 1
                  FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = 'admin'
                ) AS isAdmin,
                EXISTS(
                  SELECT 1
                  FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = 'super_admin'
                ) AS isSuperAdmin,
                u.is_banned AS isBanned,
                u.banned_at AS bannedAt,
                u.created_at AS createdAt,
                u.updated_at AS updatedAt
         FROM users u
         ${where}
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "admin_list_users",
        reason: "list_users",
        metadata: { limit, offset, sort: sortColumn, order: orderSql, search }
      });
      return res.json({ ok: true, users: rows });
    } catch (error) {
      console.error("List users error", error);
      return res.status(500).json({ ok: false, message: "Failed to list users." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/users/banned",
  summary: "List banned users",
  tags: ["Admin"],
  query: z.object({
    limit: zLongLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["banned_at", "created_at", "email", "name"]).optional(),
    order: zSortOrder.optional(),
    search: zSearch
  })
});
app.get(
  "/admin/users/banned",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLongLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["banned_at", "created_at", "email", "name"]).optional(),
        order: zSortOrder.optional(),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    try {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "banned_at";
      const order = req.query.order || "desc";
      const search = req.query.search;
      const sortMap = {
        banned_at: "banned_at",
        created_at: "created_at",
        email: "email",
        name: "name"
      };
      const sortColumn = sortMap[sortKey] || "banned_at";
      const orderSql = order === "asc" ? "ASC" : "DESC";
      const clauses = ["is_banned = 1"];
      const params = [];
      if (search) {
        clauses.push("(email LIKE ? OR name LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await dbPool.query(
        `SELECT u.id, u.email, u.name, u.points,
                EXISTS(
                  SELECT 1
                  FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = 'admin'
                ) AS isAdmin,
                EXISTS(
                  SELECT 1
                  FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = 'super_admin'
                ) AS isSuperAdmin,
                u.is_banned AS isBanned,
                u.banned_at AS bannedAt,
                u.created_at AS createdAt,
                u.updated_at AS updatedAt
         FROM users u
         ${where}
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "admin_list_banned",
        reason: "list_banned_users",
        metadata: { limit, offset, sort: sortColumn, order: orderSql, search }
      });
      return res.json({ ok: true, users: rows });
    } catch (error) {
      console.error("List banned users error", error);
      return res.status(500).json({ ok: false, message: "Failed to list banned users." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/users/{id}/logs",
  summary: "Get user audit logs",
  tags: ["Admin", "Audit"],
  params: z.object({ id: zId }),
  query: z.object({
    limit: zLongLimit.optional(),
    offset: zOffset.optional(),
    scope: z.enum(["actor", "target", "all"]).optional(),
    sort: z.enum(["id", "created_at"]).optional(),
    order: zSortOrder.optional(),
    action: zOptionalString(160),
    search: zSearch
  })
});
app.get(
  "/admin/users/:id/logs",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLongLimit.optional(),
        offset: zOffset.optional(),
        scope: z.enum(["actor", "target", "all"]).optional(),
        sort: z.enum(["id", "created_at"]).optional(),
        order: zSortOrder.optional(),
        action: zOptionalString(160),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }
    try {
      const limit = req.query.limit ?? 200;
      const offset = req.query.offset ?? 0;
      const scope = req.query.scope ? String(req.query.scope).trim().toLowerCase() : "all";
      const sortKey = req.query.sort || "id";
      const order = req.query.order || "desc";
      const search = req.query.search;
      const action = req.query.action ? String(req.query.action).trim() : null;
      const sortMap = {
        id: "id",
        created_at: "created_at"
      };
      const sortColumn = sortMap[sortKey] || "id";
      const orderSql = order === "asc" ? "ASC" : "DESC";

      const clauses = [];
      const params = [];
      if (scope === "actor") {
        clauses.push("actor_user_id = ?");
        params.push(userId);
      } else if (scope === "target") {
        clauses.push("target_user_id = ?");
        params.push(userId);
      } else {
        clauses.push("(actor_user_id = ? OR target_user_id = ?)");
        params.push(userId, userId);
      }
      if (action) {
        clauses.push("action = ?");
        params.push(action);
      }
      if (search) {
        clauses.push("(action LIKE ? OR reason LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const [rows] = await dbPool.query(
        `SELECT id, actor_user_id AS actorUserId, target_user_id AS targetUserId, action, reason, points_delta AS pointsDelta,
                points_before AS pointsBefore, points_after AS pointsAfter, related_entity_type AS relatedEntityType,
                related_entity_id AS relatedEntityId, metadata, created_at AS createdAt
         FROM audit_logs
         ${where}
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_get_user_logs",
        reason: "get_user_logs",
        metadata: { scope, limit, offset, sort: sortColumn, order: orderSql, search, action }
      });
      return res.json({ ok: true, logs: rows });
    } catch (error) {
      console.error("Get user logs error", error);
      return res.status(500).json({ ok: false, message: "Failed to fetch user logs." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/users/{id}/devices",
  summary: "List user devices",
  tags: ["Admin"],
  params: z.object({ id: zId }),
  query: z.object({ limit: zLimit.optional(), offset: zOffset.optional() }),
  responses: {
    200: {
      description: "Devices",
      content: { "application/json": { schema: AdminDeviceListSchema } }
    }
  }
});
app.get(
  "/admin/users/:id/devices",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      body: z.object({}).default({}),
      query: z.object({ limit: zLimit.optional(), offset: zOffset.optional() })
    })
  ),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }
    try {
      const limit = req.query.limit ?? 50;
      const offset = req.query.offset ?? 0;
      const [rows] = await dbPool.query(
        `SELECT d.id,
                d.fingerprint,
                d.user_agent AS userAgent,
                d.last_ip AS lastIp,
                d.first_seen AS firstSeen,
                d.last_seen AS lastSeen,
                d.revoked_at AS revokedAt,
                d.revoked_by AS revokedBy,
                (
                  SELECT COUNT(*)
                  FROM refresh_tokens rt
                  WHERE rt.user_id = d.user_id
                    AND rt.device_id = d.id
                    AND rt.revoked_at IS NULL
                    AND rt.expires_at > NOW()
                ) AS activeSessions
         FROM user_devices d
         WHERE d.user_id = ?
         ORDER BY d.last_seen DESC
         LIMIT ? OFFSET ?`,
        [userId, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_list_devices",
        reason: "list_devices",
        metadata: { limit, offset }
      });
      return res.json({ ok: true, devices: rows });
    } catch (error) {
      console.error("List devices error", error);
      return res.status(500).json({ ok: false, message: "Failed to list devices." });
    }
  }
);

registerRoute({
  method: "delete",
  path: "/admin/users/{id}/devices/{deviceId}",
  summary: "Revoke user device",
  tags: ["Admin"],
  params: z.object({ id: zId, deviceId: zId })
});
app.delete(
  "/admin/users/:id/devices/:deviceId",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId, deviceId: zId }),
      query: z.object({}),
      body: z.object({}).default({})
    })
  ),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    const deviceId = parsePositiveInt(req.params.deviceId);
    if (!userId || !deviceId) {
      return res.status(400).json({ ok: false, message: "Invalid user or device id." });
    }
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [deviceRows] = await connection.query(
        "SELECT id, revoked_at AS revokedAt FROM user_devices WHERE id = ? AND user_id = ? FOR UPDATE",
        [deviceId, userId]
      );
      if (!deviceRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Device not found." });
      }
      if (!req.user.isSuperAdmin && (await isUserInRole(userId, "super_admin", connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot revoke super admin devices." });
      }
      const alreadyRevoked = Boolean(deviceRows[0].revokedAt);
      await connection.query(
        "UPDATE user_devices SET revoked_at = COALESCE(revoked_at, NOW()), revoked_by = ? WHERE id = ? AND user_id = ?",
        [req.user.id, deviceId, userId]
      );
      const [sessionResult] = await connection.query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL",
        [userId, deviceId]
      );
      const revokedSessions = Number(sessionResult.affectedRows || 0);
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_device_revoke",
        reason: "revoke_device",
        relatedEntityType: "user_device",
        relatedEntityId: deviceId,
        metadata: { revokedSessions, alreadyRevoked }
      });
      await connection.commit();
      return res.json({ ok: true, deviceId, revokedSessions, alreadyRevoked });
    } catch (error) {
      await connection.rollback();
      console.error("Revoke device error", error);
      return res.status(500).json({ ok: false, message: "Failed to revoke device." });
    } finally {
      connection.release();
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/users/{id}/sessions",
  summary: "List user sessions",
  tags: ["Admin"],
  params: z.object({ id: zId }),
  query: z.object({ limit: zLimit.optional(), offset: zOffset.optional() }),
  responses: {
    200: {
      description: "Sessions",
      content: { "application/json": { schema: AdminSessionListSchema } }
    }
  }
});
app.get(
  "/admin/users/:id/sessions",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      body: z.object({}).default({}),
      query: z.object({ limit: zLimit.optional(), offset: zOffset.optional() })
    })
  ),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) {
      return res.status(400).json({ ok: false, message: "Invalid user id." });
    }
    try {
      const limit = req.query.limit ?? 50;
      const offset = req.query.offset ?? 0;
      const [rows] = await dbPool.query(
        `SELECT rt.id,
                rt.device_id AS deviceId,
                rt.created_at AS createdAt,
                rt.last_used_at AS lastUsedAt,
                rt.revoked_at AS revokedAt,
                rt.expires_at AS expiresAt,
                (rt.revoked_at IS NULL AND rt.expires_at > NOW()) AS isActive,
                d.user_agent AS userAgent,
                d.last_ip AS lastIp
         FROM refresh_tokens rt
         LEFT JOIN user_devices d ON d.id = rt.device_id
         WHERE rt.user_id = ?
         ORDER BY rt.created_at DESC
         LIMIT ? OFFSET ?`,
        [userId, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_list_sessions",
        reason: "list_sessions",
        metadata: { limit, offset }
      });
      return res.json({ ok: true, sessions: rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) })) });
    } catch (error) {
      console.error("List sessions error", error);
      return res.status(500).json({ ok: false, message: "Failed to list sessions." });
    }
  }
);

registerRoute({
  method: "delete",
  path: "/admin/users/{id}/sessions/{sessionId}",
  summary: "Revoke user session",
  tags: ["Admin"],
  params: z.object({ id: zId, sessionId: zId })
});
app.delete(
  "/admin/users/:id/sessions/:sessionId",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId, sessionId: zId }),
      query: z.object({}),
      body: z.object({}).default({})
    })
  ),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    const sessionId = parsePositiveInt(req.params.sessionId);
    if (!userId || !sessionId) {
      return res.status(400).json({ ok: false, message: "Invalid user or session id." });
    }
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      if (!req.user.isSuperAdmin && (await isUserInRole(userId, "super_admin", connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot revoke super admin sessions." });
      }
      const [result] = await connection.query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ? AND user_id = ?",
        [sessionId, userId]
      );
      if (!result.affectedRows) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Session not found." });
      }
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_session_revoke",
        reason: "revoke_session",
        relatedEntityType: "refresh_token",
        relatedEntityId: sessionId
      });
      await connection.commit();
      return res.json({ ok: true, sessionId });
    } catch (error) {
      await connection.rollback();
      console.error("Revoke session error", error);
      return res.status(500).json({ ok: false, message: "Failed to revoke session." });
    } finally {
      connection.release();
    }
  }
);

registerRoute({
  method: "post",
  path: "/admin/users/{id}/reset-password",
  summary: "Reset user password",
  tags: ["Admin"],
  params: z.object({ id: zId }),
  body: z.object({ newPassword: z.string().min(6).max(200) })
});
app.post(
  "/admin/users/:id/reset-password",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ newPassword: z.string().min(6).max(200) })
    })
  ),
  async (req, res) => {
    const userId = parsePositiveInt(req.params.id);
    const { newPassword } = req.body || {};
    if (!userId || !newPassword) {
      return res.status(400).json({ ok: false, message: "User id and newPassword are required." });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ ok: false, message: "Password must be at least 6 characters." });
    }
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        "SELECT id FROM users WHERE id = ? FOR UPDATE",
        [userId]
      );
      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "User not found." });
      }
      if (!req.user.isSuperAdmin && (await isUserInRole(userId, "super_admin", connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot reset super admin password." });
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await connection.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
      await connection.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?", [userId]);
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "admin_reset_password",
        reason: "reset_password"
      });
      await connection.commit();
      return res.json({ ok: true, userId });
    } catch (error) {
      await connection.rollback();
      console.error("Reset password error", error);
      return res.status(500).json({ ok: false, message: "Failed to reset password." });
    } finally {
      connection.release();
    }
  }
);

// Admin group management.
registerRoute({
  method: "post",
  path: "/admin/groups",
  summary: "Create group",
  tags: ["Admin", "Groups"],
  body: z.object({
    name: z.string().trim().min(1).max(160),
    description: zNullableString(500),
    isPrivate: zBooleanString.optional()
  })
});
app.post(
  "/admin/groups",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        name: z.string().trim().min(1).max(160),
        description: zNullableString(500),
        isPrivate: zBooleanString.optional()
      })
    })
  ),
  async (req, res) => {
    const name = req.body?.name ? String(req.body.name).trim() : "";
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const isPrivateInput = req.body?.isPrivate;
    const isPrivate = isPrivateInput === undefined ? 1 : isPrivateInput ? 1 : 0;
    if (!name) {
      return res.status(400).json({ ok: false, message: "Group name is required." });
    }
    try {
      const [result] = await dbPool.query(
        "INSERT INTO user_groups (name, description, is_private, created_by) VALUES (?, ?, ?, ?)",
        [name, description || null, isPrivate, req.user.id]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "group_create",
        reason: "group_create",
        relatedEntityType: "group",
        relatedEntityId: result.insertId
      });
      return res.status(201).json({ ok: true, groupId: result.insertId });
    } catch (error) {
      console.error("Create group error", error);
      return res.status(500).json({ ok: false, message: "Failed to create group." });
    }
  }
);

registerRoute({
  method: "patch",
  path: "/admin/groups/{id}",
  summary: "Update group",
  tags: ["Admin", "Groups"],
  params: z.object({ id: zId }),
  body: z.object({
    name: zOptionalString(160),
    description: zNullableString(500),
    isPrivate: zBooleanString.optional()
  })
});
app.patch(
  "/admin/groups/:id",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({
        name: zOptionalString(160),
        description: zNullableString(500),
        isPrivate: zBooleanString.optional()
      })
    })
  ),
  async (req, res) => {
    const groupId = parsePositiveInt(req.params.id);
    if (!groupId) {
      return res.status(400).json({ ok: false, message: "Invalid group id." });
    }
    const updates = [];
    const values = [];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) {
        return res.status(400).json({ ok: false, message: "name cannot be empty." });
      }
      updates.push("name = ?");
      values.push(name);
    }
    if (req.body?.description !== undefined) {
      const description = req.body.description ? String(req.body.description).trim() : null;
      updates.push("description = ?");
      values.push(description);
    }
    if (req.body?.isPrivate !== undefined) {
      updates.push("is_private = ?");
      values.push(req.body.isPrivate ? 1 : 0);
    }
    if (!updates.length) {
      return res.status(400).json({ ok: false, message: "No fields provided." });
    }
    try {
      const [result] = await dbPool.query(
        `UPDATE user_groups SET ${updates.join(", ")} WHERE id = ?`,
        [...values, groupId]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ ok: false, message: "Group not found." });
      }
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "group_update",
        reason: "group_update",
        relatedEntityType: "group",
        relatedEntityId: groupId,
        metadata: { fields: updates }
      });
      return res.json({ ok: true, groupId });
    } catch (error) {
      console.error("Update group error", error);
      return res.status(500).json({ ok: false, message: "Failed to update group." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/groups",
  summary: "List groups",
  tags: ["Admin", "Groups"],
  query: z.object({
    limit: zLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["name", "created_at"]).optional(),
    order: zSortOrder.optional(),
    search: zSearch
  })
});
app.get(
  "/admin/groups",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["name", "created_at"]).optional(),
        order: zSortOrder.optional(),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    try {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "name";
      const order = req.query.order || "asc";
      const search = req.query.search;
      const sortMap = {
        name: "name",
        created_at: "created_at"
      };
      const sortColumn = sortMap[sortKey] || "name";
      const orderSql = order === "asc" ? "ASC" : "DESC";
      const clauses = [];
      const params = [];
      if (search) {
        clauses.push("(name LIKE ? OR description LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await dbPool.query(
        `SELECT id, name, description, is_private AS isPrivate, created_by AS createdBy, created_at AS createdAt
         FROM user_groups
         ${where}
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "group_list",
        reason: "group_list",
        metadata: { count: rows.length, limit, offset, sort: sortColumn, order: orderSql, search }
      });
      return res.json({ ok: true, groups: rows });
    } catch (error) {
      console.error("List groups error", error);
      return res.status(500).json({ ok: false, message: "Failed to list groups." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/groups/{id}/members",
  summary: "List group members",
  tags: ["Admin", "Groups"],
  params: z.object({ id: zId }),
  query: z.object({
    limit: zLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["joined_at", "email", "name"]).optional(),
    order: zSortOrder.optional(),
    search: zSearch
  })
});
app.get(
  "/admin/groups/:id/members",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["joined_at", "email", "name"]).optional(),
        order: zSortOrder.optional(),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    const groupId = parsePositiveInt(req.params.id);
    if (!groupId) {
      return res.status(400).json({ ok: false, message: "Invalid group id." });
    }
    try {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "joined_at";
      const order = req.query.order || "desc";
      const search = req.query.search;
      const sortMap = {
        joined_at: "gm.created_at",
        email: "u.email",
        name: "u.name"
      };
      const sortColumn = sortMap[sortKey] || "gm.created_at";
      const orderSql = order === "asc" ? "ASC" : "DESC";

      const clauses = ["gm.group_id = ?"];
      const params = [groupId];
      if (search) {
        clauses.push("(u.email LIKE ? OR u.name LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await dbPool.query(
        `SELECT gm.user_id AS userId, gm.role, gm.created_at AS joinedAt,
                u.email, u.name,
                EXISTS(
                  SELECT 1
                  FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = 'admin'
                ) AS isAdmin,
                EXISTS(
                  SELECT 1
                  FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = 'super_admin'
                ) AS isSuperAdmin
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         ${where}
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "group_list_members",
        reason: "group_list_members",
        relatedEntityType: "group",
        relatedEntityId: groupId,
        metadata: { limit, offset, sort: sortColumn, order: orderSql, search }
      });
      return res.json({ ok: true, members: rows });
    } catch (error) {
      console.error("List group members error", error);
      return res.status(500).json({ ok: false, message: "Failed to list group members." });
    }
  }
);

registerRoute({
  method: "post",
  path: "/admin/groups/{id}/members",
  summary: "Add group member",
  tags: ["Admin", "Groups"],
  params: z.object({ id: zId }),
  body: z.object({
    userId: zId,
    role: zGroupRole.optional()
  })
});
app.post(
  "/admin/groups/:id/members",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({
        userId: zId,
        role: zGroupRole.optional()
      })
    })
  ),
  async (req, res) => {
    const groupId = parsePositiveInt(req.params.id);
    const userId = parsePositiveInt(req.body?.userId);
    const role = req.body?.role ? String(req.body.role).trim() : "member";
    if (!groupId || !userId) {
      return res.status(400).json({ ok: false, message: "groupId and userId are required." });
    }
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [groupRows] = await connection.query("SELECT id FROM user_groups WHERE id = ? FOR UPDATE", [groupId]);
      if (!groupRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Group not found." });
      }
      const [userRows] = await connection.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
      if (!userRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "User not found." });
      }
      const [existing] = await connection.query(
        "SELECT id FROM group_members WHERE group_id = ? AND user_id = ?",
        [groupId, userId]
      );
      if (existing.length) {
        await connection.rollback();
        return res.status(409).json({ ok: false, message: "User already in group." });
      }
      await connection.query(
        "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)",
        [groupId, userId, role || "member"]
      );
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "group_add_member",
        reason: "group_add_member",
        relatedEntityType: "group",
        relatedEntityId: groupId,
        metadata: { role }
      });
      await connection.commit();
      return res.status(201).json({ ok: true, groupId, userId });
    } catch (error) {
      await connection.rollback();
      console.error("Add group member error", error);
      return res.status(500).json({ ok: false, message: "Failed to add group member." });
    } finally {
      connection.release();
    }
  }
);

registerRoute({
  method: "post",
  path: "/admin/groups/{id}/members/batch",
  summary: "Batch add group members",
  tags: ["Admin", "Groups"],
  params: z.object({ id: zId }),
  body: z.object({
    role: zGroupRole.optional(),
    userIds: z.array(zId).max(500).optional(),
    users: z.array(zId).max(500).optional()
  })
});
app.post(
  "/admin/groups/:id/members/batch",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({
        role: zGroupRole.optional(),
        userIds: z.array(zId).max(500).optional(),
        users: z.array(zId).max(500).optional()
      })
        .refine((data) => Array.isArray(data.userIds) || Array.isArray(data.users), {
          message: "userIds array is required."
        })
    })
  ),
  async (req, res) => {
    const groupId = parsePositiveInt(req.params.id);
    const role = req.body?.role ? String(req.body.role).trim() : "member";
    const userIdsRaw = Array.isArray(req.body?.userIds) ? req.body.userIds : req.body?.users;
    if (!groupId) {
      return res.status(400).json({ ok: false, message: "Invalid group id." });
    }
    if (!Array.isArray(userIdsRaw)) {
      return res.status(400).json({ ok: false, message: "userIds array is required." });
    }
    const uniqueIds = Array.from(new Set(userIdsRaw.map(parsePositiveInt).filter(Boolean)));
    if (!uniqueIds.length) {
      return res.status(400).json({ ok: false, message: "No valid user ids provided." });
    }
    if (uniqueIds.length > 500) {
      return res.status(400).json({ ok: false, message: "Too many user ids (max 500)." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [groupRows] = await connection.query("SELECT id FROM user_groups WHERE id = ? FOR UPDATE", [groupId]);
      if (!groupRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Group not found." });
      }

      const [validUserRows] = await connection.query(
        `SELECT id FROM users WHERE id IN (${uniqueIds.map(() => "?").join(",")})`,
        uniqueIds
      );
      const validIds = new Set(validUserRows.map((row) => Number(row.id)));
      const invalidUserIds = uniqueIds.filter((id) => !validIds.has(id));

      if (!validIds.size) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "No valid users found.", invalidUserIds });
      }

      const validIdList = Array.from(validIds);
      const [existingRows] = await connection.query(
        `SELECT user_id AS userId FROM group_members WHERE group_id = ? AND user_id IN (${validIdList.map(() => "?").join(",")})`,
        [groupId, ...validIdList]
      );
      const existingIds = new Set(existingRows.map((row) => Number(row.userId)));
      const toAdd = validIdList.filter((id) => !existingIds.has(id));

      if (toAdd.length) {
        const insertValues = toAdd.map((userId) => [groupId, userId, role || "member"]);
        await connection.query(
          "INSERT INTO group_members (group_id, user_id, role) VALUES ?",
          [insertValues]
        );
      }

      await logAudit(connection, {
        actorUserId: req.user.id,
        action: "group_add_member_batch",
        reason: "group_add_member_batch",
        relatedEntityType: "group",
        relatedEntityId: groupId,
        metadata: {
          addedCount: toAdd.length,
          skippedCount: existingIds.size,
          invalidCount: invalidUserIds.length,
          role
        }
      });
      await connection.commit();

      return res.status(201).json({
        ok: true,
        groupId,
        addedUserIds: toAdd,
        skippedUserIds: Array.from(existingIds),
        invalidUserIds
      });
    } catch (error) {
      await connection.rollback();
      console.error("Batch add group members error", error);
      return res.status(500).json({ ok: false, message: "Failed to add members." });
    } finally {
      connection.release();
    }
  }
);

registerRoute({
  method: "delete",
  path: "/admin/groups/{id}/members/{userId}",
  summary: "Remove group member",
  tags: ["Admin", "Groups"],
  params: z.object({ id: zId, userId: zId })
});
app.delete(
  "/admin/groups/:id/members/:userId",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId, userId: zId }),
      query: z.object({}),
      body: z.object({}).default({})
    })
  ),
  async (req, res) => {
    const groupId = parsePositiveInt(req.params.id);
    const userId = parsePositiveInt(req.params.userId);
    if (!groupId || !userId) {
      return res.status(400).json({ ok: false, message: "Invalid groupId or userId." });
    }
    try {
      const [result] = await dbPool.query(
        "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
        [groupId, userId]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ ok: false, message: "Membership not found." });
      }
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "group_remove_member",
        reason: "group_remove_member",
        relatedEntityType: "group",
        relatedEntityId: groupId
      });
      return res.json({ ok: true, groupId, userId });
    } catch (error) {
      console.error("Remove group member error", error);
      return res.status(500).json({ ok: false, message: "Failed to remove group member." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/logs",
  summary: "List audit logs",
  tags: ["Admin", "Audit"],
  query: z.object({
    limit: zLongLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["id", "created_at", "points_delta"]).optional(),
    order: zSortOrder.optional(),
    action: zOptionalString(160),
    search: zSearch,
    actorUserId: zOptionalId,
    targetUserId: zOptionalId,
    relatedEntityType: zOptionalString(64),
    relatedEntityId: zOptionalId
  })
});
app.get(
  "/admin/logs",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLongLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["id", "created_at", "points_delta"]).optional(),
        order: zSortOrder.optional(),
        action: zOptionalString(160),
        search: zSearch,
        actorUserId: zOptionalId,
        targetUserId: zOptionalId,
        relatedEntityType: zOptionalString(64),
        relatedEntityId: zOptionalId
      })
    })
  ),
  async (req, res) => {
    try {
      const limit = req.query.limit ?? 200;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "id";
      const order = req.query.order || "desc";
      const action = req.query.action ? String(req.query.action).trim() : null;
      const search = req.query.search;
      const actorUserId = parsePositiveInt(req.query.actorUserId);
      const targetUserId = parsePositiveInt(req.query.targetUserId);
      const relatedEntityType = req.query.relatedEntityType ? String(req.query.relatedEntityType).trim() : null;
      const relatedEntityId = parsePositiveInt(req.query.relatedEntityId);
      const sortMap = {
        id: "id",
        created_at: "created_at",
        points_delta: "points_delta"
      };
      const sortColumn = sortMap[sortKey] || "id";
      const orderSql = order === "asc" ? "ASC" : "DESC";

      const clauses = [];
      const values = [];
      if (action) {
        clauses.push("action = ?");
        values.push(action);
      }
      if (search) {
        clauses.push("(action LIKE ? OR reason LIKE ?)");
        const like = `%${search}%`;
        values.push(like, like);
      }
      if (actorUserId) {
        clauses.push("actor_user_id = ?");
        values.push(actorUserId);
      }
      if (targetUserId) {
        clauses.push("target_user_id = ?");
        values.push(targetUserId);
      }
      if (relatedEntityType) {
        clauses.push("related_entity_type = ?");
        values.push(relatedEntityType);
      }
      if (relatedEntityId) {
        clauses.push("related_entity_id = ?");
        values.push(relatedEntityId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const [rows] = await dbPool.query(
        `SELECT id, actor_user_id AS actorUserId, target_user_id AS targetUserId, action, reason, points_delta AS pointsDelta,
                points_before AS pointsBefore, points_after AS pointsAfter, related_entity_type AS relatedEntityType,
                related_entity_id AS relatedEntityId, metadata, created_at AS createdAt
         FROM audit_logs
         ${where}
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [...values, limit, offset]
      );

      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "admin_list_logs",
        reason: "list_logs",
        metadata: {
          limit,
          offset,
          sort: sortColumn,
          order: orderSql,
          action,
          search,
          actorUserId,
          targetUserId,
          relatedEntityType,
          relatedEntityId
        }
      });

      return res.json({ ok: true, logs: rows });
    } catch (error) {
      console.error("List logs error", error);
      return res.status(500).json({ ok: false, message: "Failed to list logs." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/admin/fees/summary",
  summary: "Get fee summary",
  tags: ["Admin", "Audit"],
  query: z.object({
    from: zOptionalString(64),
    to: zOptionalString(64)
  })
});
app.get(
  "/admin/fees/summary",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({ from: zOptionalString(64), to: zOptionalString(64) })
    })
  ),
  async (req, res) => {
    try {
      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;
      const clauses = ["action LIKE 'fee_%'"];
      const values = [];
      if (from && !Number.isNaN(from.getTime())) {
        clauses.push("created_at >= ?");
        values.push(from);
      }
      if (to && !Number.isNaN(to.getTime())) {
        clauses.push("created_at <= ?");
        values.push(to);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await dbPool.query(
        `SELECT COALESCE(SUM(points_delta), 0) AS totalFees, COUNT(*) AS entries
         FROM audit_logs
         ${where}`,
        values
      );
      await logAudit(dbPool, {
        actorUserId: req.user.id,
        action: "admin_fee_summary",
        reason: "fee_summary",
        metadata: { from: req.query.from || null, to: req.query.to || null }
      });
      return res.json({ ok: true, totalFees: Number(rows[0].totalFees), entries: Number(rows[0].entries) });
    } catch (error) {
      console.error("Fees summary error", error);
      return res.status(500).json({ ok: false, message: "Failed to fetch fees summary." });
    }
  }
);

// Offer endpoints.
registerRoute({
  method: "post",
  path: "/offers",
  summary: "Create offer",
  tags: ["Offers"],
  body: z.object({
    title: z.string().trim().min(1).max(160),
    description: zNullableString(2000),
    pointsCost: zPositiveInt,
    maxAcceptances: zOptionalPositiveIntOrInfinity.optional(),
    groupId: zOptionalId.optional(),
    group_id: zOptionalId.optional()
  })
});
app.post(
  "/offers",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        title: z.string().trim().min(1).max(160),
        description: zNullableString(2000),
        pointsCost: zPositiveInt,
        maxAcceptances: zOptionalPositiveIntOrInfinity.optional(),
        groupId: zOptionalId.optional(),
        group_id: zOptionalId.optional()
      })
    })
  ),
  async (req, res) => {
  try {
    const { title, description, pointsCost, maxAcceptances } = req.body || {};
    const groupIdRaw = req.body?.groupId ?? req.body?.group_id;
    let groupId = null;
    const creatorId = req.user.id;
    const cost = parsePositiveInt(pointsCost);
    const { value: maxAcceptancesValue, valid: maxAcceptancesValid } =
      parseOptionalPositiveInt(maxAcceptances);

    if (!title || !cost) {
      return res.status(400).json({ ok: false, message: "title and pointsCost are required." });
    }
    if (!maxAcceptancesValid) {
      return res.status(400).json({ ok: false, message: "maxAcceptances must be a positive integer or omitted." });
    }

    if (groupIdRaw !== undefined && groupIdRaw !== null && groupIdRaw !== "") {
      groupId = parsePositiveInt(groupIdRaw);
      if (!groupId) {
        return res.status(400).json({ ok: false, message: "Invalid groupId." });
      }
      const group = await fetchGroupById(groupId);
      if (!group) {
        return res.status(404).json({ ok: false, message: "Group not found." });
      }
      if (!req.user.isAdmin && !(await isUserInGroup(req.user.id, groupId))) {
        return res.status(403).json({ ok: false, message: "Not a member of this group." });
      }
    }

    const [result] = await dbPool.query(
      "INSERT INTO offers (creator_user_id, group_id, title, description, points_cost, max_acceptances) VALUES (?, ?, ?, ?, ?, ?)",
      [
        creatorId,
        groupId,
        String(title).trim(),
        description ? String(description).trim() : null,
        cost,
        maxAcceptancesValue
      ]
    );

    const [rows] = await dbPool.query("SELECT * FROM offers WHERE id = ?", [result.insertId]);
    await logAudit(dbPool, {
      actorUserId: creatorId,
      targetUserId: creatorId,
      action: "offer_create",
      reason: "offer_create",
      relatedEntityType: "offer",
      relatedEntityId: result.insertId
    });
    return res.status(201).json({ ok: true, offer: serializeOffer(rows[0]) });
  } catch (error) {
    console.error("Create offer error", error);
    return res.status(500).json({ ok: false, message: "Failed to create offer." });
  }
  }
);

registerRoute({
  method: "get",
  path: "/offers",
  summary: "List offers",
  tags: ["Offers"],
  query: z.object({
    active: zBooleanString.optional(),
    limit: zLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["created_at", "points_cost", "accepted_count"]).optional(),
    order: zSortOrder.optional(),
    search: zSearch
  })
});
app.get(
  "/offers",
  optionalAuthenticate,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        active: zBooleanString.optional(),
        limit: zLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["created_at", "points_cost", "accepted_count"]).optional(),
        order: zSortOrder.optional(),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    try {
      const onlyActive = req.query.active !== undefined ? req.query.active : true;
      const limit = req.query.limit ?? 50;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "created_at";
      const order = req.query.order || "desc";
      const search = req.query.search;
      const sortMap = {
        created_at: "created_at",
        points_cost: "points_cost",
        accepted_count: "accepted_count"
      };
      const sortColumn = sortMap[sortKey] || "created_at";
      const orderSql = order === "asc" ? "ASC" : "DESC";

      const clauses = [];
      const params = [];
      if (onlyActive) {
        clauses.push("is_active = 1");
      }
      if (search) {
        clauses.push("(title LIKE ? OR description LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like);
      }
      if (!req.user) {
        clauses.push("group_id IS NULL");
      } else if (!req.user.isAdmin) {
        const groupIds = await fetchUserGroupIds(req.user.id);
        const filter = buildGroupAccessFilter(groupIds);
        clauses.push(`(${filter.clause})`);
        params.push(...filter.params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await dbPool.query(
        `SELECT * FROM offers ${where} ORDER BY ${sortColumn} ${orderSql} LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      return res.json({ ok: true, offers: rows.map(serializeOffer) });
    } catch (error) {
      console.error("List offers error", error);
      return res.status(500).json({ ok: false, message: "Failed to list offers." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/offers/{id}",
  summary: "Get offer",
  tags: ["Offers"],
  params: z.object({ id: zId }),
  query: z.object({})
});
app.get(
  "/offers/:id",
  optionalAuthenticate,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  if (!offerId) {
    return res.status(400).json({ ok: false, message: "Invalid offer id." });
  }
  try {
    const [rows] = await dbPool.query("SELECT * FROM offers WHERE id = ?", [offerId]);
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }
    const offer = rows[0];
    if (!(await canAccessGroupResource(offer.group_id, req.user))) {
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    return res.json({ ok: true, offer: serializeOffer(offer) });
  } catch (error) {
    console.error("Fetch offer error", error);
    return res.status(500).json({ ok: false, message: "Failed to fetch offer." });
  }
  }
);

registerRoute({
  method: "get",
  path: "/offers/{id}/acceptances",
  summary: "List offer acceptances",
  tags: ["Offers"],
  params: z.object({ id: zId }),
  query: z.object({})
});
app.get(
  "/offers/:id/acceptances",
  optionalAuthenticate,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  if (!offerId) {
    return res.status(400).json({ ok: false, message: "Invalid offer id." });
  }
  try {
    const [offerRows] = await dbPool.query("SELECT * FROM offers WHERE id = ?", [offerId]);
    if (!offerRows.length) {
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }
    const offer = offerRows[0];
    const canAccess = await canAccessGroupResource(offer.group_id, req.user);
    if (!canAccess && (!req.user || !req.user.isAdmin) && req.user?.id !== Number(offer.creator_user_id)) {
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    const [rows] = await dbPool.query(
      "SELECT id, offer_id AS offerId, accepter_user_id AS accepterUserId, points_cost AS pointsCost, created_at AS createdAt FROM offer_acceptances WHERE offer_id = ? ORDER BY created_at DESC",
      [offerId]
    );
    return res.json({ ok: true, acceptances: rows });
  } catch (error) {
    console.error("List acceptances error", error);
    return res.status(500).json({ ok: false, message: "Failed to list acceptances." });
  }
  }
);

registerRoute({
  method: "get",
  path: "/offers/{id}/reviews",
  summary: "List offer reviews",
  tags: ["Offers"],
  params: z.object({ id: zId }),
  query: z.object({ limit: zLimit.optional(), offset: zOffset.optional() })
});
app.get(
  "/offers/:id/reviews",
  optionalAuthenticate,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({ limit: zLimit.optional(), offset: zOffset.optional() }),
      body: z.object({}).default({}) })
  ),
  async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  if (!offerId) {
    return res.status(400).json({ ok: false, message: "Invalid offer id." });
  }
  try {
    const [offerRows] = await dbPool.query("SELECT * FROM offers WHERE id = ?", [offerId]);
    if (!offerRows.length) {
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }
    const offer = offerRows[0];
    if (!(await canAccessGroupResource(offer.group_id, req.user))) {
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    const limitRaw = parsePositiveInt(req.query.limit) || 50;
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Math.min(limitRaw, 200);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const [rows] = await dbPool.query(
      `SELECT id, offer_id AS offerId, reviewer_user_id AS reviewerUserId, rating, comment, created_at AS createdAt
       FROM offer_reviews
       WHERE offer_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [offerId, limit, offset]
    );
    return res.json({ ok: true, reviews: rows });
  } catch (error) {
    console.error("List reviews error", error);
    return res.status(500).json({ ok: false, message: "Failed to list reviews." });
  }
  }
);

registerRoute({
  method: "post",
  path: "/offers/{id}/reviews",
  summary: "Create offer review",
  tags: ["Offers"],
  params: z.object({ id: zId }),
  body: z.object({ rating: zPositiveInt, comment: zNullableString(500).optional() })
});
app.post(
  "/offers/:id/reviews",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ rating: zPositiveInt, comment: zNullableString(500).optional() })
    })
  ),
  async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  const rating = parsePositiveInt(req.body?.rating);
  const comment = req.body?.comment ? String(req.body.comment).trim() : null;
  if (!offerId || !rating) {
    return res.status(400).json({ ok: false, message: "offer id and rating are required." });
  }
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ ok: false, message: "rating must be between 1 and 5." });
  }
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [offerRows] = await connection.query("SELECT * FROM offers WHERE id = ? FOR UPDATE", [offerId]);
    if (!offerRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }
    const offer = offerRows[0];
    if (!(await canAccessGroupResource(offer.group_id, req.user, connection))) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    const [acceptanceRows] = await connection.query(
      "SELECT id FROM offer_acceptances WHERE offer_id = ? AND accepter_user_id = ?",
      [offerId, req.user.id]
    );
    if (!acceptanceRows.length) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Only buyers can leave reviews." });
    }
    const [existing] = await connection.query(
      "SELECT id FROM offer_reviews WHERE offer_id = ? AND reviewer_user_id = ?",
      [offerId, req.user.id]
    );
    if (existing.length) {
      await connection.rollback();
      return res.status(409).json({ ok: false, message: "Review already exists." });
    }
    const [result] = await connection.query(
      "INSERT INTO offer_reviews (offer_id, reviewer_user_id, rating, comment) VALUES (?, ?, ?, ?)",
      [offerId, req.user.id, rating, comment]
    );
    await logAudit(connection, {
      actorUserId: req.user.id,
      targetUserId: req.user.id,
      action: "offer_review_create",
      reason: "offer_review",
      relatedEntityType: "offer",
      relatedEntityId: offerId,
      metadata: { rating }
    });
    await connection.commit();
    return res.status(201).json({ ok: true, reviewId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error("Create review error", error);
    return res.status(500).json({ ok: false, message: "Failed to create review." });
  } finally {
    connection.release();
  }
  }
);

registerRoute({
  method: "post",
  path: "/offers/{id}/accept",
  summary: "Accept offer",
  tags: ["Offers"],
  params: z.object({ id: zId })
});
app.post(
  "/offers/:id/accept",
  authenticate,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  withIdempotency("offer_accept", async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  const accepterUserId = req.user.id;
  if (!offerId) {
    return res.status(400).json({ ok: false, message: "Offer id is required." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();

    const [offerRows] = await connection.query("SELECT * FROM offers WHERE id = ? FOR UPDATE", [offerId]);
    if (!offerRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }

    const offer = offerRows[0];
    if (!offer.is_active) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Offer is not active." });
    }
    if (!(await canAccessGroupResource(offer.group_id, req.user, connection))) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Access denied." });
    }

    if (offer.max_acceptances !== null && offer.accepted_count >= offer.max_acceptances) {
      await connection.rollback();
      return res.status(409).json({ ok: false, message: "Offer has reached its maximum acceptances." });
    }

    if (Number(offer.creator_user_id) === accepterUserId) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Creator cannot accept their own offer." });
    }

    const cost = Number(offer.points_cost);
    const fee = calculateFee(cost);
    const totalCost = cost + fee;
    let accepterPoints = null;
    let creatorPoints = null;
    try {
      const debitResult = await applyPointsDelta(connection, {
        userId: accepterUserId,
        delta: -totalCost,
        actorUserId: accepterUserId,
        action: "offer_accept_debit",
        reason: "offer_accept",
        relatedEntityType: "offer",
        relatedEntityId: offerId,
        metadata: { fee, cost }
      });
      accepterPoints = debitResult.after;
      const creditResult = await applyPointsDelta(connection, {
        userId: Number(offer.creator_user_id),
        delta: cost,
        actorUserId: accepterUserId,
        action: "offer_accept_credit",
        reason: "offer_accept",
        relatedEntityType: "offer",
        relatedEntityId: offerId
      });
      creatorPoints = creditResult.after;
    } catch (error) {
      await connection.rollback();
      if (error.message === "Insufficient points") {
        return res.status(400).json({ ok: false, message: "Insufficient points." });
      }
      throw error;
    }

    const newAcceptedCount = Number(offer.accepted_count) + 1;
    const stillActive = offer.max_acceptances === null ? 1 : Number(newAcceptedCount < offer.max_acceptances);

    await connection.query(
      "UPDATE offers SET accepted_count = ?, is_active = ? WHERE id = ?",
      [newAcceptedCount, stillActive, offerId]
    );

    await connection.query(
      "INSERT INTO offer_acceptances (offer_id, accepter_user_id, points_cost) VALUES (?, ?, ?)",
      [offerId, accepterUserId, cost]
    );

    await logAudit(connection, {
      actorUserId: accepterUserId,
      targetUserId: offer.creator_user_id,
      action: "offer_accept",
      reason: "offer_accept",
      relatedEntityType: "offer",
      relatedEntityId: offerId,
      metadata: { fee, totalCost, cost }
    });

    await creditFeeToSuperAdmin(connection, fee, {
      actorUserId: accepterUserId,
      action: "fee_offer_accept",
      reason: "offer_fee",
      relatedEntityType: "offer",
      relatedEntityId: offerId,
      metadata: { fee, cost }
    });

    await connection.commit();
    return res.json({
      ok: true,
      offerId,
      accepterUserId,
      cost,
      fee,
      totalCost,
      accepterPoints,
      creatorUserId: offer.creator_user_id,
      creatorPoints
    });
  } catch (error) {
    await connection.rollback();
    console.error("Accept offer error", error);
    return res.status(500).json({ ok: false, message: "Failed to accept offer." });
  } finally {
    connection.release();
  }
  })
);

registerRoute({
  method: "delete",
  path: "/admin/offers/{id}",
  summary: "Delete offer",
  tags: ["Admin"],
  params: z.object({ id: zId })
});
app.delete(
  "/admin/offers/:id",
  authenticate,
  requireAdmin,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  if (!offerId) {
    return res.status(400).json({ ok: false, message: "Invalid offer id." });
  }
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT creator_user_id AS creatorUserId FROM offers WHERE id = ? FOR UPDATE", [offerId]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }
    const creatorId = Number(rows[0].creatorUserId);
    if (!req.user.isSuperAdmin && (await isSuperAdminUserId(creatorId, connection))) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot modify super admin offers." });
    }
    await connection.query("DELETE FROM offers WHERE id = ?", [offerId]);
    await logAudit(connection, {
      actorUserId: req.user.id,
      targetUserId: creatorId,
      action: "offer_delete",
      reason: "offer_delete",
      relatedEntityType: "offer",
      relatedEntityId: offerId
    });
    await connection.commit();
    return res.json({ ok: true, offerId, deleted: true });
  } catch (error) {
    await connection.rollback();
    console.error("Delete offer error", error);
    return res.status(500).json({ ok: false, message: "Failed to delete offer." });
  } finally {
    connection.release();
  }
  }
);

registerRoute({
  method: "patch",
  path: "/admin/offers/{id}",
  summary: "Update offer",
  tags: ["Admin"],
  params: z.object({ id: zId }),
  body: z.object({
    title: zOptionalString(160),
    description: zNullableString(2000),
    pointsCost: zPositiveInt.optional(),
    maxAcceptances: zOptionalPositiveIntOrInfinity.optional(),
    isActive: zBooleanString.optional()
  })
});
app.patch(
  "/admin/offers/:id",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({
        title: zOptionalString(160),
        description: zNullableString(2000),
        pointsCost: zPositiveInt.optional(),
        maxAcceptances: zOptionalPositiveIntOrInfinity.optional(),
        isActive: zBooleanString.optional()
      })
    })
  ),
  async (req, res) => {
  const offerId = parsePositiveInt(req.params.id);
  if (!offerId) {
    return res.status(400).json({ ok: false, message: "Invalid offer id." });
  }
  const { title, description, pointsCost, maxAcceptances, isActive } = req.body || {};
  const updates = [];
  const values = [];

  if (title !== undefined) {
    const trimmed = String(title).trim();
    if (!trimmed) {
      return res.status(400).json({ ok: false, message: "title cannot be empty." });
    }
    updates.push("title = ?");
    values.push(trimmed);
  }

  if (description !== undefined) {
    updates.push("description = ?");
    values.push(description ? String(description).trim() : null);
  }

  if (pointsCost !== undefined) {
    const cost = parsePositiveInt(pointsCost);
    if (!cost) {
      return res.status(400).json({ ok: false, message: "pointsCost must be a positive integer." });
    }
    updates.push("points_cost = ?");
    values.push(cost);
  }

  if (maxAcceptances !== undefined) {
    const { value: maxValue, valid } = parseOptionalPositiveInt(maxAcceptances);
    if (!valid) {
      return res.status(400).json({ ok: false, message: "maxAcceptances must be a positive integer or null." });
    }
    updates.push("max_acceptances = ?");
    values.push(maxValue);
  }

  if (isActive !== undefined) {
    updates.push("is_active = ?");
    values.push(isActive ? 1 : 0);
  }

  if (!updates.length) {
    return res.status(400).json({ ok: false, message: "No valid fields provided." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [currentRows] = await connection.query("SELECT * FROM offers WHERE id = ? FOR UPDATE", [offerId]);
    if (!currentRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Offer not found." });
    }

    const current = currentRows[0];
    if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(current.creator_user_id), connection))) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot modify super admin offers." });
    }
    if (maxAcceptances !== undefined) {
      const maxIndex = updates.indexOf("max_acceptances = ?");
      const maxValue = maxIndex >= 0 ? values[maxIndex] : null;
      if (maxValue !== null && Number(current.accepted_count) > maxValue) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "maxAcceptances cannot be lower than accepted_count." });
      }
    }

    values.push(offerId);
    await connection.query(`UPDATE offers SET ${updates.join(", ")} WHERE id = ?`, values);
    const [rows] = await connection.query("SELECT * FROM offers WHERE id = ?", [offerId]);
    await logAudit(connection, {
      actorUserId: req.user.id,
      targetUserId: Number(current.creator_user_id),
      action: "offer_update",
      reason: "offer_update",
      relatedEntityType: "offer",
      relatedEntityId: offerId,
      metadata: { fields: updates }
    });
    await connection.commit();
    return res.json({ ok: true, offer: serializeOffer(rows[0]) });
  } catch (error) {
    await connection.rollback();
    console.error("Update offer error", error);
    return res.status(500).json({ ok: false, message: "Failed to update offer." });
  } finally {
    connection.release();
  }
  }
);

// Bets endpoints.
registerRoute({
  method: "post",
  path: "/bets",
  summary: "Create bet",
  tags: ["Bets"],
  body: z.object({
    title: z.string().trim().min(1).max(160),
    description: zNullableString(2000),
    details: zNullableString(4000),
    closesAt: zFutureDate,
    betType: z.enum(["boolean", "number", "multiple"]).optional(),
    groupId: zOptionalId.optional(),
    group_id: zOptionalId.optional(),
    options: z.array(
      z.object({
        label: z.string().trim().min(1).max(160),
        odds: zOdds.optional(),
        value: z.coerce.number().optional()
      })
    ).min(2)
  })
});
app.post(
  "/bets",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({}),
      query: z.object({}),
      body: z.object({
        title: z.string().trim().min(1).max(160),
        description: zNullableString(2000),
        details: zNullableString(4000),
        closesAt: zFutureDate,
        betType: z.enum(["boolean", "number", "multiple"]).optional(),
        groupId: zOptionalId.optional(),
        group_id: zOptionalId.optional(),
        options: z.array(
          z.object({
            label: z.string().trim().min(1).max(160),
            odds: zOdds.optional(),
            value: z.coerce.number().optional()
          })
        ).min(2)
      })
    })
  ),
  async (req, res) => {
  try {
    const { title, description, details, closesAt, betType, options } = req.body || {};
    const groupIdRaw = req.body?.groupId ?? req.body?.group_id;
    let groupId = null;
    const creatorId = req.user.id;
    const closeDate = parseFutureDate(closesAt);
    if (!title || !closeDate || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({
        ok: false,
        message: "title, closesAt (future date), and at least two options are required."
      });
    }

    const normalizedType = betType ? String(betType).trim().toLowerCase() : "multiple";
    const allowedTypes = new Set(["boolean", "number", "multiple"]);
    const finalType = allowedTypes.has(normalizedType) ? normalizedType : "multiple";

    const optionRows = [];
    for (const option of options) {
      const label = String(option?.label || "").trim();
      if (!label) {
        return res.status(400).json({ ok: false, message: "Each option must have a label." });
      }
      const oddsValue = parseOdds(option?.odds ?? 2.0);
      if (!oddsValue) {
        return res.status(400).json({ ok: false, message: "Each option must have valid odds >= 1.01." });
      }
      let numericValue = null;
      if (finalType === "number") {
        const numericInput = option?.value ?? label;
        const parsedNumeric = Number(numericInput);
        if (!Number.isFinite(parsedNumeric)) {
          return res.status(400).json({ ok: false, message: "Numeric bet options must include a number." });
        }
        numericValue = Number(parsedNumeric.toFixed(2));
      }
      optionRows.push({ label, oddsValue, numericValue });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      if (groupIdRaw !== undefined && groupIdRaw !== null && groupIdRaw !== "") {
        groupId = parsePositiveInt(groupIdRaw);
        if (!groupId) {
          await connection.rollback();
          return res.status(400).json({ ok: false, message: "Invalid groupId." });
        }
        const group = await fetchGroupById(groupId, connection);
        if (!group) {
          await connection.rollback();
          return res.status(404).json({ ok: false, message: "Group not found." });
        }
        if (!req.user.isAdmin && !(await isUserInGroup(req.user.id, groupId, connection))) {
          await connection.rollback();
          return res.status(403).json({ ok: false, message: "Not a member of this group." });
        }
      }
      const [result] = await connection.query(
        "INSERT INTO bets (creator_user_id, group_id, title, description, details, bet_type, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          creatorId,
          groupId,
          String(title).trim(),
          description ? String(description).trim() : null,
          details ? String(details).trim() : null,
          finalType,
          closeDate
        ]
      );

      const betId = result.insertId;
      for (const optionRow of optionRows) {
        await connection.query(
          "INSERT INTO bet_options (bet_id, label, numeric_value, current_odds) VALUES (?, ?, ?, ?)",
          [betId, optionRow.label, optionRow.numericValue, optionRow.oddsValue]
        );
      }

      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ?", [betId]);
      const [optionRowsDb] = await connection.query("SELECT * FROM bet_options WHERE bet_id = ?", [betId]);
      await logAudit(connection, {
        actorUserId: creatorId,
        targetUserId: creatorId,
        action: "bet_create",
        reason: "bet_create",
        relatedEntityType: "bet",
        relatedEntityId: betId
      });
      await connection.commit();

      return res.status(201).json({
        ok: true,
        bet: serializeBet(betRows[0], optionRowsDb.map(serializeBetOption))
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Create bet error", error);
    return res.status(500).json({ ok: false, message: "Failed to create bet." });
  }
  }
);

registerRoute({
  method: "get",
  path: "/bets",
  summary: "List bets",
  tags: ["Bets"],
  query: z.object({
    active: zBooleanString.optional(),
    limit: zLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["created_at", "closes_at"]).optional(),
    order: zSortOrder.optional(),
    search: zSearch
  })
});
app.get(
  "/bets",
  optionalAuthenticate,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        active: zBooleanString.optional(),
        limit: zLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["created_at", "closes_at"]).optional(),
        order: zSortOrder.optional(),
        search: zSearch
      })
    })
  ),
  async (req, res) => {
    try {
      const onlyActive = req.query.active !== undefined ? req.query.active : false;
      const limit = req.query.limit ?? 50;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "created_at";
      const order = req.query.order || "desc";
      const search = req.query.search;
      const sortMap = {
        created_at: "created_at",
        closes_at: "closes_at"
      };
      const sortColumn = sortMap[sortKey] || "created_at";
      const orderSql = order === "asc" ? "ASC" : "DESC";

      const clauses = [];
      const params = [];
      if (onlyActive) {
        clauses.push("status = 'open'");
      }
      if (search) {
        clauses.push("(title LIKE ? OR description LIKE ? OR details LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like, like);
      }
      if (!req.user) {
        clauses.push("group_id IS NULL");
      } else if (!req.user.isAdmin) {
        const groupIds = await fetchUserGroupIds(req.user.id);
        const filter = buildGroupAccessFilter(groupIds);
        clauses.push(`(${filter.clause})`);
        params.push(...filter.params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [bets] = await dbPool.query(
        `SELECT * FROM bets ${where} ORDER BY ${sortColumn} ${orderSql} LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      if (!bets.length) {
        return res.json({ ok: true, bets: [] });
      }
      const betIds = bets.map((bet) => bet.id);
      const [options] = await dbPool.query(
        `SELECT * FROM bet_options WHERE bet_id IN (${betIds.map(() => "?").join(",")})`,
        betIds
      );
      const optionsByBet = new Map();
      for (const option of options) {
        const betId = Number(option.bet_id);
        if (!optionsByBet.has(betId)) {
          optionsByBet.set(betId, []);
        }
        optionsByBet.get(betId).push(serializeBetOption(option));
      }

      if (req.user) {
        await logAudit(dbPool, {
          actorUserId: req.user.id,
          action: "bet_list",
          reason: "bet_list",
          metadata: { count: bets.length, limit, offset, sort: sortColumn, order: orderSql, search }
        });
      }
      return res.json({
        ok: true,
        bets: bets.map((bet) => serializeBet(bet, optionsByBet.get(Number(bet.id)) || []))
      });
    } catch (error) {
      console.error("List bets error", error);
      return res.status(500).json({ ok: false, message: "Failed to list bets." });
    }
  }
);

registerRoute({
  method: "get",
  path: "/bets/{id}",
  summary: "Get bet",
  tags: ["Bets"],
  params: z.object({ id: zId }),
  query: z.object({})
});
app.get(
  "/bets/:id",
  optionalAuthenticate,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  async (req, res) => {
  const betId = parsePositiveInt(req.params.id);
  if (!betId) {
    return res.status(400).json({ ok: false, message: "Invalid bet id." });
  }
  try {
    const [betRows] = await dbPool.query("SELECT * FROM bets WHERE id = ?", [betId]);
    if (!betRows.length) {
      return res.status(404).json({ ok: false, message: "Bet not found." });
    }
    const bet = betRows[0];
    if (!(await canAccessGroupResource(bet.group_id, req.user))) {
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    const [options] = await dbPool.query("SELECT * FROM bet_options WHERE bet_id = ?", [betId]);
    return res.json({ ok: true, bet: serializeBet(bet, options.map(serializeBetOption)) });
  } catch (error) {
    console.error("Fetch bet error", error);
    return res.status(500).json({ ok: false, message: "Failed to fetch bet." });
  }
  }
);

registerRoute({
  method: "post",
  path: "/bets/{id}/buy",
  summary: "Buy bet position",
  tags: ["Bets"],
  params: z.object({ id: zId }),
  body: z.object({ optionId: zPositiveInt, stakePoints: zPositiveInt.optional(), points: zPositiveInt.optional() })
});
app.post(
  "/bets/:id/buy",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ optionId: zPositiveInt, stakePoints: zPositiveInt.optional(), points: zPositiveInt.optional() })
    })
  ),
  withIdempotency("bet_buy", async (req, res) => {
    const betId = parsePositiveInt(req.params.id);
    const optionId = parsePositiveInt(req.body?.optionId);
    const stakePoints = parsePositiveInt(req.body?.stakePoints ?? req.body?.points);
    if (!betId || !optionId || !stakePoints) {
      return res.status(400).json({ ok: false, message: "bet id, optionId, and stakePoints are required." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();

      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
      if (!betRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      const bet = betRows[0];
      if (!(await canAccessGroupResource(bet.group_id, req.user, connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Access denied." });
      }
      const closesAt = new Date(bet.closes_at);
      if (bet.status !== "open" || closesAt.getTime() <= Date.now()) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Bet is closed for new positions." });
      }

      const [optionRows] = await connection.query(
        "SELECT * FROM bet_options WHERE id = ? AND bet_id = ? FOR UPDATE",
        [optionId, betId]
      );
      if (!optionRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Option not found." });
      }

      let userPoints = null;
      try {
        const debitResult = await applyPointsDelta(connection, {
          userId: req.user.id,
          delta: -stakePoints,
          actorUserId: req.user.id,
          action: "bet_buy_debit",
          reason: "bet_buy",
          relatedEntityType: "bet",
          relatedEntityId: betId
        });
        userPoints = debitResult.after;
      } catch (error) {
        await connection.rollback();
        if (error.message === "Insufficient points") {
          return res.status(400).json({ ok: false, message: "Insufficient points." });
        }
        throw error;
      }

      const oddsAtPurchase = Number(optionRows[0].current_odds);
      const [positionResult] = await connection.query(
        "INSERT INTO bet_positions (bet_id, bet_option_id, user_id, stake_points, odds_at_purchase, status) VALUES (?, ?, ?, ?, ?, 'open')",
        [betId, optionId, req.user.id, stakePoints, oddsAtPurchase]
      );

      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        action: "bet_buy",
        reason: "bet_buy",
        relatedEntityType: "bet",
        relatedEntityId: betId,
        metadata: { optionId, stakePoints, oddsAtPurchase }
      });

      await connection.commit();
      return res.json({
        ok: true,
        positionId: positionResult.insertId,
        betId,
        optionId,
        stakePoints,
        oddsAtPurchase,
        userPoints
      });
    } catch (error) {
      await connection.rollback();
      console.error("Buy bet error", error);
      return res.status(500).json({ ok: false, message: "Failed to buy bet position." });
    } finally {
      connection.release();
    }
  })
);

registerRoute({
  method: "post",
  path: "/bets/{id}/sell",
  summary: "Sell bet position",
  tags: ["Bets"],
  params: z.object({ id: zId }),
  body: z.object({ positionId: zPositiveInt })
});
app.post(
  "/bets/:id/sell",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ positionId: zPositiveInt })
    })
  ),
  withIdempotency("bet_sell", async (req, res) => {
    const betId = Number(req.params.id);
    const positionId = Number(req.body.positionId);
    if (!betId || !positionId) {
      return res.status(400).json({ ok: false, message: "bet id and positionId are required." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();

      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
      if (!betRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      const bet = betRows[0];
      if (!(await canAccessGroupResource(bet.group_id, req.user, connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Access denied." });
      }
      if (bet.status === "resolved" || bet.status === "cancelled" || bet.status === "resolving") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Bet is not open for sell." });
      }

      const [positionRows] = await connection.query(
        "SELECT * FROM bet_positions WHERE id = ? AND bet_id = ? AND user_id = ? FOR UPDATE",
        [positionId, betId, req.user.id]
      );
      if (!positionRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Position not found." });
      }

      const position = positionRows[0];
      if (position.status !== "open") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Position is not open." });
      }

      const [optionRows] = await connection.query(
        "SELECT * FROM bet_options WHERE id = ? FOR UPDATE",
        [position.bet_option_id]
      );
      if (!optionRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Option not found." });
      }

      const currentOdds = Number(optionRows[0].current_odds);
      const purchaseOdds = Number(position.odds_at_purchase);
      const stake = Number(position.stake_points);
      const rawCashout = stake * (currentOdds / purchaseOdds);
      const cashoutPoints = Math.max(0, Math.floor(rawCashout));
      const fee = calculateFee(cashoutPoints);
      const netCashout = cashoutPoints - fee;

      let userPoints = null;
      if (netCashout > 0) {
        const deltaResult = await applyPointsDelta(connection, {
          userId: req.user.id,
          delta: netCashout,
          actorUserId: req.user.id,
          action: "bet_sell_credit",
          reason: "bet_sell",
          relatedEntityType: "bet",
          relatedEntityId: betId
        });
        userPoints = deltaResult.after;
      } else {
        const [userRows] = await connection.query("SELECT points FROM users WHERE id = ? FOR UPDATE", [req.user.id]);
        userPoints = Number(userRows[0]?.points ?? 0);
      }

      await connection.query(
        "UPDATE bet_positions SET status = 'sold', sold_points = ?, sold_at = NOW(), updated_at = NOW() WHERE id = ?",
        [netCashout, positionId]
      );

      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        action: "bet_sell",
        reason: "bet_sell",
        relatedEntityType: "bet",
        relatedEntityId: betId,
        metadata: { positionId, cashoutPoints: netCashout, fee, currentOdds, purchaseOdds }
      });

      await creditFeeToSuperAdmin(connection, fee, {
        actorUserId: req.user.id,
        action: "fee_bet_sell",
        reason: "bet_sell_fee",
        relatedEntityType: "bet",
        relatedEntityId: betId,
        metadata: { fee, positionId }
      });

      await connection.commit();
      return res.json({
        ok: true,
        positionId,
        betId,
        cashoutPoints: netCashout,
        fee,
        userPoints
      });
    } catch (error) {
      await connection.rollback();
      console.error("Sell bet error", error);
      return res.status(500).json({ ok: false, message: "Failed to sell bet position." });
    } finally {
      connection.release();
    }
  })
);

registerRoute({
  method: "get",
  path: "/bets/{id}/positions",
  summary: "List my positions for a bet",
  tags: ["Bets"],
  params: z.object({ id: zId }),
  query: z.object({
    limit: zLimit.optional(),
    offset: zOffset.optional(),
    sort: z.enum(["created_at"]).optional(),
    order: zSortOrder.optional()
  })
});
app.get(
  "/bets/:id/positions",
  authenticate,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLimit.optional(),
        offset: zOffset.optional(),
        sort: z.enum(["created_at"]).optional(),
        order: zSortOrder.optional()
      })
    })
  ),
  async (req, res) => {
    const betId = parsePositiveInt(req.params.id);
    if (!betId) {
      return res.status(400).json({ ok: false, message: "Invalid bet id." });
    }
    try {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const sortKey = req.query.sort || "created_at";
      const order = req.query.order || "desc";
      const orderSql = order === "asc" ? "ASC" : "DESC";
      const sortColumn = sortKey === "created_at" ? "created_at" : "created_at";

      const [betRows] = await dbPool.query("SELECT group_id FROM bets WHERE id = ?", [betId]);
      if (!betRows.length) {
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      if (!(await canAccessGroupResource(betRows[0].group_id, req.user))) {
        return res.status(403).json({ ok: false, message: "Access denied." });
      }
      const [rows] = await dbPool.query(
        `SELECT id, bet_id AS betId, bet_option_id AS optionId, stake_points AS stakePoints, odds_at_purchase AS oddsAtPurchase, status,
                payout_points AS payoutPoints, sold_points AS soldPoints, created_at AS createdAt
         FROM bet_positions
         WHERE bet_id = ? AND user_id = ?
         ORDER BY ${sortColumn} ${orderSql}
         LIMIT ? OFFSET ?`,
        [betId, req.user.id, limit, offset]
      );
      return res.json({ ok: true, positions: rows });
    } catch (error) {
      console.error("List positions error", error);
      return res.status(500).json({ ok: false, message: "Failed to list positions." });
    }
  }
);

registerRoute({
  method: "post",
  path: "/admin/bets/{id}/options",
  summary: "Create bet option",
  tags: ["Admin", "Bets"],
  params: z.object({ id: zId }),
  body: z.object({
    label: z.string().trim().min(1).max(160),
    odds: zOdds.optional(),
    value: z.coerce.number().optional()
  })
});
app.post(
  "/admin/bets/:id/options",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({
        label: z.string().trim().min(1).max(160),
        odds: zOdds.optional(),
        value: z.coerce.number().optional()
      })
    })
  ),
  async (req, res) => {
  const betId = parsePositiveInt(req.params.id);
  const { label, odds, value } = req.body || {};
  if (!betId || !label) {
    return res.status(400).json({ ok: false, message: "bet id and label are required." });
  }
  const oddsValue = parseOdds(odds ?? 2.0);
  if (!oddsValue) {
    return res.status(400).json({ ok: false, message: "Invalid odds." });
  }
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
    if (!betRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Bet not found." });
    }
    const bet = betRows[0];
    if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(bet.creator_user_id), connection))) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot modify super admin bets." });
    }
    if (bet.status === "resolved" || bet.status === "cancelled" || bet.status === "resolving") {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Cannot modify options for a closed bet." });
    }
    const [posRows] = await connection.query(
      "SELECT COUNT(*) AS count FROM bet_positions WHERE bet_id = ?",
      [betId]
    );
    if (Number(posRows[0].count) > 0) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Cannot modify options after positions exist." });
    }
    let numericValue = null;
    if (bet.bet_type === "number") {
      const numericInput = value ?? label;
      const parsedNumeric = Number(numericInput);
      if (!Number.isFinite(parsedNumeric)) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Numeric bet options must include a number." });
      }
      numericValue = Number(parsedNumeric.toFixed(2));
    }
    const [result] = await connection.query(
      "INSERT INTO bet_options (bet_id, label, numeric_value, current_odds) VALUES (?, ?, ?, ?)",
      [betId, String(label).trim(), numericValue, oddsValue]
    );
    await logAudit(connection, {
      actorUserId: req.user.id,
      targetUserId: Number(bet.creator_user_id),
      action: "bet_option_create",
      reason: "bet_option_create",
      relatedEntityType: "bet_option",
      relatedEntityId: result.insertId,
      metadata: { betId, odds: oddsValue }
    });
    await connection.commit();
    return res.status(201).json({ ok: true, optionId: result.insertId, betId });
  } catch (error) {
    await connection.rollback();
    console.error("Create bet option error", error);
    return res.status(500).json({ ok: false, message: "Failed to create bet option." });
  } finally {
    connection.release();
  }
  }
);

registerRoute({
  method: "patch",
  path: "/admin/bets/{betId}/options/{optionId}",
  summary: "Update bet option",
  tags: ["Admin", "Bets"],
  params: z.object({ betId: zId, optionId: zId }),
  body: z.object({
    label: zOptionalString(160),
    odds: zOdds.optional(),
    value: z.coerce.number().optional()
  })
});
app.patch(
  "/admin/bets/:betId/options/:optionId",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ betId: zId, optionId: zId }),
      query: z.object({}),
      body: z.object({
        label: zOptionalString(160),
        odds: zOdds.optional(),
        value: z.coerce.number().optional()
      })
    })
  ),
  async (req, res) => {
    const betId = parsePositiveInt(req.params.betId);
    const optionId = parsePositiveInt(req.params.optionId);
    if (!betId || !optionId) {
      return res.status(400).json({ ok: false, message: "betId and optionId are required." });
    }
    const { label, odds, value } = req.body || {};
    const updates = [];
    const values = [];
    if (label !== undefined) {
      const trimmed = String(label).trim();
      if (!trimmed) {
        return res.status(400).json({ ok: false, message: "label cannot be empty." });
      }
      updates.push("label = ?");
      values.push(trimmed);
    }
    if (odds !== undefined) {
      const oddsValue = parseOdds(odds);
      if (!oddsValue) {
        return res.status(400).json({ ok: false, message: "Invalid odds." });
      }
      updates.push("current_odds = ?");
      values.push(oddsValue);
    }
    if (value !== undefined) {
      const parsedNumeric = Number(value);
      if (!Number.isFinite(parsedNumeric)) {
        return res.status(400).json({ ok: false, message: "Invalid numeric value." });
      }
      updates.push("numeric_value = ?");
      values.push(Number(parsedNumeric.toFixed(2)));
    }
    if (!updates.length) {
      return res.status(400).json({ ok: false, message: "No valid fields provided." });
    }
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
      if (!betRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      const bet = betRows[0];
      if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(bet.creator_user_id), connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot modify super admin bets." });
      }
      if (bet.status === "resolved" || bet.status === "cancelled" || bet.status === "resolving") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Cannot modify options for a closed bet." });
      }
      const [posRows] = await connection.query(
        "SELECT COUNT(*) AS count FROM bet_positions WHERE bet_id = ?",
        [betId]
      );
      if (Number(posRows[0].count) > 0 && updates.some((field) => field !== "current_odds = ?")) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Cannot modify options after positions exist." });
      }
      values.push(optionId, betId);
      const [result] = await connection.query(
        `UPDATE bet_options SET ${updates.join(", ")} WHERE id = ? AND bet_id = ?`,
        values
      );
      if (!result.affectedRows) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Option not found." });
      }
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: Number(bet.creator_user_id),
        action: "bet_option_update",
        reason: "bet_option_update",
        relatedEntityType: "bet_option",
        relatedEntityId: optionId,
        metadata: { betId, fields: updates }
      });
      await connection.commit();
      return res.json({ ok: true, optionId, betId });
    } catch (error) {
      await connection.rollback();
      console.error("Update bet option error", error);
      return res.status(500).json({ ok: false, message: "Failed to update bet option." });
    } finally {
      connection.release();
    }
  }
);

registerRoute({
  method: "delete",
  path: "/admin/bets/{betId}/options/{optionId}",
  summary: "Delete bet option",
  tags: ["Admin", "Bets"],
  params: z.object({ betId: zId, optionId: zId })
});
app.delete(
  "/admin/bets/:betId/options/:optionId",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ betId: zId, optionId: zId }),
      query: z.object({}),
      body: z.object({}).default({})
    })
  ),
  async (req, res) => {
    const betId = parsePositiveInt(req.params.betId);
    const optionId = parsePositiveInt(req.params.optionId);
    if (!betId || !optionId) {
      return res.status(400).json({ ok: false, message: "betId and optionId are required." });
    }
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
      if (!betRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      const bet = betRows[0];
      if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(bet.creator_user_id), connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot modify super admin bets." });
      }
      if (bet.status === "resolved" || bet.status === "cancelled" || bet.status === "resolving") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Cannot modify options for a closed bet." });
      }
      const [posRows] = await connection.query(
        "SELECT COUNT(*) AS count FROM bet_positions WHERE bet_id = ?",
        [betId]
      );
      if (Number(posRows[0].count) > 0) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Cannot modify options after positions exist." });
      }
      const [countRows] = await connection.query(
        "SELECT COUNT(*) AS count FROM bet_options WHERE bet_id = ?",
        [betId]
      );
      if (Number(countRows[0].count) <= 2) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Bet must have at least two options." });
      }
      const [result] = await connection.query(
        "DELETE FROM bet_options WHERE id = ? AND bet_id = ?",
        [optionId, betId]
      );
      if (!result.affectedRows) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Option not found." });
      }
      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: Number(bet.creator_user_id),
        action: "bet_option_delete",
        reason: "bet_option_delete",
        relatedEntityType: "bet_option",
        relatedEntityId: optionId,
        metadata: { betId }
      });
      await connection.commit();
      return res.json({ ok: true, optionId, betId });
    } catch (error) {
      await connection.rollback();
      console.error("Delete bet option error", error);
      return res.status(500).json({ ok: false, message: "Failed to delete bet option." });
    } finally {
      connection.release();
    }
  }
);

// Admin: list bets that are past close time and not resolved yet.
registerRoute({
  method: "get",
  path: "/admin/bets/pending-resolution",
  summary: "List bets pending resolution",
  tags: ["Admin", "Bets"],
  query: z.object({
    limit: zLimit.optional(),
    offset: zOffset.optional()
  })
});
app.get(
  "/admin/bets/pending-resolution",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({}),
      body: z.object({}).default({}),
      query: z.object({
        limit: zLimit.optional(),
        offset: zOffset.optional()
      })
    })
  ),
  async (req, res) => {
    try {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const [bets] = await dbPool.query(
        "SELECT * FROM bets WHERE closes_at <= NOW() AND resolved_at IS NULL AND status NOT IN ('cancelled', 'resolving') ORDER BY closes_at ASC LIMIT ? OFFSET ?",
        [limit, offset]
      );
      if (!bets.length) {
        return res.json({ ok: true, bets: [] });
      }
      const betIds = bets.map((bet) => bet.id);
      const [options] = await dbPool.query(
        `SELECT * FROM bet_options WHERE bet_id IN (${betIds.map(() => "?").join(",")})`,
        betIds
      );
      const optionsByBet = new Map();
      for (const option of options) {
        const id = Number(option.bet_id);
        if (!optionsByBet.has(id)) {
          optionsByBet.set(id, []);
        }
        optionsByBet.get(id).push(serializeBetOption(option));
      }
      return res.json({
        ok: true,
        bets: bets.map((bet) => serializeBet(bet, optionsByBet.get(Number(bet.id)) || []))
      });
    } catch (error) {
      console.error("Pending bets error", error);
      return res.status(500).json({ ok: false, message: "Failed to fetch pending bets." });
    }
  }
);

// Admin: resolve a bet by enqueueing a payout job.
registerRoute({
  method: "post",
  path: "/admin/bets/{id}/resolve",
  summary: "Resolve bet (enqueue payouts)",
  tags: ["Admin", "Bets"],
  params: z.object({ id: zId }),
  body: z.object({ resultOptionId: zPositiveInt })
});
app.post(
  "/admin/bets/:id/resolve",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({ resultOptionId: zPositiveInt })
    })
  ),
  withIdempotency("admin_bet_resolve", async (req, res) => {
    const betId = parsePositiveInt(req.params.id);
    const resultOptionId = parsePositiveInt(req.body?.resultOptionId);
    if (!betId || !resultOptionId) {
      return res.status(400).json({ ok: false, message: "bet id and resultOptionId are required." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();

      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
      if (!betRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      const bet = betRows[0];
      if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(bet.creator_user_id), connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot resolve super admin bets." });
      }
      if (bet.status === "cancelled") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Bet is cancelled." });
      }
      if (bet.resolved_at || bet.status === "resolved") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Bet already resolved." });
      }

      const [optionRows] = await connection.query(
        "SELECT id FROM bet_options WHERE id = ? AND bet_id = ?",
        [resultOptionId, betId]
      );
      if (!optionRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Result option not found." });
      }

      const jobResult = await enqueuePayoutJob(connection, {
        betId,
        resultOptionId,
        resolvedBy: req.user.id,
        metadata: { requestedBy: req.user.id }
      });
      if (jobResult.alreadyCompleted) {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Bet already resolved." });
      }

      await connection.query(
        "UPDATE bets SET status = 'resolving', result_option_id = ?, updated_at = NOW() WHERE id = ?",
        [resultOptionId, betId]
      );

      await logAudit(connection, {
        actorUserId: req.user.id,
        targetUserId: null,
        action: "bet_resolve_queued",
        reason: "bet_resolve_queued",
        relatedEntityType: "bet",
        relatedEntityId: betId,
        metadata: { resultOptionId, jobId: jobResult.jobId }
      });

      await connection.commit();
      return res.json({
        ok: true,
        betId,
        resultOptionId,
        jobId: jobResult.jobId,
        queued: true
      });
    } catch (error) {
      await connection.rollback();
      console.error("Resolve bet error", error);
      return res.status(500).json({ ok: false, message: "Failed to resolve bet." });
    } finally {
      connection.release();
    }
  })
);

registerRoute({
  method: "patch",
  path: "/admin/bets/{id}",
  summary: "Update bet",
  tags: ["Admin", "Bets"],
  params: z.object({ id: zId }),
  body: z.object({
    title: zOptionalString(160),
    description: zNullableString(2000),
    details: zNullableString(4000),
    closesAt: zFutureDate.optional(),
    status: z.enum(["open", "closed", "cancelled"]).optional()
  })
});
app.patch(
  "/admin/bets/:id",
  authenticate,
  requireAdmin,
  validateRequest(
    z.object({
      params: z.object({ id: zId }),
      query: z.object({}),
      body: z.object({
        title: zOptionalString(160),
        description: zNullableString(2000),
        details: zNullableString(4000),
        closesAt: zFutureDate.optional(),
        status: z.enum(["open", "closed", "cancelled"]).optional()
      })
    })
  ),
  async (req, res) => {
  const betId = parsePositiveInt(req.params.id);
  if (!betId) {
    return res.status(400).json({ ok: false, message: "Invalid bet id." });
  }
  const { title, description, details, closesAt, status } = req.body || {};
  let normalizedStatus = null;
  const updates = [];
  const values = [];

  if (title !== undefined) {
    const trimmed = String(title).trim();
    if (!trimmed) {
      return res.status(400).json({ ok: false, message: "title cannot be empty." });
    }
    updates.push("title = ?");
    values.push(trimmed);
  }

  if (description !== undefined) {
    updates.push("description = ?");
    values.push(description ? String(description).trim() : null);
  }

  if (details !== undefined) {
    updates.push("details = ?");
    values.push(details ? String(details).trim() : null);
  }

  if (closesAt !== undefined) {
    const closeDate = parseFutureDate(closesAt);
    if (!closeDate) {
      return res.status(400).json({ ok: false, message: "closesAt must be a future date." });
    }
    updates.push("closes_at = ?");
    values.push(closeDate);
  }

  if (status !== undefined) {
    normalizedStatus = String(status).trim().toLowerCase();
    const allowed = new Set(["open", "closed", "cancelled"]);
    if (!allowed.has(normalizedStatus)) {
      return res.status(400).json({ ok: false, message: "status must be open, closed, or cancelled." });
    }
    updates.push("status = ?");
    values.push(normalizedStatus);
  }

  if (!updates.length) {
    return res.status(400).json({ ok: false, message: "No valid fields provided." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
    if (!betRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Bet not found." });
    }
    const bet = betRows[0];
    if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(bet.creator_user_id), connection))) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot modify super admin bets." });
    }
    if (bet.status === "resolved" || bet.status === "resolving") {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Cannot modify a resolved bet." });
    }

    if (normalizedStatus === "cancelled" && bet.status !== "cancelled") {
      // Delegate to cancel flow for refunds to keep logic consistent.
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Use DELETE /admin/bets/:id to cancel with refunds." });
    }

    values.push(betId);
    await connection.query(`UPDATE bets SET ${updates.join(", ")} WHERE id = ?`, values);
    const [updatedRows] = await connection.query("SELECT * FROM bets WHERE id = ?", [betId]);
    const [options] = await connection.query("SELECT * FROM bet_options WHERE bet_id = ?", [betId]);
    await logAudit(connection, {
      actorUserId: req.user.id,
      targetUserId: Number(bet.creator_user_id),
      action: "bet_update",
      reason: "bet_update",
      relatedEntityType: "bet",
      relatedEntityId: betId,
      metadata: { fields: updates }
    });
    await connection.commit();
    return res.json({ ok: true, bet: serializeBet(updatedRows[0], options.map(serializeBetOption)) });
  } catch (error) {
    await connection.rollback();
    console.error("Update bet error", error);
    return res.status(500).json({ ok: false, message: "Failed to update bet." });
  } finally {
    connection.release();
  }
  }
);

// Admin: cancel a bet and refund open positions.
registerRoute({
  method: "delete",
  path: "/admin/bets/{id}",
  summary: "Cancel bet",
  tags: ["Admin", "Bets"],
  params: z.object({ id: zId })
});
app.delete(
  "/admin/bets/:id",
  authenticate,
  requireAdmin,
  validateRequest(z.object({ params: z.object({ id: zId }), query: z.object({}), body: z.object({}).default({}) })),
  withIdempotency("admin_bet_cancel", async (req, res) => {
    const betId = parsePositiveInt(req.params.id);
    if (!betId) {
      return res.status(400).json({ ok: false, message: "Invalid bet id." });
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();

      const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
      if (!betRows.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: "Bet not found." });
      }
      const bet = betRows[0];
      if (!req.user.isSuperAdmin && (await isSuperAdminUserId(Number(bet.creator_user_id), connection))) {
        await connection.rollback();
        return res.status(403).json({ ok: false, message: "Cannot cancel super admin bets." });
      }
      if (bet.status === "resolved" || bet.status === "resolving") {
        await connection.rollback();
        return res.status(400).json({ ok: false, message: "Cannot cancel a resolved bet." });
      }

      const [positions] = await connection.query(
        "SELECT * FROM bet_positions WHERE bet_id = ? AND status = 'open' FOR UPDATE",
        [betId]
      );

      const refundsByUser = new Map();
      for (const position of positions) {
        const stake = Number(position.stake_points);
        const userId = Number(position.user_id);
        refundsByUser.set(userId, (refundsByUser.get(userId) || 0) + stake);
        await connection.query(
          "UPDATE bet_positions SET status = 'cancelled', payout_points = ?, cancelled_at = NOW(), updated_at = NOW() WHERE id = ?",
          [stake, position.id]
        );
      }

      for (const [userId, refund] of refundsByUser.entries()) {
        await applyPointsDelta(connection, {
          userId,
          delta: refund,
          actorUserId: req.user.id,
          action: "bet_refund",
          reason: "bet_cancel",
          relatedEntityType: "bet",
          relatedEntityId: betId,
          metadata: { refund }
        });
      }

      await connection.query(
        "UPDATE bets SET status = 'cancelled', updated_at = NOW() WHERE id = ?",
        [betId]
      );
      await logAudit(connection, {
        actorUserId: req.user.id,
        action: "bet_cancel",
        reason: "bet_cancel",
        relatedEntityType: "bet",
        relatedEntityId: betId,
        metadata: { refunds: Object.fromEntries(refundsByUser) }
      });

      await connection.commit();
      return res.json({ ok: true, betId, refunds: Object.fromEntries(refundsByUser) });
    } catch (error) {
      await connection.rollback();
      console.error("Cancel bet error", error);
      return res.status(500).json({ ok: false, message: "Failed to cancel bet." });
    } finally {
      connection.release();
    }
  })
);

const openApiGenerator = new OpenApiGeneratorV3(registry.definitions);
const openApiDocument = openApiGenerator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "Efrei API",
    version: "0.1.0"
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer"
      }
    }
  }
});

app.get("/openapi.json", (req, res) => {
  res.json(openApiDocument);
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

// Attach a WS server on the same HTTP server under /ws/odds.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/odds" });

// Fan-out helper to broadcast an odds update to every open WS client.
const broadcastOdds = (payload) => {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

// Push the current snapshot immediately after a client connects.
wss.on("connection", (socket) => {
  socket.send(JSON.stringify(latestOdds));
});

// Subscribe to Redis pub/sub and rebroadcast updates to HTTP/WS consumers.
const connectRedis = async () => {
  const client = createClient({ url: `redis://${redisHost}:${redisPort}` });
  client.on("error", (err) => {
    logger.error({ err }, "Redis error");
  });
  await client.connect();
  redisQueueClient = client;

  const subscriber = client.duplicate();
  subscriber.on("error", (err) => {
    logger.error({ err }, "Redis subscriber error");
  });
  await subscriber.connect();
  await subscriber.subscribe(oddsChannel, (message) => {
    try {
      const payload = JSON.parse(message);
      latestOdds = payload;
      broadcastOdds(payload);
    } catch (error) {
      console.error("Invalid odds payload", error);
    }
  });
};

const ensureColumn = async (tableName, columnName, definitionSql) => {
  const [rows] = await dbPool.query(
    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [dbName, tableName, columnName]
  );
  if (Number(rows[0]?.count) === 0) {
    await dbPool.query(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }
};

const ensureCheckConstraint = async (tableName, constraintName, definitionSql) => {
  const [rows] = await dbPool.query(
    "SELECT COUNT(*) AS count FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ?",
    [dbName, constraintName]
  );
  if (Number(rows[0]?.count) === 0) {
    await dbPool.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} CHECK (${definitionSql})`);
  }
};

const ensureTrigger = async (triggerName, createSql) => {
  const [rows] = await dbPool.query(
    "SELECT COUNT(*) AS count FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?",
    [dbName, triggerName]
  );
  if (Number(rows[0]?.count) === 0) {
    await dbPool.query(createSql);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureRole = async (name, description = null) => {
  await dbPool.query(
    "INSERT IGNORE INTO roles (name, description) VALUES (?, ?)",
    [name, description]
  );
  const [rows] = await dbPool.query("SELECT id FROM roles WHERE name = ?", [name]);
  return rows[0]?.id;
};

const ensurePermission = async (name, description = null) => {
  await dbPool.query(
    "INSERT IGNORE INTO permissions (name, description) VALUES (?, ?)",
    [name, description]
  );
  const [rows] = await dbPool.query("SELECT id FROM permissions WHERE name = ?", [name]);
  return rows[0]?.id;
};

const ensureRolePermission = async (roleId, permissionId) => {
  await dbPool.query(
    "INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
    [roleId, permissionId]
  );
};

const ensureUserRole = async (userId, roleId, assignedBy = null) => {
  await dbPool.query(
    "INSERT IGNORE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)",
    [userId, roleId, assignedBy]
  );
};

const seedRbac = async () => {
  const adminAccessId = await ensurePermission("admin.access", "Access to admin endpoints");
  const adminSuperId = await ensurePermission("admin.super", "Super admin privileges");
  const adminRoleId = await ensureRole("admin", "Standard admin role");
  const superRoleId = await ensureRole("super_admin", "Super admin role");

  if (adminRoleId && adminAccessId) {
    await ensureRolePermission(adminRoleId, adminAccessId);
  }
  if (superRoleId && adminAccessId) {
    await ensureRolePermission(superRoleId, adminAccessId);
  }
  if (superRoleId && adminSuperId) {
    await ensureRolePermission(superRoleId, adminSuperId);
  }

  if (adminRoleId) {
    await dbPool.query(
      "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT id, ? FROM users WHERE is_admin = 1",
      [adminRoleId]
    );
  }
  if (superRoleId) {
    await dbPool.query(
      "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT id, ? FROM users WHERE is_super_admin = 1",
      [superRoleId]
    );
  }
};

const ensureSchema = async () => {
  const createUsersTableSql = `
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      points INT UNSIGNED NOT NULL DEFAULT 1000,
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      is_super_admin TINYINT(1) NOT NULL DEFAULT 0,
      is_banned TINYINT(1) NOT NULL DEFAULT 0,
      banned_at DATETIME NULL,
      profile_description TEXT NULL,
      profile_visibility VARCHAR(16) NOT NULL DEFAULT 'public',
      profile_alias VARCHAR(160) NULL,
      profile_quote TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createUsersTableSql);
  await ensureColumn("users", "points", "points INT UNSIGNED NOT NULL DEFAULT 1000");
  await ensureColumn("users", "is_admin", "is_admin TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_super_admin", "is_super_admin TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_banned", "is_banned TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("users", "banned_at", "banned_at DATETIME NULL");
  await ensureColumn("users", "profile_description", "profile_description TEXT NULL");
  await ensureColumn("users", "profile_visibility", "profile_visibility VARCHAR(16) NOT NULL DEFAULT 'public'");
  await ensureColumn("users", "profile_alias", "profile_alias VARCHAR(160) NULL");
  await ensureColumn("users", "profile_quote", "profile_quote TEXT NULL");
  await dbPool.query("ALTER TABLE users MODIFY COLUMN points INT UNSIGNED NOT NULL DEFAULT 1000");
  await ensureCheckConstraint("users", "chk_users_points_nonnegative", "points >= 0");
  await ensureTrigger(
    "trg_users_points_nonnegative_insert",
    `CREATE TRIGGER trg_users_points_nonnegative_insert
     BEFORE INSERT ON users
     FOR EACH ROW
     BEGIN
       IF NEW.points < 0 THEN
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'points cannot be negative';
       END IF;
     END;`
  );
  await ensureTrigger(
    "trg_users_points_nonnegative_update",
    `CREATE TRIGGER trg_users_points_nonnegative_update
     BEFORE UPDATE ON users
     FOR EACH ROW
     BEGIN
       IF NEW.points < 0 THEN
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'points cannot be negative';
       END IF;
     END;`
  );

  const createRolesTableSql = `
    CREATE TABLE IF NOT EXISTS roles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL UNIQUE,
      description TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createRolesTableSql);

  const createPermissionsTableSql = `
    CREATE TABLE IF NOT EXISTS permissions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL UNIQUE,
      description TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createPermissionsTableSql);

  const createRolePermissionsTableSql = `
    CREATE TABLE IF NOT EXISTS role_permissions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      role_id BIGINT UNSIGNED NOT NULL,
      permission_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_role_permission (role_id, permission_id),
      CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createRolePermissionsTableSql);

  const createUserRolesTableSql = `
    CREATE TABLE IF NOT EXISTS user_roles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      role_id BIGINT UNSIGNED NOT NULL,
      assigned_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_role (user_id, role_id),
      CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_user_roles_assigned_by FOREIGN KEY (assigned_by) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createUserRolesTableSql);

  const createIdempotencyTableSql = `
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      idem_key VARCHAR(128) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      route VARCHAR(128) NOT NULL,
      method VARCHAR(8) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'processing',
      response_status INT NULL,
      response_body JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,
      UNIQUE KEY uniq_idem (idem_key, user_id, route, method),
      CONSTRAINT fk_idempotency_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createIdempotencyTableSql);

  const createUserDevicesTableSql = `
    CREATE TABLE IF NOT EXISTS user_devices (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      fingerprint CHAR(64) NOT NULL,
      user_agent TEXT NULL,
      last_ip VARCHAR(64) NULL,
      revoked_at DATETIME NULL,
      revoked_by BIGINT UNSIGNED NULL,
      first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_device (user_id, fingerprint),
      CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_user_devices_revoked_by FOREIGN KEY (revoked_by) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createUserDevicesTableSql);
  await ensureColumn("user_devices", "revoked_at", "revoked_at DATETIME NULL");
  await ensureColumn("user_devices", "revoked_by", "revoked_by BIGINT UNSIGNED NULL");

  const createGroupsTableSql = `
    CREATE TABLE IF NOT EXISTS user_groups (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      is_private TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_groups_creator FOREIGN KEY (created_by) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createGroupsTableSql);

  const createGroupMembersTableSql = `
    CREATE TABLE IF NOT EXISTS group_members (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'member',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_group_member (group_id, user_id),
      CONSTRAINT fk_group_members_group FOREIGN KEY (group_id) REFERENCES user_groups(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_group_members_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createGroupMembersTableSql);

  const createOffersTableSql = `
    CREATE TABLE IF NOT EXISTS offers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      creator_user_id BIGINT UNSIGNED NOT NULL,
      group_id BIGINT UNSIGNED NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT,
      points_cost INT UNSIGNED NOT NULL,
      max_acceptances INT UNSIGNED NULL,
      accepted_count INT UNSIGNED NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_offers_creator FOREIGN KEY (creator_user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_offers_group FOREIGN KEY (group_id) REFERENCES user_groups(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createOffersTableSql);
  await ensureColumn("offers", "group_id", "group_id BIGINT UNSIGNED NULL");

  const createAcceptancesTableSql = `
    CREATE TABLE IF NOT EXISTS offer_acceptances (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      offer_id BIGINT UNSIGNED NOT NULL,
      accepter_user_id BIGINT UNSIGNED NOT NULL,
      points_cost INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_acceptances_offer FOREIGN KEY (offer_id) REFERENCES offers(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_acceptances_user FOREIGN KEY (accepter_user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createAcceptancesTableSql);

  const createBetsTableSql = `
    CREATE TABLE IF NOT EXISTS bets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      creator_user_id BIGINT UNSIGNED NOT NULL,
      group_id BIGINT UNSIGNED NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT,
      details TEXT,
      bet_type VARCHAR(16) NOT NULL DEFAULT 'multiple',
      closes_at DATETIME NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      result_option_id BIGINT UNSIGNED NULL,
      resolved_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_bets_creator FOREIGN KEY (creator_user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_bets_group FOREIGN KEY (group_id) REFERENCES user_groups(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createBetsTableSql);
  await ensureColumn("bets", "details", "details TEXT");
  await ensureColumn("bets", "group_id", "group_id BIGINT UNSIGNED NULL");

  const createBetOptionsTableSql = `
    CREATE TABLE IF NOT EXISTS bet_options (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      bet_id BIGINT UNSIGNED NOT NULL,
      label VARCHAR(160) NOT NULL,
      numeric_value DECIMAL(12,2) NULL,
      current_odds DECIMAL(7,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_bet_options_bet FOREIGN KEY (bet_id) REFERENCES bets(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createBetOptionsTableSql);

  const createPayoutJobsTableSql = `
    CREATE TABLE IF NOT EXISTS payout_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      bet_id BIGINT UNSIGNED NOT NULL,
      result_option_id BIGINT UNSIGNED NULL,
      resolved_by BIGINT UNSIGNED NULL,
      payload JSON NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      error_message TEXT NULL,
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 5,
      next_attempt_at DATETIME NULL,
      last_error_at DATETIME NULL,
      dead_at DATETIME NULL,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_payout_bet (bet_id),
      CONSTRAINT fk_payout_bet FOREIGN KEY (bet_id) REFERENCES bets(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_payout_option FOREIGN KEY (result_option_id) REFERENCES bet_options(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT fk_payout_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createPayoutJobsTableSql);
  await ensureColumn("payout_jobs", "result_option_id", "result_option_id BIGINT UNSIGNED NULL");
  await ensureColumn("payout_jobs", "resolved_by", "resolved_by BIGINT UNSIGNED NULL");
  await ensureColumn("payout_jobs", "payload", "payload JSON NULL");
  await ensureColumn("payout_jobs", "max_attempts", "max_attempts INT NOT NULL DEFAULT 5");
  await ensureColumn("payout_jobs", "next_attempt_at", "next_attempt_at DATETIME NULL");
  await ensureColumn("payout_jobs", "last_error_at", "last_error_at DATETIME NULL");
  await ensureColumn("payout_jobs", "dead_at", "dead_at DATETIME NULL");

  const createPositionsTableSql = `
    CREATE TABLE IF NOT EXISTS bet_positions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      bet_id BIGINT UNSIGNED NOT NULL,
      bet_option_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      stake_points INT UNSIGNED NOT NULL,
      odds_at_purchase DECIMAL(7,2) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      payout_points INT UNSIGNED NULL,
      sold_points INT UNSIGNED NULL,
      sold_at DATETIME NULL,
      settled_at DATETIME NULL,
      cancelled_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_positions_bet FOREIGN KEY (bet_id) REFERENCES bets(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_positions_option FOREIGN KEY (bet_option_id) REFERENCES bet_options(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_positions_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createPositionsTableSql);

  const createAuthSecretsTableSql = `
    CREATE TABLE IF NOT EXISTS auth_secrets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      secret VARCHAR(255) NOT NULL,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      expires_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createAuthSecretsTableSql);
  const [secretRows] = await dbPool.query("SELECT COUNT(*) AS count FROM auth_secrets");
  if (Number(secretRows[0]?.count) === 0 && jwtSecret) {
    await dbPool.query("INSERT INTO auth_secrets (secret, is_primary) VALUES (?, 1)", [jwtSecret]);
  }

  const createRefreshTokensTableSql = `
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      device_id BIGINT UNSIGNED NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      last_used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_refresh_device FOREIGN KEY (device_id) REFERENCES user_devices(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
      UNIQUE KEY uniq_refresh_token (token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createRefreshTokensTableSql);
  await ensureColumn("refresh_tokens", "device_id", "device_id BIGINT UNSIGNED NULL");

  const createOfferReviewsTableSql = `
    CREATE TABLE IF NOT EXISTS offer_reviews (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      offer_id BIGINT UNSIGNED NOT NULL,
      reviewer_user_id BIGINT UNSIGNED NOT NULL,
      rating TINYINT UNSIGNED NOT NULL,
      comment TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_review_offer FOREIGN KEY (offer_id) REFERENCES offers(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_review_user FOREIGN KEY (reviewer_user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      UNIQUE KEY uniq_offer_review (offer_id, reviewer_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createOfferReviewsTableSql);

  const createAuditLogsTableSql = `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      actor_user_id BIGINT UNSIGNED NULL,
      target_user_id BIGINT UNSIGNED NULL,
      action VARCHAR(64) NOT NULL,
      reason TEXT NULL,
      points_delta INT NULL,
      points_before INT NULL,
      points_after INT NULL,
      related_entity_type VARCHAR(64) NULL,
      related_entity_id BIGINT UNSIGNED NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createAuditLogsTableSql);

  await seedRbac();
};

const ensureSchemaWithRetry = async () => {
  const retryableErrors = new Set([
    "ER_FK_CANNOT_OPEN_PARENT",
    "ER_NO_SUCH_TABLE",
    "ER_BAD_DB_ERROR"
  ]);
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ensureSchema();
      return;
    } catch (error) {
      const shouldRetry = retryableErrors.has(error.code);
      if (!shouldRetry || attempt === maxAttempts) {
        throw error;
      }
      logger.warn({ attempt, maxAttempts, err: error }, "Schema not ready, retrying");
      await sleep(2000);
    }
  }
};

const bootstrapAdmin = async () => {
  if (!adminBootstrapEmail && !adminBootstrapUserId) {
    return;
  }
  try {
    let result;
    let targetUserId = adminBootstrapUserId || null;
    if (adminBootstrapUserId) {
      [result] = await dbPool.query(
        "UPDATE users SET is_admin = 1, is_super_admin = 1 WHERE id = ?",
        [adminBootstrapUserId]
      );
    } else if (adminBootstrapEmail) {
      [result] = await dbPool.query(
        "UPDATE users SET is_admin = 1, is_super_admin = 1 WHERE email = ?",
        [adminBootstrapEmail]
      );
      if (result && result.affectedRows > 0) {
        const [rows] = await dbPool.query("SELECT id FROM users WHERE email = ?", [adminBootstrapEmail]);
        targetUserId = rows[0]?.id ? Number(rows[0].id) : null;
      }
    }
    if (result && result.affectedRows > 0) {
      if (targetUserId) {
        superAdminIdCache = targetUserId;
        const superRoleId = await ensureRole("super_admin", "Super admin role");
        if (superRoleId) {
          await ensureUserRole(targetUserId, superRoleId, targetUserId);
        }
      }
      logger.info("Admin bootstrap applied.");
    }
  } catch (error) {
    logger.error({ err: error }, "Admin bootstrap failed");
  }
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

  await ensureSchemaWithRetry();
  await bootstrapAdmin();
};

const start = async () => {
  await initDatabase();
  await connectRedis();

  // Start the HTTP server (WS piggybacks on it).
  server.listen(port, () => {
    logger.info({ port }, "API listening");
  });
};

start().catch((error) => {
  logger.error({ err: error }, "API failed to start");
  process.exit(1);
});
