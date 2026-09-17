import { expect, test } from "bun:test";
import { RegistryClient } from "../packages/oci/registry.ts";

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) test(`stalled registry ${method} is bounded without replaying the write`, async () => {
  let requests = 0;
  const client = new RegistryClient("registry.test", { writeTimeoutMs: 30, credentials: async () => undefined, fetcher: async (_url, init) => {
    requests++;
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
  } });
  await expect(client.request("/v2/test/blobs/uploads/", { method, ...(method === "PUT" || method === "PATCH" ? { body: new Uint8Array(1024) } : {}) })).rejects.toThrow("connection failed");
  expect(requests).toBe(1);
});

test("uploads are independent of read deadlines and respect a separate write budget", async () => {
  let chunks = 0;
  const client = new RegistryClient("registry.test", { headersTimeoutMs: 60, bodyIdleTimeoutMs: 60, writeTimeoutMs: 2000, credentials: async () => undefined, fetcher: async (_url, init) => {
    const stream = init!.body as ReadableStream<Uint8Array>, reader = stream.getReader();
    while (!(await reader.read()).done) { await Bun.sleep(20); expect(init!.signal!.aborted).toBe(false); }
    return new Response(null, { status: 201 });
  } });
  expect((await client.request("/v2/test/blobs/uploads/id", { method: "PATCH", body: new ReadableStream<Uint8Array>({ async pull(output) { await Bun.sleep(20); if (++chunks === 8) output.close(); else output.enqueue(new Uint8Array(1024)); } }) })).status).toBe(201);
});

test.each(["stalled", "slow-reader"])("real HTTP write fixture: %s", async (scenario) => {
  // Bun can retain native proxy state after other tests restore process.env. Exercise real
  // transport in a fresh process with explicit proxy-free loopback fixture environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:https?|all|no)_proxy$/i.test(key)));
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/registry-write-http.fixture.ts`, scenario], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr, stdout }).toEqual({ exit: 0, stderr: "", stdout: "ok\n" });
  } finally { clearTimeout(timer); }
}, 25000);

test.each([0, -1, Infinity, 2147483648])("invalid write timeout %s is rejected", (writeTimeoutMs) => {
  expect(() => new RegistryClient("registry.test", { writeTimeoutMs })).toThrow("write timeout");
});
