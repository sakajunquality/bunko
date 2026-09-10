import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { applyDocuments } from "../packages/bunko/apply.ts";
import { packDependencies, importDependencies } from "../packages/bunko/external-deps.ts";
import { pushLayout } from "../packages/bunko/push-layout.ts";
import { pruneLocal, pruneRegistry } from "../packages/bunko/prune.ts";
import { LayerCache, cacheKey, packFormat } from "../packages/bunko/cache.ts";
import { dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer, tar } from "../packages/oci/tar.ts";
import { extractDependencies } from "../packages/oci/extract.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { runImage } from "./run-image.ts";
import { MockRegistry } from "./mock-registry.ts";
import { resolveDocuments } from "../packages/bunko/resolve.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }
const platform = { os: "linux", architecture: "amd64" } as const;

test("external dependency artifacts preserve prepared packages, enforce lock/platform and run", async () => {
  const root = await fixture(), f = await dependencyFixture(root), selected = await loadProject({ path: f.source });
  const plan = await dependencyPlan(selected, f.source);
  await installDependencies(f.source, plan, await selectToolchain(), platform, f.cache);
  const pkgPath = join(f.source, "node_modules/fixture-msg/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  await writeFile(pkgPath, JSON.stringify({ ...pkg, scripts: { install: "THIS MUST NEVER EXECUTE" } }));
  const output = join(root, "deps");
  const packed = await packDependencies(f.source, join(f.source, "bun.lock"), platform, output);
  expect(packed.inventory.map((i) => i.name)).toContain("fixture-msg");
  const mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  const publication = await pushLayout(output, "registry.test/deps", [], registry);
  expect(publication.reference).toBe(`registry.test/deps@${packed.digest}`);
  const imported = await importDependencies(publication.reference, platform, "/app", plan.lock, join(root, "registry-import"), registry);
  expect(imported.inventory).toEqual(packed.inventory);
  const base = await baseLayout(join(root, "base"));
  const result = await build({ path: f.source, baseLayout: base, output: join(root, "image"), push: false,
    localCache: false, gitMetadata: false, installCache: f.cache, externalDeps: { "linux/amd64": `layout:${output}` }, depsStrategy: "closure", provenance: true });
  expect(result.images[0]!.dependencyArtifact).toBe(packed.digest);
  expect(result.images[0]!.closure).toBeUndefined();
  expect(await runImage(result, join(root, "runtime"))).toBe("fixture-msg works");
  await expect(importDependencies(`layout:${output}`, platform, "/app", {}, join(root, "bad-lock"), {})).rejects.toThrow("lock mismatch");
  await expect(importDependencies(`layout:${output}`, { os: "linux", architecture: "arm64", variant: "v8" }, "/app", plan.lock, join(root, "bad-arch"), {})).rejects.toThrow("platform");
});

test("target-bound workspace dependencies resolve through a per-target map", async () => {
  const root = await fixture(), f = await dependencyFixture(root), workspace = await workspaceFixture(root);
  const source = join(workspace.source, "services/api"), manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  manifest.bunko.external = ["fixture-msg"];
  await writeFile(join(source, "package.json"), JSON.stringify(manifest));
  const selected = await loadProject({ path: f.source }), plan = await dependencyPlan(selected, f.source);
  await installDependencies(f.source, plan, await selectToolchain(), platform, f.cache);
  const output = join(root, "bound-deps");
  const packed = await packDependencies(f.source, join(workspace.source, "bun.lock"), platform, output, "/app", "services/api");
  await expect(importDependencies(`layout:${output}`, platform, "/app", workspace.lock, join(root, "wrong-target"), {}, "services/worker")).rejects.toThrow("mismatch");
  const mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  const yaml = join(root, "pod.yaml"); await writeFile(yaml, `image: bunko://${source}\n`);
  const result = await resolveDocuments({ files: [yaml], repo: "registry.test/map", baseLayout: await baseLayout(join(root, "base")), localCache: false,
    registry, installCache: workspace.cache, externalDepsByTarget: { [source]: { "linux/amd64": `layout:${output}` } } });
  expect(result.targets[0]!.images[0]!.dependencyArtifact).toBe(packed.digest);
  expect(result.output).toContain("registry.test/map/fixture-api@sha256:");
});

test("dependency extraction accepts PAX paths and internal links but rejects traversal through links", async () => {
  const root = await fixture(), path = `app/node_modules/pkg/${"x".repeat(150)}/file.txt`, archive = join(root, "safe.tar");
  await Bun.write(archive, Buffer.concat(await Array.fromAsync(tar([
    { type: "file", path, content: Buffer.from("payload") },
    { type: "symlink", path: "app/node_modules/link", target: `pkg/${"x".repeat(150)}/file.txt` },
  ], 0))));
  const extracted = join(root, "tree");
  await extractDependencies(archive, extracted, "app/node_modules");
  expect(await readFile(join(extracted, "app/node_modules/link"), "utf8")).toBe("payload");
  const malicious = join(root, "unsafe.tar");
  await Bun.write(malicious, Buffer.concat(await Array.fromAsync(tar([{ type: "symlink", path: "app/node_modules/link", target: "../../escape" }], 0))));
  await expect(extractDependencies(malicious, join(root, "bad"), "app/node_modules")).rejects.toThrow("escapes");
});

test("apply never starts kubectl after invalid resolve and preserves kubectl exit status", async () => {
  const root = await fixture(), marker = join(root, "called"), kubectl = join(root, "kubectl");
  await writeFile(kubectl, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},await Bun.stdin.text());console.log("applied");console.error("diagnostic");process.exit(7);`, { mode: 0o755 });
  const invalid = join(root, "bad.yaml"), valid = join(root, "valid.yaml");
  await writeFile(invalid, 'image: "bunko://app "\n');
  await writeFile(valid, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n");
  await expect(applyDocuments({ files: [invalid], kubectlPath: kubectl })).rejects.toThrow("Invalid bunko reference");
  expect(await Bun.file(marker).exists()).toBe(false);
  const result = await applyDocuments({ context: root, files: [valid], kubectlPath: kubectl, kubeDryRun: "client", report: join(root, "report.json") });
  expect(result.exit).toBe(7); expect(result.stdout).toBe("applied\n"); expect(result.stderr).toBe("diagnostic\n");
  expect(await readFile(marker, "utf8")).toContain("ConfigMap");
  expect(JSON.parse(await readFile(join(root, "report.json"), "utf8")).status).toBe("failed");
});

test("local prune previews then removes only old validated keys and unshared blobs", async () => {
  const root = await fixture(), directory = join(root, "cache"), store = new BlobStore(join(root, "store"));
  const cache = new LayerCache(store, { directory, log: () => {} });
  const layer = (await packLayer(store, [{ path: "app/asset", type: "file", content: Buffer.from("same") }], "assets", 0))!;
  const old = cacheKey("old"), fresh = cacheKey("fresh");
  for (const key of [old, fresh]) await cache.remember({ schemaVersion: 1, kind: "assets", key, packFormat, destination: "/app", platform: null, layer, inventory: [], native: [] });
  await utimes(join(directory, "keys/assets", `${old.slice(7)}.json`), 1, 1);
  const preview = await pruneLocal(directory, false, 86400);
  expect(preview.keys).toHaveLength(1); expect(preview.blobs).toHaveLength(0); expect(preview.deleted).toHaveLength(0);
  const result = await pruneLocal(directory, true, 86400);
  expect(result.keys).toEqual(preview.keys); expect(result.deleted).toHaveLength(1);
  expect(await Bun.file(new BlobStore(directory).path(layer.descriptor.digest)).exists()).toBe(true);
  const final = await pruneLocal(directory, true, 0);
  expect(final.blobs).toEqual([layer.descriptor.digest]);
  expect(await Bun.file(new BlobStore(directory).path(layer.descriptor.digest)).exists()).toBe(false);
  const bad = join(root, "bad-cache"); await mkdir(bad); await symlink(join(directory, "keys"), join(bad, "keys"));
  await expect(pruneLocal(bad, true, 0)).rejects.toThrow("symlinked");
});

test("dependency extraction rejects file parents, truncated payloads and decompression-size budgets", async () => {
  const root = await fixture();
  const first = Buffer.concat(await Array.fromAsync(tar([{ path: "app/node_modules/a", type: "file", content: Buffer.from("x") }], 0)));
  const second = Buffer.concat(await Array.fromAsync(tar([{ path: "app/node_modules/a/child", type: "file", content: Buffer.from("x") }], 0)));
  const overlap = join(root, "overlap.tar");
  await writeFile(overlap, Buffer.concat([first.subarray(0, -1024), second]));
  await expect(extractDependencies(overlap, join(root, "overlap"), "app/node_modules")).rejects.toThrow("Overlapping");
  const truncated = join(root, "truncated.tar"); await writeFile(truncated, first.subarray(0, 1536));
  await expect(extractDependencies(truncated, join(root, "truncated"), "app/node_modules")).rejects.toThrow("Truncated");
  const bounded = join(root, "bounded.tar"); await writeFile(bounded, first);
  await expect(extractDependencies(bounded, join(root, "bounded"), "app/node_modules", 0)).rejects.toThrow("size limit");
});

test("dependency extraction writes large files without chunk corruption and rejects preexisting trees", async () => {
  const root = await fixture(), data = Buffer.alloc(256 * 1024 + 37);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const archive = join(root, "large.tar"), tree = join(root, "tree");
  await writeFile(archive, Buffer.concat(await Array.fromAsync(tar([{ path: "app/node_modules/package/data", type: "file", content: data }], 0))));
  await extractDependencies(archive, tree, "app/node_modules");
  expect(await readFile(join(tree, "app/node_modules/package/data"))).toEqual(data);
  await expect(extractDependencies(archive, tree, "app/node_modules")).rejects.toThrow("Output already exists");
});

test("apply preserves kubectl output if a report path becomes unwritable", async () => {
  const root = await fixture(), report = join(root, "report.json"), kubectl = join(root, "kubectl"), input = join(root, "input.yaml");
  await writeFile(input, "kind: ConfigMap\napiVersion: v1\nmetadata: {name: test}\n");
  // A directory appearing at the report path is refused at write time; the earlier regular-file case is now an ordinary replacement.
  await writeFile(kubectl, `#!${process.execPath}\nimport {mkdir} from "node:fs/promises";await Bun.stdin.text();await mkdir(${JSON.stringify(report)});console.log("applied");`, { mode: 0o755 });
  const result = await applyDocuments({ files: [input], context: root, kubectlPath: kubectl, report });
  expect(result.exit).toBe(1); expect(result.stdout).toBe("applied\n"); expect(result.stderr).toContain("Could not write apply report");
  expect(await readdir(report)).toEqual([]);
});

