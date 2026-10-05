import { tokenSearch } from "../../src/handlers.js";

export function GET(request: Request) {
  return tokenSearch(request);
}
