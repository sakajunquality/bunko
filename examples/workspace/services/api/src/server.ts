import { message } from "@example/shared";
import isNumber from "is-number";
import pkg from "is-number/package.json";
import { xxh32 } from "@node-rs/xxhash";
const server = Bun.serve({ port: 3000, fetch() {
  return Response.json({ service: "api", message, number: isNumber(42), version: pkg.version, hash: xxh32("bunko") });
} });
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
