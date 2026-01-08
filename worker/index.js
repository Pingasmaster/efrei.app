// Worker service: generates sample odds and publishes them to Redis.
const { createClient } = require("redis");

// Runtime configuration for Redis connection and publish cadence.
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";
const intervalMs = Number(process.env.ODDS_INTERVAL_MS || 2500);

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

// Connect to Redis, publish once, then publish on an interval.
const start = async () => {
  const client = createClient({ url: `redis://${redisHost}:${redisPort}` });
  client.on("error", (err) => console.error("Redis error", err));
  await client.connect();

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

  console.log(`Odds worker publishing to ${oddsChannel} every ${intervalMs}ms`);
};

// Bootstrap the worker and exit on fatal failure.
start().catch((error) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
