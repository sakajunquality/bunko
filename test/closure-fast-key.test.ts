import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { cacheKey } from "../packages/bunko/cache.ts";
import { closurePlanInputs } from "../packages/bunko/closure.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { dependencyPlan } from "../packages/bunko/deps.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { pruneLocal } from "../packages/bunko/prune.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import type { ProgressEvent } from "../packages/bunko/progress.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }
/** Collects the log text and the phases a build ran, so a skipped install is observable directly. */
function recorder() {
  const events: ProgressEvent[] = [];
  const state = { log: "", events, phases: () => events.filter((e) => e.status === "completed").map((e) => e.phase) };
  return { state, options: { log: (text: string) => { state.log += text; }, progress: (event: ProgressEvent) => events.push(event) } };
}

test("an unchanged closure skips the Linux install and projection while reproducing its layer, inventory and diagnostics", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  // An unguarded import yields a stable finding in both the cold and cached paths.
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports="fixture-msg works";require("undeclared-helper");\n');
  const cacheDir = join(root, "cache");
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir, installCache: f.cache, depsStrategy: "closure" as const };
  const cold = recorder(), first = await build({ ...options, ...cold.options, output: join(root, "cold") });
  expect(cold.state.log).toContain("Planning Linux dependency closure (amd64)");
  expect(cold.state.phases()).toContain("install");
  expect(cold.state.log).toContain('BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "undeclared-helper"');
  expect((await readdir(join(cacheDir, "plans", "deps"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  const warm = recorder(), second = await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  expect(warm.state.log).not.toContain("Planning Linux dependency closure");
  expect(warm.state.phases()).not.toContain("install");
  expect(warm.state.log).toContain('BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "undeclared-helper"');
  expect(second.cache.find((event) => event.kind === "deps")!.status).toBe("local");
  expect(second.root).toEqual(first.root);
  expect(second.layers.find((layer) => layer.kind === "deps")).toEqual(first.layers.find((layer) => layer.kind === "deps")!);
  expect(second.images[0]!.inventory).toEqual(first.images[0]!.inventory);
  expect(first.images[0]!.closure!.packages.length).toBeGreaterThan(0);
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
  expect(second.images[0]!.native).toEqual(first.images[0]!.native);
  // Retention owns the index: usage counts it and pruning the record it names reclaims it.
  const usage = await pruneLocal(cacheDir, false, 0, Number.MAX_SAFE_INTEGER);
  expect(usage.managedBytes).toBeGreaterThan(0); expect(usage.keys).toHaveLength(0);
  const pruned = await pruneLocal(cacheDir, true, 0, 0);
  expect(pruned.keys.some((key) => key.startsWith("plans/deps/"))).toBe(true);
  expect((await readdir(join(cacheDir, "plans", "deps"))).filter((name) => name.endsWith(".json"))).toHaveLength(0);
}, 15_000);

test("sharedDeps reuses one union closure per platform and keeps target aliases", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...f.manifests[""], bunko: { sharedDeps: true } }));
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache };
  const cold = recorder(), first = await buildTargets({ ...options, ...cold.options, output: join(root, "cold") });
  const warm = recorder(), second = await buildTargets({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.phases()).not.toContain("install");
  expect(warm.state.log.match(/Reusing dependency closure \(amd64\)/g)).toHaveLength(2);
  expect(second.map((result) => result.root)).toEqual(first.map((result) => result.root));
  expect(second[0]!.layers[0]!.descriptor.digest).toBe(second[1]!.layers[0]!.descriptor.digest);
  expect(second.map((result) => result.images[0]!.closure)).toEqual(first.map((result) => result.images[0]!.closure));
  expect(second[1]!.images[0]!.inventory).toEqual(first[1]!.images[0]!.inventory);
}, 15_000);

