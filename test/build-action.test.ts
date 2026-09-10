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
  expect((await readFile(summary, "utf8"))).toContain("second");
}, 15000);

test("build Action forwards typed cache sources, destinations and export policy literally", () => {
  const result = buildArguments({ "cache-from": "type=local,src=cache with spaces", "cache-to": "type=registry,repo=registry.test/cache\ntype=local,dest=exported cache", "cache-export-error": "fail" }, "/tmp/action");
  expect(result.args).toContain("type=local,src=cache with spaces");
  expect(result.args.filter((value) => value === "--cache-to")).toHaveLength(2);
  expect(result.args.slice(result.args.indexOf("--cache-export-error"), result.args.indexOf("--cache-export-error") + 2)).toEqual(["--cache-export-error", "fail"]);
});
