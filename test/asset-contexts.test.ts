import { MockRegistry } from "./mock-registry.ts";
import { resolveDocuments } from "../packages/bunko/resolve.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetMappings, normalizeAssetContexts, parseAssetContexts, stageAssetMappings } from "../packages/bunko/asset-contexts.ts";
import { build } from "../packages/bunko/build.ts";
import { provenance } from "../packages/bunko/attest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { baseLayout, cli, inspectTar, project, temporary } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await temporary(); roots.push(root);
  const context = join(root, "external-private-location");
  await mkdir(join(context, "config"), { recursive: true });
  await writeFile(join(context, "config/settings.json"), '{"message":"asset-data"}');
  // Unselected source is never scanned or packaged.
  await writeFile(join(context, ".env"), "unselected-secret");
  await symlink("/nonexistent", join(context, "unselected-link"));
  const mapping = { context: "repo", from: "config", to: "/repo/config" };
  const source = await project(join(root, "app"), { bunko: { assetMappings: [mapping] } }, 'console.log("server");');
  return { root, context, mapping, source };
}

test("mapped assets use exact image destinations and content-addressed metadata without host paths", async () => {
  const f = await fixture();
  const options = { path: f.source, baseLayout: await baseLayout(join(f.root, "base")), assetContexts: { repo: f.context }, gitMetadata: false, cacheDir: join(f.root, "cache") };
  const first = await build({ ...options, output: join(f.root, "first"), verifyDeterministic: true });
  const layer = first.layers.find((item) => item.kind === "assets")!;
  const entries = await inspectTar(new BlobStore(first.layout!).path(layer.descriptor.digest));
  expect(entries.find((item) => item.name === "repo/config/settings.json")?.content).toContain("asset-data");
  expect(entries.some((item) => item.name.startsWith("app/repo"))).toBe(false);
  expect(JSON.stringify(first)).not.toContain(f.context);
  expect(JSON.stringify(provenance(first))).not.toContain(f.context);
  expect(JSON.stringify(provenance(first))).toContain("urn:bunko:asset:repo:0");
  const second = await build({ ...options, output: join(f.root, "second") });
  expect(second.cache.some((event) => event.kind === "assets" && event.status === "local")).toBe(true);
  expect(second.root.digest).toBe(first.root.digest);
  await writeFile(join(f.context, "config/settings.json"), '{"message":"changed"}');
  const changed = await build({ ...options, output: join(f.root, "changed") });
  expect(changed.root.digest).not.toBe(first.root.digest);
  expect(changed.assetMaterials![0]!.digest).not.toBe(first.assetMaterials![0]!.digest);
  expect(changed.layers.find((item) => item.kind === "app")!.descriptor.digest).toBe(first.layers.find((item) => item.kind === "app")!.descriptor.digest);
});

test("asset snapshots are immutable and preserve file mappings", async () => {
  const f = await fixture();
  const staged = await stageAssetMappings([{ ...f.mapping, from: "config/settings.json", to: "/repo/settings.json" }], { repo: f.context }, join(f.root, "stage"));
  await writeFile(join(f.context, "config/settings.json"), "changed");
  const entry = staged.entries[0]!;
  expect(entry.path).toBe("repo/settings.json");
  if (entry.type !== "file" || !("source" in entry)) throw new Error("Expected staged file");
  expect(await readFile(entry.source, "utf8")).toContain("asset-data");
});

test.each(["config/.env.production", "config/node_modules/package.json", "config/.npmrc"])("selected excluded files fail closed: %s", async (name) => {
  const f = await fixture();
  await mkdir(join(f.context, name, ".."), { recursive: true }); await writeFile(join(f.context, name), "private-value");
  await expect(stageAssetMappings([f.mapping], { repo: f.context }, join(f.root, "stage"))).rejects.toThrow("Excluded asset input");
});

test("ignore rules, output exclusions, symlinks and missing contexts fail before packaging", async () => {
  const f = await fixture(), stage = join(f.root, "stage");
  await expect(stageAssetMappings([f.mapping], {}, stage)).rejects.toThrow("Missing asset context");
  await expect(stageAssetMappings([f.mapping], { repo: f.context }, stage, [join(f.context, "config")])).rejects.toThrow("Excluded asset input");
  await writeFile(join(f.context, ".bunkoignore"), "config/settings.json\n");
  await expect(stageAssetMappings([f.mapping], { repo: f.context }, stage)).rejects.toThrow("Excluded asset input");
  await rm(join(f.context, ".bunkoignore"));
  await symlink("config", join(f.context, "linked"));
  await expect(stageAssetMappings([{ ...f.mapping, from: "linked/settings.json" }], { repo: f.context }, stage)).rejects.toThrow("symlinks");
  await symlink("../../app/src/server.ts", join(f.context, "config/source.ts"));
  await expect(stageAssetMappings([f.mapping], { repo: f.context }, stage)).rejects.toThrow("symlinks");
});

test.each(["/usr/local/bin/bun", "/etc/config", "/app/node_modules/pkg", "/repo/../etc/config", "/repo/.wh.hidden", "/", "repo/config"])("unsafe image mappings are rejected: %s", (to) => {
  expect(() => assetMappings([{ context: "repo", from: "config", to }])).toThrow();
});