test("the closure plan key covers the lock, manifests, externals, script policy, Bun revision and target platform", async () => {
  const root = await fixture(), f = await dependencyFixture(root);
  const project = await loadProject({ path: f.source, depsStrategy: "closure" });
  const plan = await dependencyPlan(project, f.source), toolchain = await selectToolchain();
  const amd64 = { os: "linux" as const, architecture: "amd64" as const };
  const key = (...args: Parameters<typeof closurePlanInputs>) => cacheKey(closurePlanInputs(...args));
  const original = key(plan, toolchain, amd64, "sha256:" + "0".repeat(64), [project]);
  expect(key(plan, toolchain, amd64, "sha256:" + "0".repeat(64), [project])).toBe(original);
  const changed = {
    lock: key({ ...plan, lock: { ...plan.lock, packages: { "fixture-msg": ["fixture-msg@1.0.1", "", {}, "sha512-x"] } } }, toolchain, amd64, "sha256:" + "0".repeat(64), [project]),
    manifest: key({ ...plan, manifest: { ...plan.manifest, dependencies: { "fixture-msg": "1.0.1" } } }, toolchain, amd64, "sha256:" + "0".repeat(64), [project]),
    patches: key({ ...plan, patches: { "patches/fixture-msg.patch": "sha256:" + "1".repeat(64) } }, toolchain, amd64, "sha256:" + "0".repeat(64), [project]),
    registry: key({ ...plan, registry: "https://registry.example/" }, toolchain, amd64, "sha256:" + "0".repeat(64), [project]),
    version: key(plan, { ...toolchain, version: "1.4.9" }, amd64, "sha256:" + "0".repeat(64), [project]),
    revision: key(plan, { ...toolchain, revision: "deadbeef" }, amd64, "sha256:" + "0".repeat(64), [project]),
    platform: key(plan, toolchain, { os: "linux", architecture: "arm64" }, "sha256:" + "0".repeat(64), [project]),
    base: key(plan, toolchain, amd64, "sha256:" + "1".repeat(64), [project]),
    external: key(plan, toolchain, amd64, "sha256:" + "0".repeat(64), [{ ...project, external: [] }]),
    scripts: key(plan, toolchain, amd64, "sha256:" + "0".repeat(64), [{ ...project, allowIgnoredScripts: ["fixture-msg"] }]),
    undeclared: key(plan, toolchain, amd64, "sha256:" + "0".repeat(64), [{ ...project, undeclaredImports: "off" as const }]),
    workdir: key(plan, toolchain, amd64, "sha256:" + "0".repeat(64), [{ ...project, targetPath: "services/api" }]),
  };
  for (const [name, value] of Object.entries(changed)) expect([name, value === original]).toEqual([name, false]);
  expect(new Set(Object.values(changed)).size).toBe(Object.keys(changed).length);
});

test("a plan hit rejects the same case-colliding runtime namespace that full projection rejects", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const cacheDir = join(root, "cache");
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir, installCache: f.cache, depsStrategy: "closure" as const };
  await build({ ...options, output: join(root, "cold") });
  // Assets are not a plan input, so the collision must be caught on a warm plan hit as well as cold.
  await mkdir(join(f.source, ".BUNKO-DEPS"));
  await writeFile(join(f.source, ".BUNKO-DEPS/example.txt"), "case collision");
  const manifest = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...manifest, bunko: { ...manifest.bunko, assets: ["public", ".BUNKO-DEPS"] } }));
  const warm = recorder();
  await expect(build({ ...options, ...warm.options, output: join(root, "warm") })).rejects.toThrow("overlap runtime node_modules");
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  await expect(build({ ...options, localCache: false, registryCache: false, output: join(root, "projected") })).rejects.toThrow("overlap runtime node_modules");
}, 15_000);

test("an offline closure build reuses a prepared plan and still refuses to install", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache, depsStrategy: "closure" as const };
  await expect(build({ ...options, offline: true, output: join(root, "cold") })).rejects.toThrow("Offline dependency installation is unavailable");
  const online = await build({ ...options, output: join(root, "online") });
  const warm = recorder(), offline = await build({ ...options, ...warm.options, offline: true, output: join(root, "offline") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  expect(offline.root).toEqual(online.root);
}, 15_000);

test("--no-cache and --verify-deterministic never take the closure shortcut", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache, depsStrategy: "closure" as const };
  await build({ ...options, output: join(root, "cold") });
  const warm = recorder(); await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  const disabled = recorder(); await build({ ...options, ...disabled.options, localCache: false, registryCache: false, output: join(root, "disabled") });
  expect(disabled.state.log).not.toContain("Reusing dependency closure");
  expect(disabled.state.phases()).toContain("install");
  const verified = recorder(), result = await build({ ...options, ...verified.options, verifyDeterministic: true, output: join(root, "verified") });
  expect(verified.state.log).not.toContain("Reusing dependency closure");
  expect(verified.state.log.match(/Planning Linux dependency closure \(amd64\)/g)).toHaveLength(2);
  expect(result.cache.every((event) => event.status === "bypass")).toBe(true);
}, 15_000);


test("cached closure plans preserve optional findings without warning under error policy", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports="fixture-msg works";try{require("optional-helper")}catch{}');
  const manifest = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...manifest, bunko: { ...manifest.bunko, deps: { undeclaredImports: "error" } } }));
  const cacheDir = join(root, "cache"), options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir, installCache: f.cache, depsStrategy: "closure" as const };
  const first = await build({ ...options, output: join(root, "cold") });
  const planFile = join(cacheDir, "plans/deps", (await readdir(join(cacheDir, "plans/deps")))[0]!);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  expect(plan.optionalUndeclared).toHaveLength(1);
  expect(plan.optionalUndeclared[0].code).toBe("BUNKO_OPTIONAL_IMPORT");
  const warm = recorder(), second = await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.phases()).not.toContain("install");
  expect(warm.state.log).not.toContain("BUNKO_OPTIONAL_IMPORT");
  expect(second.root).toEqual(first.root);
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
  // Incomplete metadata must reproject, never silently discard diagnostics or sizes.
  delete plan.packages;
  await writeFile(planFile, canonicalJSON(plan));
  const invalid = recorder();
  await build({ ...options, ...invalid.options, output: join(root, "invalid") });
  expect(invalid.state.phases()).toContain("install");
}, 15_000);
