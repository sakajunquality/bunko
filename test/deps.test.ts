import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { buildDependencyFilters, classifyAddon, dependencyInputs, dependencyPlan, inspectELF, installDependencies, runtimeEntries, validateLock, type DependencyPlan } from "../packages/bunko/deps.ts";
import type { Project } from "../packages/bunko/config.ts";
import { discover } from "../packages/bunko/workspace.ts";
import { requiredInputs } from "../packages/bunko/ignore.ts";
import { snapshot } from "../packages/bunko/files.ts";
import { cacheKey } from "../packages/bunko/cache.ts";
import { bundle, selectToolchain } from "../packages/bunko/toolchain.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function dir() { const root = await temporary(); directories.push(root); return root; }
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

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

  // Frozen serialization: the production dependency key must not move when the closure path
  // changes what it feeds into it, so every production layer in every cache stays valid.
  test("the production dependency serialization is byte-stable and keeps the target's own workspace sources", () => {
    const manifests: Record<string, Record<string, unknown>> = {
      "": { name: "workspace-fixture", private: true, workspaces: ["services/*", "packages/*"] },
      "services/api": { name: "@fixture/api", version: "1.0.0", dependencies: { "@fixture/shared": "workspace:*", "fixture-msg": "1.0.0" } },
      "packages/shared": { name: "@fixture/shared", version: "1.0.0" },
    };
    const plan = { manifest: manifests[""]!, workspace: { packages: Object.entries(manifests).map(([path, manifest]) => ({ path, manifest })) },
      workspaceSources: { "packages/shared": `sha256:${"a".repeat(64)}`, "services/api": `sha256:${"b".repeat(64)}` },
      lock: { lockfileVersion: 1, packages: { "fixture-msg": ["fixture-msg@1.0.0", "", {}, "sha512-x"] } },
      registry: "https://registry.npmjs.org", resolution: {}, patches: {} } as unknown as DependencyPlan;
    const project = { targetPath: "services/api", external: ["fixture-msg"] } as unknown as Project;
    const inputs = dependencyInputs(plan, { path: "/bun", version: "1.4.2", revision: "abcdef" }, { os: "linux", architecture: "amd64" }, `sha256:${"0".repeat(64)}`, project);
    expect(Buffer.from(canonicalJSON(inputs)).toString()).toBe('{"base":"sha256:0000000000000000000000000000000000000000000000000000000000000000","external":["fixture-msg"],"layout":"workspace-v2","libc":"glibc","linker":"isolated","lock":{"lockfileVersion":1,"packages":{"fixture-msg":["fixture-msg@1.0.0","",{},"sha512-x"]}},"manifests":{"":{"name":"workspace-fixture"},"packages/shared":{"name":"@fixture/shared","version":"1.0.0"},"services/api":{"dependencies":{"@fixture/shared":"workspace:*","fixture-msg":"1.0.0"},"name":"@fixture/api","version":"1.0.0"}},"nativeAddonPolicy":"target-elf-v1","patches":{},"platform":{"architecture":"amd64","os":"linux"},"registry":"https://registry.npmjs.org","resolution":{},"scripts":false,"strategy":"production","targetPath":"services/api","toolchain":{"revision":"abcdef","version":"1.4.2"},"workspaceSources":{"packages/shared":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","services/api":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}');
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

  test("scopes the host build install to the target member and its workspace closure", async () => {
    const root = await dir(), f = await workspaceFixture(root), toolchain = await selectToolchain();
    const discovered = await discover({ path: join(f.source, "services/api") });
    const target = await loadProject({ path: join(f.source, "services/api") }, discovered.workspace);
    const plan = await dependencyPlan(target, f.source);
    const filters = buildDependencyFilters(plan, target.targetPath);
    expect(filters).toEqual([".", "./services/api"]);
    expect(buildDependencyFilters({ ...plan, workspace: undefined }, "services/api")).toBeUndefined();
    expect(buildDependencyFilters(plan, "")).toBeUndefined();
    // Bun reads `*`, a leading `!` and a trailing `...` as pattern syntax, and an
    // unmatched filter only warns, so those member paths take the full install.
    for (const path of ["services/*", "services/api...", "!services/api", "services/a..b", "services/api!", "services/{api}"]) {
      expect(buildDependencyFilters({ ...plan, workspace: { ...plan.workspace!, packages: [...plan.workspace!.packages, { path, text: "", manifest: {} }] } }, path)).toBeUndefined();
    }
    expect(buildDependencyFilters({ ...plan, workspace: { ...plan.workspace!, packages: [...plan.workspace!.packages, { path: "services/api.v2", text: "", manifest: {} }] } }, "services/api.v2")).toEqual([".", "./services/api.v2"]);
    const scoped = join(root, "scoped"), complete = join(root, "complete");
    for (const stage of [scoped, complete]) await cp(f.source, stage, { recursive: true });
    await installDependencies(scoped, plan, toolchain, undefined, f.cache, false, filters);
    await installDependencies(complete, plan, toolchain, undefined, f.cache);
    // Only the worker pins fixture-msg@2.0.0, so it proves the sibling stayed out of the store.
    expect(await readdir(join(complete, "node_modules/.bun"))).toContain("fixture-msg@2.0.0");
    expect(await readdir(join(scoped, "node_modules/.bun"))).not.toContain("fixture-msg@2.0.0");
    expect(await readdir(join(scoped, "node_modules/.bun"))).toContain("fixture-msg@1.0.0");
    expect(await readdir(join(scoped, "services/worker"))).not.toContain("node_modules");
    // The target keeps the exact tree the bundler resolves through, links included.
    expect((await readdir(join(scoped, "services/api/node_modules"))).sort()).toEqual((await readdir(join(complete, "services/api/node_modules"))).sort());
    for (const link of ["@fixture/shared", "fixture-msg"]) {
      expect(await readlink(join(scoped, "services/api/node_modules", link))).toBe(await readlink(join(complete, "services/api/node_modules", link)));
    }
    // Peer contexts and overrides are resolved from the same lock, so everything the
    // scoped install materializes must be byte-identical to the full install's copy.
    let compared = 0;
    async function sameAsComplete(path: string) {
      const info = await lstat(join(scoped, path));
      if (info.isSymbolicLink()) { compared++; return expect(await readlink(join(scoped, path))).toBe(await readlink(join(complete, path))); }
      if (info.isDirectory()) { for (const child of (await readdir(join(scoped, path))).sort()) await sameAsComplete(`${path}/${child}`); return; }
      compared++;
      expect(await readFile(join(scoped, path))).toEqual(await readFile(join(complete, path)));
    }
    for (const tree of ["node_modules", "services/api/node_modules"]) await sameAsComplete(tree);
    expect(compared).toBeGreaterThan(10);
  });

  test("scoped and full build installs bundle byte-identical application output", async () => {
    const root = await realpath(await dir()), f = await workspaceFixture(root), toolchain = await selectToolchain();
    const discovered = await discover({ path: join(f.source, "services/api") });
    const target = await loadProject({ path: join(f.source, "services/api") }, discovered.workspace);
    const plan = await dependencyPlan(target, f.source);
    const outputs: Record<string, string>[] = [];
    for (const [name, filters] of [["scoped", buildDependencyFilters(plan, target.targetPath)], ["complete", undefined]] as const) {
      const stage = join(root, name);
      await cp(f.source, stage, { recursive: true });
      await installDependencies(stage, plan, toolchain, undefined, f.cache, false, filters);
      const built = await bundle({ ...target, platform: { os: "linux", architecture: "amd64" } }, toolchain, join(stage, target.targetPath), () => {}, stage);
      const emitted: Record<string, string> = { inventory: canonicalJSON(built.inventory).toString() };
      for (const file of (await readdir(built.outdir, { recursive: true })).sort()) {
        if ((await lstat(join(built.outdir, file))).isFile()) emitted[file] = await readFile(join(built.outdir, file), "utf8");
      }
      outputs.push(emitted);
    }
    expect(Object.keys(outputs[0]!).sort()).toEqual(["inventory", "src/server.js", "src/server.js.map"]);
    expect(outputs[0]).toEqual(outputs[1]!);
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
    const elf = (machine: number) => { const bytes = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18); bytes.writeUInt16LE(56, 54); return bytes; };
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

test("workspace source digests describe the snapshot, so excluded files never move the dependency key", async () => {
  const root = await dir(), f = await workspaceFixture(root);
  // Source mode adds .gitignore to the exclusions the snapshot applies before this digest is taken.
  const api = JSON.parse(await readFile(join(f.source, "services/api/package.json"), "utf8"));
  await writeFile(join(f.source, "services/api/package.json"), JSON.stringify({ ...api, bunko: { ...api.bunko, mode: "source", build: null } }));
  let iteration = 0;
  /** Plan a target the way a build does: required inputs, snapshot, then the plan over that snapshot. */
  const digest = async () => {
    const selection = { path: f.source, targets: ["services/api"] };
    const discovery = await discover(selection);
    const projects = [await loadProject({ ...selection, path: join(discovery.directory, discovery.targets[0]!.path) }, discovery.workspace)];
    const staging = join(root, `snapshot-${iteration++}`), assetExclusions: string[] = [], explicitAssets = new Set<string>();
    const required = await requiredInputs(discovery.directory, projects, [], assetExclusions, explicitAssets);
    await snapshot(discovery.directory, staging, [], undefined, [], required, assetExclusions, true, explicitAssets);
    const plan = await dependencyPlan(projects[0]!, staging, false);
    return plan.workspaceSources!["packages/shared"]!;
  };
  const before = await digest();
  // Pinned so a change to what the digest serializes is visible here, not in a stale cache.
  expect(before).toBe("sha256:86518a7973a7cf6be0ce31e95a3339d3b3db0350ecf3928715d69cef4d5afd50");
  // Nothing a snapshot drops may reach the key: excluded names, credentials, VCS state,
  // .bunkoignore and .gitignore entries, and the symlinks hiding inside them.
  await mkdir(join(f.source, "packages/shared/node_modules/.bin"), { recursive: true });
  await symlink("../../index.ts", join(f.source, "packages/shared/node_modules/.bin/tool"));
  await writeFile(join(f.source, "packages/shared/.env"), "TOKEN=fixture");
  await mkdir(join(f.source, "packages/shared/.git"));
  await writeFile(join(f.source, "packages/shared/.git/HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(f.source, "packages/shared/scratch"));
  await symlink("../index.ts", join(f.source, "packages/shared/scratch/link"));
  await writeFile(join(f.source, ".gitignore"), "packages/shared/scratch/\n");
  await writeFile(join(f.source, "packages/shared/notes.tmp"), "ignored");
  await writeFile(join(f.source, ".bunkoignore"), "packages/shared/notes.tmp\n");
  expect(await digest()).toBe(before);
  // What the image does carry still moves it: an empty directory and an executable bit.
  await mkdir(join(f.source, "packages/shared/empty"));
  const directoryAdded = await digest();
  expect(directoryAdded).not.toBe(before);
  await writeFile(join(f.source, "packages/shared/run.sh"), "#!/bin/sh\necho fixture\n");
  await chmod(join(f.source, "packages/shared/run.sh"), 0o755);
  const executable = await digest();
  expect(executable).not.toBe(directoryAdded);
  await chmod(join(f.source, "packages/shared/run.sh"), 0o644);
  expect(await digest()).not.toBe(executable);
});
