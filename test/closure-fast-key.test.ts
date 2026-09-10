import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { cacheKey } from "../packages/bunko/cache.ts";
import { closurePlanInputs } from "../packages/bunko/closure.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { dependencyInputs, dependencyPlan } from "../packages/bunko/deps.ts";
import { discover } from "../packages/bunko/workspace.ts";
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
  // Acknowledgements filter the replayed findings without touching the plan key, so the install stays skipped and the plan still hits.
  const manifest = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...manifest, bunko: { ...manifest.bunko, deps: { acknowledgedImports: [{ package: "fixture-msg", name: "undeclared-helper", reason: "known probe" }] } } }));
  const acknowledged = recorder();
  await build({ ...options, ...acknowledged.options, output: join(root, "acknowledged") });
  expect(acknowledged.state.phases()).not.toContain("install");
  expect(acknowledged.state.log).toContain("Reusing dependency closure (amd64)");
  expect(acknowledged.state.log).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(acknowledged.state.log).toContain("Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> undeclared-helper");
  await writeFile(join(f.source, "package.json"), canonicalJSON(manifest));
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

/**
 * A regression guard, not a proof of the feature: it also passes on main by construction, because `closurePlanInputs` never reads the field. The
 * behavioural evidence that acknowledgements survive a plan hit is the replay assertion in the first test of this file.
 */
test("acknowledged imports are a reporting-time filter and never enter the closure plan key", async () => {
  const root = await fixture(), f = await dependencyFixture(root);
  const project = await loadProject({ path: f.source, depsStrategy: "closure" });
  const plan = await dependencyPlan(project, f.source), toolchain = await selectToolchain();
  const amd64 = { os: "linux" as const, architecture: "amd64" as const }, base = "sha256:" + "0".repeat(64);
  const key = (...args: Parameters<typeof closurePlanInputs>) => cacheKey(closurePlanInputs(...args));
  const acknowledgedImports = [{ package: "fixture-msg", name: "undeclared-helper", reason: "known probe" }, { package: "grpc-gcp", name: "protobufjs", version: "1.0.1" }];
  expect(key(plan, toolchain, amd64, base, [{ ...project, acknowledgedImports }])).toBe(key(plan, toolchain, amd64, base, [project]));
  // The policy itself still keys, so acknowledgements are the only reporting input a plan ignores.
  expect(key(plan, toolchain, amd64, base, [{ ...project, acknowledgedImports, undeclaredImports: "error" as const }])).not.toBe(key(plan, toolchain, amd64, base, [project]));
});

/** A member that depends on both services: the shape that puts a build target into `workspaceSources`. */
async function dependent(f: Awaited<ReturnType<typeof workspaceFixture>>) {
  const manifest = { name: "@fixture/consumer", version: "1.0.0", type: "module", module: "index.ts", dependencies: { "@fixture/api": "workspace:*", "@fixture/worker": "workspace:*" }, bunko: { enabled: false } };
  await mkdir(join(f.source, "packages/consumer"), { recursive: true });
  await writeFile(join(f.source, "packages/consumer/package.json"), canonicalJSON(manifest));
  await writeFile(join(f.source, "packages/consumer/index.ts"), 'export const consumer = "consumer";\n');
  await writeFile(join(f.source, "bun.lock"), canonicalJSON({ ...f.lock,
    workspaces: { ...f.lock.workspaces, "packages/consumer": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } },
    packages: { ...f.lock.packages, "@fixture/consumer": ["@fixture/consumer@workspace:packages/consumer"] } }));
}

