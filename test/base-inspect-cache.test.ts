import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { baseCapabilities } from "../packages/bunko/base-capabilities.ts";
import { baseInspectDirectory, baseInspection, baseInspectPath, baseInspectVersion, readBaseInspection, validateBaseInspection, writeBaseInspection } from "../packages/bunko/base-inspect.ts";
import { pruneLocal } from "../packages/bunko/prune.ts";
import { baseFilesystem, type BaseFilesystem } from "../packages/bunko/runtime-layer.ts";
import { resolveBase, LayoutSource } from "../packages/oci/source.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { media, type Digest } from "../packages/oci/types.ts";
import { baseLayout, project, readJSON, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A base with a second layer, so a cache hit skips more than one decode. */
async function fixture(entries: TarEntry[] = [{ path: "app", type: "directory" }, { path: "usr/lib/libz.so.1", type: "file", content: Buffer.from("stub") }]) {
  const root = await temporary(); roots.push(root);
  const base = await baseLayout(join(root, "base")), store = new BlobStore(base);
  const index = await Bun.file(join(base, "index.json")).json();
  const manifest = await readJSON<any>(base, index.manifests[0]), config = await readJSON<any>(base, manifest.config);
  const layer = (await packLayer(store, entries, "assets", 0, []))!;
  manifest.layers.push(layer.descriptor); config.rootfs.diff_ids.push(layer.diffId); config.history.push({ created_by: "base inspection fixture" });
  manifest.config = await store.put(canonicalJSON(config), media.config);
  index.manifests[0] = await store.put(canonicalJSON(manifest), media.manifest);
  await writeFile(join(base, "index.json"), canonicalJSON(index));
  return { root, base, cache: join(root, "cache"), source: await project(join(root, "source"), { bunko: { workdir: "/app" } }) };
}

/** Every exported blob as name -> content hash, so equality compares bytes rather than filenames. */
async function layoutBytes(layout: string): Promise<Record<string, string>> {
  const directory = join(layout, "blobs", "sha256"), result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) result[name] = sha256(await readFile(join(directory, name)));
  return result;
}

/** Layer descriptors of the fixture layout's single platform manifest. */
async function baseLayers(base: string): Promise<{ digest: Digest }[]> {
  const index = await Bun.file(join(base, "index.json")).json();
  return (await readJSON<any>(base, index.manifests[0])).layers;
}

/** Compare two inspected trees entry for entry, normalizing the absent-link shapes. */
function entries(tree: BaseFilesystem) {
  return [...tree].map(([path, node]) => [path, { type: node.type, mode: node.mode, size: node.size, link: node.link ?? undefined }] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function options(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return { path: f.source, baseLayout: f.base, push: false as const, gitMetadata: false, cacheDir: f.cache, ...extra };
}

test("musl search configuration survives base inspection and cache replay", async () => {
  const path = "etc/ld-musl-x86_64.path", text = "/opt/lib\n/usr/lib";
  const f = await fixture([{ path, type: "file", content: Buffer.from(text) }]);
  const store = new BlobStore(f.base);
  const base = await resolveBase(new LayoutSource(f.base), { os: "linux", architecture: "amd64" }, store, true);
  const tree = await baseFilesystem(store, base, f.root);
  expect(tree.get(path)?.muslSearchPath).toBe(text);
  const record = baseInspection(base.descriptor.digest, tree);
  expect(validateBaseInspection(record, base.descriptor.digest).get(path)?.muslSearchPath).toBe(text);
  const entry = record.entries.find((entry) => entry.path === path)!;
  entry.muslSearchPath = "x".repeat(4097); entry.size = 4097;
  expect(() => validateBaseInspection(record, base.descriptor.digest)).toThrow("musl search path");
  entry.muslSearchPath = "x".repeat(4096); entry.size = 4096;
  expect(validateBaseInspection(record, base.descriptor.digest).get(path)?.muslSearchPath).toHaveLength(4096);
  entry.size = 4097;
  expect(() => validateBaseInspection(record, base.descriptor.digest)).toThrow("musl search path");
});

test("invalid UTF-8 search configuration is not expanded into cached replacement characters", async () => {
  const path = "etc/ld-musl-x86_64.path";
  const f = await fixture([{ path, type: "file", content: Buffer.alloc(4096, 0xff) }]);
  const store = new BlobStore(f.base);
  const base = await resolveBase(new LayoutSource(f.base), { os: "linux", architecture: "amd64" }, store, true);
  const tree = await baseFilesystem(store, base, f.root);
  expect(tree.get(path)?.muslSearchPath).toBeUndefined();
  expect(validateBaseInspection(baseInspection(base.descriptor.digest, tree), base.descriptor.digest).get(path)?.muslSearchPath).toBeUndefined();
});

test("a warm base inspection replays the same image and is reported as a local cache hit", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold") }) as any);
  const record = baseInspectPath(f.cache, cold.baseDigest as Digest);
  expect(await Bun.file(record).exists()).toBe(true);
  expect(cold.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "miss", reason: "not-found" });

  const messages: string[] = [];
  const warm = await build(options(f, { output: join(f.root, "warm"), log: (message: string) => messages.push(message) }) as any);
  expect(warm.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "local" });
  expect(messages.join("")).toContain("Reusing inspected base filesystem");
  // Byte-for-byte equivalence of the resulting image: index, manifest, config and every layer.
  expect(warm.root).toEqual(cold.root);
  expect(warm.manifest).toEqual(cold.manifest);
  expect(warm.config).toEqual(cold.config);
  expect(await layoutBytes(join(f.root, "warm"))).toEqual(await layoutBytes(join(f.root, "cold")));
}, 120000);

