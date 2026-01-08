// API service: exposes REST + WebSocket odds endpoints and business APIs.
const express = require("express");
const cors = require("cors");
const http = require("http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimitModule = require("express-rate-limit");
const { WebSocketServer, WebSocket } = require("ws");
const { createClient } = require("redis");
const mysql = require("mysql2/promise");

const app = express();
const port = process.env.PORT || 4000;
const jwtSecret = process.env.JWT_SECRET || "dev-secret";

// Redis configuration for realtime odds.
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";

// MySQL configuration for users, offers, bets, and points.
const dbHost = process.env.DB_HOST || "mysql";
const dbPort = Number(process.env.DB_PORT || 3306);
const dbName = process.env.DB_NAME || "efrei";
const dbUser = process.env.DB_USER || "efrei";
const dbPassword = process.env.DB_PASSWORD || "efrei";

let dbPool = null;
let jwtSecretsCache = { secrets: null, primary: null, fetchedAt: 0 };

// Last known odds payload kept in memory for fast HTTP/WS replies.
let latestOdds = {
  type: "odds",
  updatedAt: new Date().toISOString(),
  events: []
};

// Allow browser calls from the frontend and parse JSON bodies.
app.use(cors());
app.use(express.json());

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

// Simple health probe for liveness checks.
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "api" });
});

// Placeholder endpoint for future business logic.
app.get("/absurde", (req, res) => {
  res.json({ message: "stub", idea: "replace with your business logic" });
});

// Synchronous REST endpoint that returns the latest odds snapshot.
app.get("/odds", (req, res) => {
  res.json(latestOdds);
});

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
  return {
    id: Number(rows[0].id),
    email: rows[0].email,
    name: rows[0].name,
    points: Number(rows[0].points),
    isAdmin: Boolean(rows[0].isAdmin),
    isSuperAdmin: Boolean(rows[0].isSuperAdmin),
    isBanned: Boolean(rows[0].isBanned),
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
    console.error("JWT secret lookup failed", error);
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
    "SELECT id FROM users WHERE is_super_admin = 1 ORDER BY id ASC LIMIT 1"
  );
  if (!rows.length) {
    return null;
  }
  superAdminIdCache = Number(rows[0].id);
  return superAdminIdCache;
};

const requireSuperAdminId = async (connection) => {
  const superAdminId = await getSuperAdminId(connection);
  if (!superAdminId) {
    throw new Error("Super admin not configured");
  }
  return superAdminId;
};

const creditFeeToSuperAdmin = async (connection, feePoints, context = {}) => {
  if (!feePoints) {
    return;
  }
  const superAdminId = await requireSuperAdminId(connection);
  const [rows] = await connection.query("SELECT points FROM users WHERE id = ? FOR UPDATE", [superAdminId]);
  if (!rows.length) {
    throw new Error("Super admin not found");
  }
  const before = Number(rows[0].points);
  const after = before + Number(feePoints);
  await connection.query("UPDATE users SET points = ? WHERE id = ?", [after, superAdminId]);
  await logPointChange(connection, {
    actorUserId: context.actorUserId ?? null,
    targetUserId: superAdminId,
    action: context.action ?? "fee_credit",
    reason: context.reason ?? "fee_credit",
    pointsBefore: before,
    pointsAfter: after,
    relatedEntityType: context.relatedEntityType ?? null,
    relatedEntityId: context.relatedEntityId ?? null,
    metadata: context.metadata ?? { fee: feePoints }
  });
};

