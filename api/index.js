const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { createClient } = require("redis");

const app = express();
const port = process.env.PORT || 4000;
const redisHost = process.env.REDIS_HOST || "redis";
const redisPort = process.env.REDIS_PORT || "6379";
const oddsChannel = process.env.ODDS_CHANNEL || "odds_updates";

let latestOdds = {
  type: "odds",
  updatedAt: new Date().toISOString(),
  events: []
};

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "api" });
});

app.get("/absurde", (req, res) => {
  res.json({ message: "stub", idea: "replace with your business logic" });
});

app.get("/odds", (req, res) => {
  res.json(latestOdds);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/odds" });

const broadcastOdds = (payload) => {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

wss.on("connection", (socket) => {
  socket.send(JSON.stringify(latestOdds));
});

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

connectRedis().catch((error) => {
  console.error("Failed to connect Redis subscriber", error);
});

server.listen(port, () => {
  console.log(`API listening on ${port}`);
});
