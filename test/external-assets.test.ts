import { MockRegistry } from "./mock-registry.ts";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { assetMappings, stageAssetMappings } from "../packages/bunko/asset-contexts.ts";
import { build } from "../packages/bunko/build.ts";
import { provenance } from "../packages/bunko/attest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { media, type Platform } from "../packages/oci/types.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

interface LayerFixture { gzip: Uint8Array; diffId: `sha256:${string}`; descriptor: { mediaType: string; digest: `sha256:${string}`; size: number } }
/** Build a raw gzip layer, including whiteouts, which the normal packer deliberately refuses to emit. */
async function layer(entries: { name: string; type?: "file" | "directory" | "symlink" | "link"; mode?: number; content?: string; linkname?: string }[]): Promise<LayerFixture> {
  const archive = pack();
  for (const entry of entries) archive.entry({ name: entry.name, type: entry.type ?? "file", mode: entry.mode ?? 0o644, linkname: entry.linkname, size: Buffer.byteLength(entry.content ?? "") }, entry.content ?? "");
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array));
  const tar = Buffer.concat(chunks), gzip = gzipSync(tar);
  return { gzip, diffId: sha256(tar), descriptor: { mediaType: media.gzip, digest: sha256(gzip), size: gzip.byteLength } };
}

const amd64: Platform = { os: "linux", architecture: "amd64" }, arm64: Platform = { os: "linux", architecture: "arm64", variant: "v8" };
function toolImage(registry: MockRegistry, repository: string, tag: string, variants: { platform: Platform; layers: LayerFixture[] }[], indexed = true) {
  const prefix = `registry.test/${repository}`;
  const store = (bytes: Uint8Array, type: string, references: string[]) => {
    const digest = sha256(bytes);
    for (const reference of [digest, ...references]) registry.manifests.set(`${prefix}/${reference}`, { bytes, type });
    return { mediaType: type, digest, size: bytes.byteLength };
  };
  const manifests = variants.map((variant) => {
    for (const item of variant.layers) registry.blobs.set(`${prefix}/${item.descriptor.digest}`, item.gzip);
    const config = canonicalJSON({ ...variant.platform, rootfs: { type: "layers", diff_ids: variant.layers.map((item) => item.diffId) } });
    registry.blobs.set(`${prefix}/${sha256(config)}`, config);
    const manifest = canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config: { mediaType: media.config, digest: sha256(config), size: config.byteLength }, layers: variant.layers.map((item) => item.descriptor) });
    return { ...store(manifest, media.manifest, indexed ? [] : [tag]), platform: variant.platform };
  });
  const root = indexed ? store(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests }), media.index, [tag]) : manifests[0]!;
  return { reference: `registry.test/${repository}:${tag}`, digest: `registry.test/${repository}@${root.digest}`, manifests };
}

async function fixture(indexed = true) {
  const root = await temporary(); roots.push(root);
  const registry = new MockRegistry();
  const first = await layer([
    { name: "usr/", type: "directory", mode: 0o755 }, { name: "usr/local/", type: "directory", mode: 0o755 }, { name: "usr/local/bin/", type: "directory", mode: 0o755 },
    { name: "usr/local/bin/spannerdef", mode: 0o755, content: "replaced binary" },
    { name: "opt/", type: "directory", mode: 0o755 }, { name: "opt/tool/", type: "directory", mode: 0o755 },
    { name: "opt/tool/old.txt", content: "stale" }, { name: "opt/tool/keep.txt", content: "keep" },
    { name: "opt/links/", type: "directory", mode: 0o755 }, { name: "opt/links/alias", type: "symlink", mode: 0o777, linkname: "../tool/keep.txt" },
    // No headers for opt/implicit or opt/implicit/bin, as several real images omit them.
    { name: "opt/implicit/bin/tool", mode: 0o755, content: "implicit tool" },
  ]);
  const variant = async (name: string) => layer([
    { name: "usr/local/bin/spannerdef", mode: 0o755, content: `${name} spannerdef` },
    { name: "opt/tool/.wh.old.txt" },
    { name: "opt/tool/nested/", type: "directory", mode: 0o755 }, { name: "opt/tool/nested/data.json", content: '{"schema":1}' },
  ]);
  const image = toolImage(registry, "tools/spannerdef", "v1.2.3", [
    { platform: amd64, layers: [first, await variant("amd64")] },
    ...(indexed ? [{ platform: arm64, layers: [first, await variant("arm64")] }] : []),
  ], indexed);
  const external = (platform: Platform = amd64) => ({ platform, registry: { fetcher: registry.fetch, credentials: async () => undefined }, cache: join(root, "asset-cache") });
  const configDigest = JSON.parse(Buffer.from(registry.manifests.get(`registry.test/tools/spannerdef/${image.manifests[0]!.digest}`)!.bytes).toString()).config.digest as string;
  return { root, registry, image, external, configDigest };
}

