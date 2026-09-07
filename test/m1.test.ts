import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { LayoutSource, resolveBase } from "../packages/oci/source.ts";
import { media, type ImageIndex } from "../packages/oci/types.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { baseLayout, project, readJSON, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function dir() { const root = await temporary(); directories.push(root); return root; }

describe("M1 build/cache/export integration", () => {
  test("a source edit verifies remote deps/assets before reuse with zero upload", async () => {
    const root = await dir(), fixture = await dependencyFixture(root), base = await baseLayout(join(root, "base")), remote = new MockRegistry();
    const options = { path: fixture.source, baseLayout: base, repo: "registry.example/team", push: true, gitMetadata: false, localCache: false,
      registry: { fetcher: remote.fetch, credentials: async () => undefined }, installCache: fixture.cache };
    const first = await build(options);
    expect(first.publication?.published).toBe(true);
    expect(first.publication?.reference).toBe(`registry.example/team/hello@${first.root.digest}`);
    expect(first.cache.filter((c) => c.kind !== "app").map((c) => c.status)).toEqual(["miss", "miss"]);
    const reusable = first.layers.filter((l) => l.kind !== "app").map((l) => l.descriptor.digest);
    await writeFile(join(fixture.source, "src/server.ts"), 'import message from "fixture-msg"; console.log(message, "changed");\n');
    remote.requests.length = 0;
    const second = await build(options);
    expect(second.root.digest).not.toBe(first.root.digest);
    expect(second.cache.filter((c) => c.kind !== "app").map((c) => c.status)).toEqual(["registry", "registry"]);
    expect(second.publication!.transfers.filter((t) => ["deps", "assets"].includes(t.kind)).every((t) => t.uploaded === 0 && t.action === "reused")).toBe(true);
    expect(remote.requests.filter((r) => r.method === "GET" && reusable.some((digest) => r.url.pathname.endsWith(`/blobs/${digest}`)))).toHaveLength(reusable.length);
    expect(second.publication!.transfers.filter((t) => t.action === "uploaded").map((t) => t.kind).sort()).toEqual(["app", "config"]);
  });

  test("local cache recovers from a corrupt blob and determinism verification bypasses it", async () => {
    const root = await dir(), fixture = await dependencyFixture(root), base = await baseLayout(join(root, "base")), cache = join(root, "cache");
    const options = { path: fixture.source, baseLayout: base, gitMetadata: false, cacheDir: cache, installCache: fixture.cache };
    const first = await build({ ...options, output: join(root, "one") });
    const second = await build({ ...options, output: join(root, "two") });
    expect(second.cache.filter((c) => c.kind !== "app").map((c) => c.status)).toEqual(["local", "local"]);
    expect(second.root.digest).toBe(first.root.digest);
    const assets = first.layers.find((l) => l.kind === "assets")!;
    await writeFile(new BlobStore(cache).path(assets.descriptor.digest), "corrupt");
    const third = await build({ ...options, output: join(root, "three") });
    expect(third.cache.filter((c) => c.kind !== "app").map((c) => c.status)).toEqual(["miss", "local"]);
    expect(third.root.digest).toBe(first.root.digest);
    const checked = await build({ ...options, output: join(root, "four"), verifyDeterministic: true });
    expect(checked.cache.every((c) => c.status === "bypass")).toBe(true);
    expect(checked.root.digest).toBe(first.root.digest);
  });

  test("cache metadata corruption is a miss and denied cache writes do not fail image publication", async () => {
    const root = await dir(), fixture = await dependencyFixture(root), base = await baseLayout(join(root, "base")), remote = new MockRegistry();
    const options = { path: fixture.source, baseLayout: base, repo: "registry.example/team", push: true, gitMetadata: false, localCache: false,
      registry: { fetcher: remote.fetch, credentials: async () => undefined }, installCache: fixture.cache };
    const first = await build(options);
    for (const [key, value] of remote.manifests) if (key.includes("/bunko-cache-")) remote.manifests.set(key, { ...value, bytes: canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, layers: [] }) });
    remote.cacheWritable = false;
    const second = await build(options);
    expect(second.cache.filter((c) => c.kind !== "app").map((c) => c.status)).toEqual(["miss", "miss"]);
    expect(second.publication!.published).toBe(true);
    expect(second.root.digest).toBe(first.root.digest);
  });

  test("dry-run makes no registry writes or exports, but reports transfer estimates", async () => {
    const root = await dir(), source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), remote = new MockRegistry();
    const result = await build({ path: source, baseLayout: base, output: join(root, "out"), tarball: join(root, "out.tar"), repo: "registry.example/app", push: true, bare: true,
      dryRun: true, localCache: false, gitMetadata: false, report: join(root, "report.json"), registry: { fetcher: remote.fetch, credentials: async () => undefined } });
    expect(remote.requests.every((r) => ["GET", "HEAD"].includes(r.method))).toBe(true);
    expect(await Bun.file(join(root, "out/index.json")).exists()).toBe(false);
    expect(await Bun.file(join(root, "out.tar")).exists()).toBe(false);
    expect(result.publication?.transfers.some((t) => t.action === "would-upload")).toBe(true);
    expect(JSON.parse(await readFile(join(root, "report.json"), "utf8")).dryRun).toBe(true);
  });

  test("exports one index containing both platform manifests with shared assets", async () => {
    const root = await dir(), source = await project(join(root, "app"), { bunko: { assets: ["public"] } });
    await mkdir(join(source, "public")); await writeFile(join(source, "public/file"), "shared");
    const base = await baseLayout(join(root, "base")), arm = await baseLayout(join(root, "arm"), { os: "linux", architecture: "arm64" });
    const a = JSON.parse(await readFile(join(base, "index.json"), "utf8")) as ImageIndex;
    const b = await resolveBase(new LayoutSource(arm), { os: "linux", architecture: "arm64" }, new BlobStore(join(root, "arm-store")));
    for (const d of [b.descriptor, b.manifest.config, ...b.manifest.layers]) await new BlobStore(base).copyFrom(new BlobStore(arm), d);
    a.manifests.push({ ...b.descriptor, platform: { os: "linux", architecture: "arm64" } }); await writeFile(join(base, "index.json"), canonicalJSON(a));
    const result = await build({ path: source, baseLayout: base, output: join(root, "out"), platform: "linux/arm64,linux/amd64", localCache: false, gitMetadata: false, verifyDeterministic: true });
    const index = await readJSON<ImageIndex>(result.layout!, result.root);
    expect(index.manifests.map((d) => d.platform?.architecture)).toEqual(["amd64", "arm64"]);
    expect(result.images[0]!.layers[0]!.descriptor.digest).toBe(result.images[1]!.layers[0]!.descriptor.digest);
    for (const platform of [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "arm64" }] as const) {
      const selected = await resolveBase(new LayoutSource(result.layout!), platform, new BlobStore(join(root, `verify-${platform.architecture}`)));
      expect(selected.config.architecture).toBe(platform.architecture);
    }
    await expect(build({ path: source, baseLayout: base, output: join(root, "bad"), platform: "linux/amd64,linux/arm64", noIndex: true })).rejects.toThrow("single platform");
  });

  test("Docker archive has manifest.json and verified uncompressed layer.tar entries", async () => {
    const root = await dir(), source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), tarball = join(root, "image.tar");
    const result = await build({ path: source, baseLayout: base, tarball, localCache: false, gitMetadata: false });
    const script = `import tarfile,sys,json,io,hashlib
with tarfile.open(sys.argv[1]) as t:
 m=json.load(t.extractfile('manifest.json'))[0]
 c=json.load(t.extractfile(m['Config']))
 layers=[t.extractfile(p).read() for p in m['Layers']]
 assert ['sha256:'+hashlib.sha256(b).hexdigest() for b in layers] == c['rootfs']['diff_ids']
 print(json.dumps(dict(architecture=c['architecture'],tag=m['RepoTags'][0],files=tarfile.open(fileobj=io.BytesIO(layers[-1])).getnames())))`;
    const child = Bun.spawn(["python3", "-c", script, tarball], { stdout: "pipe", stderr: "pipe" });
    const data = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0); expect(data.architecture).toBe("amd64");
    expect(data.files).toContain("app/src/server.js"); expect(data.tag).toContain(result.root.digest.slice(7));
  });
});
