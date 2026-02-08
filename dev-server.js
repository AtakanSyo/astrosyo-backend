// dev-server.js
require("dotenv").config();
const http = require("http");

// import your handler (adjust the path to your file)
const handler = require("./api/observe-tonight"); // <-- CHANGE THIS PATH

const server = http.createServer((req, res) => {
  // Minimal res helpers to mimic Vercel
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    const data = Buffer.from(JSON.stringify(obj));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", data.length);
    res.end(data);
  };

  // Collect body as string (so your readJsonBody works)
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    req.body = body || null;
    try {
      await handler(req, res);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || "Unhandled error" });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Local dev server running on http://localhost:${PORT}`);
});