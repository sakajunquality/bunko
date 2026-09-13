import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pack } from "tar-stream";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { media, type BaseImage } from "../packages/oci/types.ts";
import { checkRebaseSafety } from "../packages/bunko/rebase-safety.ts";
import { temporary } from "./helpers.ts";
import { rebaseRuntime } from "./rebase-fixture.ts";

const platform = { os: "linux", architecture: "amd64" } as const;
const options = { platform, epoch: 0, entrypoint: ["/usr/local/bin/bun"], args: [], workdir: "/app", env: {}, labels: {} };
const context = { mode: "bundle", libc: "glibc", bunVersion: Bun.version, bunRevision: Bun.revision, runtimeOrigin: "base" } as const;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await temporary(); directories.push(root); const store = new BlobStore(join(root, "store"));
  async function base(overrides: Record<string, TarEntry | null> = {}): Promise<BaseImage> {
    const entries: Record<string, TarEntry> = Object.fromEntries([
      { path: "usr/local/bin/bun", type: "file", content: rebaseRuntime(platform), executable: true },
      { path: "lib64/ld-linux-x86-64.so.2", type: "file", content: Buffer.from("loader"), executable: true },
      { path: "etc/os-release", type: "file", content: Buffer.from("ID=debian\n") },
      { path: "lib/libc.so.6", type: "file", content: Buffer.from("libc") },
    ].map((entry) => [entry.path, entry as TarEntry]));
    for (const [path, entry] of Object.entries(overrides)) if (entry) entries[path] = entry; else delete entries[path];
    const layer = (await packLayer(store, Object.values(entries), "assets", 0, []))!;
    const config = { ...platform, rootfs: { type: "layers" as const, diff_ids: [layer.diffId] } };
    const descriptor = await store.put(canonicalJSON(config), media.config);
    const manifest = { schemaVersion: 2 as const, mediaType: media.manifest, config: descriptor, layers: [layer.descriptor] };
    return { config, manifest, descriptor: await store.put(canonicalJSON(manifest), media.manifest) };
  }
  async function app(base: BaseImage, entries: TarEntry[]): Promise<BaseImage> {
    const layer = (await packLayer(store, entries, "app", 0, []))!;
    return { ...base, manifest: { ...base.manifest, layers: [...base.manifest.layers, layer.descriptor] }, config: { ...base.config, rootfs: { type: "layers", diff_ids: [...base.config.rootfs.diff_ids, layer.diffId] } } };
  }
  const old = await base();
  const policy = (fresh: BaseImage) => ({ schemaVersion: 1 as const, transitions: [{ platform: "linux/amd64", libc: "glibc" as const, oldBase: old.descriptor.digest, newBase: fresh.descriptor.digest }] });
  return { root, store, base, app, old, policy };
}

test("exact base contents pass and changed files require an exact ABI contract", async () => {
  const f = await fixture();
  const fresh = await f.base({ "lib/new.so": { path: "lib/new.so", type: "file", content: Buffer.from("new") } });
  expect((await checkRebaseSafety(f.store, f.old, f.old, f.old, options, context, f.root)).policy).toBe("identical-files");
  await expect(checkRebaseSafety(f.store, f.old, f.old, fresh, options, context, f.root)).rejects.toThrow("filesystem entry changed");
  expect((await checkRebaseSafety(f.store, f.old, f.old, fresh, options, context, f.root, f.policy(fresh))).policy).toBe("explicit-abi-contract");
  for (const patch of [{ platform: "linux/arm64" }, { libc: "musl" }, { newBase: sha256("other") }]) {
    const policy = f.policy(fresh); Object.assign(policy.transitions[0]!, patch);
    await expect(checkRebaseSafety(f.store, f.old, f.old, fresh, options, context, f.root, policy)).rejects.toThrow("exact base transition");
  }
});