test("mapping validation rejects traversal, globs, unknown keys and duplicate context names", () => {
  for (const from of ["../config", "config/*", "./config", "/config"]) expect(() => assetMappings([{ context: "repo", from, to: "/repo/config" }])).toThrow();
  expect(() => assetMappings([{ context: "repo", from: "config", to: "/repo/config", extra: true }])).toThrow();
  expect(() => parseAssetContexts(["repo=/one", "repo=/two"])).toThrow();
  expect(parseAssetContexts(["repo=/tmp/input"]).repo).toBe("/tmp/input");
});

test("mapped assets reject internal and application output collisions", async () => {
  const f = await fixture();
  await expect(stageAssetMappings([f.mapping, f.mapping], { repo: f.context }, join(f.root, "stage"))).rejects.toThrow("overlap");
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "fixture", module: "src/server.ts", bunko: { assetMappings: [{ ...f.mapping, from: "config/settings.json", to: "/app/src/server.js" }] } }));
  await expect(build({ path: f.source, baseLayout: await baseLayout(join(f.root, "base")), assetContexts: { repo: f.context }, output: join(f.root, "out"), localCache: false })).rejects.toThrow("overlap");
});


test("asset mappings cannot replace a custom runtime", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "fixture", module: "src/server.ts", bunko: { runtime: { bunPath: "/repo/config/bun" }, assetMappings: [f.mapping] } }));
  await expect(build({ path: f.source, assetContexts: { repo: f.context }, output: join(f.root, "out"), localCache: false })).rejects.toThrow("overlaps the configured Bun runtime");
});


test("recursive mappings preserve empty directories and modes but reject reserved descendants", async () => {
  const f = await fixture();
  await mkdir(join(f.context, "config/empty"));
  await writeFile(join(f.context, "config/run.sh"), "echo fixture", { mode: 0o755 });
  const staged = await stageAssetMappings([f.mapping], { repo: f.context }, join(f.root, "stage"));
  expect(staged.entries.some((entry) => entry.path === "repo/config/empty" && entry.type === "directory")).toBe(true);
  expect(staged.entries.some((entry) => entry.path === "repo/config/run.sh" && entry.type === "file" && entry.executable)).toBe(true);
  await mkdir(join(f.context, "config/.bunko-deps"));
  await expect(stageAssetMappings([{ ...f.mapping, to: "/app" }], { repo: f.context }, join(f.root, "invalid"))).rejects.toThrow("destination is reserved");
});

test("destination mappings participate in material identity", async () => {
  const f = await fixture();
  const first = await stageAssetMappings([f.mapping], { repo: f.context }, join(f.root, "first"));
  const relocated = await stageAssetMappings([{ ...f.mapping, to: "/repo/other" }], { repo: f.context }, join(f.root, "second"));
  expect(first.materials[0]!.digest).not.toBe(relocated.materials[0]!.digest);
});


test("API bindings validate names and paths without exposing host values", () => {
  expect(() => normalizeAssetContexts({ "invalid:name": "/tmp/input" })).toThrow("Asset contexts require");
  expect(() => normalizeAssetContexts({ repo: "private-value\n" })).toThrow("Asset contexts require");
});

test("case and file/directory mapping conflicts fail", async () => {
  const f = await fixture();
  const file = { context: "repo", from: "config/settings.json", to: "/repo/item" };
  await expect(stageAssetMappings([file, { ...file, to: "/repo/ITEM" }], { repo: f.context }, join(f.root, "case"))).rejects.toThrow("Case-colliding");
  await expect(stageAssetMappings([file, { ...file, to: "/repo/item/child" }], { repo: f.context }, join(f.root, "parent"))).rejects.toThrow("collision");
});


test("resolve forwards mapped inputs into its published image", async () => {
  const f = await fixture(), registry = new MockRegistry();
  const result = await resolveDocuments({ context: f.root, files: ["-"], stdin: async () => "image: bunko://app\n", assetContexts: { repo: f.context }, baseLayout: await baseLayout(join(f.root, "base")), repo: "registry.test/team", gitMetadata: false, localCache: false, registryCache: false, registry: { fetcher: registry.fetch, credentials: async () => undefined } });
  expect(result.output).toContain("registry.test/team/hello@sha256:");
  expect(result.targets[0]!.assetMaterials![0]!.to).toBe("/repo/config");
});

test("resolve and apply CLI accept unused named contexts without reading them", async () => {
  const f = await fixture(), manifest = join(f.root, "input.yaml"), kubectl = join(f.root, "kubectl");
  await writeFile(manifest, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n");
  await writeFile(kubectl, `#!${process.execPath}\nconsole.log(await Bun.stdin.text());`, { mode: 0o755 });
  for (const command of ["resolve", "apply"]) {
    const result = await cli([command, "-f", manifest, "--asset-context", `unused=${join(f.root, "absent")}`, ...(command === "apply" ? ["--kubectl-path", kubectl, "--kube-dry-run", "client"] : [])]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("ConfigMap");
  }
});