test("a cache hit never decodes the base layers", async () => {
  const f = await fixture(), registry = new MockRegistry();
  const push = { push: true, repo: "registry.example/app", dryRun: true, registry: { fetcher: registry.fetch, credentials: async () => undefined } };
  const cold = await build(options(f, push) as any);
  expect(cold.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "miss", reason: "not-found" });
  // A dry run never uploads layer bytes, so only inspection would read this blob.
  const blob = new BlobStore(f.base).path((await baseLayers(f.base)).at(-1)!.digest);
  await rm(blob);
  const warm = await build(options(f, push) as any);
  expect(warm.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "local" });
  await expect(build(options(f, { ...push, localCache: false }) as any)).rejects.toThrow();
}, 120000);

test("an invalid record is a miss and the build re-inspects and rewrites it", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold") }) as any);
  const record = baseInspectPath(f.cache, cold.baseDigest as Digest);
  const original = await readFile(record);
  await writeFile(record, "{\"schemaVersion\":1,\"kind\":\"base-inspect\",\"entries\":[");
  const messages: string[] = [];
  const repaired = await build(options(f, { output: join(f.root, "repaired"), log: (message: string) => messages.push(message) }) as any);
  expect(repaired.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "miss", reason: "invalid-or-unavailable" });
  expect(messages.join("")).toContain("Ignoring invalid local base inspection cache");
  expect(repaired.root).toEqual(cold.root);
  expect(await readFile(record)).toEqual(original);
}, 120000);

test("the record embeds the inspection version, and a bump is a miss", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold") }) as any);
  const record = baseInspectPath(f.cache, cold.baseDigest as Digest);
  const stored = JSON.parse((await readFile(record)).toString());
  expect(stored).toMatchObject({ schemaVersion: 1, kind: "base-inspect", version: baseInspectVersion, digest: cold.baseDigest });
  expect(record).toContain(join(baseInspectDirectory, baseInspectVersion));
  // Records from another inspection version are unreadable, whether they sit under this
  // version's directory or an older one.
  expect(() => validateBaseInspection({ ...stored, version: "base-inspect-v0" }, cold.baseDigest as Digest)).toThrow("inconsistent base inspection metadata");
  expect(() => validateBaseInspection({ ...stored, digest: `sha256:${"0".repeat(64)}` }, cold.baseDigest as Digest)).toThrow("inconsistent base inspection metadata");
  await mkdir(join(f.cache, baseInspectDirectory, "base-inspect-v0"), { recursive: true });
  await rename(record, join(f.cache, baseInspectDirectory, "base-inspect-v0", `${(cold.baseDigest as string).slice(7)}.json`));
  const bumped = await build(options(f, { output: join(f.root, "bumped") }) as any);
  expect(bumped.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "miss", reason: "not-found" });
  expect(bumped.root).toEqual(cold.root);
}, 120000);

