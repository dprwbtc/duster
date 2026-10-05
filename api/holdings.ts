import { holdings } from "../src/handlers.js";

export function GET(request: Request) {
  return holdings(request);
}