test("image asset mappings validate sources, references and destinations", () => {
  expect(() => assetMappings([{ image: "registry.test/tools:v1", context: "repo", from: "/bin/tool", to: "/tools/tool" }])).toThrow("exactly one of context, image or url");
  expect(() => assetMappings([{ image: "registry.test/tools:v1", url: "https://example.test/tool", sha256: "a".repeat(64), to: "/tools/tool" }])).toThrow("exactly one of context, image or url");
  expect(() => assetMappings([{ from: "/bin/tool", to: "/tools/tool" }])).toThrow("exactly one of context, image or url");
  expect(() => assetMappings([{ image: "registry.test/tools:v1", from: "bin/tool", to: "/tools/tool" }])).toThrow("absolute from path");
  for (const from of ["/bin/../tool", "/bin/*", "/"]) expect(() => assetMappings([{ image: "registry.test/tools:v1", from, to: "/tools/tool" }])).toThrow();
  expect(() => assetMappings([{ image: "registry.test/tools:v1 bad", from: "/bin/tool", to: "/tools/tool" }])).toThrow("Invalid image reference");
  expect(() => assetMappings([{ image: "registry.test/tools:v1", from: "/bin/tool", to: "/usr/local/bin/tool" }])).toThrow("destination is reserved");
  expect(() => assetMappings([{ image: "registry.test/tools:v1", from: "/bin/tool", to: "/tools/tool", mode: "4755" }])).toThrow("Asset mode");
  expect(() => assetMappings([{ image: "registry.test/tools:v1", from: "/bin/tool", to: "/tools/tool", exclude: ["x"] }])).toThrow("accept only");
  expect(assetMappings([{ image: "registry.test/tools:v1", from: "/bin/tool", to: "/tools/tool", mode: "0755", platform: "linux/amd64" }])[0]).toEqual({ image: "registry.test/tools:v1", from: "/bin/tool", to: "/tools/tool", mode: "0755", platform: "linux/amd64" });
});

test("url asset mappings require https and a mandatory lowercase digest", () => {
  const valid = { url: "https://example.test/tool.tgz", sha256: "b".repeat(64), to: "/tools/tool" };
  expect(assetMappings([valid])[0]).toEqual(valid);
  expect(() => assetMappings([{ ...valid, url: "http://example.test/tool.tgz" }])).toThrow("plain HTTPS location");
  expect(() => assetMappings([{ ...valid, url: "https://user:secret@example.test/tool.tgz" }])).toThrow("without credentials");
  expect(() => assetMappings([{ ...valid, url: "https://example.test/tool.tgz#part" }])).toThrow("without credentials");
  expect(() => assetMappings([{ url: valid.url, to: "/tools/tool" }])).toThrow("require url and sha256");
  for (const sha256 of ["B".repeat(64), "c".repeat(63), "sha256:" + "d".repeat(64)]) expect(() => assetMappings([{ ...valid, sha256 }])).toThrow("64 lowercase hexadecimal");
  expect(() => assetMappings([{ ...valid, from: "tool" }])).toThrow("accept only");
  expect(() => assetMappings([{ ...valid, to: "/etc/tool" }])).toThrow("destination is reserved");
});

test("image sources copy a file and a directory, applying later layers and whiteouts", async () => {
  const f = await fixture();
  const staged = await stageAssetMappings([
    { image: f.image.reference, from: "/usr/local/bin/spannerdef", to: "/tools/spannerdef", mode: "0755" },
    { image: f.image.reference, from: "/opt/tool", to: "/tools/tool" },
  ], {}, join(f.root, "stage"), [], f.external());
  const paths = staged.entries.map((entry) => entry.path).sort();
  expect(paths).toEqual(["tools/spannerdef", "tools/tool", "tools/tool/keep.txt", "tools/tool/nested", "tools/tool/nested/data.json"]);
  const binary = staged.entries.find((entry) => entry.path === "tools/spannerdef")!;
  if (binary.type !== "file" || !("source" in binary)) throw new Error("Expected a staged file");
  expect(await Bun.file(binary.source).text()).toBe("amd64 spannerdef");
  expect(binary.executable).toBe(true);
  expect(staged.materials[0]!.resolved).toBe(f.image.manifests[0]!.digest);
  expect(JSON.stringify(staged.materials)).not.toContain(f.root);
});

