// API service: exposes REST + WebSocket odds endpoints and relays Redis updates.
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { createClient } = require("redis");

const app = express();
// Runtime config with Docker-friendly defaults for local dev.
const port = process.env.PORT || 4000;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";

// Last known odds payload kept in memory for fast HTTP/WS replies.
let latestOdds = {
  type: "odds",
  updatedAt: new Date().toISOString(),
  events: []
};

// Allow browser calls from the frontend and parse JSON bodies.
app.use(cors());
app.use(express.json());

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

// Start Redis subscription; keep the process alive even if it fails once.
connectRedis().catch((error) => {
  console.error("Failed to connect Redis subscriber", error);
});

// Start the HTTP server (WS piggybacks on it).
server.listen(port, () => {
  console.log(`API listening on ${port}`);
});
