import { VERSION } from "../packages/bunko/config.ts";
import { afterEach, expect, test } from "bun:test";
import { readFile, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkConfig, doctor, type DiagnosticTarget } from "../packages/bunko/diagnostics.ts";
import { diagnosticsFormat, diagnosticsOutput, renderDiagnostics, renderedTargetKeys } from "../packages/bunko/diagnostics-format.ts";
import { closureReport, formatClosureInfo, formatWhy, whyPackage } from "../packages/bunko/closure-report.ts";
import { validateCommandOptions } from "../packages/bunko/command-options.ts";
import { cli, project, temporary } from "./helpers.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
import { main } from "../packages/bunko/cli.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

/** Run the CLI in process with a chosen terminal state; Bun offers no pty, and stdout ownership is restored either way. */
async function withStdout(argv: string[], streams: { stdout: boolean; stderr?: boolean }, environment: Record<string, string> = {}) {
  const chunks: string[] = [], previous = { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY, write: process.stdout.write };
  const restoreEnvironment = Object.entries(environment).map(([key, value]) => { const before = process.env[key]; process.env[key] = value; return () => { if (before === undefined) delete process.env[key]; else process.env[key] = before; }; });
  process.stdout.isTTY = streams.stdout; process.stderr.isTTY = streams.stderr ?? false;
  process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { code: await main(argv), stdout: chunks.join("") }; }
  finally {
    process.stdout.write = previous.write; process.stdout.isTTY = previous.stdout; process.stderr.isTTY = previous.stderr;
    for (const restore of restoreEnvironment) restore();
  }
}

/** A piped child process is the redirected case: stdout is never a terminal. */
async function runCLI(argv: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...environment } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** Every documented target field, so the rendering snapshot and the coverage check see them all. */
const fixtureTarget: DiagnosticTarget = {
  inheritedDefaults: ["user"], lockfileVersion: 1,
  entrypoints: { server: "src/server.ts", worker: "src/worker.ts" }, defaultEntrypoint: "server",
  assetMappings: [{ context: "data", from: "config.json", to: "/repo/config.json", mode: "0644", exclude: ["*.tmp"] }],
  assetInputs: { entries: 1, contexts: ["data"], external: 0 },
  name: "api", path: "services/api", entrypoint: "src/server.ts", mode: "bundle",
  platforms: [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "arm64", variant: "v8" }],
  dependencyStrategy: "closure", external: ["sharp"], base: "oven/bun:1.4.2-distroless",
  user: "65532:65532", ports: [8080, 9090], workdir: "/app",
  runtimePath: "/usr/local/bin/bun", runtimeInjection: "release", assets: ["db"], runtimeCertificateCount: 1, runtimeSystemCaTrust: false, explicitAssetsOverrideGitignore: false,
  assetExcludes: ["db/tmp"], assetMode: 0o644,
  toolchainRequirements: { version: "1.4.2", versionSource: "package.json#packageManager", ranges: [">=1.3.11 <1.5"], rangeSources: ["package.json#engines.bun"] },
  runtimeArgumentCount: 2, environmentKeys: ["PORT"], defineKeys: ["BUILD_CONSTANT"], unmatchedAllowances: ["fixture-mgs"],
};
const fixture = { schemaVersion: 1, status: "valid", bunko: "0.1.2", workspace: true, targets: [fixtureTarget],
  unchecked: ["base image runtime", "registry credentials and connectivity"] };