// The CLI maps both `--no-cache` and `--no-local-cache` onto `localCache: false`.
test.each([["--no-local-cache", { localCache: false }], ["--no-cache", { localCache: false, registryCache: false }]] as const)("%s never consults or writes the base inspection cache", async (_flag, extra) => {
  const f = await fixture();
  const result = await build(options(f, { output: join(f.root, "image"), ...extra }) as any);
  expect(result.cache).toContainEqual({ kind: "base", key: result.baseDigest, status: "bypass", reason: "disabled" });
  expect(await Bun.file(baseInspectPath(f.cache, result.baseDigest as Digest)).exists()).toBe(false);
  // A record left by an earlier build stays untouched and unread.
  const warm = await build(options(f, { output: join(f.root, "warm") }) as any);
  expect(warm.cache).toContainEqual({ kind: "base", key: result.baseDigest, status: "miss", reason: "not-found" });
  const bypassed = await build(options(f, { output: join(f.root, "again"), ...extra }) as any);
  expect(bypassed.cache).toContainEqual({ kind: "base", key: result.baseDigest, status: "bypass", reason: "disabled" });
  expect(bypassed.root).toEqual(warm.root);
}, 120000);

test("determinism verification reuses one cached inspection for both iterations", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold") }) as any);
  let scans = 0;
  const warm = await build(options(f, { output: join(f.root, "warm"), verifyDeterministic: true,
    progress: (event: any) => { if (event.phase === "base-inspect" && event.status === "completed") scans++; } }) as any);
  expect(warm.verifiedDeterministic).toBe(true);
  expect(scans).toBe(1);
  expect(warm.cache.filter((event: any) => event.kind === "base")).toEqual([{ kind: "base", key: cold.baseDigest, status: "local" }]);
  expect(warm.root).toEqual(cold.root);
}, 120000);

test("base inspections are counted by cache-info and reclaimed by prune", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold") }) as any);
  const record = baseInspectPath(f.cache, cold.baseDigest as Digest);
  const bytes = (await readFile(record)).byteLength;
  const withRecord = await pruneLocal(f.cache, false, 0, Number.MAX_SAFE_INTEGER);
  await rm(record);
  const without = await pruneLocal(f.cache, false, 0, Number.MAX_SAFE_INTEGER);
  expect(withRecord.managedBytes - without.managedBytes).toBe(bytes);

  await build(options(f, { output: join(f.root, "warm") }) as any);
  const budget = await pruneLocal(f.cache, false, undefined, 0);
  expect(budget.keys).toContain(join(baseInspectDirectory, baseInspectVersion, `${(cold.baseDigest as string).slice(7)}.json`));
  expect(budget.remainingBytes).toBe(0);
  const executed = await pruneLocal(f.cache, true, undefined, 0);
  expect(executed.deleted).toContain(record);
  expect(await Bun.file(record).exists()).toBe(false);

  // A superseded inspection version can never be read again, so it is always a prune candidate.
  const stale = join(f.cache, baseInspectDirectory, "base-inspect-v0", `${"a".repeat(64)}.json`);
  await mkdir(join(f.cache, baseInspectDirectory, "base-inspect-v0"), { recursive: true });
  await writeFile(stale, canonicalJSON({ schemaVersion: 1, kind: "base-inspect", version: "base-inspect-v0", digest: `sha256:${"a".repeat(64)}`, entries: [] }));
  const superseded = await pruneLocal(f.cache, false, Number.MAX_SAFE_INTEGER);
  expect(superseded.keys).toContain(join(baseInspectDirectory, "base-inspect-v0", `${"a".repeat(64)}.json`));
  await mkdir(join(f.cache, baseInspectDirectory, "unrelated"), { recursive: true });
  await expect(pruneLocal(f.cache)).rejects.toThrow("unknown base inspection namespaces");
}, 120000);

test("a record round-trips the inspected tree exactly", async () => {
  const f = await fixture();
  const root = await temporary(); roots.push(root);
  const store = new BlobStore(join(root, "store")), source = new LayoutSource(f.base);
  const base = await resolveBase({ root: () => source.root(), blob: source.blob.bind(source) }, { os: "linux", architecture: "amd64" }, store, true);
  const tree = await baseFilesystem(store, base, root);
  const replayed = validateBaseInspection(JSON.parse(Buffer.from(canonicalJSON(baseInspection(base.descriptor.digest, tree))).toString()), base.descriptor.digest);
  expect([...replayed].map(([path, node]) => [path, { ...node }]).sort()).toEqual([...tree].map(([path, node]) => [path, { ...node, link: node.link ?? undefined }]).sort());
  // A path inspection could never have produced is refused rather than replayed.
  const record = baseInspection(base.descriptor.digest, tree);
  for (const entries of [[{ ...record.entries[0]!, path: "../escape" }], [{ ...record.entries[0]!, type: "socket" }], [{ ...record.entries[0]!, mode: -1 }],
    [{ ...record.entries[0]!, size: 1.5 }], [record.entries[0]!, record.entries[0]!]]) {
    expect(() => validateBaseInspection({ ...record, entries }, base.descriptor.digest)).toThrow();
  }
  expect((await readBaseInspection(join(root, "absent"), base.descriptor.digest, () => {})).invalid).toBe(false);
}, 120000);