test("image sources resolve the target platform and honour an explicit override", async () => {
  const f = await fixture();
  const selection = { image: f.image.reference, from: "/usr/local/bin/spannerdef", to: "/tools/spannerdef", mode: "0755" };
  const content = async (mapping: { image: string; from: string; to: string; mode?: string; platform?: string }, platform: Platform) => {
    const staged = await stageAssetMappings([mapping], {}, join(f.root, `stage-${Math.random()}`), [], f.external(platform));
    const entry = staged.entries[0]!;
    if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
    return { text: await Bun.file(entry.source).text(), resolved: staged.materials[0]!.resolved };
  };
  expect((await content(selection, amd64)).text).toBe("amd64 spannerdef");
  const other = await content(selection, arm64);
  expect(other.text).toBe("arm64 spannerdef");
  expect(other.resolved).toBe(f.image.manifests[1]!.digest);
  // A single-platform tool image needs the override to serve a differently targeted build.
  const single = await fixture(false);
  await expect(stageAssetMappings([{ ...selection, image: single.image.reference }], {}, join(single.root, "stage"), [], single.external(arm64))).rejects.toThrow("does not match the requested platform");
  expect((await content({ ...selection, image: single.image.reference, platform: "linux/amd64" }, arm64)).text).toBe("amd64 spannerdef");
});

test("image extraction is cached by resolved digest, selection and mode", async () => {
  const f = await fixture();
  const mapping = { image: f.image.reference, from: "/opt/tool", to: "/tools/tool" };
  const first = await stageAssetMappings([mapping], {}, join(f.root, "first"), [], f.external());
  const pulled = (request: { url: URL }) => request.url.pathname.includes("/blobs/") && !request.url.pathname.endsWith(f.configDigest);
  const blobs = f.registry.requests.filter(pulled).length;
  expect(blobs).toBe(2);
  const second = await stageAssetMappings([mapping], {}, join(f.root, "second"), [], f.external());
  expect(second.materials[0]!.digest).toBe(first.materials[0]!.digest);
  expect(f.registry.requests.filter(pulled).length).toBe(blobs);
  // A different mode is a different extraction, but still reuses no stale content.
  const relabelled = await stageAssetMappings([{ ...mapping, mode: "0444" }], {}, join(f.root, "third"), [], f.external());
  expect(relabelled.materials[0]!.digest).not.toBe(first.materials[0]!.digest);
});

test("image sources reject links, missing paths, offline builds and unpinned reproducible references", async () => {
  const f = await fixture();
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/opt/missing", to: "/tools/missing" }], {}, join(f.root, "missing"), [], f.external())).rejects.toThrow("Missing image asset input");
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/opt/tool/keep.txt/inner", to: "/tools/inner" }], {}, join(f.root, "inner"), [], f.external())).rejects.toThrow("traverses a link or non-directory");
  for (const from of ["/opt/links", "/opt/links/alias"]) await expect(stageAssetMappings([{ image: f.image.reference, from, to: "/tools/alias" }], {}, join(f.root, `link-${from.length}`), [], f.external())).rejects.toThrow("Unsupported image asset entry type (symlink)");
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/opt/links/alias/keep.txt", to: "/tools/alias" }], {}, join(f.root, "through"), [], f.external())).rejects.toThrow("traverses a link or non-directory");
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/opt/tool", to: "/tools/tool" }], {}, join(f.root, "offline"), [], { ...f.external(), offline: true })).rejects.toThrow("Offline builds cannot resolve image asset sources");
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/opt/tool", to: "/tools/tool" }], {}, join(f.root, "tagged"), [], { ...f.external(), reproducible: true })).rejects.toThrow("pinned to a sha256 digest");
  await stageAssetMappings([{ image: f.image.digest, from: "/opt/tool", to: "/tools/tool" }], {}, join(f.root, "pinned"), [], { ...f.external(), reproducible: true });
});

test("image assets build a runnable image and record the resolved digest in provenance", async () => {
  const f = await fixture();
  const source = await project(join(f.root, "app"), { bunko: { assetMappings: [
    { image: f.image.reference, from: "/usr/local/bin/spannerdef", to: "/tools/spannerdef", mode: "0755" },
    { image: f.image.reference, from: "/opt/tool", to: "/tools/tool" },
  ] } }, 'console.log("server");');
  const result = await build({ path: source, baseLayout: await baseLayout(join(f.root, "base")), output: join(f.root, "image"), gitMetadata: false,
    cacheDir: join(f.root, "cache"), assetCache: join(f.root, "asset-cache"), registry: { fetcher: f.registry.fetch, credentials: async () => undefined } });
  const layers = result.layers.find((item) => item.kind === "assets")!;
  const entries = await inspectTar(new BlobStore(result.layout!).path(layers.descriptor.digest));
  expect(entries.find((item) => item.name === "tools/spannerdef")?.content).toBe("amd64 spannerdef");
  expect(entries.find((item) => item.name === "tools/spannerdef")?.mode).toBe(0o755);
  expect(entries.find((item) => item.name === "tools/tool/nested/data.json")?.content).toBe('{"schema":1}');
  expect(entries.some((item) => item.name.endsWith("old.txt"))).toBe(false);
  expect(result.assetMaterials!.map((material) => material.resolved)).toEqual([f.image.manifests[0]!.digest, f.image.manifests[0]!.digest]);
  expect(result.assetMaterials!.every((material) => material.platforms?.join() === "linux/amd64")).toBe(true);
  const statement = JSON.stringify(provenance(result));
  expect(statement).toContain("urn:bunko:asset:image:0");
  expect(statement).toContain(f.image.manifests[0]!.digest);
});

