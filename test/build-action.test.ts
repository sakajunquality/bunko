import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildArguments, buildSummary, imageResults, runBuildAction } from "../build/run.ts";
import { prepareRelease } from "../scripts/release.ts";
import { setup } from "../scripts/setup.ts";
import metadata from "../package.json";
import { baseLayout, temporary } from "./helpers.ts";
let root: string;
beforeAll(async () => { root = await temporary(); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("build Action keeps arguments literal, exports local images and validates publishing intent", () => {
  const args = buildArguments({ path: "project with spaces", targets: "first\nsecond", "asset-contexts": "data=literal;$(not-a-command)", push: "false", "registry-mirrors": "docker.io=mirror.example/cache\norigin.example=second.example", "registry-config": "tls config.json" }, "/tmp/action");
  expect(args.args).toContain("data=literal;$(not-a-command)");
  expect(args.args).toContain("docker.io=mirror.example/cache"); expect(args.args).toContain("origin.example=second.example"); expect(args.args).toContain("tls config.json");
  expect(args.args).toContain("--oci-layout"); expect(args.references).toBe("");
  expect(() => buildArguments({ push: "true" }, "/tmp/action")).toThrow("requires repo");
  expect(() => buildArguments({ otel: "yes" }, "/tmp/action")).toThrow("true or false");
  const published = buildArguments({ push: "true", repo: "registry.example/team" }, "/tmp/action");
  expect(published.layout).toBe(""); expect(published.args).toContain("--image-refs");
});

test("build Action forwards install cache, bare, image user and report inputs only when provided", () => {
  const defaults = buildArguments({}, "/tmp/action");
  for (const flag of ["--install-cache", "--bare", "--image-user"]) expect(defaults.args).not.toContain(flag);
  expect(defaults.report).toBe(join("/tmp/action", "report.json")); expect(defaults.args).toContain(defaults.report);
  expect(buildArguments({ bare: "false" }, "/tmp/action").args).not.toContain("--bare");
  const explicit = buildArguments({ "install-cache": "install cache", bare: "true", "image-user": "65532:65532", report: "reports/build report.json" }, "/tmp/action");
  const after = (flag: string) => explicit.args[explicit.args.indexOf(flag) + 1];
  expect(after("--install-cache")).toBe("install cache"); expect(after("--image-user")).toBe("65532:65532"); expect(explicit.args).toContain("--bare");
  expect(explicit.report).toBe(resolve("reports/build report.json")); expect(after("--report")).toBe(explicit.report);
  expect(() => buildArguments({ bare: "yes" }, "/tmp/action")).toThrow("true or false");
  expect(() => buildArguments({ report: "report\n.json" }, "/tmp/action")).toThrow("line breaks");
});

test("reports preserve all targets and summaries escape application-controlled labels", () => {
  const digest = `sha256:${"a".repeat(64)}`, target = "name|<img>\nnext";
  const images = imageResults({ status: "success", targets: [{ target, root: { digest } }, { target: "second", root: { digest }, publication: { published: true, reference: `registry.example/second@${digest}` } }] });
  expect(images).toHaveLength(2); expect(images[0]!.reference).toBeUndefined();
  expect(buildSummary(images)).not.toContain("<img>"); expect(buildSummary(images)).toContain("name&#124;");
  expect(() => imageResults({ status: "failed", targets: [] })).toThrow("failed");
  expect(() => imageResults({ target: "bad", root: { digest: "not-a-digest" } })).toThrow("Invalid");
});

test("installed CLI builds two workspace targets and exposes report/layout without a misleading single digest", async () => {
  const distribution = join(root, "distribution"); await prepareRelease(distribution);
  const installed = await setup({ version: metadata.version, distribution, temporary: root });
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "action-workspace", workspaces: ["apps/*"] }));
  for (const name of ["first", "second"]) {
    const path = join(source, "apps", name); await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, module: "index.ts" }));
    await writeFile(join(path, "index.ts"), `console.log(${JSON.stringify(name)});`);
  }
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], { cwd: source, stdout: "ignore", stderr: "pipe" });
  await new Response(install.stderr).text(); expect(await install.exited).toBe(0);
  const output = join(root, "outputs"), summary = join(root, "summary"), base = await baseLayout(join(root, "base"));
  const old = { PATH: process.env.PATH, RUNNER_TEMP: process.env.RUNNER_TEMP, GITHUB_OUTPUT: process.env.GITHUB_OUTPUT, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY };
  Object.assign(process.env, { PATH: `${installed.bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
  try { await runBuildAction({ path: source, "base-layout": base, "cache-dir": join(root, "cache"), push: "false", platforms: "linux/amd64" }); }
  finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const values = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  expect(JSON.parse(values.images!).map((i: { target: string }) => i.target)).toEqual(["first", "second"]);
  expect(values.digest).toBe(""); expect(values.reference).toBe(""); expect(values["image-refs"]).toBe("");
  expect(await Bun.file(values.report!).exists()).toBe(true);
  const written = await readFile(summary, "utf8");
  expect(written).toContain("second");
  // The report-derived section follows the image table for every target of the same build.
  expect(written).toContain("### bunko build");
  expect(written).toContain(`bunko ${metadata.version}`);
  expect(written).toContain("| Phase |");
  expect(written).toContain("- Cache: ");
  expect(written).toContain("- Layers: ");
  expect(written).toContain("#### first");
  expect(written).toContain("#### second");
}, 15000);

/** A stub CLI keeps summary behavior testable without a real build. Fixture path and exit code are
 * baked into the script because spawned children do not observe later process.env mutations. */
async function stubCLI(directory: string, options: { report?: string; exit?: number } = {}): Promise<string> {
  await mkdir(directory, { recursive: true });
  const copy = options.report ? `if [ -n "$target" ]; then cp ${JSON.stringify(options.report)} "$target"; fi\n` : "";
  await writeFile(join(directory, "bunko"), `#!/bin/sh\ntarget=""\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--report" ]; then target="$2"; fi\n  shift\ndone\n${copy}exit ${options.exit ?? 0}\n`, { mode: 0o755 });
  return directory;
}
async function withActionEnvironment<T>(values: Record<string, string | undefined>, task: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await task(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("the job summary follows the build report, honors summary: false and notes an unwritten report", async () => {
  const directory = join(root, "summary-inputs"); await mkdir(directory, { recursive: true });
  const digest = `sha256:${"c".repeat(64)}`;
  const success = join(directory, "success.json"), failure = join(directory, "failure.json");
  await writeFile(success, JSON.stringify({ schemaVersion: 2, target: "api", platform: "linux/amd64", builder: { version: "9.9.9" }, root: { digest }, timings: [{ phase: "bundle", status: "completed", durationMs: 2500, platform: "linux/amd64" }], cache: [{ kind: "deps", key: digest, status: "local" }], layers: [{ kind: "app", descriptor: { size: 1_500_000, mediaType: "x" } }] }));
  await writeFile(failure, JSON.stringify({ schemaVersion: 3, status: "failed", error: "registry.example rejected the manifest", targets: [], pendingTargets: ["api"] }));
  const passing = await stubCLI(join(root, "stub-pass"), { report: success });
  const failing = await stubCLI(join(root, "stub-fail"), { report: failure, exit: 1 });
  const silent = await stubCLI(join(root, "stub-silent"), { exit: 1 });
  const run = async (file: string, bin: string, inputs: Record<string, string> = {}, environment: Record<string, string | undefined> = {}) =>
    withActionEnvironment({ PATH: `${bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: root, GITHUB_OUTPUT: undefined, GITHUB_STEP_SUMMARY: join(directory, file), ...environment },
      () => runBuildAction({ path: directory, ...inputs }));

  await run("enabled.md", passing);
  const enabled = await readFile(join(directory, "enabled.md"), "utf8");
  expect(enabled).toContain("### bunko build");
  expect(enabled).toContain("bunko 9.9.9");
  expect(enabled).toContain("| bundle | 1 | 2.5 |");
  expect(enabled).toContain("- Cache: deps=local");
  expect(enabled).toContain("- Layers: app 1.5 MB (1.5 MB stored)");

  await run("disabled.md", passing, { summary: "false" });
  expect(await Bun.file(join(directory, "disabled.md")).exists()).toBe(false);

  // A failing build still explains where the time went, and a missing report degrades to one note.
  await expect(run("failed.md", failing)).rejects.toThrow("Bunko build failed");
  expect(await readFile(join(directory, "failed.md"), "utf8")).toContain("Build failed: registry.example rejected the manifest");
  await expect(run("absent.md", silent)).rejects.toThrow("Bunko build failed");
  const absent = await readFile(join(directory, "absent.md"), "utf8");
  expect(absent).toContain("No readable build report was available for this summary.");
  expect(absent.trim().split("\n").filter(Boolean)).toHaveLength(2);

  // Summary rendering is diagnostic only: an unwritable step summary leaves a successful build successful.
  const blocked = join(directory, "blocked"); await mkdir(blocked, { recursive: true });
  const outputs = join(directory, "outputs.txt");
  await run("unused.md", passing, {}, { GITHUB_STEP_SUMMARY: blocked, GITHUB_OUTPUT: outputs });
  expect(await readFile(outputs, "utf8")).toContain("images=");

  // Step outputs are the result of the step, so their failure surfaces on a successful build and
  // stays out of the way of a build failure.
  await expect(run("output-success.md", passing, {}, { GITHUB_OUTPUT: blocked })).rejects.toThrow(/EISDIR|directory/);
  await expect(run("output-failure.md", failing, {}, { GITHUB_OUTPUT: blocked })).rejects.toThrow("Bunko build failed");
  expect(await readFile(join(directory, "output-failure.md"), "utf8")).toContain("Build failed: registry.example rejected the manifest");

  // A failing build with the summary disabled reports only the build failure and writes no summary.
  await expect(run("off.md", failing, { summary: "false" })).rejects.toThrow("Bunko build failed");
  expect(await Bun.file(join(directory, "off.md")).exists()).toBe(false);
});

test("build Action forwards typed cache sources, destinations and export policy literally", () => {
  const result = buildArguments({ "cache-from": "type=local,src=cache with spaces", "cache-to": "type=registry,repo=registry.test/cache\ntype=local,dest=exported cache", "cache-export-error": "fail" }, "/tmp/action");
  expect(result.args).toContain("type=local,src=cache with spaces");
  const destinations = result.args.flatMap((value, index) => value === "--cache-to" ? [result.args[index + 1]] : []);
  expect(destinations).toEqual(["type=registry,repo=registry.test/cache", "type=local,dest=exported cache"]);
  expect(result.args.slice(result.args.indexOf("--cache-export-error"), result.args.indexOf("--cache-export-error") + 2)).toEqual(["--cache-export-error", "fail"]);
});
