// Local dev server: serves public/ and routes /api/* to the same handlers Vercel runs,
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
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "GET /api/holdings": h.holdings,
  "GET /api/tokens/search": h.tokenSearch,
  "POST /api/plan": h.plan,
  "POST /api/send": h.send,
  "GET /api/status": h.status,
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
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const r = await route(await toRequest(req));
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.writeHead(r.status);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const file = path.normalize(path.join(publicDir, url.pathname === "/" ? "index.html" : url.pathname));
    if (req.method === "GET" && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Bulk Swap UI: http://localhost:${PORT}`));