/** Two layers written by Python's tar implementation, covering the tar shapes the inspection
 * version is meant to pin: whiteouts, an opaque directory, a directory only implied by a
 * descendant, a hardlink, a symlink and a PAX long path. */
async function awkwardBase(root: string): Promise<string> {
  const base = await baseLayout(join(root, "awkward")), store = new BlobStore(base);
  const long = `deep/${"n".repeat(120)}/${"m".repeat(120)}/file.txt`;
  const script = `import tarfile,sys,io
def add(t, name, data=b"", mode=0o644, type=tarfile.REGTYPE, link=""):
 i = tarfile.TarInfo(name); i.mode = mode; i.type = type; i.linkname = link; i.size = len(data)
 t.addfile(i, io.BytesIO(data) if type == tarfile.REGTYPE else None)
with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as t:
 add(t, "etc", type=tarfile.DIRTYPE, mode=0o755)
 add(t, "etc/ssl/certs/ca-certificates.crt", b"-----BEGIN CERTIFICATE-----\\n")
 add(t, "usr/share/fonts/truetype/stub.ttf", b"font")
 add(t, "usr/lib/libz.so.1", b"elf", mode=0o755)
 add(t, "bin/sh", b"shell", mode=0o755)
 add(t, "doomed/keep.txt", b"keep")
 add(t, "doomed/gone.txt", b"gone")
 add(t, "opaquedir/old.txt", b"old")
 add(t, "target.txt", b"target")
 add(t, "sym", type=tarfile.SYMTYPE, link="target.txt")
 add(t, "hard", type=tarfile.LNKTYPE, link="target.txt")
 add(t, "${long}", b"long")
with tarfile.open(sys.argv[2], "w", format=tarfile.PAX_FORMAT) as t:
 add(t, "doomed/.wh.gone.txt")
 add(t, "opaquedir/.wh..wh..opq")
 add(t, "opaquedir/new.txt", b"new")
 add(t, "app", type=tarfile.DIRTYPE, mode=0o755)
`;
  const files = [join(root, "awkward-1.tar"), join(root, "awkward-2.tar")];
  const child = Bun.spawn(["python3", "-c", script, ...files], { stdout: "ignore", stderr: "pipe" });
  if (await child.exited) throw new Error(`tar fixture failed: ${await new Response(child.stderr).text()}`);
  const index = await Bun.file(join(base, "index.json")).json();
  const manifest = await readJSON<any>(base, index.manifests[0]), config = await readJSON<any>(base, manifest.config);
  for (const file of files) {
    const bytes = await readFile(file);
    manifest.layers.push(await store.put(bytes, media.tar));
    config.rootfs.diff_ids.push(sha256(bytes)); config.history.push({ created_by: "awkward base fixture" });
  }
  manifest.config = await store.put(canonicalJSON(config), media.config);
  index.manifests[0] = await store.put(canonicalJSON(manifest), media.manifest);
  await writeFile(join(base, "index.json"), canonicalJSON(index));
  return base;
}

async function inspect(base: string, store?: BlobStore) {
  const root = await temporary(); roots.push(root);
  const source = new LayoutSource(base), blobs = store ?? new BlobStore(join(root, "store"));
  const image = await resolveBase({ root: () => source.root(), blob: source.blob.bind(source) }, { os: "linux", architecture: "amd64" }, blobs, true);
  return { image, tree: await baseFilesystem(blobs, image, root) };
}

