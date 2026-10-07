import { refresh } from "../src/handlers.js";

export function POST(request: Request) {
  return refresh(request);
}
