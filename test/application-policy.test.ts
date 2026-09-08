import { workspaceFixture } from "./workspace-fixture.ts";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { readBunfig, installConfig } from "../packages/bunko/bunfig.ts";
import { build } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { dependencyInputs, dependencyPlan } from "../packages/bunko/deps.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { imageConfig } from "../packages/oci/image.ts";
import type { ImageConfig } from "../packages/oci/types.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function dir() { const root = await temporary(); dirs.push(root); return root; }

test("install-only bunfig accepts age gates, ignores tests, and rejects other options without values", async () => {
  const root = await dir();
  await writeFile(join(root, "bunfig.toml"), '[install]\nminimumReleaseAge=86400\nminimumReleaseAgeExcludes=["@types/*"]\n[test]\npreload=["never-execute.ts"]\n');
  const policy = await readBunfig(root);
  expect(Bun.TOML.parse(installConfig(policy))).toEqual({ install: { linker: "isolated", minimumReleaseAge: 86400, minimumReleaseAgeExcludes: ["@types/*"] } });
  for (const text of ['preload=["secret-value"]', '[install]\nregistry="secret-value"', '[install]\nminimumReleaseAge=-1']) {
    await writeFile(join(root, "bunfig.toml"), text);
    let message = "";
    try { await readBunfig(root); } catch (error) { message = String(error); }
    expect(message).not.toBe(""); expect(message).not.toContain("secret-value");
  }
});

test.each(["production", "closure"])("ignored-script allowance never executes hooks (%s)", async (strategy) => {
  const root = await dir(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const pkg = join(f.cache, "fixture-msg@1.0.0@@@1/package.json");
  const original = JSON.parse(await readFile(pkg, "utf8"));
  await writeFile(pkg, JSON.stringify({ ...original, scripts: { postinstall: `touch ${JSON.stringify(join(root, "should-never-exist"))}` } }));
  const manifest = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
  manifest.bunko.deps = { strategy };
  await writeFile(join(f.source, "package.json"), JSON.stringify(manifest));
  const options = { path: f.source, baseLayout: base, installCache: f.cache, localCache: false, gitMetadata: false };
  await expect(build({ ...options, output: join(root, "rejected") })).rejects.toThrow("declares install scripts");
  manifest.bunko.deps.allowIgnoredScripts = ["fixture-msg"];
  await writeFile(join(f.source, "package.json"), JSON.stringify(manifest));
  await writeFile(join(f.source, "bunfig.toml"), '[install]\nminimumReleaseAge=86400\n[test]\npreload=["never-execute.ts"]\n');
  const result = await build({ ...options, output: join(root, "accepted") });
  expect(result.images[0]!.inventory.find((p) => p.name === "fixture-msg")?.ignoredInstallScripts).toEqual(["postinstall"]);
  expect(await Bun.file(join(root, "should-never-exist")).exists()).toBe(false);
  const selected = await loadProject({ path: f.source }), plan = await dependencyPlan(selected, f.source), toolchain = await selectToolchain();
  const inputs = dependencyInputs(plan, toolchain, { os: "linux", architecture: "amd64" }, `sha256:${"0".repeat(64)}`, selected);
  expect(inputs.allowIgnoredScripts).toEqual(["fixture-msg"]);
  expect(inputs.installPolicy).toEqual({ minimumReleaseAge: 86400 });
});

test("label inheritance can omit base OCI identity while preserving explicit labels", () => {
  const base: ImageConfig = { os: "linux", architecture: "amd64", rootfs: { type: "layers", diff_ids: [] }, config: { Labels: { "org.opencontainers.image.title": "base", "org.opencontainers.image.source": "base-source", "vendor.key": "retained" } } };
  const result = imageConfig(base, [], { platform: { os: "linux", architecture: "amd64" }, epoch: 0, entrypoint: ["bun"], args: [], workdir: "/app", env: {}, inheritBaseOciLabels: false, labels: { "org.opencontainers.image.title": "application" } });
  expect(result.config?.Labels?.["org.opencontainers.image.title"]).toBe("application");
  expect(result.config?.Labels?.["org.opencontainers.image.source"]).toBeUndefined();
  expect(result.config?.Labels?.["vendor.key"]).toBe("retained");
});


test("opaque dependency loads require an explicit allowance while application loads stay strict", async () => {
  const root = await dir(), f = await dependencyFixture(root, false), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports = name => require(name);');
  await writeFile(join(f.source, "src/server.ts"), 'import load from "fixture-msg"; console.log(load("node:path").sep);');
  const manifest = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
  const options = { path: f.source, baseLayout: base, installCache: f.cache, localCache: false, gitMetadata: false };
  await expect(build({ ...options, output: join(root, "strict") })).rejects.toThrow("Bun build failed");
  manifest.bunko.build = { allowUnresolved: [""] };
  await writeFile(join(f.source, "package.json"), JSON.stringify(manifest));
  await build({ ...options, output: join(root, "allowed") });
  await writeFile(join(f.source, "src/server.ts"), 'const name = process.argv[2]; require(name);');
  await expect(build({ ...options, output: join(root, "app-computed") })).rejects.toThrow("Computed require/import");
  await writeFile(join(f.source, "src/server.ts"), 'import "missing-literal-package";');
  await expect(build({ ...options, output: join(root, "missing") })).rejects.toThrow("Bun build failed");
});


test.each(["production", "closure"])("workspace script allowances apply to resolved runtime packages (%s)", async (strategy) => {
  const root = await dir(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  const pkg = join(f.cache, "fixture-msg@1.0.0@@@1/package.json");
  await writeFile(pkg, JSON.stringify({ ...JSON.parse(await readFile(pkg, "utf8")), scripts: { postinstall: `touch ${JSON.stringify(join(root, "executed"))}` } }));
  const manifest = f.manifests["services/api"]!;
  (manifest.bunko as Record<string, unknown>).deps = { strategy, allowIgnoredScripts: ["fixture-msg"] };
  await writeFile(join(f.source, "services/api/package.json"), JSON.stringify(manifest));
  const result = await build({ path: join(f.source, "services/api"), baseLayout: base, output: join(root, "out"), installCache: f.cache, localCache: false, gitMetadata: false });
  expect(result.images[0]!.inventory.find((p) => p.name === "fixture-msg" && p.version === "1.0.0")?.ignoredInstallScripts).toEqual(["postinstall"]);
  expect(await Bun.file(join(root, "executed")).exists()).toBe(false);
});
