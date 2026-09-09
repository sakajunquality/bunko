import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "../packages/bunko/build.ts";
import { assertBaseDataPaths } from "../packages/bunko/runtime-ca.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { media } from "../packages/oci/types.ts";
import { baseLayout, project, readJSON, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(entries: TarEntry[]) {
  const root = await temporary(); roots.push(root);
  const base = await baseLayout(join(root, "base")), store = new BlobStore(base);
  const index = await Bun.file(join(base, "index.json")).json();
  const manifest = await readJSON<any>(base, index.manifests[0]), config = await readJSON<any>(base, manifest.config);
  const layer = (await packLayer(store, entries, "assets", 0, []))!;
  manifest.layers.push(layer.descriptor); config.rootfs.diff_ids.push(layer.diffId); config.history.push({ created_by: "base path fixture" });
  manifest.config = await store.put(canonicalJSON(config), media.config);
  index.manifests[0] = await store.put(canonicalJSON(manifest), media.manifest);
  await writeFile(join(base, "index.json"), canonicalJSON(index));
  return { root, base, source: await project(join(root, "source")) };
}

test.each(["bundle", "source", "compile"])("%s rejects a base workdir symlink before publication", async (mode) => {
  const f = await fixture([{ path: "app", type: "symlink", target: "etc" }]), registry = new MockRegistry();
  await expect(build({ path: f.source, mode, baseLayout: f.base, repo: "registry.example/app", push: true, localCache: false, gitMetadata: false, registry: { fetcher: registry.fetch, credentials: async () => undefined } })).rejects.toThrow("workdir has a non-directory or symlink");
  expect(registry.requests.some((request) => !["GET", "HEAD"].includes(request.method))).toBe(false);
}, 120000);

test("stale base application content is rejected even when the current build could overwrite it", async () => {
  const f = await fixture([{ path: "app/old-module.js", type: "file", content: Buffer.from("old data") }]);
  await expect(build({ path: f.source, baseLayout: f.base, output: join(f.root, "image"), push: false, localCache: false, gitMetadata: false })).rejects.toThrow("Base application workdir is not empty");
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "fresh-app", module: "src/server.ts", bunko: { workdir: "/fresh-app" } }));
  const result = await build({ path: f.source, baseLayout: f.base, output: join(f.root, "fresh"), push: false, localCache: false, gitMetadata: false });
  expect((await readJSON<any>(result.layout!, result.config)).config.WorkingDir).toBe("/fresh-app");
});

test("ordinary external assets reject base symlink parents and incompatible destination types", async () => {
  for (const entries of [
    [{ path: "runtime-data", type: "symlink", target: "etc" }],
    [{ path: "runtime-data/config.json", type: "directory" }],
    [{ path: "runtime-data/config.json/nested", type: "file", content: Buffer.from("implied directory") }],
  ] as TarEntry[][]) {
    const f = await fixture(entries), context = join(f.root, "context"); await mkdir(context); await writeFile(join(context, "config.json"), "{}");
    await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "asset-guard", module: "src/server.ts", bunko: { assetMappings: [{ context: "data", from: "config.json", to: "/runtime-data/config.json" }] } }));
    await expect(build({ path: f.source, baseLayout: f.base, output: join(f.root, "image"), push: false, localCache: false, gitMetadata: false, assetContexts: { data: context } })).rejects.toThrow("Data destination");
  }
});

test("an asset cannot replace a directory that is only implied by base tar paths", () => {
  const tree = new Map([["runtime-data/config.json/child", { type: "file", mode: 420, size: 1 }]]);
  expect(() => assertBaseDataPaths(tree, [{ path: "runtime-data/config.json", type: "file", content: Buffer.from("data") }])).toThrow("incompatible base entry");
});


test("empty and explicitly cleared base workdirs are accepted", async () => {
  const empty = await fixture([{ path: "app", type: "directory" }]);
  const first = await build({ path: empty.source, baseLayout: empty.base, output: join(empty.root, "image"), push: false, localCache: false, gitMetadata: false });
  expect(first.images).toHaveLength(1);
  const f = await fixture([{ path: "app/old-module.js", type: "file", content: Buffer.from("old") }]);
  const archive = join(f.root, "opaque.tar");
  const child = Bun.spawn(["python3", "-c", "import tarfile,sys\nwith tarfile.open(sys.argv[1], 'w') as t:\n i=tarfile.TarInfo('app/.wh..wh..opq');t.addfile(i)", archive], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  const store = new BlobStore(f.base), index = await Bun.file(join(f.base, "index.json")).json();
  const manifest = await readJSON<any>(f.base, index.manifests[0]), config = await readJSON<any>(f.base, manifest.config), bytes = await readFile(archive);
  manifest.layers.push(await store.put(bytes, media.tar)); config.rootfs.diff_ids.push(sha256(bytes)); config.history.push({ created_by: "clear old application" });
  manifest.config = await store.put(canonicalJSON(config), media.config); index.manifests[0] = await store.put(canonicalJSON(manifest), media.manifest);
  await writeFile(join(f.base, "index.json"), canonicalJSON(index));
  const cleared = await build({ path: f.source, baseLayout: f.base, output: join(f.root, "image"), push: false, localCache: false, gitMetadata: false });
  expect(cleared.images).toHaveLength(1);
});

test("base inspection is shared across determinism passes", async () => {
  const f = await fixture([{ path: "app", type: "directory" }]); let scans = 0;
  const result = await build({ path: f.source, baseLayout: f.base, output: join(f.root, "image"), push: false, localCache: false, gitMetadata: false, verifyDeterministic: true,
    progress: (event) => { if (event.phase === "base-inspect" && event.status === "completed") scans++; } });
  expect(result.verifiedDeterministic).toBe(true); expect(scans).toBe(1);
});