/** A two-platform base layout, so per-platform asset layers can be compared in one build. */
async function dualBase(root: string): Promise<string> {
  const store = new BlobStore(root), manifests = [];
  for (const platform of [amd64, arm64]) {
    const item = (await packLayer(store, [{ path: "base-marker", type: "file", content: Buffer.from(`${platform.architecture}\n`) }], "assets", 0))!;
    const config = await store.put(canonicalJSON({ ...platform, config: { User: "65532:65532", Env: ["PATH=/usr/local/bin:/usr/bin:/bin"] }, rootfs: { type: "layers", diff_ids: [item.diffId] } }), media.config);
    manifests.push({ ...await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config, layers: [item.descriptor] }), media.manifest), platform });
  }
  await writeFile(join(root, "oci-layout"), canonicalJSON({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(root, "index.json"), canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests }));
  return root;
}

test("multi-platform builds pack one asset layer per platform", async () => {
  const f = await fixture();
  const source = await project(join(f.root, "app"), { bunko: { assetMappings: [
    { image: f.image.reference, from: "/usr/local/bin/spannerdef", to: "/tools/spannerdef", mode: "0755" },
    // Pinned to one platform, so every target resolves the same content and shares one material.
    { image: f.image.reference, from: "/opt/tool", to: "/tools/tool", platform: "linux/amd64" },
  ] } }, 'console.log("server");');
  const result = await build({ path: source, baseLayout: await dualBase(join(f.root, "dual")), platform: "linux/amd64,linux/arm64", output: join(f.root, "image"), gitMetadata: false,
    cacheDir: join(f.root, "cache"), assetCache: join(f.root, "asset-cache"), registry: { fetcher: f.registry.fetch, credentials: async () => undefined } });
  const assets = result.images.map((image) => image.layers.find((item) => item.kind === "assets")!.descriptor.digest);
  expect(assets[0]).not.toBe(assets[1]);
  for (const [index, image] of result.images.entries()) {
    const entries = await inspectTar(new BlobStore(result.layout!).path(assets[index]!));
    expect(entries.find((item) => item.name === "tools/spannerdef")?.content).toBe(`${image.platform.architecture} spannerdef`);
    expect(entries.find((item) => item.name === "tools/tool/keep.txt")?.content).toBe("keep");
  }
  // Each material names the target platforms it was resolved for, so two digests are never ambiguous,
  // and a platform-independent selection stays one material carrying both.
  expect(result.assetMaterials!.map((material) => [material.to, material.resolved, material.platforms])).toEqual([
    ["/tools/spannerdef", f.image.manifests[0]!.digest, ["linux/amd64"]],
    ["/tools/tool", f.image.manifests[0]!.digest, ["linux/amd64", "linux/arm64"]],
    ["/tools/spannerdef", f.image.manifests[1]!.digest, ["linux/arm64"]],
  ]);
  const statement = JSON.stringify(provenance(result));
  for (const platform of ["linux/amd64", "linux/arm64"]) expect(statement).toContain(platform);
});

/** An in-memory fetch. The downloader only ever sees fetch-shaped calls, so this drives exactly the same
 * code paths as a socket transport while staying deterministic on every Bun release and runner: no
 * listener, port, resolver or address family is involved. Bodies are pulled one chunk at a time and
 * honour the abort signal, so what the downloader actually reads is observable, and a body that never
 * completes is expressed directly instead of through a server runtime's streaming semantics. */
interface AssetRoute { status?: number; location?: string; body?: string; oversized?: number; stall?: boolean }
function assetFetcher(route: (url: URL, count: number) => AssetRoute | undefined) {
  let requests = 0, pulls = 0;
  const filler = new Uint8Array(64 * 1024);
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input), selected = route(url, ++requests);
    if (!selected) throw new Error(`Fixture has no route for ${input}`);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new Error("The operation was aborted");
    const payload = selected.body === undefined ? undefined : new TextEncoder().encode(selected.body);
    let sent = false, remaining = selected.oversized ?? 0;
    const next = () => { if (payload && !sent) { sent = true; return payload; } if (remaining > 0) { remaining--; return filler; } return undefined; };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) { controller.error(new Error("The operation was aborted")); return; }
        const value = next();
        if (value) { pulls++; controller.enqueue(value); return; }
        if (!selected.stall) { controller.close(); return; }
        if (!signal) throw new Error("Fixture stall requires an abort signal");
        // Never settles on its own: only the downloader's own deadline ends this body.
        return new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true }));
      },
    });
    return new Response(body, { status: selected.status ?? 200, headers: selected.location ? { location: selected.location } : {} });
  };
  return { fetcher, requests: () => requests, pulls: () => pulls };
}

