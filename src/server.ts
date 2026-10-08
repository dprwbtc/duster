// Local dev server: serves public/ (the homepage at /, Spacedust at /dust) and routes /api/* to the same handlers Vercel runs,
// with the same security headers as vercel.json. Run with `npm run web`.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as h from "./handlers.js";

const PORT = Number(process.env.PORT ?? 3000);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const securityHeaders: [string, string][] = vercel.headers[0].headers.map((x: { key: string; value: string }) => [x.key, x.value]);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm" };

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "GET /api/config": h.config,
  "GET /api/holdings": h.holdings,
  "GET /api/tokens/search": h.tokenSearch,
  "POST /api/plan": h.plan,
  "POST /api/refresh": h.refresh,
  "POST /api/send": h.send,
  "GET /api/status": h.status,
  "GET /api/img": h.img,
  "GET /api/accounts": h.accounts,
  "POST /api/reclaim": h.reclaim,
};

async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

http
  .createServer(async (req, res) => {
    for (const [k, v] of securityHeaders) if (k !== "Strict-Transport-Security") res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://localhost");
    // /i/<mint> is the page's image URL; vercel.json rewrites it to /api/img (outside the /api firewall budget)
    const route = routes[`${req.method} ${url.pathname}`] ?? (req.method === "GET" && /^\/i\/[^/]+$/.test(url.pathname) ? h.img : undefined);
    if (route) {
      const r = await route(await toRequest(req));
      // handler headers win over the site-wide ones (the image proxy sends its own CSP and Content-Type);
      // the body goes out as raw bytes, so binary responses (WebP from /api/img) pass through untouched
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.writeHead(r.status);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    // a directory serves its index.html, like Vercel: / is the homepage, /dust is Spacedust
    let file = path.normalize(path.join(publicDir, url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    // never serve dotfiles (.DS_Store and friends), like Vercel
    const dotfile = path.relative(publicDir, file).split(path.sep).some((seg) => seg.startsWith("."));
    if (req.method === "GET" && !dotfile && (file + path.sep).startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const body = fs.readFileSync(file), type = types[path.extname(file)] ?? "application/octet-stream";
      // byte ranges, which Safari needs before it will play a video
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) { res.writeHead(416, { "Content-Range": `bytes */${body.length}` }); return res.end(); }
        res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${body.length}` });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes" });
      return res.end(body);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  })
  .listen(PORT, "127.0.0.1", () => console.log(`lilvader.space: http://localhost:${PORT}  ·  Spacedust: http://localhost:${PORT}/dust`));