test("a replayed tree matches the decoded tree for whiteouts, links, implied parents and PAX paths", async () => {
  const root = await temporary(); roots.push(root);
  const base = await awkwardBase(root);
  const { image, tree: cold } = await inspect(base);
  // The fixture must actually exercise the shapes the inspection version pins.
  expect(cold.has("doomed/gone.txt")).toBe(false);
  expect(cold.has("doomed/keep.txt")).toBe(true);
  expect(cold.has("opaquedir/old.txt")).toBe(false);
  expect(cold.has("opaquedir/new.txt")).toBe(true);
  expect(cold.get("deep")).toMatchObject({ type: "directory" });
  expect(cold.get("sym")).toMatchObject({ type: "symlink", link: "target.txt" });
  expect(cold.get("hard")).toMatchObject({ type: "link", link: "target.txt" });
  expect([...cold.keys()].some((path) => path.includes("n".repeat(120)))).toBe(true);

  const warm = validateBaseInspection(JSON.parse(Buffer.from(canonicalJSON(baseInspection(image.descriptor.digest, cold))).toString()), image.descriptor.digest);
  expect(entries(warm)).toEqual(entries(cold));
  const config = image.config.config ?? {};
  expect(baseCapabilities(warm, config, "/app")).toEqual(baseCapabilities(cold, config, "/app"));
  expect(baseCapabilities(cold, config, "/app").ca.systemStorePresent).toBe(true);
  expect(baseCapabilities(cold, config, "/app").fonts.count).toBe(1);
  expect(baseCapabilities(cold, config, "/app").shells).toEqual(["/bin/sh"]);

  // The same base through two real builds: the second replays the record and produces the same image.
  const f = { root, base, cache: join(root, "cache"), source: await project(join(root, "source"), { bunko: { workdir: "/app" } }) };
  const cold2 = await build(options(f, { output: join(root, "cold") }) as any);
  const warm2 = await build(options(f, { output: join(root, "warm") }) as any);
  expect(warm2.cache).toContainEqual({ kind: "base", key: cold2.baseDigest, status: "local" });
  expect(warm2.root).toEqual(cold2.root);
  expect(await layoutBytes(join(root, "warm"))).toEqual(await layoutBytes(join(root, "cold")));
}, 120000);

test("a warm build still uploads base layers a registry refuses to mount", async () => {
  const f = await fixture();
  const target = (registry: MockRegistry) => ({ push: true, repo: "registry.example/team", registryCache: false,
    registry: { fetcher: registry.fetch, credentials: async () => undefined } });
  const cold = await build(options(f, target(new MockRegistry())) as any);
  // A second, empty registry: nothing is already present and mounts are refused, so the warm
  // build has to materialize every base layer from the source it never decoded.
  const fresh = new MockRegistry(); fresh.mount = "unsupported";
  const warm = await build(options(f, target(fresh)) as any);
  expect(warm.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "local" });
  expect(warm.publication!.published).toBe(true);
  expect(warm.publication!.blobs.mounted).toBe(0);
  const layers = await baseLayers(f.base);
  expect(warm.publication!.transfers.filter((t: any) => t.kind === "base" && t.action === "uploaded").length).toBe(layers.length);
  expect(warm.root).toEqual(cold.root);
  // Every base layer reached the registry with its own bytes, even though nothing decoded them.
  for (const layer of layers) {
    const stored = fresh.blobs.get(`registry.example/team/hello/${layer.digest}`);
    expect(stored).toBeDefined();
    expect(sha256(stored!)).toBe(layer.digest);
  }
}, 120000);

test("a warm archive export re-verifies base DiffIDs that inspection no longer checks", async () => {
  const f = await fixture();
  // A base whose config claims a DiffID its last layer does not have. Nothing else changes.
  const index = await Bun.file(join(f.base, "index.json")).json(), store = new BlobStore(f.base);
  const manifest = await readJSON<any>(f.base, index.manifests[0]), config = await readJSON<any>(f.base, manifest.config);
  config.rootfs.diff_ids[config.rootfs.diff_ids.length - 1] = `sha256:${"b".repeat(64)}`;
  manifest.config = await store.put(canonicalJSON(config), media.config);
  index.manifests[0] = await store.put(canonicalJSON(manifest), media.manifest);
  await writeFile(join(f.base, "index.json"), canonicalJSON(index));
  const digest = index.manifests[0].digest as Digest;
  // Inspecting it from the layers fails, so seed a record the way an honest earlier build would have.
  await expect(build(options(f, { output: join(f.root, "cold"), localCache: false }) as any)).rejects.toThrow("Layer DiffID mismatch");
  const good = await fixture();
  await writeBaseInspection(f.cache, digest, (await inspect(good.base)).tree, {}, () => {});

  // An OCI layout export copies blobs and checks compressed digests, so it never notices.
  const layout = await build(options(f, { output: join(f.root, "layout") }) as any);
  expect(layout.cache).toContainEqual({ kind: "base", key: digest, status: "local" });
  // A Docker archive export decodes every layer and does notice.
  await expect(build(options(f, { output: join(f.root, "archive"), tarball: join(f.root, "image.tar") }) as any)).rejects.toThrow("Layer DiffID mismatch");
}, 120000);

