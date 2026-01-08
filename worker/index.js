// Worker service: publishes odds and processes payout jobs.
const http = require("http");
const mysql = require("mysql2/promise");
const { createClient } = require("redis");
const pino = require("pino");
const promClient = require("prom-client");

// Runtime configuration for Redis connection and publish cadence.
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";
const intervalMs = Number(process.env.ODDS_INTERVAL_MS || 2500);
const payoutQueueName = process.env.PAYOUT_QUEUE || "payout_jobs";
const payoutPollIntervalMs = Number(process.env.PAYOUT_POLL_INTERVAL_MS || 5000);
const payoutMaxAttemptsRaw = Number(process.env.PAYOUT_MAX_ATTEMPTS || 5);
const payoutMaxAttempts = Number.isFinite(payoutMaxAttemptsRaw) && payoutMaxAttemptsRaw > 0
  ? payoutMaxAttemptsRaw
  : 5;
const payoutBackoffBaseMsRaw = Number(process.env.PAYOUT_BACKOFF_BASE_MS || 10000);
const payoutBackoffBaseMs = Number.isFinite(payoutBackoffBaseMsRaw) && payoutBackoffBaseMsRaw > 0
  ? payoutBackoffBaseMsRaw
  : 10000;
const payoutBackoffMaxMsRaw = Number(process.env.PAYOUT_BACKOFF_MAX_MS || 5 * 60 * 1000);
const payoutBackoffMaxMs = Number.isFinite(payoutBackoffMaxMsRaw) && payoutBackoffMaxMsRaw > 0
  ? payoutBackoffMaxMsRaw
  : 5 * 60 * 1000;
const payoutDelayedSetName = process.env.PAYOUT_DELAYED_SET || "payout_jobs_delayed";
const payoutDeadLetterQueueName = process.env.PAYOUT_DEAD_LETTER_QUEUE || "payout_jobs_dead";
const metricsPort = Number(process.env.METRICS_PORT || 9102);
const logLevel = process.env.LOG_LEVEL || "info";

// MySQL configuration.
const dbHost = process.env.DB_HOST || "mysql";
const dbPort = Number(process.env.DB_PORT || 3306);
const dbName = process.env.DB_NAME || "efrei";
const dbUser = process.env.DB_USER || "efrei";
const dbPassword = process.env.DB_PASSWORD || "efrei";

let dbPool = null;
let superAdminIdCache = null;
let redisQueueClient = null;

const logger = pino({
  level: logLevel,
  base: { service: "worker" },
  timestamp: pino.stdTimeFunctions.isoTime
});

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: "worker_" });

const payoutJobsTotal = new promClient.Counter({
  name: "worker_payout_jobs_total",
  help: "Total payout jobs processed",
  labelNames: ["status"],
  registers: [metricsRegistry]
});

const payoutJobAttemptsTotal = new promClient.Counter({
  name: "worker_payout_job_attempts_total",
  help: "Total payout job attempts",
  labelNames: ["status"],
  registers: [metricsRegistry]
});

const payoutJobDuration = new promClient.Histogram({
  name: "worker_payout_job_duration_seconds",
  help: "Payout job duration in seconds",
  labelNames: ["status"],
  registers: [metricsRegistry]
});

