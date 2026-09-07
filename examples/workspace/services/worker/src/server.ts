import { message } from "@example/shared";
import isNumber from "is-number";
import pkg from "is-number/package.json";
const server = Bun.serve({ port: 3000, fetch() {
  return Response.json({ service: "worker", message, number: isNumber(42), version: pkg.version });
} });
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
