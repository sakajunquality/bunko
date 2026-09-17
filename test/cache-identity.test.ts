import { expect, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { CacheDriver, cacheKey, cacheWriter, packFormat, type CacheRecord } from "../packages/bunko/cache.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { MockRegistry } from "./mock-registry.ts";
import { temporary } from "./helpers.ts";

// This fixture is checked by every supported Bun/OS job. A compressor or packing
// change must be investigated and versioned before cross-version reuse is enabled.
export function packingFixture(): TarEntry[] {
  const content = Buffer.alloc(256 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < content.length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; content[index] = state & 255; }
  return [
    { path: "app/data", type: "file", content },
    { path: `app/${"long-name-".repeat(18)}`, type: "file", content: Buffer.from("unicode 日本語\n".repeat(100)), mode: 0o444 },
    { path: "app/bin", type: "file", content: Buffer.from("#!/bin/sh\nexit 0\n"), executable: true },
    { path: "app/link", type: "symlink", target: "data" },
  ];
}

test("packing bytes are identical across supported toolchains", async () => {
  const root = await temporary();
  try {
    const layer = (await packLayer(new BlobStore(root), packingFixture(), "assets", 1234567890))!;
    expect(packFormat).toBe("tar-gzip-v4");
    expect(layer.descriptor.digest).toBe("sha256:ef7ba48cfaaed00fb7a1252f70192a5facf8f027e6cc68805f204e3c11ccb3e1");
    expect(layer.diffId).toBe("sha256:30fc4a005e0d3e38a5493a1090ed7c1c19274cec54cc72ec85c8c5eaaade8663");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diagnostic writer differences remain idempotent for local and registry cache publication", async () => {
  const root = await temporary(), store = new BlobStore(join(root, "source")), mock = new MockRegistry();
  try {
    const layer = (await packLayer(store, [{ path: "app/data", type: "file", content: Buffer.from("same") }], "assets", 0))!;
    const record: CacheRecord = { schemaVersion: 1, key: cacheKey("same-content"), kind: "assets", packFormat, destination: "/app", platform: null, layer, inventory: [], native: [], writer: cacheWriter };
    const changed = { ...record, writer: { bunko: "99.0.0", bun: "99.0.0", revision: "another-writer" } };
    const driver = new CacheDriver(store, { directory: join(root, "cache"), repository: "registry.test/cache", strictLocal: true, registry: { credentials: async () => undefined, fetcher: mock.fetch }, log: () => {} });
    await driver.remember(record); await driver.remember(changed);
    const publish = async (input: CacheRecord) => {
      const remote = new CacheDriver(store, { repository: "registry.test/cache", registry: { credentials: async () => undefined, fetcher: mock.fetch }, log: () => {} });
      await remote.remember(input); await remote.publish(); return remote.exports.at(-1)!.status;
 };
    expect(await publish(record)).toBe("written");
    expect(await publish(changed)).toBe("already-present");
    const invalid = { ...changed, inventory: [{ path: "x", name: "changed", version: "1" }] };
    expect(await publish(invalid)).toBe("failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
