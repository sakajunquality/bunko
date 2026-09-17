import assert from "node:assert/strict";
import { createServer } from "node:http";
import { RegistryClient } from "../packages/oci/registry.ts";

if (process.argv[2] === "stalled") {
  let received = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.arrayBuffer(); received = true; return new Promise<Response>(() => {});
  } });
  const host = `127.0.0.1:${server.port}`;
  try {
    const client = new RegistryClient(host, { insecure: [host], writeTimeoutMs: 300, credentials: async () => undefined });
    await assert.rejects(client.request("/v2/test/manifests/tag", { method: "PUT", body: "{}" }), /connection failed/);
    assert.equal(received, true);
  } finally { await server.stop(true); }
} else if (process.argv[2] === "slow-reader") {
  let received = 0, sourceEOF = false;
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { received += chunk.length; request.pause(); setTimeout(() => request.resume(), 10); });
    request.on("end", () => { response.writeHead(201); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const host = `127.0.0.1:${address.port}`;
  let chunks = 0;
  try {
    const client = new RegistryClient(host, { insecure: [host], headersTimeoutMs: 50, bodyIdleTimeoutMs: 50, writeTimeoutMs: 15000, credentials: async () => undefined });
    const body = new ReadableStream<Uint8Array>({ pull(output) {
      if (chunks++ === 256) { sourceEOF = true; output.close(); }
      else output.enqueue(new Uint8Array(65536));
    } });
    assert.equal((await client.request("/v2/test/blobs/uploads/id", { method: "PUT", body })).status, 201);
    assert.equal(sourceEOF, true);
    assert.equal(received, 256 * 65536);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
} else throw new Error("Unknown HTTP fixture scenario");
console.log("ok");
