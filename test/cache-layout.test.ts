import { expect, test } from "bun:test";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CacheDriver, cacheKey, cacheTag, packFormat, type CacheRecord } from "../packages/bunko/cache.ts";
import { pruneLocal, pruneRegistry } from "../packages/bunko/prune.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

async function record(store: BlobStore, name: string): Promise<CacheRecord> {
  return { schemaVersion: 1, kind: "assets", key: cacheKey(name), packFormat, destination: "/app", platform: null, layer: (await packLayer(store, [{ path: "app/data", type: "file", content: Buffer.from(name) }], "assets", 0))!, inventory: [], native: [] };
}

test("future cache records are reported and protect every blob from reclamation", async () => {
  const root = await temporary(), directory = join(root, "cache"), store = new BlobStore(join(root, "source"));
  try {
    const known = await record(store, "known"), driver = new CacheDriver(store, { directory, log: () => {}, strictLocal: true });
    await driver.remember(known);
    const future = join(directory, "keys/assets", `${"f".repeat(64)}.json`);
    await writeFile(future, JSON.stringify({ schemaVersion: 2, hiddenReferences: [known.layer.descriptor.digest] }));
    const orphan = join(directory, "blobs/sha256", "b".repeat(64)); await writeFile(orphan, "unseen-reference"); await utimes(orphan, 1, 1);
    const result = await pruneLocal(directory, true, 0);
    expect(result.unmanaged).toEqual([`keys/assets/${"f".repeat(64)}.json`]); expect(result.orphanReclamationSkipped).toBe(true);
    expect(result.blobs).toEqual([]); expect(result.residue).toEqual([]);
    expect(await readFile(orphan, "utf8")).toBe("unseen-reference");
    expect(await Bun.file(join(directory, "blobs/sha256", known.layer.descriptor.digest.slice(7))).exists()).toBe(true);
    expect(await Bun.file(future).exists()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("future layout envelopes prevent reads, writes and pruning without rewriting metadata", async () => {
  const root = await temporary(), store = new BlobStore(join(root, "source")), directory = join(root, "cache");
  try {
    const item = await record(store, "layout"), options = { directory, log: () => {}, strictLocal: true };
    await new CacheDriver(store, options).remember(item);
    const path = join(directory, "bunko-cache.json"), envelope = JSON.stringify({ schemaVersion: 1, layoutVersion: 2, minReader: 2 }); await writeFile(path, envelope);
    const reader = new CacheDriver(new BlobStore(join(root, "reader")), options);
    expect(await reader.get(item.key, "assets")).toBeUndefined();
    await expect(new CacheDriver(store, options).remember(item)).rejects.toThrow("Unsupported cache layout");
    const result = await pruneLocal(directory, true, 0); expect(result.unmanaged).toEqual(["bunko-cache.json"]); expect(result.deleted).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(envelope);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown namespaces are listed without traversal or deletion", async () => {
  const root = await temporary();
  try {
    await mkdir(join(root, "keys/future"), { recursive: true }); await writeFile(join(root, "keys/future/data"), "keep");
    const result = await pruneLocal(root, true, 0); expect(result.unmanaged).toEqual(["keys/future"]); expect(result.deleted).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry keep-current retains current-format tags while selecting old packing identities", async () => {
  const root = await temporary(), store = new BlobStore(root), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch };
  try {
    const current = await record(store, "current"), old = { ...await record(store, "old"), packFormat: "tar-gzip-v4/bunko-0.11.0/bun-1.4.2-old" };
    const producer = new CacheDriver(store, { repository: "registry.test/cache", registry, log: () => {} });
    await producer.remember(current); await producer.remember(old); await producer.publish();
    const result = await pruneRegistry("registry.test/cache", false, { ...registry, fetcher: async (input, init) => new URL(input).pathname.endsWith("/tags/list") ? Response.json({ tags: [cacheTag("assets", current.key), cacheTag("assets", old.key)] }) : mock.fetch(input, init) }, { keepCurrent: true });
    expect(result.retained).toHaveLength(1); expect(result.tags).toHaveLength(1); expect(result.tags[0]!.tag).toContain(old.key.slice(7));
    expect(result.deleted).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown root namespaces retain their otherwise unreferenced blobs", async () => {
  const root = await temporary();
  try {
    await mkdir(join(root, "future")); await mkdir(join(root, "blobs/sha256"), { recursive: true });
    const digest = "a".repeat(64), blob = join(root, "blobs/sha256", digest);
    await writeFile(join(root, "future/refs.json"), JSON.stringify([digest])); await writeFile(blob, "keep"); await utimes(blob, 1, 1);
    const result = await pruneLocal(root, true, 0); expect(result.unmanaged).toContain("future"); expect(result.residue).toEqual([]);
    expect(await readFile(blob, "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("base inspection readers and writers honor future root envelopes", async () => {
  const root = await temporary();
  const { writeBaseInspection, readBaseInspection, baseInspectPath } = await import("../packages/bunko/base-inspect.ts");
  const digest = `sha256:${"a".repeat(64)}` as const, next = `sha256:${"b".repeat(64)}` as const;
  try {
    await writeBaseInspection(root, digest, new Map(), {}, () => {});
    await writeFile(join(root, "bunko-cache.json"), JSON.stringify({ schemaVersion: 1, layoutVersion: 2, minReader: 2 }));
    expect((await readBaseInspection(root, digest, () => {})).tree).toBeUndefined();
    await writeBaseInspection(root, next, new Map(), {}, () => {});
    expect(await Bun.file(baseInspectPath(root, next)).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("future closure plan layouts are retained before interpreting their references", async () => {
  const root = await temporary();
  try {
    await mkdir(join(root, "plans/deps"), { recursive: true });
    const name = `${"a".repeat(64)}.json`, path = join(root, "plans/deps", name);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: "deps-plan", layout: "closure-plan-v3", packFormat, planKey: `sha256:${"a".repeat(64)}`, key: "future-reference" }));
    const result = await pruneLocal(root, true, 7 * 86400, Number.MAX_SAFE_INTEGER);
    expect(result.unmanaged).toContain(`plans/deps/${name}`); expect(result.deleted).toEqual([]); expect(await Bun.file(path).exists()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry pruning leaves future plan layouts unmanaged", async () => {
  const { canonicalJSON, sha256 } = await import("../packages/oci/digest.ts");
  const { media } = await import("../packages/oci/types.ts");
  const key = `sha256:${"a".repeat(64)}` as const, tag = cacheTag("deps-plan", key);
  const config = canonicalJSON({ schemaVersion: 1, kind: "deps-plan", layout: "closure-plan-v3", packFormat: "tar-gzip-v5", planKey: key, key: "future-reference" });
  const digest = sha256(config), manifest = { schemaVersion: 2, mediaType: media.manifest, artifactType: "application/vnd.bunko.cache.v1", config: { digest, size: config.length, mediaType: "application/vnd.bunko.cache.plan.config.v1+json" }, layers: [{}] };
  const result = await pruneRegistry("registry.test/cache", true, { credentials: async () => undefined, fetcher: async (input, init) => {
    expect(init?.method).not.toBe("DELETE");
    const path = new URL(input).pathname;
    if (path.endsWith("/tags/list")) return Response.json({ tags: [tag] });
    if (path.endsWith(`/manifests/${tag}`)) return Response.json(manifest);
    if (path.endsWith(`/blobs/${digest}`)) return new Response(Buffer.from(config));
    throw new Error("Unexpected request");
  } }, { keepCurrent: true });
  expect(result.unmanaged).toEqual([tag]); expect(result.tags).toEqual([]); expect(result.deleted).toEqual([]);
});