const body = "static go binary\n";
const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");

test("url assets stream, verify and cache a single file", async () => {
  const root = await temporary(); roots.push(root);
  const server = assetFetcher(() => ({ body }));
  const external = { platform: amd64, cache: join(root, "asset-cache"), fetcher: server.fetcher };
  const mapping = { url: "https://assets.test/spannerdef", sha256: digest, to: "/tools/spannerdef", mode: "0755" };
  const staged = await stageAssetMappings([mapping], {}, join(root, "first"), [], external);
  const entry = staged.entries[0]!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  expect(entry.path).toBe("tools/spannerdef");
  expect(entry.executable).toBe(true);
  expect(await Bun.file(entry.source).text()).toBe(body);
  expect(server.requests()).toBe(1);
  // A cached digest is reused without another request, and stays available offline.
  await stageAssetMappings([mapping], {}, join(root, "second"), [], external);
  expect(server.requests()).toBe(1);
  await stageAssetMappings([mapping], {}, join(root, "offline"), [], { ...external, offline: true });
  await expect(stageAssetMappings([mapping], {}, join(root, "cold"), [], { ...external, cache: join(root, "empty"), offline: true })).rejects.toThrow("Offline builds require a cached URL asset");
});

test("url assets fail closed on checksum, size, redirect and transport violations", async () => {
  const root = await temporary(); roots.push(root);
  const wrong = assetFetcher(() => ({ body: "tampered payload" }));
  const external = { platform: amd64, cache: join(root, "asset-cache"), fetcher: wrong.fetcher };
  const mapping = { url: "https://assets.test/spannerdef", sha256: digest, to: "/tools/spannerdef" };
  const failure = stageAssetMappings([mapping], {}, join(root, "mismatch"), [], external);
  await expect(failure).rejects.toThrow(`expected sha256:${digest}`);
  await expect(stageAssetMappings([mapping], {}, join(root, "mismatch2"), [], external)).rejects.toThrow("received sha256:");
  const large = assetFetcher(() => ({ body }));
  await expect(stageAssetMappings([mapping], {}, join(root, "large"), [], { ...external, fetcher: large.fetcher, limit: 4 })).rejects.toThrow("exceeds the 4 byte limit");
  const looping = assetFetcher((url, count) => ({ status: 302, location: `https://assets.test/hop-${count}` }));
  await expect(stageAssetMappings([mapping], {}, join(root, "loop"), [], { ...external, fetcher: looping.fetcher })).rejects.toThrow("exceeded 4 redirects");
  const offsite = assetFetcher(() => ({ status: 302, location: "https://elsewhere.test/spannerdef" }));
  await expect(stageAssetMappings([mapping], {}, join(root, "offsite"), [], { ...external, fetcher: offsite.fetcher })).rejects.toThrow("redirected off its original host");
  const missing = assetFetcher(() => ({ status: 404 }));
  await expect(stageAssetMappings([mapping], {}, join(root, "missing"), [], { ...external, fetcher: missing.fetcher })).rejects.toThrow("Asset download failed (404)");
});

test.each([301, 302, 307, 308])("a %i redirect to the same host is followed once", async (status) => {
  const root = await temporary(); roots.push(root);
  const server = assetFetcher((url) => url.pathname.endsWith("/final") ? { body } : { status, location: "https://assets.test/final" });
  const staged = await stageAssetMappings([{ url: "https://assets.test/download", sha256: digest, to: "/tools/spannerdef" }], {}, join(root, "stage"), [], { platform: amd64, cache: join(root, "asset-cache"), fetcher: server.fetcher });
  const entry = staged.entries[0]!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  expect(await Bun.file(entry.source).text()).toBe(body);
  expect(entry.executable).toBe(false);
  expect(server.requests()).toBe(2);
});

/** A single-platform image built from exact layer contents, for whiteout and link edge cases. */
async function layeredImage(name: string, sets: Parameters<typeof layer>[0][]) {
  const root = await temporary(); roots.push(root);
  const registry = new MockRegistry(), layers: LayerFixture[] = [];
  for (const set of sets) layers.push(await layer(set));
  const image = toolImage(registry, `tools/${name}`, "v1", [{ platform: amd64, layers }], false);
  const external = (extra: Record<string, unknown> = {}) => ({ platform: amd64, registry: { fetcher: registry.fetch, credentials: async () => undefined }, cache: join(root, "asset-cache"), ...extra });
  return { root, registry, image, external };
}