test("new base parents and collisions are checked against the combined replacement tree", async () => {
  const f = await fixture();
  const image = await f.app(f.old, [{ path: "app/main.js", type: "file", content: Buffer.from("app") }]);
  for (const entry of [
    { path: "app", type: "symlink" as const, target: "elsewhere" },
    { path: "app", type: "file" as const, content: Buffer.from("blocked") },
    { path: "app/main.js", type: "file" as const, content: Buffer.from("base collision") },
  ]) {
    const fresh = await f.base({ [entry.path]: entry });
    await expect(checkRebaseSafety(f.store, image, f.old, fresh, options, context, f.root, f.policy(fresh))).rejects.toThrow();
  }
});

test("generated whiteouts are rejected even when they leave no entry in the effective tree", async () => {
  const f = await fixture(), archive = pack(), chunks: Buffer[] = [];
  const reader = (async () => { for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  archive.entry({ name: "etc/.wh.os-release", size: 0 }, Buffer.alloc(0)); archive.finalize(); await reader;
  const bytes = Buffer.concat(chunks), descriptor = await f.store.put(bytes, media.tar);
  const image = { ...f.old, manifest: { ...f.old.manifest, layers: [...f.old.manifest.layers, descriptor] }, config: { ...f.old.config, rootfs: { type: "layers" as const, diff_ids: [...f.old.config.rootfs.diff_ids, sha256(bytes)] } } };
  await expect(checkRebaseSafety(f.store, image, f.old, f.old, options, context, f.root)).rejects.toThrow("whiteout");
});

test("runtime scripts, wrong ELF libc, symlinks, permissions and revised Bun bytes are rejected", async () => {
  const f = await fixture(), path = "usr/local/bin/bun";
  const bad = rebaseRuntime(platform); bad[900] = 1;
  for (const entry of [
    { path, type: "file" as const, content: bad, executable: true },
    { path, type: "file" as const, content: rebaseRuntime(platform), mode: 0o644 as const },
    { path, type: "symlink" as const, target: "other-bun" },
  ]) {
    const fresh = await f.base({ [path]: entry });
    await expect(checkRebaseSafety(f.store, f.old, f.old, fresh, options, context, f.root, f.policy(fresh))).rejects.toThrow("executable");
  }
  for (const bytes of [Buffer.from(`\0${Bun.revision.padEnd(40, "0")}\0`), rebaseRuntime(platform, "musl"), rebaseRuntime({ os: "linux", architecture: "arm64" })]) {
    const original = await f.base({ [path]: { path, type: "file", content: bytes, executable: true } });
    await expect(checkRebaseSafety(f.store, original, original, original, options, context, f.root)).rejects.toThrow();
  }
});

test("explicit contracts reject changed or unidentified distributions and renamed native binaries", async () => {
  const f = await fixture();
  for (const entry of [null, { path: "etc/os-release", type: "file" as const, content: Buffer.from("ID=alpine\n") }]) {
    const fresh = await f.base({ "etc/os-release": entry });
    await expect(checkRebaseSafety(f.store, f.old, f.old, fresh, options, context, f.root, f.policy(fresh))).rejects.toThrow("distribution");
  }
  for (const [path, bytes] of [["app/addon.node", Buffer.from("addon")], ["app/renamed", rebaseRuntime(platform)]] as const) {
    const image = await f.app(f.old, [{ path, type: "file", content: bytes }]);
    expect((await checkRebaseSafety(f.store, image, f.old, f.old, options, context, f.root)).nativeAddons).toBe(1);
    await expect(checkRebaseSafety(f.store, image, f.old, f.old, options, context, f.root, f.policy(f.old))).rejects.toThrow("native addons");
  }
});


test("an ABI contract cannot hide a missing direct Bun shared library", async () => {
  const f = await fixture();
  const fresh = await f.base({ "lib/libc.so.6": null, "app/cache/libc.so.6": { path: "app/cache/libc.so.6", type: "file", content: Buffer.from("unrelated") } });
  await expect(checkRebaseSafety(f.store, f.old, f.old, fresh, options, context, f.root, f.policy(fresh))).rejects.toThrow("missing shared library libc.so.6");
});