test("the closure plan key drops the selected targets' own sources and every member they cannot reach", async () => {
  const root = await fixture(), f = await workspaceFixture(root);
  await dependent(f);
  const { workspace } = await discover({ path: join(f.source, "services/api") });
  const api = await loadProject({ path: join(f.source, "services/api"), depsStrategy: "closure" }, workspace);
  const worker = await loadProject({ path: join(f.source, "services/worker"), depsStrategy: "closure" }, workspace);
  const toolchain = await selectToolchain(), amd64 = { os: "linux" as const, architecture: "amd64" as const }, base = `sha256:${"0".repeat(64)}`;
  // Only the workspace and the lock decide workspaceSources, so one plan describes every selection.
  const plan = () => dependencyPlan(api, f.source);
  const key = async (projects: (typeof api)[]) => cacheKey(closurePlanInputs(await plan(), toolchain, amd64, base, projects));
  const production = async () => cacheKey(dependencyInputs(await plan(), toolchain, amd64, base, api));
  expect(Object.keys((await plan()).workspaceSources ?? {})).toEqual(["packages/shared", "services/api", "services/worker"]);
  const [target, union, before] = [await key([api]), await key([api, worker]), await production()];
  await writeFile(join(f.source, "services/api/src/server.ts"), "console.log('api edited');\n");
  expect(await key([api])).toBe(target);
  expect(await key([api, worker])).toBe(union);
  // Production packages the target's files under .bunko-workspace, so its key must still move.
  expect(await production()).not.toBe(before);
  // The worker is a sibling service the api neither depends on nor externalises, so it is
  // outside the api's closure and its bytes are not part of the api's plan.
  await writeFile(join(f.source, "services/worker/src/server.ts"), "console.log('worker edited');\n");
  expect(await key([api])).toBe(target);
  expect(await key([api, worker])).toBe(union);
  // A workspace package the closure does reach through an external keeps its bytes.
  const externalised = await key([worker]);
  await writeFile(join(f.source, "packages/shared/index.ts"), 'export const message = "shared-v2";\n');
  expect(await key([worker])).not.toBe(externalised);
});

test("an edit to a target other members depend on still reuses the closure", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  await dependent(f);
  const options = { path: join(f.source, "services/api"), baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache, depsStrategy: "closure" as const };
  const cold = recorder(), first = await build({ ...options, ...cold.options, output: join(root, "cold") });
  expect(cold.state.log).toContain("Planning Linux dependency closure (amd64)");
  await writeFile(join(f.source, "services/api/src/server.ts"), "import {message} from '@fixture/shared'; import msg from 'fixture-msg'; import peer from 'fixture-adapter'; console.log('api edited', message, msg, peer);\n");
  const warm = recorder(), second = await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  expect(warm.state.phases()).not.toContain("install");
  expect(second.layers.find((layer) => layer.kind === "deps")).toEqual(first.layers.find((layer) => layer.kind === "deps")!);
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
  // Another member's sources remain part of the key, so its edit reprojects.
  await writeFile(join(f.source, "packages/shared/index.ts"), 'export const message = "shared-v2";\n');
  const changed = recorder(); await build({ ...options, ...changed.options, output: join(root, "changed") });
  expect(changed.state.log).not.toContain("Reusing dependency closure");
  expect(changed.state.phases()).toContain("install");
}, 30_000);

test("a workspace cycle that packages the target itself records no reusable plan", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  // The one shape that puts a target inside its own closure: the target externalises a
  // workspace package that depends back on it, so its files really are closure bytes.
  const cycle = { "@fixture/api": "workspace:*" };
  await writeFile(join(f.source, "packages/shared/package.json"), canonicalJSON({ ...f.manifests["packages/shared"]!, dependencies: cycle }));
  const api = f.manifests["services/api"]!;
  await writeFile(join(f.source, "services/api/package.json"), canonicalJSON({ ...api, bunko: { ...api.bunko as object, external: ["fixture-msg", "fixture-adapter", "@fixture/shared"] } }));
  await writeFile(join(f.source, "bun.lock"), canonicalJSON({ ...f.lock, workspaces: { ...f.lock.workspaces, "packages/shared": { ...f.lock.workspaces["packages/shared"], dependencies: cycle } } }));
  const cacheDir = join(root, "cache");
  const options = { path: join(f.source, "services/api"), baseLayout: base, push: false, gitMetadata: false, cacheDir, installCache: f.cache, depsStrategy: "closure" as const };
  const first = await build({ ...options, output: join(root, "cold") });
  expect(first.images[0]!.closure!.packages.map((pkg) => pkg.path)).toContain("services/api");
  expect(await readdir(join(cacheDir, "plans", "deps")).catch(() => [])).toHaveLength(0);
  const warm = recorder(); await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).not.toContain("Reusing dependency closure");
  expect(warm.state.phases()).toContain("install");
}, 30_000);