test("a lower symlink parent survives an upper layer that only populates through it", async () => {
  const f = await layeredImage("linked-parent", [
    [{ name: "a", type: "symlink", mode: 0o777, linkname: "/elsewhere" }],
    [{ name: "a/tool", mode: 0o755, content: "tool" }],
  ]);
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/a", to: "/tools/a" }], {}, join(f.root, "root"), [], f.external())).rejects.toThrow("Unsupported image asset entry type (symlink)");
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/a/tool", to: "/tools/tool" }], {}, join(f.root, "child"), [], f.external())).rejects.toThrow("traverses a link or non-directory");
});

test("a whiteout followed by repopulation leaves the directory selectable", async () => {
  const f = await layeredImage("repopulated", [
    [{ name: "a/", type: "directory", mode: 0o755 }, { name: "a/old", content: "old" }],
    [{ name: "a/.wh.old" }],
    [{ name: ".wh.a" }, { name: "a/new", content: "new" }],
  ]);
  const staged = await stageAssetMappings([{ image: f.image.reference, from: "/a", to: "/tools/a" }], {}, join(f.root, "stage"), [], f.external());
  expect(staged.entries.map((entry) => entry.path).sort()).toEqual(["tools/a", "tools/a/new"]);
  const entry = staged.entries.find((item) => item.path === "tools/a/new")!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  expect(await Bun.file(entry.source).text()).toBe("new");
});

test("implied directories count toward the selection bound even when a later whiteout deletes them", async () => {
  const f = await layeredImage("churn", [
    [{ name: "a/b/c/tool", mode: 0o755, content: "tool" }],
    [{ name: "a/.wh.b" }],
    [{ name: "a/new", content: "new" }],
  ]);
  const mapping = { image: f.image.reference, from: "/a", to: "/tools/a" };
  // The first layer contributes exactly four (a, a/b, a/b/c, a/b/c/tool), all but one later deleted.
  // Only the final file crosses a bound of four, so a counter that shrank on deletion would not throw.
  await expect(stageAssetMappings([mapping], {}, join(f.root, "bounded"), [], f.external({ entryLimit: 4 }))).rejects.toThrow("too many entries");
  const exact = await stageAssetMappings([mapping], {}, join(f.root, "exact"), [], f.external({ entryLimit: 5 }));
  expect(exact.entries.map((entry) => entry.path).sort()).toEqual(["tools/a", "tools/a/new"]);
  const staged = await stageAssetMappings([mapping], {}, join(f.root, "stage"), [], f.external());
  expect(staged.entries.map((entry) => entry.path).sort()).toEqual(["tools/a", "tools/a/new"]);
});

async function selection(image: Awaited<ReturnType<typeof layeredImage>>, from: string, name: string) {
  const staged = await stageAssetMappings([{ image: image.image.reference, from, to: "/tools/x" }], {}, join(image.root, name), [], image.external());
  const contents: Record<string, string> = {};
  for (const entry of staged.entries) if (entry.type === "file" && "source" in entry) contents[entry.path] = await Bun.file(entry.source).text();
  return { paths: staged.entries.map((entry) => entry.path).sort(), contents };
}

test("a directory deleted in one layer and repopulated in a later one keeps only the new content", async () => {
  const f = await layeredImage("later-repopulation", [
    [{ name: "a/", type: "directory", mode: 0o755 }, { name: "a/old", content: "old" }],
    [{ name: ".wh.a" }],
    [{ name: "a/new", content: "new" }],
  ]);
  const result = await selection(f, "/a", "stage");
  expect(result.paths).toEqual(["tools/x", "tools/x/new"]);
  expect(result.contents).toEqual({ "tools/x/new": "new" });
});

test.each([
  ["nested", "a/.wh..wh..opq"],
  ["root", ".wh..wh..opq"],
])("an opaque whiteout (%s) removes earlier content below the selection", async (name, marker) => {
  const f = await layeredImage(`opaque-${name}`, [
    [{ name: "a/", type: "directory", mode: 0o755 }, { name: "a/old", content: "old" }, { name: "a/stale/", type: "directory", mode: 0o755 }, { name: "a/stale/deep", content: "deep" }],
    [{ name: marker }, { name: "a/new", content: "new" }],
  ]);
  const result = await selection(f, "/a", "stage");
  expect(result.paths).toEqual(["tools/x", "tools/x/new"]);
  expect(result.contents).toEqual({ "tools/x/new": "new" });
});

