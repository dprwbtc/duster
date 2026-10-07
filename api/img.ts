import { img } from "../src/handlers.js";

// Node runtime (sharp is a native module). Resolving metadata, fetching it and re-encoding the image is capped
// at about 11s inside the handler; this leaves headroom.
export const config = { maxDuration: 15 };

export function GET(request: Request) {
  return img(request);
}
