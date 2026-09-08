import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LayerCache, cacheKey, packFormat, type CacheRecord } from "../packages/bunko/cache.ts";
import { pruneLocal } from "../packages/bunko/prune.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-cache-smoke-")), container = `bunko-cache-${randomUUID()}`;
let started = false;
try {
  await command(["docker", "run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::5000", "registry:3"]); started = true;
  const host = `localhost:${(await command(["docker", "port", container, "5000/tcp"])).split(":").at(-1)}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://${host}/v2/`)).ok) break; } catch { /* Wait for this registry. */ }
    if (i === 50) throw new Error("Registry did not start"); await Bun.sleep(100);
  }
  const registry = { insecure: [host], credentials: async () => undefined }, store = new BlobStore(join(directory, "producer"));
  const layer = (await packLayer(store, [{ path: "app/asset", type: "file", content: Buffer.alloc(65536, 42) }], "assets", 0))!;
  const item: CacheRecord = { schemaVersion: 1, key: cacheKey("distribution fixture"), kind: "assets", packFormat, destination: "/app", platform: null, layer, inventory: [], native: [] };
  const producer = new LayerCache(store, { repository: `${host}/shared`, registry, log: () => {} });
  await producer.remember(item); await producer.publish();
  const local = join(directory, "local");
  const consumer = new LayerCache(new BlobStore(join(directory, "consumer")), { directory: local, readRepositories: [`${host}/missing`, `${host}/shared`], repository: `${host}/branch`, registry, log: () => {} });
  const hit = await consumer.get(item.key, "assets"); if (!hit) throw new Error("Read source did not provide a hit");
  await consumer.persistHits(); await consumer.publish();
  const fresh = new LayerCache(new BlobStore(join(directory, "fresh")), { readRepositories: [`${host}/branch`], registry, log: () => {} });
  if (!await fresh.get(item.key, "assets")) throw new Error("Read hit was not promoted to write destination");
  const preview = await pruneLocal(local, false, 0, 0), applied = await pruneLocal(local, true, 0, 0);
  if (preview.bytes !== applied.bytes || applied.remainingBytes !== 0 || !applied.deleted.length) throw new Error("Quota preview and deletion disagreed");
  const report = { schemaVersion: 1, registry: "Distribution 3", orderedReadFallback: true, readHitPromotion: true, freshDestinationRead: true,
    managedBytes: preview.managedBytes, reclaimedBytes: applied.bytes, remainingManagedBytes: applied.remainingBytes };
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report));
} finally { if (started) await command(["docker", "rm", "--force", container]); await rm(directory, { recursive: true, force: true }); }
