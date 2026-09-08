import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { classifyAddon, dependencyInputs, dependencyPlan, inspectELF, installDependencies, runtimeEntries, validateLock } from "../packages/bunko/deps.ts";
import { cacheKey } from "../packages/bunko/cache.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function dir() { const root = await temporary(); directories.push(root); return root; }
import { dependencyFixture } from "./dependency-fixture.ts";

describe("isolated Bun dependency preparation", () => {
  test("adapts optional peer metadata and invalidates dependency keys when patches change", async () => {
    const root = await dir(), fixture = await dependencyFixture(root);
    const manifest = JSON.parse(await readFile(join(fixture.source, "package.json"), "utf8"));
    manifest.peerDependencies = { "optional-peer": "1.0.0" };
    manifest.peerDependenciesMeta = { "optional-peer": { optional: true } };
    const lock = JSON.parse(JSON.stringify(fixture.lock));
    lock.workspaces[""].peerDependencies = manifest.peerDependencies;
    lock.workspaces[""].optionalPeers = ["optional-peer"];
    expect(() => validateLock(manifest, lock)).not.toThrow();
    lock.workspaces[""].optionalPeers = [];
    expect(() => validateLock(manifest, lock)).toThrow("optional peers");
    const original = JSON.parse(await readFile(join(fixture.source, "package.json"), "utf8"));
    const patches = { "fixture-msg@1.0.0": "patches/msg.patch" };
    await mkdir(join(fixture.source, "patches"));
    await writeFile(join(fixture.source, "patches/msg.patch"), 'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = "fixture-msg works";\n+module.exports = "patched fixture";\n');
    await writeFile(join(fixture.source, "package.json"), JSON.stringify({ ...original, patchedDependencies: patches }));
    await writeFile(join(fixture.source, "bun.lock"), canonicalJSON({ ...fixture.lock, patchedDependencies: patches }));
    const project = await loadProject({ path: fixture.source });
    const plan = await dependencyPlan(project, fixture.source);
    // Bun fetches the original tarball when first applying a patch; the synthetic
    // download cache cannot exercise that network path. The real-package install
    // is covered separately by the build and cache validation probe.
    const toolchain = await selectToolchain(), platform = { os: "linux", architecture: "amd64" } as const;
    const base = `sha256:${"0".repeat(64)}` as const;
    const before = cacheKey(dependencyInputs(plan, toolchain, platform, base, project));
    await writeFile(join(fixture.source, "patches/msg.patch"), await readFile(join(fixture.source, "patches/msg.patch"), "utf8") + "\n");
    const after = cacheKey(dependencyInputs(await dependencyPlan(project, fixture.source), toolchain, platform, base, project));
    expect(after).not.toBe(before);
    expect(plan.patches["patches/msg.patch"]).toMatch(/^sha256:/);
  });

  test.each(['const p = "fixture-msg"; import(p);', 'const p = "fixture-msg"; require(p);', 'import("fixture-" + "msg");'])("rejects computed application imports: %s", async (code) => {
    const root = await dir(), source = await project(join(root, "app"), {}, code), base = await baseLayout(join(root, "base"));
    await expect(build({ path: source, baseLayout: base, output: join(root, "out"), localCache: false })).rejects.toThrow("Computed require/import");
  });
  test("frozen build/production installs preserve source and do not execute scripts", async () => {
    const root = await dir(), fixture = await dependencyFixture(root);
    const project = await loadProject({ path: fixture.source });
    const plan = await dependencyPlan(project, fixture.source), toolchain = await selectToolchain();
    const host = join(root, "host"), runtime = join(root, "runtime");
    await cp(fixture.source, host, { recursive: true }); await cp(fixture.source, runtime, { recursive: true });
    await installDependencies(host, plan, toolchain, undefined, fixture.cache);
    await installDependencies(runtime, plan, toolchain, { os: "linux", architecture: "amd64" }, fixture.cache);
    expect(await Bun.file(join(host, "node_modules/fixture-dev/package.json")).exists()).toBe(true);
    expect(await Bun.file(join(runtime, "node_modules/fixture-dev/package.json")).exists()).toBe(false);
    expect(await Bun.file(join(host, "must-not-exist")).exists()).toBe(false);
    expect((await readdir(fixture.source)).includes("node_modules")).toBe(false);
    const content = await runtimeEntries(runtime, "app", { os: "linux", architecture: "amd64" });
    expect(content.inventory.map((p) => p.name)).toEqual(["fixture-msg"]);
    expect(content.entries.some((e) => e.type === "symlink" && e.path === "app/node_modules/fixture-msg")).toBe(true);
    expect(content.entries.every((e) => e.type !== "symlink" || !e.target.startsWith("/"))).toBe(true);
  });

  test("bundles JS dependencies and packages only production runtime externals", async () => {
    const root = await dir(), fixture = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
    const result = await build({ path: fixture.source, baseLayout: base, output: join(root, "out"), installCache: fixture.cache, localCache: false, gitMetadata: false, verifyDeterministic: true });
    expect(result.layers.map((l) => l.kind)).toEqual(["deps", "assets", "app"]);
    expect(result.images[0]!.inventory.map((p) => p.name)).toEqual(["fixture-msg"]);
    const files = await inspectTar(new BlobStore(result.layout!).path(result.layers[0]!.descriptor.digest));
    expect(files.some((f) => f.name.includes("fixture-dev"))).toBe(false);
    const bundled = await dependencyFixture(join(root, "bundle"), false);
    const bundledResult = await build({ path: bundled.source, baseLayout: base, output: join(root, "bundle-out"), installCache: bundled.cache, localCache: false, gitMetadata: false });
    expect(bundledResult.layers.map((l) => l.kind)).toEqual(["assets", "app"]);
    const app = await inspectTar(new BlobStore(bundledResult.layout!).path(bundledResult.layers[1]!.descriptor.digest));
    expect(app.find((f) => f.name.endsWith("server.js"))?.content).toContain("fixture-msg works");
  });

  test("rejects stale manifests, unsupported schemas, and non-registry sources before installation", async () => {
    const root = await dir(), fixture = await dependencyFixture(root);
    const manifest = JSON.parse(await readFile(join(fixture.source, "package.json"), "utf8"));
    expect(() => validateLock({ ...manifest, dependencies: { "fixture-msg": "2.0.0" } }, fixture.lock)).toThrow("disagree");
    expect(() => validateLock(manifest, { ...fixture.lock, lockfileVersion: 999 })).toThrow("schema");
    expect(() => validateLock(manifest, { ...fixture.lock, packages: { bad: ["x@file:../escape"] } })).toThrow("non-registry");
    await writeFile(join(fixture.source, "package.json"), JSON.stringify({ ...manifest, dependencies: { "fixture-msg": "file:../escape" } }));
    await expect(loadProject({ path: fixture.source })).rejects.toThrow("registry dependencies only");
  });

  test("keeps npm credentials out of resolution metadata and removes install auth files", async () => {
    const root = await dir(), fixture = await dependencyFixture(root);
    await writeFile(join(fixture.source, ".npmrc"), "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=private-test-token\n");
    const project = await loadProject({ path: fixture.source }), plan = await dependencyPlan(project, fixture.source);
    expect(JSON.stringify(plan.resolution)).not.toContain("private-test-token");
    const stage = join(root, "stage"); await cp(fixture.source, stage, { recursive: true });
    await installDependencies(stage, plan, await selectToolchain(), undefined, fixture.cache);
    expect(await Bun.file(join(stage, ".npmrc")).exists()).toBe(false);
    expect(await readFile(join(fixture.source, ".npmrc"), "utf8")).toContain("private-test-token");
  });

  test("refuses escaping dependency symlinks and packages requiring install scripts", async () => {
    const root = await dir(); await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "node_modules/pkg/package.json"), JSON.stringify({ name: "pkg", version: "1.0.0", scripts: { install: "node-gyp rebuild" } }));
    await expect(runtimeEntries(root, "app", { os: "linux", architecture: "amd64" })).rejects.toThrow("install scripts");
    await rm(join(root, "node_modules/pkg"), { recursive: true });
    await symlink("/etc/passwd", join(root, "node_modules/escape"));
    await expect(runtimeEntries(root, "app", { os: "linux", architecture: "amd64" })).rejects.toThrow("escapes");
  });

  test("validates native ELF architecture without executing the target file", async () => {
    const root = await dir(), path = join(root, "addon.node"), bytes = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(183, 18); bytes.writeUInt16LE(56, 54);
    await writeFile(path, bytes);
    expect((await inspectELF(path, { os: "linux", architecture: "arm64" }))?.architecture).toBe("arm64");
    await expect(inspectELF(path, { os: "linux", architecture: "amd64" })).rejects.toThrow("architecture mismatch");
  });

  test("omits prebuilt addons for other platforms and requires one for the target", async () => {
    const root = await dir(), pkg = join(root, "node_modules/multi"), releases = join(pkg, "releases");
    await mkdir(releases, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "multi", version: "1.0.0" }));
    const elf = (machine: number) => { const bytes = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(machine, 18); bytes.writeUInt16LE(56, 54); return bytes; };
    await writeFile(join(releases, "linux-arm64.node"), elf(183));
    await writeFile(join(releases, "linux-x64.node"), elf(62));
    await writeFile(join(releases, "darwin-arm64.node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const arm64 = { os: "linux", architecture: "arm64" } as const;
    expect(await classifyAddon(join(releases, "darwin-arm64.node"), arm64)).toEqual({ omit: "foreign-format" });
    expect(await classifyAddon(join(releases, "linux-x64.node"), arm64)).toEqual({ omit: "foreign-architecture" });
    const content = await runtimeEntries(root, "app", arm64);
    expect(content.entries.map((e) => e.path).filter((p) => p.endsWith(".node"))).toEqual(["app/node_modules/multi/releases/linux-arm64.node"]);
    expect(content.native.map((n) => n.path)).toEqual(["app/node_modules/multi/releases/linux-arm64.node"]);
    expect(content.omitted).toEqual([{ path: "multi/releases/darwin-arm64.node", reason: "foreign-format" }, { path: "multi/releases/linux-x64.node", reason: "foreign-architecture" }]);
    await rm(join(releases, "linux-arm64.node"));
    await expect(runtimeEntries(root, "app", arm64)).rejects.toThrow("no linux/arm64 build: multi");
  });
});
