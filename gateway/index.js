const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "dev-secret";
const businessApiUrl = process.env.BUSINESS_API_URL || "http://api:4000";

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

app.post("/auth/register", (req, res) => {
  const { email } = req.body || {};
  res.json({ ok: true, message: "stub", email: email || null });
});

app.post("/auth/login", (req, res) => {
  const { email } = req.body || {};
  const token = jwt.sign({ sub: email || "anonymous" }, jwtSecret, { expiresIn: "1h" });
  res.json({ token });
});

const apiProxy = createProxyMiddleware({
  target: businessApiUrl,
  changeOrigin: true,
  pathRewrite: { "^/api": "" }
});

const wsProxy = createProxyMiddleware({
  target: businessApiUrl,
  changeOrigin: true,
  ws: true
});

app.use("/api", apiProxy);
app.use("/ws", wsProxy);

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/ws")) {
    wsProxy.upgrade(req, socket, head);
  }
});

server.listen(port, () => {
  console.log(`Gateway listening on ${port}`);
});
