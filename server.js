const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");

// Static assets: PWA manifest/service-worker/icons + the roadmap PDF gallery.
// Everything here is a plain file read — no external calls, no API keys.
const STATIC_FILES = {
  "/manifest.json": { file: "manifest.json", type: "application/manifest+json; charset=utf-8", cache: "public, max-age=3600" },
  "/sw.js": { file: "sw.js", type: "application/javascript; charset=utf-8", cache: "no-cache" },
  "/favicon.png": { file: "favicon.png", type: "image/png", cache: "public, max-age=86400" },
  "/icons/icon-192.png": { file: "icons/icon-192.png", type: "image/png", cache: "public, max-age=86400" },
  "/icons/icon-512.png": { file: "icons/icon-512.png", type: "image/png", cache: "public, max-age=86400" },
  "/roadmap-gallery.pdf": { file: "roadmap-gallery.pdf", type: "application/pdf", cache: "public, max-age=86400" }
};

function send(res, status, type, data, extraHeaders) {
  res.writeHead(status, Object.assign({
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin"
  }, extraHeaders || {}));
  res.end(data);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      if (!fs.existsSync(INDEX_FILE)) return send(res, 500, "text/plain; charset=utf-8", "index.html not found");
      return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(INDEX_FILE, "utf8"));
    }
    if (req.method === "GET" && STATIC_FILES[u.pathname]) {
      const spec = STATIC_FILES[u.pathname];
      const fp = path.join(ROOT, spec.file);
      if (!fs.existsSync(fp)) return send(res, 404, "text/plain; charset=utf-8", "Not found");
      return send(res, 200, spec.type, fs.readFileSync(fp), { "cache-control": spec.cache });
    }
    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  } catch (e) {
    return send(res, 500, "text/plain; charset=utf-8", "server error");
  }
});
server.listen(PORT, () => console.log(`Applied AI Roadmap server listening on ${PORT}`));