test("an offline warm build reports a missing base blob at the point it is needed", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold"), offline: true }) as any);
  const blob = new BlobStore(f.base).path((await baseLayers(f.base)).at(-1)!.digest);
  await rm(blob);
  const phases: string[] = [];
  await expect(build(options(f, { output: join(f.root, "warm"), offline: true,
    progress: (event: any) => { if (event.status === "completed") phases.push(event.phase); } }) as any)).rejects.toThrow(blob);
  // The inspection itself succeeded from the record; the layout export is where the bytes were needed.
  expect(phases).toContain("base-inspect");
  await expect(build(options(f, { output: join(f.root, "cold-again"), offline: true, localCache: false }) as any)).rejects.toThrow(blob);
  expect(cold.images).toHaveLength(1);
}, 120000);

test("records outside the metadata limits are neither written nor read", async () => {
  const f = await fixture();
  const huge: BaseFilesystem = new Map();
  for (let i = 0; i < 90_000; i++) huge.set(`usr/lib/very/long/path/segment/${i}/${"x".repeat(60)}.so`, { type: "file", mode: 0o644, size: i });
  await writeBaseInspection(f.cache, `sha256:${"c".repeat(64)}`, huge, {}, () => {});
  expect(await Bun.file(baseInspectPath(f.cache, `sha256:${"c".repeat(64)}`)).exists()).toBe(false);
  // Above the entry cap a record is refused before any entry is inspected.
  const entry = { path: "app", type: "directory", mode: 0o755, size: 0 };
  const record = { schemaVersion: 1, kind: "base-inspect", version: baseInspectVersion, digest: `sha256:${"d".repeat(64)}`, entries: new Array(200_001).fill(entry) };
  expect(() => validateBaseInspection(record, `sha256:${"d".repeat(64)}`)).toThrow("Invalid base inspection entries");
  expect(validateBaseInspection({ ...record, entries: [entry] }, `sha256:${"d".repeat(64)}`).size).toBe(1);
}, 120000);

test("prune holds a current-version record to the rules a build reads it by", async () => {
  const f = await fixture();
  const cold = await build(options(f, { output: join(f.root, "cold") }) as any);
  const record = baseInspectPath(f.cache, cold.baseDigest as Digest);
  const stored = JSON.parse((await readFile(record)).toString());
  // Envelope-valid but unreadable: the build treats it as a miss, so prune must not count it as reusable.
  await writeFile(record, canonicalJSON({ ...stored, entries: [null] }));
  await expect(pruneLocal(f.cache, false, 0, Number.MAX_SAFE_INTEGER)).rejects.toThrow("Prune refuses inconsistent cache metadata");
  const repaired = await build(options(f, { output: join(f.root, "repaired") }) as any);
  expect(repaired.cache).toContainEqual({ kind: "base", key: cold.baseDigest, status: "miss", reason: "invalid-or-unavailable" });
  expect((await pruneLocal(f.cache, false, 0, Number.MAX_SAFE_INTEGER)).managedBytes).toBeGreaterThan(0);
  // A superseded version can never be read, so its content is not held to the current rules.
  const old = join(f.cache, baseInspectDirectory, "base-inspect-v0", `${"e".repeat(64)}.json`);
  await mkdir(join(f.cache, baseInspectDirectory, "base-inspect-v0"), { recursive: true });
  await writeFile(old, canonicalJSON({ schemaVersion: 1, kind: "base-inspect", version: "base-inspect-v0", digest: `sha256:${"e".repeat(64)}`, entries: [{ shape: "from a future version" }] }));
  expect((await pruneLocal(f.cache, false, Number.MAX_SAFE_INTEGER)).keys).toContain(join(baseInspectDirectory, "base-inspect-v0", `${"e".repeat(64)}.json`));
}, 120000);


test("a missing layout blob rejects consumption after destination setup", async () => {
  const root = await temporary(); roots.push(root);
  const descriptor = { digest: sha256("missing"), size: 7, mediaType: media.tar };
  const stream = await new LayoutSource(join(root, "missing-layout")).blob(descriptor);
  // Consumers may await filesystem setup before reading the returned iterable.
  await Bun.sleep(25);
  await expect(new BlobStore(join(root, "destination")).putStream(stream, media.tar, descriptor)).rejects.toThrow("ENOENT");
});
