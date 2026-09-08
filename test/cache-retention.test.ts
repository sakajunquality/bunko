import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { LayerCache, cacheKey, cacheTag, packFormat, type CacheRecord } from "../packages/bunko/cache.ts";
import { pruneLocal } from "../packages/bunko/prune.ts";
import { validateCacheOptions } from "../packages/bunko/cache-options.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }
async function record(store: BlobStore, name: string): Promise<CacheRecord> {
  return { schemaVersion: 1, kind: "assets", key: cacheKey(name), packFormat, destination: "/app", platform: null,
    layer: (await packLayer(store, [{ path: "app/data", type: "file", content: Buffer.from(name) }], "assets", 0))!, inventory: [], native: [] };
}

test("ordered cache sources tolerate denied reads and promote hits to the write destination", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "producer")), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const item = await record(store, "shared");
  const producer = new LayerCache(store, { repository: "registry.test/team", registry, log: () => {} });
  await producer.remember(item); await producer.publish();
  const consumer = new LayerCache(new BlobStore(join(root, "consumer")), { readRepositories: ["registry.test/denied", "registry.test/team"], repository: "registry.test/branch", log: () => {},
    registry: { ...registry, fetcher: async (url, init) => new URL(url).pathname.startsWith("/v2/denied/") ? new Response(null, { status: 403 }) : mock.fetch(url, init) } });
  expect((await consumer.get(item.key, "assets"))!.layer).toEqual(item.layer);
  expect(consumer.events[0]).toMatchObject({ status: "registry", source: "registry.test/team" });
  await consumer.publish();
  expect(mock.manifests.has(`registry.test/branch/${cacheTag("assets", item.key)}`)).toBe(true);
  const readOnly = new LayerCache(new BlobStore(join(root, "read-only")), { readRepositories: ["registry.test/branch"], registry, log: () => {} });
  expect(await readOnly.get(item.key, "assets")).toBeDefined();
  const before = mock.requests.length; await readOnly.publish(); expect(mock.requests.length).toBe(before);
  mock.blobs.set(`registry.test/team/${item.layer.descriptor.digest}`, Buffer.from("corruption"));
  const fallback = new LayerCache(new BlobStore(join(root, "fallback")), { readRepositories: ["registry.test/team", "registry.test/branch"], registry, log: () => {} });
  expect(await fallback.get(item.key, "assets")).toBeDefined();
  expect(fallback.events[0]!.source).toBe("registry.test/branch");
  expect(() => validateCacheOptions({ cacheFrom: ["registry.test/team:tag"] })).toThrow("Repository");
  expect(() => validateCacheOptions({ cacheFrom: ["registry.test/team"], registryCache: false })).toThrow("requires");
});

test("quota pruning accounts shared blobs once, previews oldest keys and leaves unknown files untouched", async () => {
  const root = await fixture(), directory = join(root, "cache"), store = new BlobStore(join(root, "store"));
  const cache = new LayerCache(store, { directory, log: () => {} }), first = await record(store, "first"), last = await record(store, "last");
  const shared = { ...first, key: cacheKey("shared alias") };
  for (const [i, item] of [first, shared, last].entries()) {
    await cache.remember(item); await utimes(join(directory, "keys/assets", `${item.key.slice(7)}.json`), i + 1, i + 1);
  }
  const unknown = join(directory, "blobs/sha256", "f".repeat(64)); await writeFile(unknown, "unowned");
  const usage = await pruneLocal(directory, false, 0, Number.MAX_SAFE_INTEGER);
  const metadataSizes = await Promise.all([first, shared, last].map(async (r) => (await readFile(join(directory, "keys/assets", `${r.key.slice(7)}.json`))).length));
  expect(usage.managedBytes).toBe(metadataSizes.reduce((a, b) => a + b, 0) + first.layer.descriptor.size + last.layer.descriptor.size);
  expect(usage.keys).toHaveLength(0);
  const keep = usage.managedBytes - metadataSizes[0]!;
  const preview = await pruneLocal(directory, false, 0, keep);
  expect(preview.keys).toEqual([`assets/${first.key.slice(7)}.json`]); expect(preview.blobs).toHaveLength(0);
  expect(preview.deleted).toHaveLength(0); expect(preview.remainingBytes).toBe(keep);
  const applied = await pruneLocal(directory, true, 0, keep);
  expect(applied.keys).toEqual(preview.keys);
  const final = await pruneLocal(directory, true, 0, 0);
  expect(final.blobs.sort()).toEqual([first.layer.descriptor.digest, last.layer.descriptor.digest].sort());
  expect(final.remainingBytes).toBe(0);
  expect(await readFile(unknown, "utf8")).toBe("unowned");
  await expect(pruneLocal(directory, true, 0, -1)).rejects.toThrow("budget");
});

