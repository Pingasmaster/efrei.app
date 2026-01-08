// Worker service: publishes odds and processes payout jobs.
const mysql = require("mysql2/promise");
const { createClient } = require("redis");

// Runtime configuration for Redis connection and publish cadence.
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";
const intervalMs = Number(process.env.ODDS_INTERVAL_MS || 2500);
const payoutQueueName = process.env.PAYOUT_QUEUE || "payout_jobs";
const payoutPollIntervalMs = Number(process.env.PAYOUT_POLL_INTERVAL_MS || 5000);

// MySQL configuration.
const dbHost = process.env.DB_HOST || "mysql";
const dbPort = Number(process.env.DB_PORT || 3306);
const dbName = process.env.DB_NAME || "efrei";
const dbUser = process.env.DB_USER || "efrei";
const dbPassword = process.env.DB_PASSWORD || "efrei";

let dbPool = null;
let superAdminIdCache = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const markJobFailed = async (connection, jobId, message) => {
  await connection.query(
    "UPDATE payout_jobs SET status = 'failed', error_message = ?, updated_at = NOW() WHERE id = ?",
    [message, jobId]
  );
};

const processPayoutJob = async (jobId) => {
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [jobRows] = await connection.query("SELECT * FROM payout_jobs WHERE id = ? FOR UPDATE", [jobId]);
    if (!jobRows.length) {
      await connection.rollback();
      return;
    }
    const job = jobRows[0];
    if (job.status === "completed") {
      await connection.rollback();
      return;
    }
    if (job.status === "processing" && job.started_at) {
      const startedAt = new Date(job.started_at).getTime();
      if (Number.isFinite(startedAt) && Date.now() - startedAt < 15 * 60 * 1000) {
        await connection.rollback();
        return;
      }
    }

    await connection.query(
      "UPDATE payout_jobs SET status = 'processing', started_at = NOW(), attempts = attempts + 1, error_message = NULL WHERE id = ?",
      [jobId]
    );

    const betId = Number(job.bet_id);
    const resultOptionId = Number(job.result_option_id || 0);
    if (!betId || !resultOptionId) {
      await markJobFailed(connection, jobId, "Missing bet_id or result_option_id");
      await connection.commit();
      return;
    }

    const [betRows] = await connection.query("SELECT * FROM bets WHERE id = ? FOR UPDATE", [betId]);
    if (!betRows.length) {
      await markJobFailed(connection, jobId, "Bet not found");
      await connection.commit();
      return;
    }
    const bet = betRows[0];
    if (bet.status === "resolved" && bet.resolved_at) {
      await connection.query(
        "UPDATE payout_jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?",
        [jobId]
      );
      await connection.commit();
      return;
    }

    const [optionRows] = await connection.query(
      "SELECT id FROM bet_options WHERE id = ? AND bet_id = ?",
      [resultOptionId, betId]
    );
    if (!optionRows.length) {
      await markJobFailed(connection, jobId, "Result option not found");
      await connection.commit();
      return;
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
  } catch (error) {
    await connection.rollback();
    try {
      await connection.query(
        "UPDATE payout_jobs SET status = 'failed', error_message = ?, updated_at = NOW() WHERE id = ?",
        [error?.message || "Unknown error", jobId]
      );
    } catch (updateError) {
      console.error("Failed to mark payout job failed", updateError);
    }
    console.error("Payout job error", error);
  } finally {
    connection.release();
  }
};

const pollQueuedJobs = async () => {
  const [rows] = await dbPool.query(
    "SELECT id FROM payout_jobs WHERE status IN ('queued', 'failed') ORDER BY created_at ASC LIMIT 10"
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
      console.error("Queue listener error", error);
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
      console.warn(`MySQL not ready (attempt ${attempt}/${maxAttempts}), retrying...`);
      await sleep(2000);
    }
  }
};

// Connect to Redis, publish once, then publish on an interval.
const start = async () => {
  await initDatabase();

  const client = createClient({ url: `redis://${redisHost}:${redisPort}` });
  client.on("error", (err) => console.error("Redis error", err));
  await client.connect();

  const queueClient = client.duplicate();
  queueClient.on("error", (err) => console.error("Redis queue error", err));
  await queueClient.connect();

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
    publish().catch((error) => console.error("Publish error", error));
  }, intervalMs);

  // Start payout job queue listener.
  listenToQueue(queueClient).catch((error) => console.error("Queue listener stopped", error));

  // Fallback polling in case the queue is empty or Redis is down.
  setInterval(() => {
    pollQueuedJobs().catch((error) => console.error("Payout poll error", error));
  }, payoutPollIntervalMs);

  console.log(`Odds worker publishing to ${oddsChannel} every ${intervalMs}ms`);
  console.log(`Payout worker listening on ${payoutQueueName}`);
};

// Bootstrap the worker and exit on fatal failure.
start().catch((error) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
