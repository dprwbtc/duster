import { accounts } from "../src/handlers.js";

export function GET(request: Request) {
  return accounts(request);
}
