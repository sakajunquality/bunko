import { expect, test } from "bun:test";
import { RegistryClient } from "../packages/oci/registry.ts";

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) test(`stalled registry ${method} is bounded without replaying the write`, async () => {
  let requests = 0;
  const client = new RegistryClient("registry.test", { headersTimeoutMs: 30, bodyIdleTimeoutMs: 30, credentials: async () => undefined, fetcher: async (_url, init) => {
    requests++;
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
  } });
  await expect(client.request("/v2/test/blobs/uploads/", { method, ...(method === "PUT" || method === "PATCH" ? { body: new Uint8Array(1024) } : {}) })).rejects.toThrow("connection failed");
  expect(requests).toBe(1);
});

test("upload progress can exceed the idle deadline without a total-transfer timeout", async () => {
  let chunks = 0;
  const client = new RegistryClient("registry.test", { headersTimeoutMs: 60, bodyIdleTimeoutMs: 60, credentials: async () => undefined, fetcher: async (_url, init) => {
    const stream = init!.body as ReadableStream<Uint8Array>, reader = stream.getReader();
    while (!(await reader.read()).done) { await Bun.sleep(20); expect(init!.signal!.aborted).toBe(false); }
    return new Response(null, { status: 201 });
  } });
  expect((await client.request("/v2/test/blobs/uploads/id", { method: "PATCH", body: new ReadableStream<Uint8Array>({ async pull(output) { await Bun.sleep(20); if (++chunks === 8) output.close(); else output.enqueue(new Uint8Array(1024)); } }) })).status).toBe(201);
});

test("real HTTP writes abort when a server accepts the body but never responds", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { await request.arrayBuffer(); return new Promise<Response>(() => {}); } });
  const host = `127.0.0.1:${server.port}`;
  try {
    const client = new RegistryClient(host, { insecure: [host], headersTimeoutMs: 100, credentials: async () => undefined });
    await expect(client.request("/v2/test/manifests/tag", { method: "PUT", body: "{}" })).rejects.toThrow("connection failed");
  } finally { await server.stop(true); }
});
