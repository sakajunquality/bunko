import { afterEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { RegistryClient, RegistryError, RegistryNetworkDisabledError } from "../packages/oci/registry.ts";
import { media } from "../packages/oci/types.ts";
import { offlineOptions } from "../packages/bunko/offline.ts";
import { temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const anonymous = async () => undefined;
async function input() {
  const root = await temporary(); roots.push(root);
  const store = new BlobStore(root), bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  return { store, bytes, descriptor: await store.put(bytes, media.gzip) };
}

test.each([404, 410])("expired upload status %s restarts from byte zero after a committed chunk", async (status) => {
  const { store, bytes, descriptor } = await input(), registry = new MockRegistry();
  let patches = 0, expired = false; const delays: number[] = [];
  const publisher = new Publisher("registry.example/app", { credentials: anonymous, sleep: async (ms) => { delays.push(ms); }, fetcher: async (url, init) => {
    const response = await registry.fetch(url, init);
    if (init?.method === "PATCH" && ++patches === 2) {
      await registry.fetch(url, { method: "DELETE" }); expired = true;
      throw new Error("Connection lost");
    }
    if ((!init?.method || init.method === "GET") && expired && new URL(url).pathname.includes("/uploads/")) { expired = false; return new Response(null, { status }); }
    return response;
  } });
  expect((await publisher.blob(store, descriptor)).action).toBe("uploaded");
  expect(registry.blobs.get(`registry.example/app/${descriptor.digest}`)).toEqual(bytes);
  expect(patches).toBe(4); expect(delays).toHaveLength(1);
});

test("repeated upload expiration is bounded even when each session accepts one chunk", async () => {
  const { store, descriptor } = await input(), registry = new MockRegistry(); let patches = 0;
  const publisher = new Publisher("registry.example/app", { credentials: anonymous, sleep: async () => {}, fetcher: async (url, init) => {
    const response = await registry.fetch(url, init);
    if (init?.method === "PATCH" && ++patches % 2 === 0) { await registry.fetch(url, { method: "DELETE" }); throw new Error("Connection lost"); }
    return response;
  } });
  await expect(publisher.blob(store, descriptor)).rejects.toThrow("repeatedly expired");
  expect(patches).toBe(8);
});

test("expired scoped tokens refresh before sending an upload body and unquoted parameters are accepted", async () => {
  let now = 1000, tokens = 0; const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sent: (string | null)[] = [];
  try {
    const client = new RegistryClient("registry.example", { credentials: anonymous, fetcher: async (url, init) => {
      if (new URL(url).hostname === "auth.example") {
        expect(new URL(url).searchParams.get("service")).toBe("registry.example");
        return Response.json({ token: `token-${++tokens}`, expires_in: 2 });
      }
      const auth = new Headers(init?.headers).get("Authorization");
      if (init?.method === "PATCH") sent.push(auth);
      return auth ? new Response(null, { status: 202 }) : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token", service=registry.example' } });
    } });
    await client.request("/v2/app/blobs/x", { method: "HEAD" }, ["repository:app:pull,push"]);
    now += 2000;
    await client.request("/v2/app/blobs/uploads/1", { method: "PATCH", body: "bytes" }, ["repository:app:pull,push"]);
    expect(tokens).toBe(2); expect(sent).toEqual(["Bearer token-2"]);
  } finally { clock.mockRestore(); }
});

test("registry errors retain standard codes but never reflect messages, details, or unknown codes", async () => {
  const client = new RegistryClient("registry.example", { credentials: anonymous, retries: 0, fetcher: async () => Response.json({ errors: [
    { code: "DENIED", message: "SECRET_PAYLOAD", detail: "SECRET_PAYLOAD" },
    { code: "SECRET_PAYLOAD", message: "SECRET_PAYLOAD" }, { code: "MANIFEST_UNKNOWN" },
  ] }, { status: 403 }) });
  try { await client.request("/v2/app/manifests/latest"); throw new Error("Expected rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).codes).toEqual(["DENIED", "MANIFEST_UNKNOWN"]);
    expect(String(error)).not.toContain("SECRET_PAYLOAD");
  }
  const large = new RegistryClient("registry.example", { credentials: anonymous, fetcher: async () => new Response("x".repeat(65537), { status: 403 }) });
  await expect(large.request("/v2/")).rejects.toThrow("Registry GET failed (403)");
});

test("a stalled error body is cancelled without hiding the HTTP failure", async () => {
  let cancelled = false;
  const client = new RegistryClient("registry.example", { credentials: anonymous, fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }) });
  await expect(client.request("/v2/")).rejects.toThrow("Registry GET failed (403)");
  expect(cancelled).toBe(true);
});

test("offline transport rejection retains its type and never retries", async () => {
  const options = offlineOptions({ path: ".", offline: true, baseLayout: "fixture" }); let sleeps = 0;
  const client = new RegistryClient("registry.example", { ...options.registry, retries: 3, sleep: async () => { sleeps++; } });
  await expect(client.request("/v2/")).rejects.toBeInstanceOf(RegistryNetworkDisabledError);
  await expect(client.request("/v2/")).rejects.toThrow("disabled in offline mode");
  expect(sleeps).toBe(0);
});

test("successful nonstandard 2xx upload and manifest responses still require verified remote content", async () => {
  const { store, descriptor } = await input(), registry = new MockRegistry();
  const publisher = new Publisher("registry.example/app", { credentials: anonymous, fetcher: async (url, init) => {
    const response = await registry.fetch(url, init);
    return init?.method === "PUT" && response.ok ? new Response(null, { status: 204, headers: response.headers }) : response;
  } });
  expect((await publisher.blob(store, descriptor)).action).toBe("uploaded");
  const config = await store.put(Buffer.from("{}"), media.config);
  await publisher.blob(store, config);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config, layers: [descriptor] }));
  const manifest = await store.put(bytes, media.manifest);
  await publisher.manifest(store, manifest, "verified");
  expect(registry.manifests.get("registry.example/app/verified")?.bytes).toEqual(bytes);
  const corrupt = new Publisher("registry.example/app", { credentials: anonymous, fetcher: async (url, init) => {
    if ((!init?.method || init.method === "GET") && new URL(url).pathname.includes("/manifests/")) return new Response("corrupt");
    const response = await registry.fetch(url, init);
    return init?.method === "PUT" && response.ok ? new Response(null, { status: 204, headers: response.headers }) : response;
  } });
  await expect(corrupt.manifest(store, manifest, "verified")).rejects.toThrow("published manifest bytes");
});

test("transient mount failures fall back and session creation retries are bounded", async () => {
  const { store, descriptor } = await input(), registry = new MockRegistry(); let mounts = 0, starts = 0;
  store.origins.set(descriptor.digest, { registry: "registry.example", repository: "base" });
  const publisher = new Publisher("registry.example/app", { credentials: anonymous, sleep: async () => {}, fetcher: async (url, init) => {
    if (init?.method === "POST") {
      if (new URL(url).searchParams.has("mount")) { mounts++; return new Response(null, { status: 503 }); }
      if (++starts < 3) return new Response(null, { status: 429 });
    }
    return registry.fetch(url, init);
  } });
  expect((await publisher.blob(store, descriptor)).action).toBe("uploaded");
  expect(mounts).toBe(1); expect(starts).toBe(3);
  let attempts = 0;
  const unavailable = new Publisher("registry.example/other", { credentials: anonymous, sleep: async () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") { attempts++; return new Response(null, { status: 503 }); }
    return new Response(null, { status: 404 });
  } });
  store.origins.delete(descriptor.digest);
  await expect(unavailable.blob(store, descriptor)).rejects.toThrow("Registry POST failed (503)");
  expect(attempts).toBe(3);
});
