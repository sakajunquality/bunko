import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { rm, readFile, writeFile } from "node:fs/promises";
import { LayerCache, CacheExportError, cacheKey, cacheTag, packFormat, type CacheRecord } from "../packages/bunko/cache.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
import { Telemetry } from "../packages/bunko/telemetry.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await temporary(); roots.push(root); return root; }
async function record(store: BlobStore, value: string): Promise<CacheRecord> {
  return { schemaVersion: 1, kind: "assets", key: cacheKey("same inputs"), packFormat, destination: "/app", platform: null,
    layer: (await packLayer(store, [{ path: "app/data", type: "file", content: Buffer.from(value) }], "assets", 0))!, inventory: [], native: [] };
}

test.each([false, true])("immutable write races reconcile only identical verified records (conflict=%s)", async (conflict) => {
  const root = await fixture(), mock = new MockRegistry(), registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const winnerStore = new BlobStore(join(root, "winner")), winner = await record(winnerStore, "winner");
  const producer = new LayerCache(winnerStore, { repository: "registry.test/cache", registry, log: () => {} });
  await producer.remember(winner); await producer.publish();
  const store = new BlobStore(join(root, "challenger")), candidate = await record(store, conflict ? "different" : "winner");
  let hide = true, tagWrites = 0;
  const tagPath = `/v2/cache/manifests/${cacheTag("assets", candidate.key)}`;
  const cache = new LayerCache(store, { repository: "registry.test/cache", exportError: "fail", log: () => {}, registry: { ...registry, fetcher: async (url, init = {}) => {
    if (new URL(url).pathname === tagPath) {
      if ((init.method ?? "GET") === "GET" && hide) { hide = false; return new Response(null, { status: 404 }); }
      if (init.method === "PUT") { tagWrites++; return Response.json({ errors: [{ code: "DENIED", message: "immutable tag" }] }, { status: 409 }); }
    }
    return mock.fetch(url, init);
  } } });
  await cache.remember(candidate);
  if (conflict) await expect(cache.publish()).rejects.toBeInstanceOf(CacheExportError); else await cache.publish();
  expect(tagWrites).toBe(1);
  expect(cache.exports[0]).toMatchObject({ backend: "registry", status: conflict ? "failed" : "already-present", ...(conflict ? { reason: "conflict" } : {}) });
  expect(cache.exports[0]!.durationMs).toBeGreaterThanOrEqual(0);
  const consumer = new LayerCache(new BlobStore(join(root, "consumer")), { readRepositories: ["registry.test/cache"], registry, log: () => {} });
  expect((await consumer.get(winner.key, "assets"))!.layer).toEqual(winner.layer);
});

test("registry cache artifacts publish in parallel and report in record order", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), mock = new MockRegistry();
  mock.latencyMs = 10;
  const registry = { credentials: async () => undefined, fetcher: mock.fetch, publishConcurrency: 3 };
  const cache = new LayerCache(store, { repository: "registry.test/cache", registry, log: () => {} });
  const kinds = ["deps", "assets", "app", "runtime"] as const;
  for (const kind of kinds) await cache.remember({ ...await record(store, `payload ${kind}`), kind, key: cacheKey(`inputs ${kind}`) });
  await cache.publish();
  expect(cache.exports.map((entry) => entry.kind)).toEqual([...kinds]);
  expect(cache.exports.every((entry) => entry.status === "written")).toBe(true);
  expect(mock.maxInFlight).toBe(3);
  expect(mock.inFlight).toBe(0);
});

test("existing cache metadata does not conceal corrupt or conflicting outputs", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch }, item = await record(store, "same");
  const first = new LayerCache(store, { repository: "registry.test/cache", registry, log: () => {} });
  await first.remember(item); await first.publish(); expect(first.exports[0]!.status).toBe("written");
  const repeat = new LayerCache(new BlobStore(join(root, "repeat")), { repository: "registry.test/cache", registry, log: () => {} });
  await repeat.store.copyFrom(store, item.layer.descriptor); await repeat.remember(item); await repeat.publish();
  expect(repeat.exports[0]).toMatchObject({ status: "already-present", bytes: 0 });
  mock.blobs.set(`registry.test/cache/${item.layer.descriptor.digest}`, Buffer.from("broken"));
  const corrupt = new LayerCache(store, { repository: "registry.test/cache", registry, log: () => {}, exportError: "fail" });
  await corrupt.remember(item); await expect(corrupt.publish()).rejects.toBeInstanceOf(CacheExportError);
  expect(corrupt.exports[0]).toMatchObject({ status: "failed", reason: "invalid" });
});

test("explicit registry cache exports work without image push and dry runs never write", async () => {
  const root = await fixture(), source = join(root, "source"); await project(source);
  const mock = new MockRegistry(), registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const options = { path: source, baseLayout: await baseLayout(join(root, "base")), cacheRepo: "registry.test/cache", localCache: false, push: false, gitMetadata: false, registry };
  const result = await build({ ...options, output: join(root, "image") });
  expect(result.publication).toBeUndefined();
  expect(result.cacheExports!.some((entry) => entry.status === "written")).toBe(true);
  expect([...mock.manifests.keys()].some((key) => key.includes("bunko-cache-v1-app-"))).toBe(true);
  mock.requests.length = 0;
  const dry = await build({ ...options, dryRun: true, output: join(root, "dry") });
  expect(dry.cacheExports).toEqual([]);
  expect(mock.requests.every((request) => ["GET", "HEAD"].includes(request.method))).toBe(true);
  mock.requests.length = 0;
  await writeFile(join(source, "src/server.ts"), "const = invalid;");
  await expect(build({ ...options, output: join(root, "bad") })).rejects.toThrow();
  expect(mock.requests.every((request) => ["GET", "HEAD"].includes(request.method))).toBe(true);
});

