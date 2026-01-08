const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "api" });
});

app.get("/absurde", (req, res) => {
  res.json({ message: "stub", idea: "replace with your business logic" });
});

app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
