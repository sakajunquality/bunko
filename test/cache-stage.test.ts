import { expect, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheDriver, cacheKey, packFormat } from "../packages/bunko/cache.ts";
import { withCacheLock } from "../packages/bunko/cache-lock.ts";
import { pruneLocal } from "../packages/bunko/prune.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { temporary } from "./helpers.ts";

function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("slow layer materialization leaves the metadata lock available to prune and another writer", async () => {
  const root = await temporary(), directory = join(root, "cache"), store = new BlobStore(join(root, "source"));
  const started = gate(), resume = gate(), bytes = Buffer.from("authenticated layer");
  const descriptor = { digest: sha256(bytes), size: bytes.length, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" };
  store.defer(descriptor, async () => { started.resolve(); await resume.promise; return (async function* () { yield bytes; })(); });
  const record = { destination: "/app", platform: null, inventory: [], native: [], schemaVersion: 1 as const, key: cacheKey("staging-test"), kind: "assets" as const, packFormat, layer: { kind: "assets" as const, descriptor, diffId: descriptor.digest } };
  const cache = new CacheDriver(store, { directory, log: () => {}, strictLocal: true });
  const pending = cache.remember(record);
  try {
    await started.promise;
    expect(await withCacheLock(directory, async () => "available", undefined, 100)).toBe("available");
    expect((await pruneLocal(directory, true, 0)).deleted).toEqual([]);
    expect((await readdir(directory)).filter((name) => name.startsWith(".bunko-stage-"))).toHaveLength(1);
    resume.resolve(); await pending;
    expect(await readFile(join(directory, "blobs/sha256", descriptor.digest.slice(7)))).toEqual(bytes);
    expect(JSON.parse(await readFile(join(directory, "keys/assets", `${record.key.slice(7)}.json`), "utf8"))).toEqual(record);
    expect((await readdir(directory)).filter((name) => name.startsWith(".bunko-stage-"))).toEqual([]);
  } finally { resume.resolve(); await pending.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("a failed digest never publishes metadata and removes private staging files", async () => {
  const root = await temporary(), directory = join(root, "cache"), store = new BlobStore(join(root, "source"));
  const descriptor = { digest: sha256("expected"), size: 8, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" };
  store.defer(descriptor, async () => (async function* () { yield Buffer.from("replaced"); })());
  const cache = new CacheDriver(store, { directory, log: () => {}, strictLocal: true });
  try {
    await expect(cache.remember({ destination: "/app", platform: null, inventory: [], native: [], schemaVersion: 1, key: cacheKey("bad"), kind: "assets", packFormat, layer: { kind: "assets", descriptor, diffId: descriptor.digest } })).rejects.toThrow("mismatch");
    expect((await readdir(directory)).filter((name) => name.startsWith(".bunko-stage-") || name === "keys")).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a killed stage is previewed then reclaimed, while a slow live owner survives prune", async () => {
  const root = await temporary(), directory = join(root, "cache"), script = join(root, "stage.ts");
  const { writeFile, utimes } = await import("node:fs/promises");
  await writeFile(script, `import {withStagedCacheBlob} from ${JSON.stringify(join(import.meta.dir, "../packages/bunko/cache-stage.ts"))}; import {BlobStore} from ${JSON.stringify(join(import.meta.dir, "../packages/oci/blob-store.ts"))}; const store=new BlobStore(process.argv[3]); const d=await store.put(Buffer.from("staged"),"application/octet-stream"); await withStagedCacheBlob(process.argv[2],store,d,async()=>{console.log("ready");await Bun.sleep(30000)});`);
  const child = Bun.spawn([process.execPath, script, directory, join(root, "source")], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); reader.releaseLock();
    const stage = join(directory, (await readdir(directory)).find((name) => name.startsWith(".bunko-stage-"))!);
    await utimes(stage, 1, 1);
    expect((await pruneLocal(directory, true, 0)).residue).toEqual([]);
    child.kill("SIGKILL"); await child.exited;
    const preview = await pruneLocal(directory, false, 0);
    expect(preview.residue).toEqual([stage]); expect(preview.residueBytes).toBeGreaterThan(6); expect(preview.deleted).toEqual([]);
    const applied = await pruneLocal(directory, true, 0);
    expect(applied.deleted).toEqual([stage]); expect((await readdir(directory)).some((name) => name.startsWith(".bunko-stage-"))).toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; await rm(root, { recursive: true, force: true }); }
});

test("only old owned orphan blobs and UUID temporary files are reclaimed", async () => {
  const root = await temporary();
  const { mkdir, writeFile, utimes } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  try {
    await mkdir(join(root, "blobs/sha256"), { recursive: true });
    const oldBlob = join(root, "blobs/sha256", "a".repeat(64)), recent = join(root, "blobs/sha256", "b".repeat(64));
    const oldTemp = join(root, "blobs", `.tmp-${randomUUID()}`), unknown = join(root, "blobs/.tmp-user-file");
    for (const path of [oldBlob, oldTemp, unknown, recent]) await writeFile(path, "data");
    for (const path of [oldBlob, oldTemp, unknown]) await utimes(path, 1, 1);
    const result = await pruneLocal(root, true, 0);
    expect(result.residue.sort()).toEqual([oldBlob, oldTemp].sort()); expect(result.residueBytes).toBe(8);
    expect(result.remainingBytes).toBe(0); expect(await readFile(unknown, "utf8")).toBe("data"); expect(await readFile(recent, "utf8")).toBe("data");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prune retains uncertain or unsafe abandoned stages and never waits on a held lease", async () => {
  const root = await temporary();
  const { mkdir, writeFile, utimes, symlink, link } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { hostname } = await import("node:os");
  const { withCacheMutex, cacheMutexProtocol } = await import("../packages/bunko/cache-mutex.ts");
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await child.exited;
  try {
    for (const variant of ["foreign", "malformed", "symlink", "hardlink", "busy"]) {
      const stage = join(root, `.bunko-stage-${randomUUID()}`); await mkdir(stage);
      await withCacheMutex(stage, Date.now(), async (identity) => {
        const owner = { schemaVersion: 1, kind: "layer-cache-stage", protocol: cacheMutexProtocol, mutexIdentity: identity, hostname: variant === "foreign" ? "another-host" : hostname(), pid: child.pid };
        await writeFile(join(stage, "owner.json"), variant === "malformed" ? "{" : JSON.stringify(owner));
        if (variant === "symlink" || variant === "hardlink") {
          const unrelated = join(root, `keep-${variant}`); await writeFile(unrelated, "keep");
          await mkdir(join(stage, "blobs/sha256"), { recursive: true });
          await (variant === "symlink" ? symlink : link)(unrelated, join(stage, "blobs/sha256", "a".repeat(64)));
        }
        await utimes(stage, 1, 1);
        if (variant === "busy") {
          const start = Date.now(); expect((await pruneLocal(root, true, 0)).residue).toEqual([]); expect(Date.now() - start).toBeLessThan(2000);
        }
      });
      if (variant !== "busy") expect((await pruneLocal(root, true, 0)).residue).toEqual([]);
      else await rm(stage, { recursive: true });
    }
    expect(await readFile(join(root, "keep-symlink"), "utf8")).toBe("keep");
    expect(await readFile(join(root, "keep-hardlink"), "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});