test("check-config renders an aligned summary of the object it also serializes as JSON", () => {
  expect(renderDiagnostics(fixture)).toBe([
    "bunko 0.1.2 · check-config · valid · workspace",
    "",
    "api (services/api)",
    "  Entrypoint          src/server.ts · bundle mode",
    "  Entrypoints         server = src/server.ts, worker = src/worker.ts · default server",
    "  Platforms           linux/amd64, linux/arm64/v8",
    "  Base                oven/bun:1.4.2-distroless",
    "  Dependencies        closure · bun.lock version 1",
    "  External            sharp",
    "  Assets              db · excludes db/tmp · mode 0644",
    "  Asset mappings      data:config.json → /repo/config.json (0644) excludes *.tmp",
    "                      1 selected entry in data",
    "  Environment         PORT",
    "  Defines             BUILD_CONSTANT",
    "  User                65532:65532",
    "  Workdir             /app",
    "  Ports               8080, 9090",
    "  Runtime             /usr/local/bin/bun · injected release · 2 runtime arguments · 1 CA certificate",
    "  Toolchain           version 1.4.2 (package.json#packageManager)",
    "                      range >=1.3.11 <1.5 (package.json#engines.bun)",
    "  Inherited defaults  user",
    "  Warnings            ignored-script allowances matching no locked package: fixture-mgs",
    "",
    "Not checked offline:",
    "  - base image runtime",
    "  - registry credentials and connectivity",
    "",
  ].join("\n"));
  const minimal = renderDiagnostics({ ...fixture, workspace: false, targets: [{ ...fixtureTarget, entrypoints: undefined, defaultEntrypoint: undefined, assetMappings: [], assetInputs: { entries: 0, contexts: [], external: 0 }, base: undefined, user: undefined, ports: undefined, external: [], assets: [], assetExcludes: [], assetMode: undefined, lockfileVersion: undefined, runtimeInjection: undefined, runtimeArgumentCount: 0, runtimeCertificateCount: 0, environmentKeys: [], defineKeys: [], inheritedDefaults: [], unmatchedAllowances: [], toolchainRequirements: { ranges: [] } }] });
  expect(minimal).toContain("check-config · valid · single project");
  expect(minimal).toContain("  Dependencies  closure · no lockfile\n");
  expect(minimal).toContain("  Toolchain     none declared\n");
  for (const label of ["Entrypoints", "Base", "External", "Assets", "Asset mappings", "User", "Ports", "Inherited defaults", "Warnings"]) expect(minimal).not.toContain(`  ${label} `);
});

test("doctor renders the toolchain comparison above the same target blocks", () => {
  const rendered = renderDiagnostics({ ...fixture, toolchain: { version: "1.4.2", revision: "744846f84", path: "/opt/bun/bin/bun" },
    host: { os: "linux", architecture: "arm64", runtime: "1.4.2" }, optionalTools: { docker: true, kubectl: false },
    advice: ["Use check-base --run to verify a base in Docker."] });
  expect(rendered.split("\n").slice(0, 7)).toEqual([
    "bunko 0.1.2 · doctor · valid · workspace",
    "",
    "Toolchain",
    "  Selected            1.4.2+744846f84 · /opt/bun/bin/bun",
    "  Declared            1.4.2 (package.json#packageManager)",
    "  Host                linux/arm64 · Bun 1.4.2",
    "  Optional tools      docker yes · kubectl no",
  ]);
  expect(rendered).toContain("\napi (services/api)\n");
  expect(rendered).toEndWith("\nNext steps:\n  - Use check-base --run to verify a base in Docker.\n");
});

test("diagnostics keep JSON for scripts, render text for terminals and drop no target field", async () => {
  expect(diagnosticsFormat(undefined, false)).toBe("json"); expect(diagnosticsFormat(undefined, true)).toBe("text");
  expect(diagnosticsFormat("json", true)).toBe("json"); expect(diagnosticsFormat("text", false)).toBe("text");
  expect(() => diagnosticsFormat("yaml", true)).toThrow("--format must be json or text");
  expect(diagnosticsOutput(fixture, "json")).toBe(`${JSON.stringify(fixture)}\n`);
  expect(diagnosticsOutput(fixture, "text")).toBe(renderDiagnostics(fixture));
  // A field added to the JSON must be rendered or listed here deliberately.
  const notRendered: string[] = [];
  const root = await temporary(); directories.push(root);
  const live = (await checkConfig({ path: await project(join(root, "app")) })).targets[0]!;
  for (const key of [...Object.keys(live), ...Object.keys(fixtureTarget)]) expect([...renderedTargetKeys, ...notRendered]).toContain(key);
  expect([...renderedTargetKeys].sort()).toEqual(Object.keys(fixtureTarget).sort());
  const explicit = await runCLI(["check-config", join(root, "app"), "--format", "json"]);
  expect(explicit.code).toBe(0); expect(explicit.stderr).toBe(""); expect(JSON.parse(explicit.stdout).targets[0].name).toBe("hello");
});