const payoutQueueDepth = new promClient.Gauge({
  name: "worker_payout_queue_depth",
  help: "Current payout queue depth",
  registers: [metricsRegistry]
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calculateBackoffMs = (attempt) => {
  const exponent = Math.max(0, Number(attempt) - 1);
  const baseDelay = Math.min(payoutBackoffBaseMs * 2 ** exponent, payoutBackoffMaxMs);
  const jitter = Math.floor(baseDelay * (Math.random() * 0.2));
  return baseDelay + jitter;
};

const scheduleDelayedRetry = async (jobId, nextAttemptAtMs) => {
  if (!redisQueueClient) {
    return;
  }
  await redisQueueClient.zAdd(payoutDelayedSetName, {
    score: Number(nextAttemptAtMs),
    value: String(jobId)
  });
};

const moveDueDelayedJobs = async () => {
  if (!redisQueueClient) {
    return;
  }
  const now = Date.now();
  const due = await redisQueueClient.zRangeByScore(payoutDelayedSetName, 0, now, { LIMIT: { offset: 0, count: 50 } });
  if (!due.length) {
    return;
  }
  const ids = due.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  if (!ids.length) {
    return;
  }
  const batch = redisQueueClient.multi();
  due.forEach((value) => {
    batch.zRem(payoutDelayedSetName, value);
    batch.lPush(payoutQueueName, value);
  });
  await batch.exec();
  await dbPool.query(
    `UPDATE payout_jobs
     SET status = 'queued', next_attempt_at = NULL, updated_at = NOW()
     WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
};

// Static sample matches used to fabricate odds for the demo.
const matches = [
  { id: "match-1", league: "Ligue 1", home: "Paris FC", away: "Lyon" },
  { id: "match-2", league: "Premier League", home: "Chelsea", away: "Arsenal" },
  { id: "match-3", league: "Serie A", home: "Roma", away: "Napoli" },
  { id: "match-4", league: "La Liga", home: "Valencia", away: "Sevilla" }
];

// Utility to generate a random odd between min and max with 2 decimals.
const randomOdd = (min, max) => {
  const value = Math.random() * (max - min) + min;
  return Number(value.toFixed(2));
};

// Build the payload with randomized starts and market prices.
const buildOdds = () => {
  const now = Date.now();
  return matches.map((match) => {
    return {
      id: match.id,
      league: match.league,
      home: match.home,
      away: match.away,
      startsAt: new Date(now + Math.floor(Math.random() * 90 + 15) * 60000).toISOString(),
      markets: [
        { id: `${match.id}-home`, label: match.home, price: randomOdd(1.6, 3.1) },
        { id: `${match.id}-draw`, label: "Draw", price: randomOdd(2.8, 4.2) },
        { id: `${match.id}-away`, label: match.away, price: randomOdd(1.9, 3.6) }
      ]
    };
  });
};

const feeRate = 0.02;
const calculateFee = (amount) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(amount * feeRate));
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
  if (!action) return;
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
  return { before, after };
};

const getSuperAdminId = async (connection) => {
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

const creditFeeToSuperAdmin = async (connection, feePoints, context = {}) => {
  if (!feePoints) return;
  const superAdminId = await getSuperAdminId(connection);
  if (!superAdminId) return;
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

const markJobFailed = async (connection, jobId, message, attempt = 1, maxAttempts = payoutMaxAttempts) => {
  const errorMessage = message || "Unknown error";
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? attempt : 1;
  const safeMax = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : payoutMaxAttempts;
  if (safeAttempt >= safeMax) {
    await connection.query(
      `UPDATE payout_jobs
       SET status = 'dead',
           error_message = ?,
           last_error_at = NOW(),
           dead_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [errorMessage, jobId]
    );
    payoutJobsTotal.inc({ status: "dead" });
    payoutJobAttemptsTotal.inc({ status: "failed" });
    if (redisQueueClient) {
      await redisQueueClient.lPush(payoutDeadLetterQueueName, String(jobId));
    }
    logger.error({ jobId, attempt: safeAttempt, maxAttempts: safeMax, error: errorMessage }, "Payout job dead");
    return { status: "dead" };
  }
  const delayMs = calculateBackoffMs(safeAttempt);
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await connection.query(
    `UPDATE payout_jobs
     SET status = 'retry_wait',
         error_message = ?,
         last_error_at = NOW(),
         next_attempt_at = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [errorMessage, nextAttemptAt, jobId]
  );
  payoutJobsTotal.inc({ status: "retry_wait" });
  payoutJobAttemptsTotal.inc({ status: "failed" });
  await scheduleDelayedRetry(jobId, nextAttemptAt.getTime());
  logger.warn({
    jobId,
    attempt: safeAttempt,
    maxAttempts: safeMax,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: errorMessage
  }, "Payout job retry scheduled");
  return { status: "retry_wait", nextAttemptAt };
};

const processPayoutJob = async (jobId) => {
  const connection = await dbPool.getConnection();
  const startedAt = process.hrtime.bigint();
  let attempt = 0;
  let maxAttempts = payoutMaxAttempts;
  try {
    await connection.beginTransaction();
    const [jobRows] = await connection.query("SELECT * FROM payout_jobs WHERE id = ? FOR UPDATE", [jobId]);
    if (!jobRows.length) {
      await connection.rollback();
      return;
    }
    const job = jobRows[0];
    maxAttempts = Number(job.max_attempts || payoutMaxAttempts);
    if (job.status === "completed" || job.status === "dead") {
      await connection.rollback();
      return;
    }
    if (job.status === "processing" && job.started_at) {
      const runningForMs = Date.now() - new Date(job.started_at).getTime();
      if (Number.isFinite(runningForMs) && runningForMs < 15 * 60 * 1000) {
        await connection.rollback();
        return;
      }
    }
    if (job.next_attempt_at) {
      const nextAttemptAt = new Date(job.next_attempt_at).getTime();
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) {
        await connection.rollback();
        await scheduleDelayedRetry(jobId, nextAttemptAt);
        return;
      }
    }

    attempt = Number(job.attempts || 0) + 1;
    await connection.query(
      "UPDATE payout_jobs SET status = 'processing', started_at = NOW(), attempts = ?, error_message = NULL WHERE id = ?",
      [attempt, jobId]
    );
    payoutJobAttemptsTotal.inc({ status: "started" });

    const betId = Number(job.bet_id);
    const resultOptionId = Number(job.result_option_id || 0);
    if (!betId || !resultOptionId) {
      throw new Error("Missing bet_id or result_option_id");
    }

    const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
    if (!betRows.length) {
      throw new Error("Bet not found");
    }
    const bet = betRows[0];
    if (bet.status === "resolved" && bet.resolved_at) {
      await connection.query(
        "UPDATE payout_jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?",
        [jobId]
      );
      await connection.commit();
      const durationSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
      payoutJobsTotal.inc({ status: "completed" });
      payoutJobDuration.observe({ status: "completed" }, durationSec);
      payoutJobAttemptsTotal.inc({ status: "success" });
      return;
    }

    const [optionRows] = await connection.query(
      "SELECT id FROM bet_options WHERE id = ? AND bet_id = ?",
      [resultOptionId, betId]
    );
    if (!optionRows.length) {
      throw new Error("Result option not found");
    }

    const [positions] = await connection.query(
      "SELECT * FROM bet_positions WHERE bet_id = ? AND status = 'open' FOR UPDATE",
      [betId]
    );

    const payoutsByUser = new Map();
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
      }
      totalFees += fee;
      await connection.query(
        "UPDATE bet_positions SET status = 'settled', payout_points = ?, settled_at = NOW(), updated_at = NOW() WHERE id = ?",
        [netPayout, position.id]
      );
    }

    for (const [userId, payout] of payoutsByUser.entries()) {
      await applyPointsDelta(connection, {
        userId,
        delta: payout,
        actorUserId: Number(job.resolved_by) || null,
        action: "bet_payout",
        reason: "bet_resolve",
        relatedEntityType: "bet",
        relatedEntityId: betId
      });
    }

    await creditFeeToSuperAdmin(connection, totalFees, {
      actorUserId: Number(job.resolved_by) || null,
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

    await logAudit(connection, {
      actorUserId: Number(job.resolved_by) || null,
      action: "bet_resolve",
      reason: "bet_resolve",
      relatedEntityType: "bet",
      relatedEntityId: betId,
      metadata: { resultOptionId, totalFees, payouts: Object.fromEntries(payoutsByUser) }
    });

    await connection.query(
      "UPDATE payout_jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?",
      [jobId]
    );

    await connection.commit();
    const durationSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
    payoutJobsTotal.inc({ status: "completed" });
    payoutJobDuration.observe({ status: "completed" }, durationSec);
    payoutJobAttemptsTotal.inc({ status: "success" });
    logger.info({ jobId, betId, resultOptionId, totalFees, attempt }, "Payout job completed");
  } catch (error) {
    await connection.rollback();
    try {
      await markJobFailed(connection, jobId, error?.message || "Unknown error", attempt || 1, maxAttempts);
    } catch (updateError) {
      logger.error({ err: updateError }, "Failed to mark payout job failed");
    }
    const durationSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
    payoutJobDuration.observe({ status: "failed" }, durationSec);
    logger.error({ jobId, attempt, maxAttempts, err: error }, "Payout job error");
  } finally {
    connection.release();
  }
};

const pollQueuedJobs = async () => {
  const [rows] = await dbPool.query(
    `SELECT id
     FROM payout_jobs
     WHERE status = 'queued'
        OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
        OR (status = 'processing' AND started_at IS NOT NULL AND started_at < (NOW() - INTERVAL 15 MINUTE))
     ORDER BY created_at ASC
     LIMIT 10`
  );
  for (const row of rows) {
    await processPayoutJob(Number(row.id));
  }
};

const listenToQueue = async (queueClient) => {
  while (true) {
    try {
      const result = await queueClient.brPop(payoutQueueName, 0);
      if (result && result.element) {
        const jobId = Number(result.element);
        if (Number.isFinite(jobId) && jobId > 0) {
          await processPayoutJob(jobId);
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Queue listener error");
      await sleep(1000);
    }
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
      await sleep(2000);
    }
  }
};

const waitForSchema = async () => {
  const requiredTables = [
    "audit_logs",
    "bet_options",
    "bet_positions",
    "bets",
    "payout_jobs",
    "users"
  ];
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [rows] = await dbPool.query(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME IN (${requiredTables.map(() => "?").join(",")})`,
      [dbName, ...requiredTables]
    );
    const found = new Set(rows.map((row) => row.TABLE_NAME));
    const missing = requiredTables.filter((table) => !found.has(table));
    if (!missing.length) {
      return;
    }
    if (attempt === maxAttempts) {
      throw new Error(`Missing required tables: ${missing.join(", ")}`);
    }
    logger.warn({ attempt, maxAttempts, missing }, "Schema not ready, waiting");
    await sleep(2000);
  }
};