test("a plan whose recorded projection contains the target is rejected instead of reused", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  await dependent(f);
  const cacheDir = join(root, "cache");
  const options = { path: join(f.source, "services/api"), baseLayout: base, push: false, gitMetadata: false, cacheDir, installCache: f.cache, depsStrategy: "closure" as const };
  const first = await build({ ...options, output: join(root, "cold") });
  const planFile = join(cacheDir, "plans/deps", (await readdir(join(cacheDir, "plans/deps")))[0]!);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  // A schema-valid record under the current lookup key that claims the target is closure content:
  // the plan key no longer separates such a projection from a sound one, so the read side must.
  plan.packages.push({ name: "@fixture/api", version: "1.0.0", path: "services/api", bytes: 1, files: 1, via: ["@fixture/shared", "@fixture/api"] });
  await writeFile(planFile, canonicalJSON(plan));
  await writeFile(join(f.source, "services/api/src/server.ts"), "import {message} from '@fixture/shared'; import msg from 'fixture-msg'; import peer from 'fixture-adapter'; console.log('api edited', message, msg, peer);\n");
  const warm = recorder(), second = await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).not.toContain("Reusing dependency closure");
  expect(warm.state.phases()).toContain("install");
  // The projected closure decides, so the seeded package never reaches the result or the report.
  expect(second.images[0]!.closure!.packages.map((pkg) => pkg.path)).not.toContain("services/api");
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
}, 30_000);

test("sharedDeps records no plan when one selected target externalises another", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  // No cycle: the api target simply depends on and externalises the worker target, and both are selected.
  const api = f.manifests["services/api"]!, dependencies = { ...api.dependencies as object, "@fixture/worker": "workspace:*" };
  await writeFile(join(f.source, "services/api/package.json"), canonicalJSON({ ...api, dependencies, bunko: { ...api.bunko as object, external: ["fixture-msg", "fixture-adapter", "@fixture/worker"] } }));
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...f.manifests[""], bunko: { sharedDeps: true } }));
  await writeFile(join(f.source, "bun.lock"), canonicalJSON({ ...f.lock, workspaces: { ...f.lock.workspaces, "services/api": { ...f.lock.workspaces["services/api"], dependencies } } }));
  const cacheDir = join(root, "cache");
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir, installCache: f.cache };
  const first = await buildTargets({ ...options, output: join(root, "cold") });
  expect(first[0]!.images[0]!.closure!.packages.map((pkg) => pkg.path)).toContain("services/worker");
  expect(await readdir(join(cacheDir, "plans", "deps")).catch(() => [])).toHaveLength(0);
  const warm = recorder(); await buildTargets({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).not.toContain("Reusing dependency closure");
  expect(warm.state.phases()).toContain("install");
}, 30_000);

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
  expect(result.cache.filter((event) => event.kind !== "base").every((event) => event.status === "bypass")).toBe(true);
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

/**
 * A synthetic workspace whose lock is written by hand, so every edge the reachability walk
 * follows — plain, optional, peer, `workspace:` — and every construct it refuses to narrow
 * through can be moved one at a time. `apps/a` reaches `packages/shared`, `lib-a`, its peer
 * `peer-a`, its optional `opt-a` and that package's own `deep-a`; `apps/b`, `lib-b` and the
 * root's dev-only package are outside its closure entirely.
 */
const integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
function reachableFixture() {
  const manifests: Record<string, Record<string, unknown>> = {
    "": { name: "reach-root", private: true, workspaces: ["apps/*", "packages/*"], devDependencies: { "dev-only": "1.0.0" } },
    "apps/a": { name: "@w/a", version: "1.0.0", dependencies: { "@w/shared": "workspace:*", "lib-a": "1.0.0" }, optionalDependencies: { "opt-a": "1.0.0" } },
    "apps/b": { name: "@w/b", version: "1.0.0", dependencies: { "lib-b": "1.0.0" } },
    "packages/shared": { name: "@w/shared", version: "1.0.0", dependencies: {} },
  };
  const lock: Record<string, unknown> = { lockfileVersion: 1, configVersion: 1,
    workspaces: Object.fromEntries(Object.entries(manifests).map(([path, manifest]) => [path,
      Object.fromEntries(["name", "version", "dependencies", "devDependencies", "optionalDependencies"].filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]))])),
    packages: {
      "@w/a": ["@w/a@workspace:apps/a"], "@w/b": ["@w/b@workspace:apps/b"], "@w/shared": ["@w/shared@workspace:packages/shared"],
      "lib-a": ["lib-a@1.0.0", "", { peerDependencies: { "peer-a": "*" } }, integrity],
      "peer-a": ["peer-a@1.0.0", "", {}, integrity],
      "opt-a": ["opt-a@1.0.0", "", { dependencies: { "deep-a": "1.0.0" } }, integrity],
      "deep-a": ["deep-a@1.0.0", "", {}, integrity],
      "lib-b": ["lib-b@1.0.0", "", {}, integrity],
      "dev-only": ["dev-only@1.0.0", "", {}, integrity],
    } };
  return { manifests, lock };
}
const toPlan = (manifests: Record<string, Record<string, unknown>>, lock: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  manifest: manifests[""]!, workspace: { directory: "/w", packages: Object.entries(manifests).map(([path, manifest]) => ({ path, text: "", manifest })) },
  workspaceSources: Object.fromEntries(Object.keys(manifests).filter(Boolean).map((path, index) => [path, `sha256:${String(index).repeat(64)}`])),
  lock, registry: "https://registry.npmjs.org", resolution: {}, patches: {}, ...extra }) as unknown as Parameters<typeof closurePlanInputs>[0];
