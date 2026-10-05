import { plan } from "../src/handlers.js";

// Quoting many tokens and simulating each transaction can take a while.
export const config = { maxDuration: 60 };

export function POST(request: Request) {
  return plan(request);
}