test.each(["warn", "fail"] as const)("cache export policy %s preserves published-image evidence", async (policy) => {
  const root = await fixture(), source = join(root, "source"); await project(source);
  const mock = new MockRegistry(); mock.cacheWritable = false;
  const report = join(root, "report.json");
  const task = build({ path: source, baseLayout: await baseLayout(join(root, "base")), repo: "registry.test/images", cacheRepo: "registry.test/cache", cacheExportError: policy,
    report, push: true, localCache: false, gitMetadata: false, registry: { credentials: async () => undefined, fetcher: mock.fetch } });
  if (policy === "fail") await expect(task).rejects.toBeInstanceOf(CacheExportError); else await task;
  const written = JSON.parse(await readFile(report, "utf8")), result = written.targets?.[0] ?? written;
  expect(result.publication.published).toBe(true);
  expect(result.cacheExports.some((entry: any) => entry.status === "failed" && entry.reason === "denied")).toBe(true);
  if (policy === "fail") expect(written.status).toBe("failed");
});

test("export telemetry uses bounded labels and duration histograms", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), mock = new MockRegistry();
  const cache = new LayerCache(store, { repository: "registry.test/private-repository", registry: { credentials: async () => undefined, fetcher: mock.fetch }, log: () => {} });
  await cache.remember(await record(store, "payload"));
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => { requests.push(await request.json()); return Response.json({}); } });
  try {
    const telemetry = new Telemetry({ metrics: new URL(`http://127.0.0.1:${server.port}/v1/metrics`), headers: {}, timeout: 1000 }, () => {});
    await telemetry.run("build", () => cache.publish());
    const metrics = requests[0].resourceMetrics[0].scopeMetrics[0].metrics;
    const duration = metrics.find((entry: any) => entry.name === "bunko.cache.export.duration");
    expect(duration.unit).toBe("s"); expect(duration.histogram.dataPoints[0].count).toBe("1");
    expect(metrics.some((entry: any) => entry.name === "bunko.cache.export.bytes")).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("private-repository");
    expect(JSON.stringify(requests)).not.toContain(cache.exports[0]!.key);
    expect(cache.exports[0]).toMatchObject({ status: "written", backend: "registry" });
    expect(cache.exports[0]!.bytes).toBeGreaterThan(0);
  } finally { server.stop(true); }
});

test("strict export rejects modes that cannot write", async () => {
  const { validateCacheOptions } = await import("../packages/bunko/cache-options.ts");
  for (const mode of [{ offline: true }, { dryRun: true }, { cacheWrite: false }]) {
    expect(() => validateCacheOptions({ ...mode, cacheExportError: "fail", cacheRepo: "registry.test/cache" })).toThrow();
  }
});

test("local persistence failure does not disable explicit registry exports", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), mock = new MockRegistry();
  const cache = new LayerCache(store, { persistence: { disabled: true }, repository: "registry.test/cache", exportError: "fail", registry: { credentials: async () => undefined, fetcher: mock.fetch }, log: () => {} });
  await cache.remember(await record(store, "payload")); await cache.publish();
  expect(cache.exports[0]!.status).toBe("written");
});

test("strict cache failure preserves completed local image evidence", async () => {
  const root = await fixture(), source = join(root, "source"); await project(source);
  const mock = new MockRegistry(); mock.cacheWritable = false;
  const report = join(root, "report.json"), output = join(root, "image");
  await expect(build({ path: source, baseLayout: await baseLayout(join(root, "base")), output, report,
    cacheRepo: "registry.test/cache", cacheExportError: "fail", push: false, localCache: false, gitMetadata: false,
    registry: { credentials: async () => undefined, fetcher: mock.fetch } })).rejects.toBeInstanceOf(CacheExportError);
  const written = JSON.parse(await readFile(report, "utf8")), result = written.targets[0];
  expect(written.status).toBe("failed");
  expect(result.cacheExports.some((entry: any) => entry.reason === "denied")).toBe(true);
  expect(await Bun.file(join(output, "index.json")).exists()).toBe(true);
  if (result.supplyChain) expect(result.supplyChain.status).toBe("complete");
});

test("existing registry blob connection failures are unavailable, not corrupt cache data", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch }, item = await record(store, "payload");
  const first = new LayerCache(store, { repository: "registry.test/cache", registry, log: () => {} });
  await first.remember(item); await first.publish();
  const broken = new LayerCache(store, { repository: "registry.test/cache", exportError: "fail", log: () => {}, registry: { ...registry, retries: 0, sleep: async () => {}, fetcher: async (url, init = {}) => {
    if (new URL(url).pathname.endsWith(`/blobs/${item.layer.descriptor.digest}`)) throw new Error("Connection dropped");
    return mock.fetch(url, init);
  } } });
  await broken.remember(item); await expect(broken.publish()).rejects.toBeInstanceOf(CacheExportError);
  expect(broken.exports[0]).toMatchObject({ status: "failed", reason: "unavailable" });
});
