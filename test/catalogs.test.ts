import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { catalogs } from "../packages/bunko/catalogs.ts";
import { loadProject, validateDependencySpecs } from "../packages/bunko/config.ts";
import { discover } from "../packages/bunko/workspace.ts";
import { dependencyInputs, dependencyPlan, installDependencies, validateLock } from "../packages/bunko/deps.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(nested = false) {
  const root = await temporary(); dirs.push(root);
  const f = await workspaceFixture(root);
  const definitions = { catalog: { "fixture-dev": "1.0.0", "unused-package": "2.0.0" }, catalogs: { stable: { "fixture-msg": "1.0.0" } } };
  Object.assign(f.manifests[""]!, nested ? { workspaces: { packages: ["services/*", "packages/*"], ...definitions } } : definitions);
  f.manifests[""]!.devDependencies = { "fixture-dev": "catalog:" };
  (f.manifests["services/api"]!.dependencies as Record<string, string>)["fixture-msg"] = "catalog:stable";
  Object.assign(f.lock, definitions);
  f.lock.workspaces[""]!.devDependencies = f.manifests[""]!.devDependencies;
  f.lock.workspaces["services/api"]!.dependencies = f.manifests["services/api"]!.dependencies;
  for (const [path, manifest] of Object.entries(f.manifests)) await writeFile(join(f.source, path, "package.json"), canonicalJSON(manifest));
  await writeFile(join(f.source, "bun.lock"), canonicalJSON(f.lock));
  return { root, ...f };
}

test.each([false, true])("catalog workspace discovery and frozen installs (nested=%s)", async (nested) => {
  const f = await fixture(nested), directory = join(f.source, "services/api");
  const { workspace } = await discover({ path: directory });
  expect(workspace?.directory).toBe(await realpath(f.source));
  const project = await loadProject({ path: directory }, workspace);
  for (const pkg of workspace!.packages) validateDependencySpecs(pkg.manifest, workspace);
  const plan = await dependencyPlan(project, f.source), toolchain = await selectToolchain();
  for (const production of [false, true]) {
    const stage = join(f.root, production ? "runtime" : "build");
    await cp(f.source, stage, { recursive: true });
    await installDependencies(stage, plan, toolchain, production ? { os: "linux", architecture: "amd64" } : undefined, f.cache);
    expect(await readFile(join(stage, "bun.lock"), "utf8")).toBe(await readFile(join(f.source, "bun.lock"), "utf8"));
    expect(await Bun.file(join(stage, "must-not-exist")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(stage, "services/api/node_modules/fixture-msg/package.json"), "utf8")).version).toBe("1.0.0");
  }
});

test("catalog changes invalidate dependency identity and stale locks fail", async () => {
  const f = await fixture(), { workspace } = await discover({ path: join(f.source, "services/api") });
  const project = await loadProject({ path: join(f.source, "services/api") }, workspace);
  const plan = await dependencyPlan(project, f.source), toolchain = await selectToolchain();
  const inputs = () => canonicalJSON(dependencyInputs(plan, toolchain, { os: "linux", architecture: "amd64" }, `sha256:${"0".repeat(64)}`, project));
  expect(() => validateLock(plan.manifest, plan.lock, workspace)).not.toThrow();
  const before = inputs();
  (plan.manifest.catalog as Record<string, string>)["fixture-dev"] = "2.0.0";
  expect(inputs()).not.toBe(before);
  expect(() => validateLock(plan.manifest, plan.lock, workspace)).toThrow("disagree on catalog");
});

test("catalog references fail closed for missing, non-registry, and ambiguous definitions", async () => {
  const f = await fixture(), { workspace } = await discover({ path: join(f.source, "services/api") });
  for (const value of ["catalog:missing", "catalog:"]) expect(() => validateDependencySpecs({ dependencies: { unknown: value } }, workspace)).toThrow("Missing catalog");
  for (const value of ["file:../x", "catalog:other", "workspace:*", "https://example.test/x.tgz"]) expect(() => catalogs({ catalog: { x: value } })).toThrow("registry dependencies");
  expect(() => catalogs({ catalog: { x: "1" }, workspaces: { packages: ["packages/*"], catalog: { x: "2" } } })).toThrow("not both");
  expect(() => validateDependencySpecs({ dependencies: { x: "catalog:" } })).toThrow("require a workspace");
  expect(() => validateDependencySpecs({ dependencies: { "fixture-dev": "catalog:   " } }, workspace)).not.toThrow();
  expect(() => catalogs({ catalogs: { "bad name": {} } })).toThrow("Invalid catalog name");
});

test("whitespace catalog references follow the selected Bun installer", async () => {
  const f = await fixture();
  (f.manifests[""]!.devDependencies as Record<string, string>)["fixture-dev"] = "catalog:   ";
  (f.manifests["services/api"]!.dependencies as Record<string, string>)["fixture-msg"] = "catalog: stable ";
  for (const [path, manifest] of Object.entries(f.manifests)) await writeFile(join(f.source, path, "package.json"), canonicalJSON(manifest));
  await writeFile(join(f.source, "bun.lock"), canonicalJSON(f.lock));
  const { workspace } = await discover({ path: join(f.source, "services/api") });
  const project = await loadProject({ path: join(f.source, "services/api") }, workspace);
  const plan = await dependencyPlan(project, f.source);
  await installDependencies(f.source, plan, await selectToolchain(), undefined, f.cache);
});


test("a server target builds alongside an unrelated mobile configuration", async () => {
  const f = await fixture(true), mobile = join(f.source, "packages/mobile");
  const manifest = { name: "@fixture/mobile", version: "1.0.0", main: "mobile-router/entry", bunko: { enabled: false } };
  await mkdir(mobile);
  await writeFile(join(mobile, "package.json"), canonicalJSON(manifest));
  await writeFile(join(mobile, "tsconfig.json"), '{"extends":"mobile-framework/tsconfig.base"}');
  await writeFile(join(mobile, "unused.ts"), 'const name = "unused"; import(name);');
  f.lock.workspaces["packages/mobile"] = { name: manifest.name, version: manifest.version };
  await writeFile(join(f.source, "bun.lock"), canonicalJSON(f.lock));
  const result = await build({ path: join(f.source, "services/api"), baseLayout: await baseLayout(join(f.root, "base")), output: join(f.root, "out"), localCache: false, gitMetadata: false, installCache: f.cache });
  expect(result.targetPath).toBe("services/api");
  expect(result.images[0]!.inventory.some((pkg) => pkg.name === manifest.name)).toBe(false);
});