const isSuperAdminUserId = async (userId, connection = dbPool) => {
  if (!userId) {
    return false;
  }
  if (superAdminIdCache && Number(userId) === superAdminIdCache) {
    return true;
  }
  const [rows] = await connection.query("SELECT is_super_admin FROM users WHERE id = ?", [userId]);
  return Boolean(rows[0]?.is_super_admin);
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
    return res.status(401).json({ ok: false, message: "Invalid or expired token." });
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

// User endpoints (points never drop below 0).
app.get("/users/:id", authenticate, async (req, res) => {
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

app.patch("/me/profile", authenticate, async (req, res) => {
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
});

app.get("/profiles/:id", optionalAuthenticate, async (req, res) => {
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
});

app.get("/me/stats", authenticate, async (req, res) => {
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

app.get("/me/bets", authenticate, async (req, res) => {
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

app.get("/me/groups", authenticate, async (req, res) => {
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
app.post("/admin/users/:id/points/credit", authenticate, requireAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  const amount = parsePositiveInt(req.body?.amount ?? req.body?.points);
  if (!userId || !amount) {
    return res.status(400).json({ ok: false, message: "User id and positive amount are required." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, points, is_super_admin AS isSuperAdmin FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    if (rows[0].isSuperAdmin && !req.user.isSuperAdmin) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot modify super admin points." });
    }
    const beforePoints = Number(rows[0].points);
    const newPoints = beforePoints + amount;
    await connection.query("UPDATE users SET points = ? WHERE id = ?", [newPoints, userId]);
    await logPointChange(connection, {
      actorUserId: req.user.id,
      targetUserId: userId,
      action: "admin_points_credit",
      reason: "admin_credit",
      pointsBefore: beforePoints,
      pointsAfter: newPoints,
      metadata: { amount }
    });
    await connection.commit();
    return res.json({ ok: true, userId, points: newPoints });
  } catch (error) {
    await connection.rollback();
    console.error("Credit points error", error);
    return res.status(500).json({ ok: false, message: "Failed to credit points." });
  } finally {
    connection.release();
  }
});

app.post("/admin/users/:id/points/debit", authenticate, requireAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  const amount = parsePositiveInt(req.body?.amount ?? req.body?.points);
  if (!userId || !amount) {
    return res.status(400).json({ ok: false, message: "User id and positive amount are required." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, points, is_super_admin AS isSuperAdmin FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    if (rows[0].isSuperAdmin && !req.user.isSuperAdmin) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot modify super admin points." });
    }
    const currentPoints = Number(rows[0].points);
    if (currentPoints < amount) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Insufficient points." });
    }
    const newPoints = currentPoints - amount;
    await connection.query("UPDATE users SET points = ? WHERE id = ?", [newPoints, userId]);
    await logPointChange(connection, {
      actorUserId: req.user.id,
      targetUserId: userId,
      action: "admin_points_debit",
      reason: "admin_debit",
      pointsBefore: currentPoints,
      pointsAfter: newPoints,
      metadata: { amount }
    });
    await connection.commit();
    return res.json({ ok: true, userId, points: newPoints });
  } catch (error) {
    await connection.rollback();
    console.error("Debit points error", error);
    return res.status(500).json({ ok: false, message: "Failed to debit points." });
  } finally {
    connection.release();
  }
});

app.post("/admin/users/:id/promote", authenticate, requireSuperAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }
  try {
    const isTargetSuper = await isSuperAdminUserId(userId);
    if (isTargetSuper) {
      return res.status(400).json({ ok: false, message: "User is already super admin." });
    }
    const [result] = await dbPool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [userId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }
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
});

app.post("/admin/users/:id/demote", authenticate, requireSuperAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }
  try {
    const isTargetSuper = await isSuperAdminUserId(userId);
    if (isTargetSuper) {
      return res.status(403).json({ ok: false, message: "Cannot demote super admin." });
    }
    const [rows] = await dbPool.query("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1");
    if (Number(rows[0]?.count) <= 1 && req.user.id === userId) {
      return res.status(400).json({ ok: false, message: "Cannot demote the last admin." });
    }
    const [result] = await dbPool.query("UPDATE users SET is_admin = 0 WHERE id = ?", [userId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }
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
});

app.post("/admin/users/:id/ban", authenticate, requireAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, points, is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    const target = rows[0];
    if (target.isSuperAdmin) {
      await connection.rollback();
      return res.status(403).json({ ok: false, message: "Cannot ban super admin." });
    }
    if (target.isAdmin) {
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

    const [superRows] = await connection.query(
      "SELECT id, points FROM users WHERE id = ? FOR UPDATE",
      [superAdminId]
    );
    if (!superRows.length) {
      await connection.rollback();
      return res.status(500).json({ ok: false, message: "Super admin not found." });
    }

    const pointsToTransfer = Number(target.points) || 0;
    const superBefore = Number(superRows[0].points);
    const superAfter = superBefore + pointsToTransfer;

    if (pointsToTransfer > 0) {
      await connection.query("UPDATE users SET points = ? WHERE id = ?", [superAfter, superAdminId]);
    }
    await connection.query(
      "UPDATE users SET points = 0, is_banned = 1, banned_at = NOW() WHERE id = ?",
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

    await logPointChange(connection, {
      actorUserId: req.user.id,
      targetUserId: userId,
      action: "ban_transfer_debit",
      reason: "ban_transfer",
      pointsBefore: Number(target.points),
      pointsAfter: 0,
      relatedEntityType: "user",
      relatedEntityId: userId
    });

    if (pointsToTransfer > 0) {
      await logPointChange(connection, {
        actorUserId: req.user.id,
        targetUserId: superAdminId,
        action: "ban_transfer_credit",
        reason: "ban_transfer",
        pointsBefore: superBefore,
        pointsAfter: superAfter,
        relatedEntityType: "user",
        relatedEntityId: userId
      });
    }

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
});

app.post("/admin/users/:id/unban", authenticate, requireAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, is_banned AS isBanned, is_admin AS isAdmin, is_super_admin AS isSuperAdmin FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    const target = rows[0];
    if (target.isSuperAdmin) {
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
});

app.get("/admin/users", authenticate, requireAdmin, async (req, res) => {
  try {
    const limitRaw = parsePositiveInt(req.query.limit) || 100;
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Math.min(limitRaw, 500);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const [rows] = await dbPool.query(
      `SELECT id, email, name, points, is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned, banned_at AS bannedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM users
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      action: "admin_list_users",
      reason: "list_users",
      metadata: { limit, offset }
    });
    return res.json({ ok: true, users: rows });
  } catch (error) {
    console.error("List users error", error);
    return res.status(500).json({ ok: false, message: "Failed to list users." });
  }
});

app.get("/admin/users/banned", authenticate, requireAdmin, async (req, res) => {
  try {
    const limitRaw = parsePositiveInt(req.query.limit) || 100;
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Math.min(limitRaw, 500);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const [rows] = await dbPool.query(
      `SELECT id, email, name, points, is_admin AS isAdmin, is_super_admin AS isSuperAdmin, is_banned AS isBanned, banned_at AS bannedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM users
       WHERE is_banned = 1
       ORDER BY banned_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      action: "admin_list_banned",
      reason: "list_banned_users",
      metadata: { limit, offset }
    });
    return res.json({ ok: true, users: rows });
  } catch (error) {
    console.error("List banned users error", error);
    return res.status(500).json({ ok: false, message: "Failed to list banned users." });
  }
});

app.get("/admin/users/:id/logs", authenticate, requireAdmin, async (req, res) => {
  const userId = parsePositiveInt(req.params.id);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Invalid user id." });
  }
  try {
    const limitRaw = parsePositiveInt(req.query.limit) || 200;
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Math.min(limitRaw, 1000);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const scope = req.query.scope ? String(req.query.scope).trim().toLowerCase() : "all";
    let where = "WHERE ";
    if (scope === "actor") {
      where += "actor_user_id = ?";
    } else if (scope === "target") {
      where += "target_user_id = ?";
    } else {
      where += "(actor_user_id = ? OR target_user_id = ?)";
    }
    const params = scope === "all" ? [userId, userId, limit, offset] : [userId, limit, offset];

    const [rows] = await dbPool.query(
      `SELECT id, actor_user_id AS actorUserId, target_user_id AS targetUserId, action, reason, points_delta AS pointsDelta,
              points_before AS pointsBefore, points_after AS pointsAfter, related_entity_type AS relatedEntityType,
              related_entity_id AS relatedEntityId, metadata, created_at AS createdAt
       FROM audit_logs
       ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      params
    );
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      targetUserId: userId,
      action: "admin_get_user_logs",
      reason: "get_user_logs",
      metadata: { scope, limit, offset }
    });
    return res.json({ ok: true, logs: rows });
  } catch (error) {
    console.error("Get user logs error", error);
    return res.status(500).json({ ok: false, message: "Failed to fetch user logs." });
  }
});

app.post("/admin/users/:id/reset-password", authenticate, requireAdmin, async (req, res) => {
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
      "SELECT id, is_super_admin AS isSuperAdmin FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    if (rows[0].isSuperAdmin && !req.user.isSuperAdmin) {
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
});

// Admin group management.
app.post("/admin/groups", authenticate, requireAdmin, async (req, res) => {
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
});

app.patch("/admin/groups/:id", authenticate, requireAdmin, async (req, res) => {
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
});

app.get("/admin/groups", authenticate, requireAdmin, async (req, res) => {
  try {
    const [rows] = await dbPool.query(
      "SELECT id, name, description, is_private AS isPrivate, created_by AS createdBy, created_at AS createdAt FROM user_groups ORDER BY name ASC"
    );
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      action: "group_list",
      reason: "group_list",
      metadata: { count: rows.length }
    });
    return res.json({ ok: true, groups: rows });
  } catch (error) {
    console.error("List groups error", error);
    return res.status(500).json({ ok: false, message: "Failed to list groups." });
  }
});

app.get("/admin/groups/:id/members", authenticate, requireAdmin, async (req, res) => {
  const groupId = parsePositiveInt(req.params.id);
  if (!groupId) {
    return res.status(400).json({ ok: false, message: "Invalid group id." });
  }
  try {
    const [rows] = await dbPool.query(
      `SELECT gm.user_id AS userId, gm.role, gm.created_at AS joinedAt,
              u.email, u.name, u.is_admin AS isAdmin, u.is_super_admin AS isSuperAdmin
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY gm.created_at DESC`,
      [groupId]
    );
    await logAudit(dbPool, {
      actorUserId: req.user.id,
      action: "group_list_members",
      reason: "group_list_members",
      relatedEntityType: "group",
      relatedEntityId: groupId
    });
    return res.json({ ok: true, members: rows });
  } catch (error) {
    console.error("List group members error", error);
    return res.status(500).json({ ok: false, message: "Failed to list group members." });
  }
});

app.post("/admin/groups/:id/members", authenticate, requireAdmin, async (req, res) => {
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
});

app.post("/admin/groups/:id/members/batch", authenticate, requireAdmin, async (req, res) => {
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
});

app.delete("/admin/groups/:id/members/:userId", authenticate, requireAdmin, async (req, res) => {
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
});

app.get("/admin/logs", authenticate, requireAdmin, async (req, res) => {
  try {
    const limitRaw = parsePositiveInt(req.query.limit) || 200;
    const offsetRaw = Number(req.query.offset || 0);
    const limit = Math.min(limitRaw, 1000);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const action = req.query.action ? String(req.query.action).trim() : null;
    const targetUserId = parsePositiveInt(req.query.targetUserId);

    const clauses = [];
    const values = [];
    if (action) {
      clauses.push("action = ?");
      values.push(action);
    }
    if (targetUserId) {
      clauses.push("target_user_id = ?");
      values.push(targetUserId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await dbPool.query(
      `SELECT id, actor_user_id AS actorUserId, target_user_id AS targetUserId, action, reason, points_delta AS pointsDelta,
              points_before AS pointsBefore, points_after AS pointsAfter, related_entity_type AS relatedEntityType,
              related_entity_id AS relatedEntityId, metadata, created_at AS createdAt
       FROM audit_logs
       ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    await logAudit(dbPool, {
      actorUserId: req.user.id,
      action: "admin_list_logs",
      reason: "list_logs",
      metadata: { limit, offset, action, targetUserId }
    });

    return res.json({ ok: true, logs: rows });
  } catch (error) {
    console.error("List logs error", error);
    return res.status(500).json({ ok: false, message: "Failed to list logs." });
  }
});

app.get("/admin/fees/summary", authenticate, requireAdmin, async (req, res) => {
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
});

// Offer endpoints.
app.post("/offers", authenticate, async (req, res) => {
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
});

app.get("/offers", optionalAuthenticate, async (req, res) => {
  try {
    const onlyActive = req.query.active !== "false";
    const clauses = [];
    const params = [];
    if (onlyActive) {
      clauses.push("is_active = 1");
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
      `SELECT * FROM offers ${where} ORDER BY created_at DESC`,
      params
    );
    return res.json({ ok: true, offers: rows.map(serializeOffer) });
  } catch (error) {
    console.error("List offers error", error);
    return res.status(500).json({ ok: false, message: "Failed to list offers." });
  }
});

app.get("/offers/:id", optionalAuthenticate, async (req, res) => {
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
});

app.get("/offers/:id/acceptances", optionalAuthenticate, async (req, res) => {
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
});

app.get("/offers/:id/reviews", optionalAuthenticate, async (req, res) => {
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
});

app.post("/offers/:id/reviews", authenticate, async (req, res) => {
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
});

app.post("/offers/:id/accept", authenticate, async (req, res) => {
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

    const [userRows] = await connection.query(
      "SELECT id, points FROM users WHERE id IN (?, ?) FOR UPDATE",
      [offer.creator_user_id, accepterUserId]
    );
    const usersById = new Map(userRows.map((row) => [Number(row.id), row]));
    const creator = usersById.get(Number(offer.creator_user_id));
    const accepter = usersById.get(Number(accepterUserId));
    if (!creator || !accepter) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const cost = Number(offer.points_cost);
    const fee = calculateFee(cost);
    const totalCost = cost + fee;
    if (Number(accepter.points) < totalCost) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Insufficient points." });
    }

    const accepterBefore = Number(accepter.points);
    const creatorBefore = Number(creator.points);
    const accepterPoints = accepterBefore - totalCost;
    const creatorPoints = creatorBefore + cost;

    await connection.query("UPDATE users SET points = ? WHERE id = ?", [accepterPoints, accepterUserId]);
    await connection.query("UPDATE users SET points = ? WHERE id = ?", [creatorPoints, offer.creator_user_id]);

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

    await logPointChange(connection, {
      actorUserId: accepterUserId,
      targetUserId: accepterUserId,
      action: "offer_accept_debit",
      reason: "offer_accept",
      pointsBefore: accepterBefore,
      pointsAfter: accepterPoints,
      relatedEntityType: "offer",
      relatedEntityId: offerId
    });

    await logPointChange(connection, {
      actorUserId: accepterUserId,
      targetUserId: offer.creator_user_id,
      action: "offer_accept_credit",
      reason: "offer_accept",
      pointsBefore: creatorBefore,
      pointsAfter: creatorPoints,
      relatedEntityType: "offer",
      relatedEntityId: offerId
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
});

app.delete("/admin/offers/:id", authenticate, requireAdmin, async (req, res) => {
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
});

app.patch("/admin/offers/:id", authenticate, requireAdmin, async (req, res) => {
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
});

// Bets endpoints.
app.post("/bets", authenticate, async (req, res) => {
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
});

app.get("/bets", optionalAuthenticate, async (req, res) => {
  try {
    const onlyActive = req.query.active === "true";
    const clauses = [];
    const params = [];
    if (onlyActive) {
      clauses.push("status = 'open'");
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
      `SELECT * FROM bets ${where} ORDER BY created_at DESC`,
      params
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
        metadata: { count: bets.length }
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
});

app.get("/bets/:id", optionalAuthenticate, async (req, res) => {
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
});

app.post("/bets/:id/buy", authenticate, async (req, res) => {
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

    const [userRows] = await connection.query("SELECT id, points FROM users WHERE id = ? FOR UPDATE", [req.user.id]);
    if (!userRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const currentPoints = Number(userRows[0].points);
    if (currentPoints < stakePoints) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Insufficient points." });
    }

    const newPoints = currentPoints - stakePoints;
    await connection.query("UPDATE users SET points = ? WHERE id = ?", [newPoints, req.user.id]);

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
    await logPointChange(connection, {
      actorUserId: req.user.id,
      targetUserId: req.user.id,
      action: "bet_buy_debit",
      reason: "bet_buy",
      pointsBefore: currentPoints,
      pointsAfter: newPoints,
      relatedEntityType: "bet",
      relatedEntityId: betId
    });

    await connection.commit();
    return res.json({
      ok: true,
      positionId: positionResult.insertId,
      betId,
      optionId,
      stakePoints,
      oddsAtPurchase,
      userPoints: newPoints
    });
  } catch (error) {
    await connection.rollback();
    console.error("Buy bet error", error);
    return res.status(500).json({ ok: false, message: "Failed to buy bet position." });
  } finally {
    connection.release();
  }
});

app.post("/bets/:id/sell", authenticate, async (req, res) => {
  const betId = parsePositiveInt(req.params.id);
  const positionId = parsePositiveInt(req.body?.positionId);
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
    if (bet.status === "resolved" || bet.status === "cancelled") {
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

    const [userRows] = await connection.query("SELECT id, points FROM users WHERE id = ? FOR UPDATE", [req.user.id]);
    const currentPoints = Number(userRows[0].points);
    const newPoints = currentPoints + netCashout;

    await connection.query("UPDATE users SET points = ? WHERE id = ?", [newPoints, req.user.id]);
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
      metadata: { positionId, cashoutPoints: netCashout, fee }
    });
    await logPointChange(connection, {
      actorUserId: req.user.id,
      targetUserId: req.user.id,
      action: "bet_sell_credit",
      reason: "bet_sell",
      pointsBefore: currentPoints,
      pointsAfter: newPoints,
      relatedEntityType: "bet",
      relatedEntityId: betId
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
      userPoints: newPoints
    });
  } catch (error) {
    await connection.rollback();
    console.error("Sell bet error", error);
    return res.status(500).json({ ok: false, message: "Failed to sell bet position." });
  } finally {
    connection.release();
  }
});

app.get("/bets/:id/positions", authenticate, async (req, res) => {
  const betId = parsePositiveInt(req.params.id);
  if (!betId) {
    return res.status(400).json({ ok: false, message: "Invalid bet id." });
  }
  try {
    const [betRows] = await dbPool.query("SELECT group_id FROM bets WHERE id = ?", [betId]);
    if (!betRows.length) {
      return res.status(404).json({ ok: false, message: "Bet not found." });
    }
    if (!(await canAccessGroupResource(betRows[0].group_id, req.user))) {
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    const [rows] = await dbPool.query(
      "SELECT id, bet_id AS betId, bet_option_id AS optionId, stake_points AS stakePoints, odds_at_purchase AS oddsAtPurchase, status, payout_points AS payoutPoints, sold_points AS soldPoints, created_at AS createdAt FROM bet_positions WHERE bet_id = ? AND user_id = ? ORDER BY created_at DESC",
      [betId, req.user.id]
    );
    return res.json({ ok: true, positions: rows });
  } catch (error) {
    console.error("List positions error", error);
    return res.status(500).json({ ok: false, message: "Failed to list positions." });
  }
});

app.post("/admin/bets/:id/options", authenticate, requireAdmin, async (req, res) => {
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
    return res.status(201).json({ ok: true, optionId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error("Create bet option error", error);
    return res.status(500).json({ ok: false, message: "Failed to create bet option." });
  } finally {
    connection.release();
  }
});

app.patch("/admin/bets/:betId/options/:optionId", authenticate, requireAdmin, async (req, res) => {
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
});

app.delete("/admin/bets/:betId/options/:optionId", authenticate, requireAdmin, async (req, res) => {
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
});

// Admin: list bets that are past close time and not resolved yet.
app.get("/admin/bets/pending-resolution", authenticate, requireAdmin, async (req, res) => {
  try {
    const [bets] = await dbPool.query(
      "SELECT * FROM bets WHERE closes_at <= NOW() AND resolved_at IS NULL AND status NOT IN ('cancelled') ORDER BY closes_at ASC"
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
});

// Admin: resolve a bet and settle positions.
app.post("/admin/bets/:id/resolve", authenticate, requireAdmin, async (req, res) => {
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
    if (bet.resolved_at) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: "Bet already resolved." });
    }

    const [optionRows] = await connection.query(
      "SELECT * FROM bet_options WHERE id = ? AND bet_id = ?",
      [resultOptionId, betId]
    );
    if (!optionRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: "Result option not found." });
    }

    const [positions] = await connection.query(
      "SELECT * FROM bet_positions WHERE bet_id = ? AND status = 'open' FOR UPDATE",
      [betId]
    );

    const payoutsByUser = new Map();
    const feesByUser = new Map();
    let totalFees = 0;
    for (const position of positions) {
      const isWinner = Number(position.bet_option_id) === resultOptionId;
      const grossPayout = isWinner
        ? Math.floor(Number(position.stake_points) * Number(position.odds_at_purchase))
        : 0;
      const fee = calculateFee(grossPayout);
      const netPayout = Math.max(0, grossPayout - fee);
      if (netPayout > 0) {
        const userId = Number(position.user_id);
        payoutsByUser.set(userId, (payoutsByUser.get(userId) || 0) + netPayout);
        feesByUser.set(userId, (feesByUser.get(userId) || 0) + fee);
      }
      totalFees += fee;
      await connection.query(
        "UPDATE bet_positions SET status = 'settled', payout_points = ?, settled_at = NOW(), updated_at = NOW() WHERE id = ?",
        [netPayout, position.id]
      );
    }

    for (const [userId, payout] of payoutsByUser.entries()) {
      const [userRows] = await connection.query("SELECT points FROM users WHERE id = ? FOR UPDATE", [userId]);
      const before = Number(userRows[0]?.points ?? 0);
      const after = before + payout;
      await connection.query("UPDATE users SET points = ? WHERE id = ?", [after, userId]);
      await logPointChange(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "bet_payout",
        reason: "bet_resolve",
        pointsBefore: before,
        pointsAfter: after,
        relatedEntityType: "bet",
        relatedEntityId: betId
      });
    }

    await logAudit(connection, {
      actorUserId: req.user.id,
      targetUserId: null,
      action: "bet_resolve",
      reason: "bet_resolve",
      relatedEntityType: "bet",
      relatedEntityId: betId,
      metadata: { resultOptionId, totalFees }
    });

    await creditFeeToSuperAdmin(connection, totalFees, {
      actorUserId: req.user.id,
      action: "fee_bet_resolve",
      reason: "bet_resolve_fee",
      relatedEntityType: "bet",
      relatedEntityId: betId,
      metadata: { totalFees }
    });

    await connection.query(
      "UPDATE bets SET status = 'resolved', result_option_id = ?, resolved_at = NOW(), updated_at = NOW() WHERE id = ?",
      [resultOptionId, betId]
    );

    await connection.commit();
    return res.json({
      ok: true,
      betId,
      resultOptionId,
      payouts: Object.fromEntries(payoutsByUser),
      fees: Object.fromEntries(feesByUser),
      totalFees
    });
  } catch (error) {
    await connection.rollback();
    console.error("Resolve bet error", error);
    return res.status(500).json({ ok: false, message: "Failed to resolve bet." });
  } finally {
    connection.release();
  }
});

app.patch("/admin/bets/:id", authenticate, requireAdmin, async (req, res) => {
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
    if (bet.status === "resolved") {
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
});

// Admin: cancel a bet and refund open positions.
app.delete("/admin/bets/:id", authenticate, requireAdmin, async (req, res) => {
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
    if (bet.status === "resolved") {
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
      const [userRows] = await connection.query("SELECT points FROM users WHERE id = ? FOR UPDATE", [userId]);
      const before = Number(userRows[0]?.points ?? 0);
      const after = before + refund;
      await connection.query("UPDATE users SET points = ? WHERE id = ?", [after, userId]);
      await logPointChange(connection, {
        actorUserId: req.user.id,
        targetUserId: userId,
        action: "bet_refund",
        reason: "bet_cancel",
        pointsBefore: before,
        pointsAfter: after,
        relatedEntityType: "bet",
        relatedEntityId: betId
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
});

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
    console.error("Redis error", err);
  });
  await client.connect();
  await client.subscribe(oddsChannel, (message) => {
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
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      last_used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      UNIQUE KEY uniq_refresh_token (token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await dbPool.query(createRefreshTokensTableSql);

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
};

const bootstrapAdmin = async () => {
  if (!adminBootstrapEmail && !adminBootstrapUserId) {
    return;
  }
  try {
    let result;
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
    }
    if (result && result.affectedRows > 0) {
      if (adminBootstrapUserId) {
        superAdminIdCache = adminBootstrapUserId;
      }
      console.log("Admin bootstrap applied.");
    }
  } catch (error) {
    console.error("Admin bootstrap failed", error);
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
      console.warn(`MySQL not ready (attempt ${attempt}/${maxAttempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  await ensureSchema();
  await bootstrapAdmin();
};

const start = async () => {
  await initDatabase();
  await connectRedis();

  // Start the HTTP server (WS piggybacks on it).
  server.listen(port, () => {
    console.log(`API listening on ${port}`);
  });
};

start().catch((error) => {
  console.error("API failed to start", error);
  process.exit(1);
});
