// Gateway service: handles auth stubs and proxies traffic to the business API.
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
// Runtime configuration (defaults match docker-compose service names/ports).
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "dev-secret";
const businessApiUrl = process.env.BUSINESS_API_URL || "http://api:4000";

// Allow browser clients and parse JSON request bodies.
app.use(cors());
app.use(express.json());

// Basic health endpoint used by probes.
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

// Registration stub: returns a placeholder response for now.
app.post("/auth/register", (req, res) => {
  const { email } = req.body || {};
  res.json({ ok: true, message: "stub", email: email || null });
});

// Login stub: issues a signed JWT for the provided email.
app.post("/auth/login", (req, res) => {
  const { email } = req.body || {};
  const token = jwt.sign({ sub: email || "anonymous" }, jwtSecret, { expiresIn: "1h" });
  res.json({ token });
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

// Start listening for gateway requests.
server.listen(port, () => {
  console.log(`Gateway listening on ${port}`);
});