test("the CLI decides the diagnostics format from stdout alone and keeps errors on stderr", async () => {
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app"));
  // A terminal reader gets the summary; --format json still wins there.
  const terminal = await withStdout(["check-config", source], { stdout: true });
  expect(terminal.code).toBe(0); expect(terminal.stdout).toStartWith(`bunko ${VERSION} · check-config · valid · single project\n`);
  const forced = await withStdout(["doctor", source, "--format", "json"], { stdout: true });
  expect(forced.code).toBe(0); expect(JSON.parse(forced.stdout).toolchain.version).toMatch(/^1\.[34]\./);
  // A terminal stderr and a CI environment never change what stdout receives.
  const piped = await withStdout(["check-config", source], { stdout: false, stderr: true }, { CI: "1" });
  expect(piped.code).toBe(0); expect(JSON.parse(piped.stdout).targets[0].name).toBe("hello");
  const redirected = await runCLI(["check-config", source]), automated = await runCLI(["check-config", source], { CI: "1" });
  expect(redirected.stdout).toBe(automated.stdout); expect(JSON.parse(automated.stdout).status).toBe("valid");
  const readable = await runCLI(["check-config", source, "--format", "text"]);
  expect(readable.code).toBe(0); expect(readable.stderr).toBe(""); expect(readable.stdout).toStartWith(`bunko ${VERSION} · check-config · valid · single project\n`);
  const invalid = await runCLI(["check-config", source, "--format", "yaml"]);
  expect(invalid.code).toBe(1); expect(invalid.stdout).toBe(""); expect(invalid.stderr).toBe("bunko: --format must be json or text\n");
  // --progress is rejected by check-config, and rejecting it keeps the JSON error line it selected.
  const progress = await runCLI(["check-config", source, "--format", "text", "--progress=json"]);
  expect(progress.code).toBe(1); expect(progress.stdout).toBe("");
  expect(JSON.parse(progress.stderr)).toEqual({ schemaVersion: 1, type: "error", message: "--progress is not supported by check-config" });
});

test("offline diagnostics validate configuration without exposing configured values", async () => {
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "app", module: "src/server.ts", bunko: { env: { SECRET: "do-not-print" }, build: { define: { SECRET: '"another-secret"' } } } }));
  await writeFile(join(source, ".npmrc"), "//registry.npmjs.org/:_authToken=${BUNKO_DIAGNOSTIC_MISSING_TOKEN}\n");
  const result = await doctor({ path: source });
  expect(result.targets[0]!.environmentKeys).toEqual(["SECRET"]);
  expect(JSON.stringify(result)).not.toContain("do-not-print"); expect(JSON.stringify(result)).not.toContain("another-secret");
  expect(result.toolchain.version).toMatch(/^1\.[34]\./); expect(result.unchecked).toContain("registry credentials and connectivity");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "app", module: "src/server.ts", dependencies: { example: "1.0.0" } }));
  await expect(checkConfig({ path: source })).rejects.toThrow("text bun.lock");
});

test("command option validation rejects ignored flags including explicit negative booleans", async () => {
  for (const [command, flag] of [["prune", "push"], ["push-layout", "no-push"], ["check-base", "sbom"], ["build", "namespace"], ["doctor", "repo"], ["pack-deps", "cache-dir"]]) {
    expect(() => validateCommandOptions(command!, [flag!])).toThrow("not supported");
  }
  validateCommandOptions("build", ["no-push", "jobs"]);
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "push-layout", "/nonexistent", "--repo", "registry.test/demo", "--push=false"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("not supported by push-layout");
});

test("push-layout verifies attachments and blobs before any registry mutation", async () => {
  const { build } = await import("../packages/bunko/build.ts"), { pushLayout } = await import("../packages/bunko/push-layout.ts");
  const { baseLayout } = await import("./helpers.ts"), { MockRegistry } = await import("./mock-registry.ts");
  const { BlobStore } = await import("../packages/oci/blob-store.ts");
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), output = join(root, "image"), remote = new MockRegistry();
  const result = await build({ path: source, baseLayout: base, output, push: false, localCache: false, sbom: true, provenance: true, gitMetadata: false });
  const registry = { fetcher: remote.fetch, credentials: async () => undefined };
  expect((await pushLayout(output, "registry.test/layout", ["test"], registry)).published).toBe(true);
  remote.requests.splice(0);
  await writeFile(new BlobStore(output).path(result.attestations![0]!.manifest.digest), "corrupt");
  await expect(pushLayout(output, "registry.test/corrupt", ["test"], registry)).rejects.toThrow();
  expect(remote.requests).toHaveLength(0);
});

