import { status } from "../src/handlers.js";

export function GET(request: Request) {
  return status(request);
}