const startMetricsServer = () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
      res.end(await metricsRegistry.metrics());
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  server.listen(metricsPort, () => {
    logger.info({ metricsPort }, "Worker metrics listening");
  });
};

// Connect to Redis, publish once, then publish on an interval.
const start = async () => {
  await initDatabase();
  await waitForSchema();

  const client = createClient({ url: `redis://${redisHost}:${redisPort}` });
  client.on("error", (err) => logger.error({ err }, "Redis error"));
  await client.connect();

  const queueClient = client.duplicate();
  queueClient.on("error", (err) => logger.error({ err }, "Redis queue error"));
  await queueClient.connect();
  redisQueueClient = queueClient;

  const updateQueueDepth = async () => {
    try {
      const depth = await queueClient.lLen(payoutQueueName);
      payoutQueueDepth.set(Number(depth || 0));
    } catch (error) {
      logger.warn({ err: error }, "Failed to read payout queue depth");
    }
  };
  await updateQueueDepth();

  // Compose and publish the odds message to the channel.
  const publish = async () => {
    const payload = {
      type: "odds",
      updatedAt: new Date().toISOString(),
      events: buildOdds()
    };
    await client.publish(oddsChannel, JSON.stringify(payload));
  };

  // Publish immediately so the API has data right away.
  await publish();
  // Continue publishing at the configured interval.
  setInterval(() => {
    publish().catch((error) => logger.error({ err: error }, "Publish error"));
  }, intervalMs);

  // Start payout job queue listener.
  listenToQueue(queueClient).catch((error) => logger.error({ err: error }, "Queue listener stopped"));

  // Fallback polling in case the queue is empty or Redis is down.
  setInterval(() => {
    pollQueuedJobs().catch((error) => logger.error({ err: error }, "Payout poll error"));
  }, payoutPollIntervalMs);

  // Move delayed retries back into the main queue.
  setInterval(() => {
    moveDueDelayedJobs().catch((error) => logger.error({ err: error }, "Delayed retry move failed"));
  }, 1000);

  setInterval(() => {
    updateQueueDepth().catch((error) => logger.error({ err: error }, "Queue depth update failed"));
  }, Math.max(1000, Math.floor(payoutPollIntervalMs / 2)));

  startMetricsServer();
  logger.info({ oddsChannel, intervalMs }, "Odds worker started");
  logger.info({ payoutQueueName }, "Payout worker listening");
};

// Bootstrap the worker and exit on fatal failure.
start().catch((error) => {
  logger.error({ err: error }, "Worker failed to start");
  process.exit(1);
});
