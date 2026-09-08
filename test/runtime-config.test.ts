import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { workspaceDefaults } from "../packages/bunko/workspace-defaults.ts";
import { assertToolchain, toolchainRequirements } from "../packages/bunko/toolchain-policy.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { baseLayout, project, readJSON, temporary } from "./helpers.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("workspace defaults merge maps, replace arrays and allow explicit map resets", () => {
  const defaults = { env: { COMMON: "root", OVERRIDE: "root" }, ports: [8080], build: { minify: true, define: { FIRST: "true", OVERRIDE: "false" } } };
  expect(workspaceDefaults({ env: { OVERRIDE: "member" }, ports: [3000], build: { define: { OVERRIDE: "true" } } }, { defaults })).toEqual({ env: { COMMON: "root", OVERRIDE: "member" }, ports: [3000], build: { minify: true, define: { FIRST: "true", OVERRIDE: "true" } } });
  expect(workspaceDefaults({ mode: "source", build: null }, { defaults }).build).toBeUndefined();
  expect(() => workspaceDefaults({ defaults: {} })).toThrow("workspace root");
  expect(() => workspaceDefaults({}, { defaults: { entrypoint: "src/server.ts" } })).toThrow("Unsupported workspace default");
});

test("real workspace builds inherit runtime flags and override member environment", async () => {
  const directory = await temporary(); roots.push(directory); const fixture = await workspaceFixture(directory);
  const manifestPath = join(fixture.source, "package.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.bunko = { defaults: { mode: "source", workdir: "/srv", runtime: { args: ["--smol"] }, env: { SHARED: "root", OVERRIDE: "root" }, toolchain: { version: Bun.version } } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const memberPath = join(fixture.source, "services/api/package.json"), member = JSON.parse(await readFile(memberPath, "utf8"));
  member.bunko.build = null; member.bunko.env = { OVERRIDE: "member" }; await writeFile(memberPath, JSON.stringify(member));
  const result = await build({ path: join(fixture.source, "services/api"), baseLayout: await baseLayout(join(directory, "base")), push: false, localCache: false, registryCache: false, installCache: fixture.cache, output: join(directory, "image") });
  const config = (await readJSON<any>(result.layout!, result.config)).config;
  expect(config.WorkingDir).toBe("/srv/services/api");
  expect(config.Entrypoint).toEqual(["/usr/local/bin/bun", "--smol", "--no-install", "/srv/services/api/src/server.ts"]);
  expect(config.Env).toContain("SHARED=root"); expect(config.Env).toContain("OVERRIDE=member");
});

test("toolchain declarations constrain local selection without provisioning or network probes", async () => {
  const selected = await selectToolchain();
  expect(() => assertToolchain(toolchainRequirements([{ packageManager: `bun@${selected.version}`, engines: { bun: ">=1.3.11 <1.4" } }], { revision: selected.revision }), selected)).not.toThrow();
  expect(() => toolchainRequirements([{ packageManager: "bun@1.3.11" }], { version: "1.3.12" })).toThrow("Conflicting");
  expect(() => assertToolchain(toolchainRequirements([{ engines: { bun: "<1.0.0" } }]), selected)).toThrow("engines.bun");
  const directory = await temporary(); roots.push(directory); const source = await project(join(directory, "source"), { packageManager: "bun@1.3.999" });
  let requests = 0;
  await expect(build({ path: source, base: "registry.example/base:latest", output: join(directory, "image"), push: false, localCache: false, registry: { fetcher: async () => { requests++; throw new Error("unexpected network"); } } })).rejects.toThrow("declared version");
  expect(requests).toBe(0);
});

test("runtime argument overrides are visible by count in diagnostics and rejected for compile mode", async () => {
  const directory = await temporary(); roots.push(directory); const source = await project(join(directory, "source"), { bunko: { runtime: { args: ["--smol"] } } });
  expect((await loadProject({ path: source, runtimeArgs: ["--conditions=custom"] })).runtimeArgs).toEqual(["--conditions=custom"]);
  await expect(loadProject({ path: source, mode: "compile" })).rejects.toThrow("runtime.args");
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "check-config", source, "--runtime-arg=--conditions=custom"], { stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0); expect(error).toBe(""); expect(JSON.parse(out).targets[0].runtimeArgumentCount).toBe(1); expect(out).not.toContain("conditions");
});
