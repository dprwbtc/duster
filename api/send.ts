import { send } from "../src/handlers.js";

// Sends are paced to the RPC plan's sendTransaction rate (rpc.ts): 30 at 1/s take about 30s.
export const config = { maxDuration: 60 };

export function POST(request: Request) {
  return send(request);
}
