// Minimal local dev server for client/. SPA fallback (any non-file path
// returns index.html), correct MIME types, no-store cache headers. Serves
// the client against the currently-deployed plasma-lab + arena-server.
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../client");
const PORT = Number(process.env.PORT || 7788);

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel) rel = "index.html";
  const abs = join(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  try { if (statSync(abs).isFile()) return abs; } catch { return null; }
  return null;
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let abs = resolveFile(url.pathname);
    if (!abs) abs = join(ROOT, "index.html");
    const body = readFileSync(abs);
    const ext = extname(abs);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`m3t4 local dev server at http://localhost:${PORT}/`);
});