const reachToolchain = { path: "/bun", version: "1.4.2", revision: "abcdef" };
const reachBase = `sha256:${"0".repeat(64)}`;
const reachTarget = { targetPath: "apps/a", mode: "bundle", depsStrategy: "closure", external: ["lib-a"], undeclaredImports: "warn" } as unknown as Parameters<typeof closurePlanInputs>[4][number];
const planKeyFor = (manifests: Record<string, Record<string, unknown>>, lock: Record<string, unknown>, targets = [reachTarget]) =>
  cacheKey(closurePlanInputs(toPlan(manifests, lock), reachToolchain, { os: "linux", architecture: "amd64" }, reachBase, targets));
/** Adds a third member that `apps/a` neither depends on nor reaches, exactly as a new app would. */
function withUnrelatedMember(manifests: Record<string, Record<string, unknown>>, lock: Record<string, unknown>) {
  const added = { ...manifests, "apps/c": { name: "@w/c", version: "1.0.0", dependencies: { "lib-c": "1.0.0" } } };
  return { manifests: added, lock: { ...lock,
    workspaces: { ...lock.workspaces as object, "apps/c": { name: "@w/c", version: "1.0.0", dependencies: { "lib-c": "1.0.0" } } },
    packages: { ...lock.packages as object, "@w/c": ["@w/c@workspace:apps/c"], "lib-c": ["lib-c@1.0.0", "", {}, integrity] } } };
}

test("an unrelated workspace member leaves the plan key alone while every reachable edge still moves it", () => {
  const { manifests, lock } = reachableFixture();
  const original = planKeyFor(manifests, lock);
  // The whole point: a new app and its lock entries change nothing for a target that cannot reach them.
  const added = withUnrelatedMember(manifests, lock);
  expect(planKeyFor(added.manifests, added.lock)).toBe(original);
  const packages = lock.packages as Record<string, unknown>;
  const moved: Record<string, string> = {
    // A direct dependency, and then each edge kind the walk must follow transitively.
    direct: planKeyFor(manifests, { ...lock, packages: { ...packages, "lib-a": ["lib-a@1.0.1", "", { peerDependencies: { "peer-a": "*" } }, integrity] } }),
    peer: planKeyFor(manifests, { ...lock, packages: { ...packages, "peer-a": ["peer-a@1.0.1", "", {}, integrity] } }),
    optional: planKeyFor(manifests, { ...lock, packages: { ...packages, "opt-a": ["opt-a@1.0.1", "", { dependencies: { "deep-a": "1.0.0" } }, integrity] } }),
    behindOptional: planKeyFor(manifests, { ...lock, packages: { ...packages, "deep-a": ["deep-a@1.0.1", "", {}, integrity] } }),
    // A `workspace:` edge into another member: that member's own dependencies keep keying.
    workspaceMember: planKeyFor({ ...manifests, "packages/shared": { ...manifests["packages/shared"]!, dependencies: { "lib-a": "1.0.0" } } },
      { ...lock, workspaces: { ...lock.workspaces as object, "packages/shared": { name: "@w/shared", version: "1.0.0", dependencies: { "lib-a": "1.0.0" } } } }),
    // Reached through a shadowing nested id rather than the top-level one.
    nested: planKeyFor(manifests, { ...lock, packages: { ...packages, "@w/a/lib-a": ["lib-a@2.0.0", "", {}, integrity] } }),
  };
  for (const [name, value] of Object.entries(moved)) expect([name, value === original]).toEqual([name, false]);
  expect(new Set(Object.values(moved)).size).toBe(Object.keys(moved).length);
  const stable: Record<string, string> = {
    unrelatedPackage: planKeyFor(manifests, { ...lock, packages: { ...packages, "lib-b": ["lib-b@2.0.0", "", {}, integrity] } }),
    unrelatedMemberDeps: planKeyFor({ ...manifests, "apps/b": { ...manifests["apps/b"]!, dependencies: { "lib-b": "2.0.0" } } },
      { ...lock, workspaces: { ...lock.workspaces as object, "apps/b": { name: "@w/b", version: "1.0.0", dependencies: { "lib-b": "2.0.0" } } } }),
    // `--production` drops devDependencies, so a dev-only package is never installed or projected.
    devOnly: planKeyFor(manifests, { ...lock, packages: { ...packages, "dev-only": ["dev-only@9.9.9", "", {}, integrity] } }),
  };
  for (const [name, value] of Object.entries(stable)) expect([name, value]).toEqual([name, original]);
});

