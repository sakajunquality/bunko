import isNumber from "is-number";
import { xxh32 } from "@node-rs/xxhash";

const server = Bun.serve({
  port: 3000,
  fetch() { return Response.json({ number: isNumber(42), hash: xxh32("bunko"), message: "Hello from bunko dependencies!" }); },
});
process.on("SIGTERM", async () => { await server.stop(true); process.exit(0); });
