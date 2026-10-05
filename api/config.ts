import { config as getConfig } from "../src/handlers.js";

export function GET(request: Request) {
  return getConfig(request);
}