test("a name no lock entry provides is recorded, so supplying it later still moves the plan key", () => {
  const { manifests, lock } = reachableFixture();
  const packages = lock.packages as Record<string, unknown>;
  // An unsatisfied optional peer: common enough that falling back on it would disable narrowing
  // for most real monorepos, so the absence itself is hashed instead.
  const unsatisfied = { ...lock, packages: { ...packages, "lib-a": ["lib-a@1.0.0", "", { peerDependencies: { "peer-a": "*", "encoding": "*" }, optionalPeers: ["encoding"] }, integrity] } };
  const original = planKeyFor(manifests, unsatisfied);
  expect(original).not.toBe(planKeyFor(manifests, lock));
  const added = withUnrelatedMember(manifests, unsatisfied);
  expect(planKeyFor(added.manifests, added.lock)).toBe(original);
  // The moment any member puts that name at the top level, this target resolves it and installs it.
  const supplied = { ...unsatisfied, packages: { ...unsatisfied.packages as object, "encoding": ["encoding@1.0.0", "", {}, integrity] } };
  expect(planKeyFor(manifests, supplied)).not.toBe(original);
});

test("every construct the reachability walk refuses to narrow through falls back to the whole lock", () => {
  const { manifests, lock } = reachableFixture();
  const packages = lock.packages as Record<string, unknown>, workspaces = lock.workspaces as Record<string, unknown>;
  const inputs = (m: Record<string, Record<string, unknown>>, l: Record<string, unknown>) =>
    closurePlanInputs(toPlan(m, l), reachToolchain, { os: "linux", architecture: "amd64" }, reachBase, [reachTarget]);
  // Narrowing is on by default: the plan hashes a subset of the lock and only the members it reached.
  expect(inputs(manifests, lock).lock).not.toBe(lock);
  expect(Object.keys(inputs(manifests, lock).manifests as object)).toEqual(["", "apps/a", "packages/shared"]);
  // Every trigger below must make `closurePlanInputs` hash the lock it was handed, unchanged.
  const triggers: Record<string, [Record<string, Record<string, unknown>>, Record<string, unknown>]> = {
    // A field the walk models is fine; one it does not is a lock it does not understand.
    unknownField: [manifests, { ...lock, futureField: { anything: 1 } }],
    lockVersion: [manifests, { ...lock, lockfileVersion: 3 }],
    configVersion: [manifests, { ...lock, configVersion: 2 }],
    // A catalog, override or patch naming a package the walk reached could redirect it.
    catalog: [{ ...manifests, "": { ...manifests[""]!, catalog: { "lib-a": "1.0.0" } } }, { ...lock, catalog: { "lib-a": "1.0.0" } }],
    override: [{ ...manifests, "": { ...manifests[""]!, overrides: { "peer-a": "1.0.0" } } }, { ...lock, overrides: { "peer-a": "1.0.0" } }],
    patch: [{ ...manifests, "": { ...manifests[""]!, patchedDependencies: { "deep-a@1.0.0": "patches/deep.patch" } } }, { ...lock, patchedDependencies: { "deep-a@1.0.0": "patches/deep.patch" } }],
    trusted: [manifests, { ...lock, trustedDependencies: ["lib-a"] }],
    // Nested members: the lock ids do not express which node_modules the walk would meet first.
    nestedMembers: [{ ...manifests, "apps/a/inner": { name: "@w/inner", version: "1.0.0" } },
      { ...lock, workspaces: { ...workspaces, "apps/a/inner": { name: "@w/inner", version: "1.0.0" } }, packages: { ...packages, "@w/inner": ["@w/inner@workspace:apps/a/inner"] } }],
    malformedEntry: [manifests, { ...lock, packages: { ...packages, "lib-b": ["lib-b@1.0.0", ""] } }],
    missingTarget: [manifests, { ...lock, workspaces: Object.fromEntries(Object.entries(workspaces).filter(([path]) => path !== "apps/a")) }],
  };
  for (const [name, [m, l]] of Object.entries(triggers)) {
    // The lock the plan hashes is the caller's own object, and every member keeps its manifest.
    expect([name, inputs(m, l).lock === l]).toEqual([name, true]);
    expect([name, Object.keys(inputs(m, l).manifests as object)]).toEqual([name, Object.keys(m)]);
    expect([name, inputs(m, l).absentDependencies]).toEqual([name, undefined]);
  }
  // And the fallback really is the conservative path: an unrelated member moves the key again.
  for (const [name, [m, l]] of Object.entries(triggers)) {
    if (name === "missingTarget") continue;
    const added = withUnrelatedMember(m, l);
    expect([name, planKeyFor(added.manifests, added.lock) === planKeyFor(m, l)]).toEqual([name, false]);
  }
  // A catalog, override or patch that names nothing the walk reached still narrows.
  const unreachable: Record<string, [Record<string, Record<string, unknown>>, Record<string, unknown>]> = {
    catalog: [{ ...manifests, "": { ...manifests[""]!, catalog: { "lib-b": "1.0.0" } } }, { ...lock, catalog: { "lib-b": "1.0.0" } }],
    override: [{ ...manifests, "": { ...manifests[""]!, overrides: { "lib-b": "1.0.0" } } }, { ...lock, overrides: { "lib-b": "1.0.0" } }],
    patch: [{ ...manifests, "": { ...manifests[""]!, patchedDependencies: { "lib-b@1.0.0": "patches/b.patch" } } }, { ...lock, patchedDependencies: { "lib-b@1.0.0": "patches/b.patch" } }],
  };
  for (const [name, [m, l]] of Object.entries(unreachable)) {
    const added = withUnrelatedMember(m, l);
    expect([name, planKeyFor(added.manifests, added.lock)]).toEqual([name, planKeyFor(m, l)]);
  }
});

