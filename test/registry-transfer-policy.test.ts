import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { RegistryClient } from "../packages/oci/registry.ts";
import { registryHost } from "../packages/oci/registry-host.ts";
import { parseReference } from "../packages/oci/source.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { media } from "../packages/oci/types.ts";
import { temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("bracketed IPv6 registries retain ports and scoped authentication", async () => {
  expect(parseReference("[2001:db8::1]:443/team/app:tag")).toEqual({ registry: "[2001:db8::1]:443", repository: "team/app", reference: "tag" });
  expect(registryHost("[0:0:0:0:0:0:0:1]:443", true)).toBe("[::1]");
  const client = new RegistryClient("[::1]:80", { insecure: ["[::1]:80"], credentials: async (host) => { expect(host).toBe("[::1]:80"); return { username: "user", password: "test" }; }, fetcher: async (url, init) => {
    expect(new URL(url).origin).toBe("http://[::1]");
    return new Headers(init?.headers).has("Authorization") ? new Response(null, { status: 200 }) : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="registry"' } });
  } });
  expect((await client.request("/v2/team/app/manifests/latest")).status).toBe(200);
  for (const host of ["::1", "[:::1]", "[::1]:99999", "[::1]/path", "user@[::1]", "[fe80::1%25eth0]"]) expect(() => registryHost(host)).toThrow();
});

async function upload(host: string, minimum?: string, disconnect = false) {
  const root = await temporary(); roots.push(root);
  const registry = new MockRegistry(), store = new BlobStore(root), size = 20 * 1024 * 1024 + 1;
  const descriptor = await store.put(Buffer.alloc(size, 7), media.gzip);
  let sessions = 0, failed = false;
  const publisher = new Publisher(`${host}/app`, { credentials: async () => undefined, sleep: async () => {}, fetcher: async (url, init) => {
    if (disconnect && !failed && init?.method === "PUT") { failed = true; throw new Error("connection closed before upload completion"); }
    const response = await registry.fetch(url, init);
    if (init?.method === "POST" && response.status === 202) { sessions++; if (minimum !== undefined && sessions === 1) response.headers.set("OCI-Chunk-Min-Length", minimum); }
    return response;
  } });
  await publisher.blob(store, descriptor);
  expect(registry.blobs.get(`${host}/app/${descriptor.digest}`)?.length).toBe(size);
  return registry.requests;
}

test("registry minimum chunks control nonfinal PATCH sizes", async () => {
  const requests = await upload("registry.example", String(12 * 1024 * 1024));
  expect(requests.filter((r) => r.method === "PATCH").map((r) => r.headers.get("Content-Length"))).toEqual([String(12 * 1024 * 1024), String(8 * 1024 * 1024 + 1)]);
});

test.each(["9999999999999999999999999", "-1", "invalid", String(64 * 1024 * 1024)])("large or malformed chunk minimums use bounded streamed PUT", async (minimum) => {
  expect((await upload("registry.example", minimum, true)).some((r) => r.method === "PATCH")).toBe(false);
});

test.each(["gcr.io", "us.gcr.io", "eu.gcr.io", "asia.gcr.io"])("Google registry endpoint %s uses monolithic upload", async (host) => {
  expect((await upload(host)).some((r) => r.method === "PATCH")).toBe(false);
});