test("push-layout reports an image root published before an attachment failure", async () => {
  const { build } = await import("../packages/bunko/build.ts"), { pushLayout } = await import("../packages/bunko/push-layout.ts");
  const { baseLayout } = await import("./helpers.ts"), { MockRegistry } = await import("./mock-registry.ts");
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), output = join(root, "image"), remote = new MockRegistry(), report = join(root, "publication.json");
  const result = await build({ path: source, baseLayout: base, output, push: false, localCache: false, sbom: true, gitMetadata: false });
  const blocked = result.attestations![0]!.manifest.digest;
  await expect(pushLayout(output, "registry.test/partial", ["test"], { credentials: async () => undefined, fetcher: (url, init) => {
    if (init?.method === "PUT" && new URL(url).pathname.endsWith(`/manifests/${blocked}`)) return Promise.resolve(new Response(null, { status: 403 }));
    return remote.fetch(url, init);
  } }, report)).rejects.toThrow("image root was published");
  const data = await Bun.file(report).json();
  expect(data.status).toBe("failed"); expect(data.publication.published).toBe(true); expect(data.publication.reference).toContain(result.root.digest);
});


test("diagnostics check named entries and external bindings without staging or exposing host paths", async () => {
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app")), inputs = join(root, "inputs");
  await mkdir(inputs); await writeFile(join(inputs, "config.json"), "{}");
  await writeFile(join(source, "src/worker.ts"), "console.log(1)");
  const mapping = {context:"data",from:"config.json",to:"/repo/config.json"};
  await writeFile(join(source, "package.json"), JSON.stringify({name:"fixture",bunko:{entrypoints:{server:"src/server.ts",worker:"src/worker.ts"},defaultEntrypoint:"server",assetMappings:[mapping]}}));
  await expect(checkConfig({path:source})).rejects.toThrow("Missing asset context: data");
  const before = await readdir(root), result = await checkConfig({path:source,assetContexts:{data:inputs}});
  expect(result.targets[0]!.entrypoints).toEqual({server:"src/server.ts",worker:"src/worker.ts"});
  expect(result.targets[0]!.assetMappings).toEqual([mapping]);
  expect(result.targets[0]!.assetInputs).toEqual({entries:1,contexts:["data"],external:0});
  expect(JSON.stringify(result)).not.toContain(inputs);
  expect(await readdir(root)).toEqual(before);
  for (const command of ["check-config", "doctor"]) {
    const child = Bun.spawn([process.execPath,resolve("packages/bunko/cli.ts"),command,source,"--asset-context",`data=${inputs}`],{stdout:"pipe",stderr:"pipe"});
    const [out,error,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(exit).toBe(0); expect(error).toBe(""); expect(JSON.parse(out).targets[0].defaultEntrypoint).toBe("server");
  }
  await rm(join(inputs,"config.json")); await symlink("/nonexistent",join(inputs,"config.json"));
  await expect(checkConfig({path:source,assetContexts:{data:inputs}})).rejects.toThrow("symlinks");
});

test("closure-info and why explain the closure with sizes, paths and duplicate versions", async () => {
  const root = await temporary(); directories.push(root);
  const f = await workspaceFixture(root);
  const options = { path: f.source, installCache: f.cache, depsStrategy: "closure", sharedDeps: true };
  const report = await closureReport(options);
  expect(report.targets.map((target) => target.name)).toEqual(["fixture-api", "fixture-worker"]);
  const target = report.targets[0]!;
  expect(report.platform).toBe("linux/amd64");
  expect(target.bytes).toBe(target.packages.reduce((total, pkg) => total + pkg.bytes, 0));
  expect(target.duplicates).toEqual([{ name: "fixture-msg", bytes: expect.any(Number), versions: [expect.objectContaining({ version: "1.0.0", instances: 1 }), expect.objectContaining({ version: "2.0.0", instances: 1 })] }]);
  const table = formatClosureInfo(report, 2);
  expect(table).toContain("fixture-api (services/api) — linux/amd64, deps.strategy closure, shared closure");
  expect(table).toContain("Largest packages (2 of ");
  expect(table).toContain("Duplicate versions (largest first)");
  const why = formatWhy(whyPackage(report, "fixture-msg"), "fixture-msg");
  expect(why).toContain("fixture-msg in fixture-api (services/api)");
  expect(why).toContain("2 instance(s)");
  expect(why).toMatch(/1\.0\.0 +\d+ B +\d+ +node_modules/);
  expect(() => whyPackage(report, "fixture-dev")).toThrow("fixture-dev is not in the dependency closure");
  expect(() => validateCommandOptions("closure-info", ["repo"])).toThrow("not supported");
  // The commands need no registry access or publication, only the offline plan and the Linux production install.
  const command = await cli(["why", "fixture-msg", f.source, "--install-cache", f.cache, "--deps-strategy", "closure"]);
  expect(command.exit).toBe(0); expect(command.stderr).toBe("");
  expect(command.stdout).toContain("1 instance(s)");
  const absent = await cli(["why", "fixture-dev", f.source, "--install-cache", f.cache, "--deps-strategy", "closure"]);
  expect(absent.exit).toBe(1); expect(absent.stdout).toBe("");
  expect(absent.stderr).toContain("fixture-dev is not in the dependency closure");
});

test("closure diagnostics apply the build's source, sharing and platform policies", async () => {
  const root = await temporary(); directories.push(root);
  const f = await workspaceFixture(root);
  // Root sharedDeps selects the closure strategy and the union closure, exactly as a build resolves it.
  await writeFile(join(f.source, "package.json"), JSON.stringify({ ...f.manifests[""], bunko: { sharedDeps: true } }));
  // Ignored bytes inside a workspace package are not in the image, so they must not be counted.
  await mkdir(join(f.source, "packages/shared/generated"));
  await writeFile(join(f.source, "packages/shared/generated/blob.txt"), "x".repeat(4096));
  await writeFile(join(f.source, ".bunkoignore"), "packages/shared/generated\n");
  const report = await closureReport({ path: f.source, installCache: f.cache });
  expect(report.targets.every((target) => target.shared && target.strategy === "closure")).toBe(true);
  expect(report.targets[0]!.duplicates.map((item) => item.name)).toEqual(["fixture-msg"]);
  const shared = report.targets[0]!.packages.find((pkg) => pkg.name === "@fixture/shared")!;
  expect(shared.files).toBe(2); expect(shared.bytes).toBeLessThan(1024);
  const workerFile = join(f.source, "services/worker/package.json");
  const worker = JSON.parse(await readFile(workerFile, "utf8"));
  await writeFile(workerFile, JSON.stringify({ ...worker, bunko: { ...worker.bunko, external: [] } }));
  const union = await closureReport({ path: f.source, installCache: f.cache });
  expect(union.targets.every((target) => target.packages.length > 0)).toBe(true);
  expect(union.notes.some((note) => note.includes("runtime closure is empty"))).toBe(false);
  await expect(closureReport({ path: f.source, installCache: f.cache, platform: "linux/amd64,linux/arm64" })).rejects.toThrow("report one platform");
  await symlink("/etc/passwd", join(f.source, "packages/shared/escape"));
  await expect(closureReport({ path: f.source, installCache: f.cache })).rejects.toThrow("Source symlinks are not supported");
});

test("text diagnostics escape terminal controls in project metadata", () => {
  const report = { schemaVersion: 1 as const, bunko: VERSION, status: "valid" as const, workspace: false, targets: [], unchecked: ["name\u001b[2J\r\tvalue"] };
  expect(renderDiagnostics(report)).toContain("name\\u001b[2J\\u000d\\u0009value");
  expect(renderDiagnostics(report)).not.toContain("\u001b");
});


test("offline text diagnostics describe image and URL sources without claiming their content was inspected", () => {
  const target: DiagnosticTarget = { ...fixtureTarget, assetMappings: [
    { image: "registry.test/tool:v1", from: "/bin/tool", to: "/app/tool", platform: "linux/amd64" },
    { url: "https://example.test/data", sha256: "a".repeat(64), to: "/app/data" },
  ], assetInputs: { entries: 0, contexts: [], external: 2 } };
  const text = renderDiagnostics({ ...fixture, targets: [target] });
  expect(text).toContain("registry.test/tool:v1:/bin/tool [linux/amd64]");
  expect(text).toContain(`https://example.test/data [sha256:${"a".repeat(64)}]`);
  expect(text).toContain("2 external source(s); content not checked offline");
});

test("diagnostics explain explicit asset and native trust policies", () => {
  const output = renderDiagnostics({ ...fixture, targets: [{ ...fixtureTarget, mode: "source", explicitAssetsOverrideGitignore: true, runtimeSystemCaTrust: true }] });
  expect(output).toContain("explicit assets override .gitignore");
  expect(output).toContain("native CA trust (SSL_CERT_FILE)");
});