test("remote prune verifies ownership and never falls back to digest deletion", async () => {
  const root = await fixture(), store = new BlobStore(root), mock = new MockRegistry(), repo = "registry.test/cache";
  const cache = new LayerCache(store, { repository: repo, registry: { fetcher: mock.fetch, credentials: async () => undefined }, log: () => {} });
  const layer = (await packLayer(store, [{ path: "app/file", type: "file", content: Buffer.from("x") }], "assets", 0))!;
  const key = cacheKey("remote");
  await cache.remember({ schemaVersion: 1, kind: "assets", key, packFormat, destination: "/app", platform: null, layer, inventory: [], native: [] });
  await cache.publish();
  const tag = `bunko-cache-v1-assets-${key.slice(7)}`, deletes: string[] = [];
  const registry = { credentials: async () => undefined, fetcher: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/tags/list")) return new Response(JSON.stringify({ tags: ["latest", tag] }));
    if (init?.method === "DELETE") { deletes.push(url.pathname); return new Response(null, { status: 405 }); }
    return mock.fetch(input, init);
  } };
  expect((await pruneRegistry(repo, false, registry)).tags).toHaveLength(1); expect(deletes).toHaveLength(0);
  await expect(pruneRegistry(repo, true, registry)).rejects.toThrow("No manifest deletion");
  expect(deletes).toEqual([`/v2/cache/manifests/${tag}`]);
});