/** Adds a workspace member the api neither depends on nor reaches, the way a new app arrives in a monorepo. */
async function unrelatedMember(f: Awaited<ReturnType<typeof workspaceFixture>>) {
  const manifest = { name: "@fixture/unrelated", version: "1.0.0", type: "module", module: "index.ts", bunko: { enabled: false } };
  await mkdir(join(f.source, "packages/unrelated"), { recursive: true });
  await writeFile(join(f.source, "packages/unrelated/package.json"), canonicalJSON(manifest));
  await writeFile(join(f.source, "packages/unrelated/index.ts"), 'export const unrelated = "unrelated";\n');
  await writeFile(join(f.source, "bun.lock"), canonicalJSON({ ...f.lock,
    workspaces: { ...f.lock.workspaces, "packages/unrelated": { name: manifest.name, version: manifest.version } },
    packages: { ...f.lock.packages, "@fixture/unrelated": ["@fixture/unrelated@workspace:packages/unrelated"] } }));
}

test("a new workspace member the target cannot reach still reuses the closure", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  const options = { path: join(f.source, "services/api"), baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache, depsStrategy: "closure" as const };
  const cold = recorder(), first = await build({ ...options, ...cold.options, output: join(root, "cold") });
  expect(cold.state.phases()).toContain("install");
  // Nothing about the api's tree or dependencies changed; the workspace merely grew a member.
  await unrelatedMember(f);
  const warm = recorder(), second = await build({ ...options, ...warm.options, output: join(root, "warm") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  expect(warm.state.phases()).not.toContain("install");
  expect(second.layers.find((layer) => layer.kind === "deps")).toEqual(first.layers.find((layer) => layer.kind === "deps")!);
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
}, 30_000);

const amd64 = { os: "linux" as const, architecture: "amd64" as const };
const keyOf = (plan: Parameters<typeof closurePlanInputs>[0], target: Parameters<typeof closurePlanInputs>[4][number]) =>
  cacheKey(closurePlanInputs(plan, reachToolchain, amd64, reachBase, [target]));

/**
 * Bun's isolated linker keeps every installed package in a `node_modules/.bun/node_modules`
 * fallback tree, and the projector's ancestor search reaches it from any instance. So a name
 * the walk could not resolve is only truly absent when no lock entry anywhere installs that
 * package; when one does — here an unselected member's nested copy — the fallback tree can
 * supply it, resolve its own dependencies inside a tree the lock ids do not describe, and put
 * bytes in the closure that no narrowed subset covers.
 */
test("an unresolved name that some other lock entry installs falls back to the whole lock", () => {
  const manifests: Record<string, Record<string, unknown>> = {
    "": { name: "reach-root", private: true, workspaces: ["apps/*"] },
    "apps/a": { name: "a", version: "1.0.0", dependencies: { x: "1.0.0" } },
    "apps/b": { name: "b", version: "1.0.0", dependencies: { p: "1.0.0" } },
  };
  const packages: Record<string, unknown> = {
    a: ["a@workspace:apps/a"], b: ["b@workspace:apps/b"],
    // `x` declares `p` as an optional peer that neither `x/p` nor a top-level entry satisfies.
    x: ["x@1.0.0", "", { peerDependencies: { p: "*" }, optionalPeers: ["p"] }, integrity],
    "b/p": ["p@1.0.0", "", {}, integrity],
  };
  const lock: Record<string, unknown> = { lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: "reach-root" }, "apps/a": { name: "a", version: "1.0.0", dependencies: { x: "1.0.0" } }, "apps/b": { name: "b", version: "1.0.0", dependencies: { p: "1.0.0" } } },
    packages };
  const target = { ...reachTarget, targetPath: "apps/a", external: ["x"] };
  expect(closurePlanInputs(toPlan(manifests, lock), reachToolchain, amd64, reachBase, [target]).lock).toBe(lock);
  // The unselected member's copy of `p` is exactly what the fallback tree would supply.
  const bumped = { ...lock, packages: { ...packages, "b/p": ["p@1.0.0", "", {}, `sha512-${Buffer.alloc(64, 3).toString("base64")}`] } };
  expect(keyOf(toPlan(manifests, bumped), target)).not.toBe(keyOf(toPlan(manifests, lock), target));
  // With no entry under that name anywhere, the absence is recorded and narrowing resumes.
  const alone = { ...lock, workspaces: { "": { name: "reach-root" }, "apps/a": (lock.workspaces as Record<string, unknown>)["apps/a"] }, packages: { a: packages.a, x: packages.x } };
  const soleManifests = { "": manifests[""]!, "apps/a": manifests["apps/a"]! };
  expect(closurePlanInputs(toPlan(soleManifests, alone), reachToolchain, amd64, reachBase, [target]).lock).not.toBe(alone);
  expect(closurePlanInputs(toPlan(soleManifests, alone), reachToolchain, amd64, reachBase, [target]).absentDependencies).toEqual(["p"]);
});

