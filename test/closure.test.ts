import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { dependencyClosure } from "../packages/bunko/closure.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { discover } from "../packages/bunko/workspace.ts";
import { dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
import { runImage } from "./run-image.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await temporary(); directories.push(root);
  const f = { root, ...await workspaceFixture(root), base: await baseLayout(join(root, "base")) };
  const options = { path: f.source, baseLayout: f.base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure" };
  return { ...f, options };
}

test("closure excludes unrelated versions and bundled workspaces while preserving peer resolution", async () => {
  const f = await fixture();
  const result = await buildTargets({ ...f.options, output: join(f.root, "out"), verifyDeterministic: true });
  expect(result[0]!.images[0]!.inventory.filter((p) => p.name === "fixture-msg").map((p) => p.version)).toEqual(["1.0.0"]);
  expect(result[1]!.images[0]!.inventory.filter((p) => p.name === "fixture-msg").map((p) => p.version)).toEqual(["2.0.0"]);
  expect(result[0]!.images[0]!.inventory.some((p) => p.name === "@fixture/shared")).toBe(false);
  expect(await runImage(result[0]!, join(f.root, "api"))).toBe("api shared one one");
  expect(await runImage(result[1]!, join(f.root, "worker"))).toBe("worker shared two two");
});

test("sharedDeps produces one union layer and keeps target-specific aliases in the app layer", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...f.manifests[""], bunko: { sharedDeps: true } }));
  const result = await buildTargets({ ...f.options, depsStrategy: undefined, output: join(f.root, "out"), verifyDeterministic: true });
  expect(result[0]!.layers[0]!.descriptor.digest).toBe(result[1]!.layers[0]!.descriptor.digest);
  expect(result[0]!.images[0]!.inventory.filter((p) => p.name === "fixture-msg").map((p) => p.version).sort()).toEqual(["1.0.0", "2.0.0"]);
  expect(await runImage(result[0]!, join(f.root, "api"))).toBe("api shared one one");
  expect(await runImage(result[1]!, join(f.root, "worker"))).toBe("worker shared two two");
});

test("closure keys ignore unrelated lock/source changes and include reachable workspace bytes", async () => {
  const f = await fixture(), cacheDir = join(f.root, "cache");
  const options = { ...f.options, localCache: true, cacheDir };
  const first = await buildTargets({ ...options, output: join(f.root, "first") });
  // A dev dependency changes coherently in manifests, lock and download cache.
  const manifest = { ...f.manifests[""], devDependencies: { "fixture-dev": "2.0.0" } };
  await cp(join(f.cache, "fixture-dev@1.0.0@@@1"), join(f.cache, "fixture-dev@2.0.0@@@1"), { recursive: true });
  await writeFile(join(f.cache, "fixture-dev@2.0.0@@@1/package.json"), '{"name":"fixture-dev","version":"2.0.0","main":"index.js"}');
  await writeFile(join(f.source, "package.json"), canonicalJSON(manifest));
  await writeFile(join(f.source, "bun.lock"), canonicalJSON({ ...f.lock, workspaces: { ...f.lock.workspaces, "": { ...f.lock.workspaces[""], devDependencies: manifest.devDependencies } }, packages: { ...f.lock.packages, "fixture-dev": ["fixture-dev@2.0.0", ...f.lock.packages["fixture-dev"].slice(1)] } }));
  await writeFile(join(f.source, "packages/shared/index.ts"), 'export const message = "shared-v2";');
  const second = await buildTargets({ ...options, output: join(f.root, "second") });
  expect(second[0]!.cache.find((c) => c.kind === "deps")!.status).toBe("local");
  expect(second[0]!.layers[0]!.descriptor.digest).toBe(first[0]!.layers[0]!.descriptor.digest);
  expect(second[1]!.cache.find((c) => c.kind === "deps")!.status).toBe("miss");
  expect(await runImage(second[1]!, join(f.root, "worker"))).toBe("worker shared-v2 two two");
});

test("sharedDeps validates the common contract before building", async () => {
  const f = await fixture();
  await expect(buildTargets({ ...f.options, depsStrategy: "production", sharedDeps: true })).rejects.toThrow("closure strategy");
  const manifest = f.manifests["services/worker"]!;
  await writeFile(join(f.source, "services/worker/package.json"), canonicalJSON({ ...manifest, bunko: { ...manifest.bunko as object, workdir: "/worker" } }));
  await expect(buildTargets({ ...f.options, sharedDeps: true })).rejects.toThrow("matching workdir");
});

test("closure follows optional edges, preserves bins/data and rejects missing required or escaping links", async () => {
  const f = await fixture(), discovered = await discover({ path: f.source });
  const project = await loadProject({ ...f.options, path: join(f.source, "services/api") }, discovered.workspace);
  const plan = await dependencyPlan(project, f.source), stage = join(f.root, "stage"), platform = { os: "linux" as const, architecture: "amd64" as const };
  await cp(f.source, stage, { recursive: true });
  await installDependencies(stage, plan, await selectToolchain(), platform, f.cache);
  const pkgFile = join(stage, "services/api/node_modules/fixture-msg/package.json");
  const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
  await writeFile(pkgFile, canonicalJSON({ ...pkg, optionalDependencies: { "absent-optional": "1" }, bin: { msg: "index.js" } }));
  await writeFile(join(stage, "services/api/node_modules/fixture-msg/index.js"), 'try { require("supports-color"); } catch {}\nmodule.exports="one";');
  const closure = await dependencyClosure(stage, "app", platform, [project]);
  expect(closure.aliases.get(project.targetPath)!.some((e) => e.path === "app/node_modules/.bin/msg")).toBe(true);
  // The closure report carries guarded probes separately from real findings, so warn and error policies can ignore them without losing them.
  expect(closure.undeclared).toEqual([]);
  expect(closure.optionalUndeclared).toEqual([{ code: "BUNKO_OPTIONAL_IMPORT", package: "fixture-msg", version: "1.0.0", path: closure.inventory.find((p) => p.name === "fixture-msg")!.path, name: "supports-color", file: "index.js" }]);
  await writeFile(pkgFile, canonicalJSON({ ...pkg, dependencies: { "absent-required": "1" } }));
  await expect(dependencyClosure(stage, "app", platform, [project])).rejects.toThrow("Missing runtime dependency");
  await writeFile(pkgFile, canonicalJSON(pkg));
  await symlink("/etc/passwd", join(stage, "services/api/node_modules/fixture-msg/escape"));
  await expect(dependencyClosure(stage, "app", platform, [project])).rejects.toThrow("escapes the installed tree");
});


test("standalone closure retains package data and is independent of checkout depth", async () => {
  const root = await temporary(); directories.push(root);
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports=require("./message.json").message;');
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/message.json"), '{"message":"retained data"}');
  const options = { path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure" };
  const first = await build({ ...options, output: join(root, "first") });
  const deeper = join(root, "deeper/checkout"); await cp(f.source, deeper, { recursive: true });
  const second = await build({ ...options, path: deeper, output: join(root, "second") });
  expect(second.root.digest).toBe(first.root.digest);
  expect(first.images[0]!.inventory.map((p) => p.name)).toEqual(["fixture-msg"]);
  expect(await runImage(first, join(root, "run"))).toBe("retained data");
});
