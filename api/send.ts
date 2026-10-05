import { send } from "../src/handlers.js";

export function POST(request: Request) {
  return send(request);
}
