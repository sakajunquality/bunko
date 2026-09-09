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
  expect(() => assertToolchain(toolchainRequirements([{ packageManager: `bun@${selected.version}`, engines: { bun: ">=1.3.11 <1.5" } }], { revision: selected.revision }), selected)).not.toThrow();
  expect(() => toolchainRequirements([{ packageManager: "bun@1.3.11" }], { version: "1.3.12" })).toThrow("Conflicting");
  expect(() => assertToolchain({ revision: "0".repeat(40), ranges: [] }, selected)).toThrow("declared revision");
  expect(() => toolchainRequirements([{ packageManager: `bun@${selected.version}+sha512.fixture` }])).toThrow("exact supported version");
  expect(() => toolchainRequirements([{ packageManager: "bun@1.4.0-rc.1" }])).toThrow("exact supported version");

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

test("runtime options cannot consume or replace the configured entrypoint", async () => {
  const directory = await temporary(); roots.push(directory); const source = await project(join(directory, "source"));
  for (const args of [[""], ["other.ts"], ["run"], ["--"], ["--eval=SECRET_SCRIPT"], ["-e", "SECRET_SCRIPT"], ["--print=1"], ["--help"], ["--version"], ["--interactive"], ["--preload"], ["--conditions", "--smol"], ["--inspect", "localhost:9229"]]) {
    let requests = 0;
    try {
      await build({ path: source, runtimeArgs: args, push: false, gitMetadata: false, registry: { fetcher: async () => { requests++; throw new Error("unexpected network"); } } });
      throw new Error("Expected runtime argument rejection");
    } catch (error) { expect(String(error)).toContain("runtime.args"); expect(String(error)).not.toContain("SECRET_SCRIPT"); }
    expect(requests).toBe(0);
  }
  expect((await loadProject({ path: source, runtimeArgs: ["--preload", "./preload.ts", "--conditions=custom", "--title=-worker", "--inspect=localhost:9229"] })).runtimeArgs).toEqual(["--preload=./preload.ts", "--conditions=custom", "--title=-worker", "--inspect=localhost:9229"]);
});

test("Bun executes a preload/value pair and then the configured source entrypoint", async () => {
  const directory = await temporary(); roots.push(directory);
  const source = await project(join(directory, "source"), { bunko: { runtime: { args: ["--preload", "./preload.ts", "--smol"] } } }, 'console.log(process.env.PRELOAD_PROOF)');
  await writeFile(join(source, "preload.ts"), 'process.env.PRELOAD_PROOF = "preload followed by entrypoint";');
  const selected = await loadProject({ path: source, mode: "source" });
  const child = Bun.spawn([process.execPath, ...selected.runtimeArgs, "--no-install", selected.entrypoint], { cwd: source, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0); expect(error).toBe(""); expect(output.trim()).toBe("preload followed by entrypoint");
});

test("diagnostics expose inherited policy keys without values and account for member and CLI overrides", async () => {
  const { checkConfig } = await import("../packages/bunko/diagnostics.ts");
  const directory = await temporary(); roots.push(directory); const fixture = await workspaceFixture(directory);
  const rootPath = join(fixture.source, "package.json"), root = JSON.parse(await readFile(rootPath, "utf8"));
  root.bunko = { defaults: { user: "0:0", env: { PRIVATE_VALUE: "SECRET_VALUE" }, runtime: { args: ["--smol"] }, deps: { allowIgnoredScripts: ["fixture-msg"] } } };
  await writeFile(rootPath, JSON.stringify(root));
  const options = { path: join(fixture.source, "services/api") };
  const first = await checkConfig(options), inherited = first.targets[0]!.inheritedDefaults;
  expect(inherited).toContain("user"); expect(inherited).toContain("runtime.args"); expect(inherited).toContain("deps.allowIgnoredScripts"); expect(inherited).toContain("env.PRIVATE_VALUE");
  expect(JSON.stringify(first)).not.toContain("SECRET_VALUE");
  const override = await checkConfig({ ...options, imageUser: "65532:65532", runtimeArgs: [] });
  expect(override.targets[0]!.inheritedDefaults).not.toContain("user"); expect(override.targets[0]!.inheritedDefaults).not.toContain("runtime.args");
  const path = join(options.path, "package.json"), member = JSON.parse(await readFile(path, "utf8"));
  member.bunko.runtime = null; member.bunko.deps = { allowIgnoredScripts: [] }; member.bunko.env = { PRIVATE_VALUE: "MEMBER_VALUE" };
  await writeFile(path, JSON.stringify(member));
  expect((await checkConfig(options)).targets[0]!.inheritedDefaults).toEqual(["user"]);
});

test("environment overrides remove inherited base and platform keys in check-config and doctor", async () => {
  const directory = await temporary(); roots.push(directory); const fixture = await workspaceFixture(directory);
  const path = join(fixture.source, "package.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.bunko = { defaults: { base: "registry.example/default:latest", platforms: ["linux/amd64"] } };
  await writeFile(path, JSON.stringify(manifest));
  for (const command of ["check-config", "doctor"]) {
    const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), command, join(fixture.source, "services/api")], { env: { ...process.env, BUNKO_DEFAULT_BASE: "registry.example/override:latest", BUNKO_DEFAULT_PLATFORMS: "linux/arm64" }, stdout: "pipe", stderr: "pipe" });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(error).toBe("");
    const target = JSON.parse(out).targets[0];
    expect(target.inheritedDefaults).not.toContain("base"); expect(target.inheritedDefaults).not.toContain("platforms"); expect(target.platforms[0].architecture).toBe("arm64");
  }
});
