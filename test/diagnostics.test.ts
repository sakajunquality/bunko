import { afterEach, expect, test } from "bun:test";
import { readFile, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkConfig, doctor } from "../packages/bunko/diagnostics.ts";
import { closureReport, formatClosureInfo, formatWhy, whyPackage } from "../packages/bunko/closure-report.ts";
import { validateCommandOptions } from "../packages/bunko/command-options.ts";
import { cli, project, temporary } from "./helpers.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

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
  expect(result.targets[0]!.assetInputs).toEqual({entries:1,contexts:["data"]});
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