test("file and directory transitions across layers replace the previous entry", async () => {
  const toDirectory = await layeredImage("file-to-directory", [
    [{ name: "x", content: "was a file" }],
    [{ name: "x/", type: "directory", mode: 0o755 }, { name: "x/inner", content: "inner" }],
  ]);
  const directory = await selection(toDirectory, "/x", "stage");
  expect(directory.paths).toEqual(["tools/x", "tools/x/inner"]);
  expect(directory.contents).toEqual({ "tools/x/inner": "inner" });
  const toFile = await layeredImage("directory-to-file", [
    [{ name: "y/", type: "directory", mode: 0o755 }, { name: "y/inner", content: "inner" }],
    [{ name: "y", content: "now a file" }],
  ]);
  const file = await selection(toFile, "/y", "stage");
  expect(file.paths).toEqual(["tools/x"]);
  expect(file.contents).toEqual({ "tools/x": "now a file" });
  // The replaced directory's child is gone, and the new file is refused as a parent rather than traversed.
  await expect(stageAssetMappings([{ image: toFile.image.reference, from: "/y/inner", to: "/tools/inner" }], {}, join(toFile.root, "gone"), [], toFile.external())).rejects.toThrow("traverses a link or non-directory");
  // A file a later layer populated through without replacing it must not silently lose those entries.
  const populated = await layeredImage("file-populated", [
    [{ name: "z", content: "was a file" }],
    [{ name: "z/inner", content: "inner" }],
  ]);
  await expect(stageAssetMappings([{ image: populated.image.reference, from: "/z", to: "/tools/z" }], {}, join(populated.root, "stage"), [], populated.external())).rejects.toThrow("is a file with entries beneath it");
});

test("a hard link under an implied parent is rejected", async () => {
  const f = await layeredImage("hard-link", [
    [{ name: "h/target", content: "target" }, { name: "h/alias", type: "link", linkname: "h/target" }],
  ]);
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/h", to: "/tools/h" }], {}, join(f.root, "stage"), [], f.external())).rejects.toThrow("Unsupported image asset entry type (link)");
  await expect(stageAssetMappings([{ image: f.image.reference, from: "/h/alias", to: "/tools/alias" }], {}, join(f.root, "alias"), [], f.external())).rejects.toThrow("Unsupported image asset entry type (link)");
});

test("selections resolve directories that exist only implicitly in a layer", async () => {
  const f = await fixture();
  const staged = await stageAssetMappings([{ image: f.image.reference, from: "/opt/implicit", to: "/tools/implicit" }], {}, join(f.root, "stage"), [], f.external());
  expect(staged.entries.map((entry) => entry.path).sort()).toEqual(["tools/implicit", "tools/implicit/bin", "tools/implicit/bin/tool"]);
  const entry = staged.entries.find((item) => item.path === "tools/implicit/bin/tool")!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  expect(await Bun.file(entry.source).text()).toBe("implicit tool");
});

test("selected content bounds count directories and bytes, not only files", async () => {
  const f = await fixture();
  const mapping = { image: f.image.reference, from: "/opt/tool", to: "/tools/tool" };
  await expect(stageAssetMappings([mapping], {}, join(f.root, "entries"), [], { ...f.external(), entryLimit: 2 })).rejects.toThrow("too many entries");
  await expect(stageAssetMappings([mapping], {}, join(f.root, "bytes"), [], { ...f.external(), limit: 4 })).rejects.toThrow("exceeds the extraction size limit");
});

test("image assets are frozen into build staging and a poisoned cache is detected", async () => {
  const f = await fixture(), cache = join(f.root, "asset-cache");
  const mapping = { image: f.image.reference, from: "/opt/tool", to: "/tools/tool" };
  const first = await stageAssetMappings([mapping], {}, join(f.root, "first"), [], f.external());
  const entry = first.entries.find((item) => item.path === "tools/tool/keep.txt")!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  // Packing and hashing read private staging, never the shared cache pathname.
  expect(entry.source.startsWith(join(f.root, "first"))).toBe(true);
  expect(entry.source.startsWith(cache)).toBe(false);
  const key = (await readdir(join(cache, "images")))[0]!, content = join(cache, "images", key, "content");
  const repair = async (name: string) => {
    const repaired = await stageAssetMappings([mapping], {}, join(f.root, name), [], f.external());
    expect(repaired.materials[0]!.digest).toBe(first.materials[0]!.digest);
    const restored = repaired.entries.find((item) => item.path === "tools/tool/keep.txt")!;
    if (restored.type !== "file" || !("source" in restored)) throw new Error("Expected a staged file");
    expect(await Bun.file(restored.source).text()).toBe("keep");
    expect(repaired.entries.map((item) => item.path).sort()).toEqual(first.entries.map((item) => item.path).sort());
  };
  // Same length, so only the recorded digest distinguishes the substitution.
  await writeFile(join(content, "keep.txt"), "KEEP");
  await repair("same-length");
  // Metadata-only changes are caught as well: the executable bit and an added directory.
  await chmod(join(content, "keep.txt"), 0o700);
  await repair("mode");
  await mkdir(join(content, "extra"), { recursive: true });
  await repair("directory");
  // A regular file swapped for a link is never read through, whatever it points at.
  await rm(join(content, "keep.txt"));
  await symlink(join(f.root, "outside.txt"), join(content, "keep.txt"));
  await writeFile(join(f.root, "outside.txt"), "outside secret");
  await repair("link");
  // A manifest that no longer describes the cached content is discarded rather than trusted.
  await writeFile(join(cache, "images", key, "manifest.json"), '{"schemaVersion":1}');
  await repair("manifest");
});

