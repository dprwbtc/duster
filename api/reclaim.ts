import { reclaim } from "../src/handlers.js";

// Packing and simulating up to 400 account closes can take a while on a busy RPC.
export const config = { maxDuration: 60 };

export function POST(request: Request) {
  return reclaim(request);
}