/**
 * A lock entry is keyed by the alias its dependents write, not by the package it installs, so
 * a patch keyed on the canonical `name@version` matches nothing the walk declared. A patch can
 * add arbitrary dependencies to the installed manifest — which the projector reads and follows
 * and no lock walk models — so the canonical name has to reach the scoped-field check.
 */
test("a patch on a package an alias installs falls back to the whole lock", () => {
  const patchedDependencies = { "real@1.0.0": "patches/real.patch" };
  const manifests: Record<string, Record<string, unknown>> = {
    "": { name: "reach-root", private: true, workspaces: ["apps/*", "packages/*"], patchedDependencies },
    "apps/a": { name: "a", version: "1.0.0", dependencies: { alias: "npm:real@1.0.0" } },
    "apps/b": { name: "b", version: "1.0.0", dependencies: { c: "workspace:*" } },
    "packages/c": { name: "c", version: "1.0.0" },
  };
  const lock: Record<string, unknown> = { lockfileVersion: 1, configVersion: 1, patchedDependencies,
    workspaces: { "": { name: "reach-root" }, "apps/a": { name: "a", version: "1.0.0", dependencies: { alias: "npm:real@1.0.0" } },
      "apps/b": { name: "b", version: "1.0.0", dependencies: { c: "workspace:*" } }, "packages/c": { name: "c", version: "1.0.0" } },
    packages: { a: ["a@workspace:apps/a"], b: ["b@workspace:apps/b"], c: ["c@workspace:packages/c"],
      // The alias id never mentions `real`, which is the name the patch is keyed on.
      alias: ["real@1.0.0", "", {}, integrity] } };
  const target = { ...reachTarget, targetPath: "apps/a", external: ["alias"] };
  const patches = { patches: { "patches/real.patch": `sha256:${"c".repeat(64)}` } };
  expect(closurePlanInputs(toPlan(manifests, lock, patches), reachToolchain, amd64, reachBase, [target]).lock).toBe(lock);
  // The patch can make `real` depend on `c`, so `c`'s bytes must keep keying the plan.
  const sources = Object.fromEntries(Object.keys(manifests).filter(Boolean).map((path, index) => [path, `sha256:${String(index).repeat(64)}`]));
  const edited = { ...patches, workspaceSources: { ...sources, "packages/c": `sha256:${"9".repeat(64)}` } };
  expect(keyOf(toPlan(manifests, lock, edited), target)).not.toBe(keyOf(toPlan(manifests, lock, patches), target));
});