test("url assets are frozen into build staging and a poisoned cache is detected", async () => {
  const root = await temporary(); roots.push(root);
  const cache = join(root, "asset-cache"), server = assetFetcher(() => ({ body }));
  const external = { platform: amd64, cache, fetcher: server.fetcher };
  const mapping = { url: "https://assets.test/spannerdef", sha256: digest, to: "/tools/spannerdef" };
  const first = await stageAssetMappings([mapping], {}, join(root, "first"), [], external);
  const entry = first.entries[0]!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  expect(entry.source.startsWith(join(root, "first"))).toBe(true);
  expect(entry.source.startsWith(cache)).toBe(false);
  await writeFile(join(cache, "downloads", digest, "asset"), "poisoned");
  // Offline cannot repair a poisoned entry, so the mismatch has to surface rather than be packed.
  await expect(stageAssetMappings([mapping], {}, join(root, "offline"), [], { ...external, offline: true })).rejects.toThrow("Asset cache checksum mismatch");
  const repaired = await stageAssetMappings([mapping], {}, join(root, "second"), [], external);
  const restored = repaired.entries[0]!;
  if (restored.type !== "file" || !("source" in restored)) throw new Error("Expected a staged file");
  expect(await Bun.file(restored.source).text()).toBe(body);
  expect(server.requests()).toBe(2);
});

test("url downloads bound transport consumption and abort a stalled body", async () => {
  const root = await temporary(); roots.push(root);
  const mapping = { url: "https://assets.test/spannerdef", sha256: digest, to: "/tools/spannerdef" };
  // A 4 MiB body against a 4 KiB cap: the downloader must stop reading, not drain it.
  const large = assetFetcher(() => ({ oversized: 64 }));
  await expect(stageAssetMappings([mapping], {}, join(root, "large"), [], { platform: amd64, cache: join(root, "large-cache"), fetcher: large.fetcher, limit: 4096 })).rejects.toThrow("exceeds the 4096 byte limit");
  expect(large.pulls()).toBeLessThanOrEqual(2);
  const stalled = assetFetcher(() => ({ body: "12345678", stall: true }));
  const started = Date.now();
  await expect(stageAssetMappings([mapping], {}, join(root, "stalled"), [], { platform: amd64, cache: join(root, "stalled-cache"), fetcher: stalled.fetcher, timeoutMs: 250 })).rejects.toThrow(/abort/i);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await Bun.file(join(root, "stalled-cache", "downloads", digest, "asset")).exists()).toBe(false);
});

test("an unexpected request names the exact URL the downloader asked for", async () => {
  const root = await temporary(); roots.push(root);
  const server = assetFetcher((url) => url.pathname === "/expected" ? { body } : undefined);
  await expect(stageAssetMappings([{ url: "https://assets.test/unexpected", sha256: digest, to: "/tools/spannerdef" }], {}, join(root, "stage"), [], { platform: amd64, cache: join(root, "asset-cache"), fetcher: server.fetcher }))
    .rejects.toThrow("Fixture has no route for https://assets.test/unexpected");
});

test.each([
  ["http://assets.test/final", "plain HTTPS location"],
  ["https://user:secret@assets.test/final", "without credentials"],
  ["https://assets.test.evil.test/final", "redirected off its original host"],
  ["https://evilassets.test/final", "redirected off its original host"],
])("redirect targets are rejected: %s", async (location, message) => {
  const root = await temporary(); roots.push(root);
  const server = assetFetcher((url) => url.pathname.endsWith("/final") ? { body } : { status: 302, location });
  await expect(stageAssetMappings([{ url: "https://assets.test/download", sha256: digest, to: "/tools/spannerdef" }], {}, join(root, "stage"), [], { platform: amd64, cache: join(root, "asset-cache"), fetcher: server.fetcher })).rejects.toThrow(message);
});

test.each([
  ["https://assets.test/download", "https://cdn.assets.test/final"],
  ["https://github.com/OWNER/tool/releases/download/v1/tool", "https://objects.githubusercontent.com/final"],
])("redirect targets are accepted: %s", async (url, location) => {
  const root = await temporary(); roots.push(root);
  const server = assetFetcher((target) => target.pathname.endsWith("/final") ? { body } : { status: 302, location });
  const staged = await stageAssetMappings([{ url, sha256: digest, to: "/tools/spannerdef" }], {}, join(root, "stage"), [], { platform: amd64, cache: join(root, "asset-cache"), fetcher: server.fetcher });
  const entry = staged.entries[0]!;
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected a staged file");
  expect(await Bun.file(entry.source).text()).toBe(body);
});