test("build wiring reads shared cache while cache-write=false prevents remote cache mutations", async () => {
  const { build } = await import("../packages/bunko/build.ts"), { baseLayout, project } = await import("./helpers.ts");
  const root = await fixture(), source = await project(join(root, "source")), base = await baseLayout(join(root, "base")), mock = new MockRegistry();
  const options = { path: source, baseLayout: base, bare: true, localCache: false, gitMetadata: false, registry: { fetcher: mock.fetch, credentials: async () => undefined } };
  await build({ ...options, repo: "registry.test/image-one", cacheRepo: "registry.test/shared" });
  const before = mock.requests.length;
  const result = await build({ ...options, repo: "registry.test/image-two", cacheFrom: ["registry.test/shared"], cacheWrite: false, localCache: true, cacheDir: join(root, "local") });
  expect(result.cache.some((e) => e.kind === "app" && e.status === "registry" && e.source === "registry.test/shared")).toBe(true);
  expect(mock.requests.slice(before).filter((r) => r.method === "PUT" && r.url.pathname.includes("bunko-cache-"))).toHaveLength(0);
  const local = await build({ ...options, push: false, output: join(root, "offline"), localCache: true, cacheDir: join(root, "local"), cacheFrom: ["registry.test/shared"], registry: { credentials: async () => undefined, fetcher: async () => { throw new Error("Unexpected registry request"); } } });
  expect(local.cache.some((e) => e.kind === "app" && e.status === "local")).toBe(true);
});

test("retention CLI refuses conflicting or unsafe budgets and reports managed usage", async () => {
  const { resolve } = await import("node:path"), root = await fixture();
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  const usage = await cli(["cache-info", "--cache-dir", join(root, "absent")]);
  expect(usage.code).toBe(0); expect(JSON.parse(usage.stdout).managedBytes).toBe(0);
  for (const args of [["--keep-bytes", "-1"], ["--keep-bytes", "1", "--older-than", "0"], ["--keep-bytes", "9999999999999999999"], ["--dry-run=false"]]) {
    const result = await cli(["prune", "--cache-dir", join(root, "cache"), ...args]);
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
  }
});

test("oversized metadata is never persisted or published and missing local blobs self-heal", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), directory = join(root, "local"), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch }, logs: string[] = [];
  const item = await record(store, "healing");
  const cache = new LayerCache(store, { directory, repository: "registry.test/cache", registry, log: (s) => logs.push(s) });
  await cache.remember({ ...item, inventory: [{ path: "x", name: "x".repeat(8 * 1024 ** 2), version: "1" }] });
  await cache.publish();
  expect(mock.requests).toHaveLength(0); expect(logs.join("")).toContain("size limit");
  expect((await pruneLocal(directory, false, 0, 0)).managedBytes).toBe(0);
  await cache.remember(item); await cache.publish();
  await rm(new BlobStore(directory).path(item.layer.descriptor.digest));
  const reader = new LayerCache(new BlobStore(join(root, "reader")), { directory, readRepositories: ["registry.test/cache"], registry, log: () => {} });
  expect(await reader.get(item.key, "assets")).toBeDefined();
  expect(await reader.get(item.key, "assets")).toBeDefined();
  expect(reader.events[1]).toMatchObject({ status: "registry", source: "registry.test/cache" });
  await reader.persistHits();
  expect(await Bun.file(new BlobStore(directory).path(item.layer.descriptor.digest)).exists()).toBe(true);
});
