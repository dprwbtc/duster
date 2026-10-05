import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { getPrices, searchTokens, type TokenMeta } from "./jupiter.js";
import { getHoldings } from "./wallet.js";
import { planSwaps } from "./plan.js";

const apiKey = process.env.JUPITER_API_KEY;
if (!apiKey) {
  console.error("Missing JUPITER_API_KEY (see .env.example)");
  process.exit(1);
}
const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const PORT = Number(process.env.PORT ?? 3000);
const SOL = "So11111111111111111111111111111111111111112";
const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, "../public/index.html"));

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

function pubkey(v: unknown, what: string): PublicKey {
  try {
    if (typeof v !== "string") throw 0;
    return new PublicKey(v);
  } catch {
    throw new HttpError(400, `invalid ${what}`);
  }
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new HttpError(413, "body too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

async function metaFor(mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  for (let i = 0; i < mints.length; i += 100) {
    for (const t of await searchTokens(apiKey!, mints.slice(i, i + 100).join(","))) out.set(t.id, t);
  }
  return out;
}

async function holdingsWithValue(owner: PublicKey) {
  const holdings = (await getHoldings(connection, owner)).filter((h) => h.mint !== SOL);
  const mints = [...new Set(holdings.map((h) => h.mint))];
  const [prices, meta] = await Promise.all([getPrices(apiKey!, mints), metaFor(mints)]);
  return holdings.map((h) => {
    const price = prices[h.mint]?.usdPrice ?? null;
    const m = meta.get(h.mint);
    return {
      h,
      price,
      usd: price === null ? null : h.uiAmount * price,
      symbol: m?.symbol ?? null,
      name: m?.name ?? null,
      icon: m?.icon ?? null,
      verified: !!m?.isVerified,
    };
  });
}

type Handler = (req: http.IncomingMessage, url: URL) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "GET /api/holdings": async (_req, url) => {
    const owner = pubkey(url.searchParams.get("owner"), "owner");
    const rows = await holdingsWithValue(owner);
    return rows.map(({ h, ...r }) => ({
      mint: h.mint,
      amount: h.uiAmount,
      frozen: h.frozen,
      ...r,
    }));
  },

  "GET /api/tokens/search": async (_req, url) => {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q || q.length > 200) return [];
    const res = await searchTokens(apiKey!, q);
    return res.slice(0, 20).map((t) => ({
      id: t.id,
      symbol: t.symbol,
      name: t.name,
      icon: t.icon ?? null,
      decimals: t.decimals,
      verified: !!t.isVerified,
    }));
  },

  "POST /api/plan": async (req) => {
    const b = await readJson(req);
    const owner = pubkey(b.owner, "owner");
    const outMint = pubkey(b.outMint, "outMint").toBase58();
    if (!Array.isArray(b.mints) || b.mints.length === 0 || b.mints.length > 200) throw new HttpError(400, "select 1-200 tokens");
    const wanted = new Set<string>(b.mints.map((m: unknown) => pubkey(m, "mint").toBase58()));
    wanted.delete(outMint);
    const slippageBps = Math.min(Math.max(Math.round(Number(b.slippageBps ?? 100)), 1), 2000);
    const maxLoss = Math.min(Math.max(Number(b.maxLossPct ?? 10), 0), 100) / 100;

    // Re-read balances and prices server-side; never trust amounts from the browser.
    const rows = await holdingsWithValue(owner);
    const outPrice = (await getPrices(apiKey!, [outMint]))[outMint];
    if (!outPrice) throw new HttpError(400, "no reliable price for the output token, so swaps can't be sanity-checked");

    const skipped: { mint: string; reason: string }[] = [];
    const items: { h: (typeof rows)[number]["h"]; usd: number }[] = [];
    for (const mint of wanted) {
      const r = rows.find((x) => x.h.mint === mint);
      if (!r) skipped.push({ mint, reason: "not in wallet" });
      else if (r.h.frozen) skipped.push({ mint, reason: "account frozen" });
      else if (r.usd === null) skipped.push({ mint, reason: "no reliable price" });
      else items.push({ h: r.h, usd: r.usd });
    }

    const plan = await planSwaps({
      connection,
      apiKey: apiKey!,
      owner,
      outMint,
      outInfo: outPrice,
      items,
      slippageBps,
      maxAccounts: 20,
      maxLoss,
      closeSource: b.closeAccounts !== false,
    });
    skipped.push(...plan.skipped);
    return {
      skipped,
      txs: plan.batches.map((bt) => {
        const bytes = bt.tx.serialize();
        return {
          tx: Buffer.from(bytes).toString("base64"),
          bytes: bytes.length,
          lastValidBlockHeight: bt.lastValidBlockHeight,
          legs: bt.legs.map((l) => ({
            mint: l.holding.mint,
            usdIn: l.usdIn,
            outAmount: Number(l.build.outAmount) / 10 ** outPrice.decimals,
          })),
        };
      }),
    };
  },

  "POST /api/send": async (req) => {
    const b = await readJson(req);
    if (!Array.isArray(b.txs) || b.txs.length === 0 || b.txs.length > 20) throw new HttpError(400, "bad txs");
    const sigs: (string | { error: string })[] = [];
    for (const t of b.txs) {
      try {
        sigs.push(await connection.sendRawTransaction(Buffer.from(String(t), "base64"), { maxRetries: 3 }));
      } catch (e) {
        sigs.push({ error: (e as Error).message.slice(0, 300) });
      }
    }
    return sigs;
  },

  "GET /api/status": async (_req, url) => {
    const sigs = (url.searchParams.get("sigs") ?? "").split(",").filter(Boolean).slice(0, 20);
    const { value } = await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true });
    return value.map((v) => (v ? { status: v.confirmationStatus, err: v.err } : null));
  },
};

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(body);
  };
  try {
    // Only answer requests addressed to localhost (blocks DNS-rebinding from other sites).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "localhost" && host !== "127.0.0.1") throw new HttpError(403, "forbidden host");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return send(200, page, "text/html; charset=utf-8");
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, "not found");
    if (req.method === "POST" && !String(req.headers["content-type"]).startsWith("application/json")) throw new HttpError(415, "json only");
    send(200, JSON.stringify(await handler(req, url)), "application/json");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(status, JSON.stringify({ error: (e as Error).message }), "application/json");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Bulk Swap UI: http://localhost:${PORT}`));