/**
 * Frozen serialization of the fallback path: a lock the walk refuses to narrow must key
 * exactly as it did before narrowing existed, so every plan already stored for such a
 * workspace stays valid. Any change to this string invalidates those plans.
 */
test("the fallback plan serialization is byte-stable", () => {
  const manifests: Record<string, Record<string, unknown>> = {
    "": { name: "r", private: true, workspaces: ["apps/*"], overrides: { "lib-a": "1.0.0" } },
    "apps/a": { name: "@w/a", version: "1.0.0", dependencies: { "lib-a": "1.0.0" } },
  };
  const lock: Record<string, unknown> = { lockfileVersion: 1, configVersion: 1, overrides: { "lib-a": "1.0.0" },
    workspaces: { "": { name: "r" }, "apps/a": { name: "@w/a", version: "1.0.0", dependencies: { "lib-a": "1.0.0" } } },
    packages: { "@w/a": ["@w/a@workspace:apps/a"], "lib-a": ["lib-a@1.0.0", "", {}, "sha512-x"] } };
  const plan = { ...toPlan(manifests, lock), workspaceSources: {} } as Parameters<typeof closurePlanInputs>[0];
  const target = { ...reachTarget, targetPath: "apps/a", external: ["lib-a"] };
  expect(Buffer.from(canonicalJSON(closurePlanInputs(plan, reachToolchain, amd64, reachBase, [target]))).toString()).toBe('{"base":"sha256:0000000000000000000000000000000000000000000000000000000000000000","closureDirectory":".bunko-deps","external":["lib-a"],"layout":"workspace-v2","libc":"glibc","linker":"isolated","lock":{"configVersion":1,"lockfileVersion":1,"overrides":{"lib-a":"1.0.0"},"packages":{"@w/a":["@w/a@workspace:apps/a"],"lib-a":["lib-a@1.0.0","",{},"sha512-x"]},"workspaces":{"":{"name":"r"},"apps/a":{"dependencies":{"lib-a":"1.0.0"},"name":"@w/a","version":"1.0.0"}}},"manifests":{"":{"name":"r","overrides":{"lib-a":"1.0.0"}},"apps/a":{"dependencies":{"lib-a":"1.0.0"},"name":"@w/a","version":"1.0.0"}},"nativeAddonPolicy":"target-elf-v1","patches":{},"platform":{"architecture":"amd64","os":"linux"},"registry":"https://registry.npmjs.org","resolution":{},"scripts":false,"strategy":"closure-v1","targetPath":"apps/a","targets":[{"allowIgnoredScripts":[],"depsStrategy":"closure","external":["lib-a"],"mode":"bundle","targetPath":"apps/a","undeclaredImports":"warn"}],"toolchain":{"revision":"abcdef","version":"1.4.2"},"undeclaredImports":"warn","workspaceSources":{}}');
});
