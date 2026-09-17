import { BlobStore } from "../packages/oci/blob-store.ts";
import { LayoutSource, resolveBase } from "../packages/oci/source.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { exportLayout } from "../packages/oci/layout.ts";
import { media } from "../packages/oci/types.ts";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { baseStatus, rebasePolicyTemplate, rebaseTargets } from "../packages/bunko/rebase-operations.ts";
import { rebase, readRebasePolicy } from "../packages/bunko/rebase.ts";
import { RebaseDecisionError } from "../packages/bunko/rebase-decision.ts";
import { main } from "../packages/bunko/cli.ts";
import { rebaseArguments, rebaseOutputs } from "../rebase/run.ts";
import { pushLayout } from "../packages/bunko/push-layout.ts";
import { MockRegistry } from "./mock-registry.ts";
import { rebaseBase } from "./rebase-fixture.ts";
import { project, temporary } from "./helpers.ts";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await temporary(); paths.push(root);
  const old = await rebaseBase(join(root, "old"));
  const next = await rebaseBase(join(root, "next"), undefined, {}, [{ path: "etc/release-note", type: "file", content: Buffer.from("update") }]);
  const source = await project(join(root, "source"));
  const image = await build({ path: source, baseLayout: old.directory, output: join(root, "image"), localCache: false, gitMetadata: false });
  return { root, old, next, image, options: { image: `layout:${image.layout}`, oldBase: `layout:${old.directory}`, base: `layout:${next.directory}` } };
}
test("dry-run returns typed decisions, bounded changes, and stable exit codes", async () => {
  const f = await fixture(), report = join(f.root, "decision.json");
  try { await rebase({ ...f.options, dryRun: true, report }); throw new Error("Expected policy decision"); }
  catch (error) { expect(error).toBeInstanceOf(RebaseDecisionError); expect((error as RebaseDecisionError).exitCode).toBe(3); }
  const result = JSON.parse(await readFile(report, "utf8"));
  expect(result).toMatchObject({ decision: "requires-policy", requires: "compatibility-policy", reason: "base-files-changed" });
  expect(result.changes).toContain("etc/release-note");
  expect(await main(["rebase", f.options.image, "--old-base", f.options.oldBase, "--base", f.options.base, "--dry-run"])).toBe(3);
  expect(await main(["rebase", f.options.oldBase, "--old-base", f.options.oldBase, "--base", f.options.base, "--dry-run"])).toBe(4);
  expect(await main(["rebase", "layout:/missing-bunko-operation-fixture", "--old-base", f.options.oldBase, "--base", f.options.base, "--dry-run"])).toBe(1);
});
test("base-status resolves tags read-only and distinguishes current, outdated, legacy and unknown", async () => {
  const f = await fixture(), mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  const image = await pushLayout(f.image.layout!, "registry.test/app", ["latest"], registry);
  const old = await pushLayout(f.old.directory, "registry.test/base", ["old"], registry);
  await pushLayout(f.next.directory, "registry.test/base", ["new"], registry);
  const start = mock.requests.length;
  const result = await baseStatus([
    { image: "registry.test/app:latest", oldBase: f.options.oldBase, base: "registry.test/base:old" },
    { image: image.reference, oldBase: f.options.oldBase, base: "registry.test/base:new" },
    { image: old.reference, base: "registry.test/base:new" },
    { image: image.reference },
  ], registry);
  expect(result.results.map((r) => r.status)).toEqual(["current", "outdated", "not-rebaseable", "unknown"]);
  expect(result.results[1]!.decision).toBe("requires-policy");
  expect(result.results[0]!.image).toBe(image.reference);
  expect(mock.requests.slice(start).every((r) => ["GET", "HEAD"].includes(r.method))).toBe(true);
});
test("policy templates are unapproved, digest-bound, bounded and never overwrite existing files", async () => {
  const f = await fixture(), out = join(f.root, "policy.json");
  const result = await rebasePolicyTemplate({ ...f.options, out });
  expect(result.policy).toMatchObject({ schemaVersion: 2, reviewed: false });
  expect(result.review[0]!.changedFiles).toContain("etc/release-note");
  await expect(readRebasePolicy(out)).rejects.toThrow("policy");
  await expect(rebasePolicyTemplate({ ...f.options, out })).rejects.toThrow();
  await writeFile(out, JSON.stringify({ ...result.policy, reviewed: true }));
  expect((await rebase({ ...f.options, dryRun: true, policy: out })).decision).toBe("compatible");
  await writeFile(out, JSON.stringify({ schemaVersion: 1, targets: [{ image: f.options.image, base: f.options.base }] }));
  expect(await rebaseTargets(out)).toHaveLength(1);
  await writeFile(out, " ".repeat(65537)); await expect(rebaseTargets(out)).rejects.toThrow("64 KiB");
});
test("failed acceptance publishes nothing; successful acceptance promotes only afterward", async () => {
  const f = await fixture(), bin = join(f.root, "bin"), log = join(f.root, "docker.log"); await mkdir(bin);
  const docker = join(bin, "docker"), path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    for (const fail of [true, false]) {
      await writeFile(docker, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); if(process.argv[2]==="run")process.exit(${fail ? 9 : 0});\n`); await chmod(docker, 0o755);
      const mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined }, report = join(f.root, `smoke-${fail}.json`);
      const options = { ...f.options, base: f.options.oldBase, repo: "registry.test/app", tags: ["stable"], smokeCommand: ["/usr/local/bin/bun", "--version"], registry, report };
      if (fail) {
        await expect(rebase(options)).rejects.toThrow("smoke");
        const result = JSON.parse(await readFile(report, "utf8")); expect(result.smoke).toBe("failed"); expect(result.publication).toBeUndefined(); expect(result.error).toContain("linux/amd64 run failed (exit 9)"); expect(mock.requests.some((r) => r.method === "PUT" || r.method === "POST" || r.method === "PATCH")).toBe(false);
        expect(mock.requests.some((r) => r.method === "PUT" && r.url.pathname.endsWith("/manifests/stable"))).toBe(false);
      } else {
        const result = await rebase(options); expect(result.smoke).toBe("passed"); expect(result.publication!.tags).toEqual(["stable"]);
      }
    }
  } finally { process.env.PATH = path; }
});
test("rebase Action requires explicit acceptance before publishing and passes shell metacharacters as data", () => {
  const input = { image: "example/app@sha256:digest", "old-base": "example/base@sha256:old", base: "example/base@sha256:new", repo: "example/app", "dry-run": "false" };
  expect(() => rebaseArguments(input, "/tmp/report")).toThrow("smoke-command");
  const command = '["/app/check","$(do-not-execute)"]';
  expect(rebaseArguments({ ...input, "smoke-command": command }, "/tmp/report")).toContain(command);
});

test("Action outputs distinguish unaccepted candidates and skipped tags", () => {
  const failed = rebaseOutputs({ decision: "error", publication: { reference: "example@sha256:pending", pendingTags: ["stable"] } }, 1, false);
  expect(failed.reference).toBe(""); expect(failed["candidate-reference"]).toContain("pending");
  const skipped = rebaseOutputs({ decision: "compatible", status: "success", smoke: "passed", publication: { reference: "example@sha256:new", skippedTags: [{ tag: "stable" }] } }, 0, false);
  expect(skipped.reference).toBe(""); expect(skipped["skipped-tags"]).toContain("stable");
  expect(rebaseOutputs(undefined, 1, false).decision).toBe("error");
});

test("stale reviewed policies still request policy review, not an operational retry", async () => {
  const f = await fixture(), path = join(f.root, "policy.json");
  const template = await rebasePolicyTemplate({ ...f.options, out: path });
  await writeFile(path, JSON.stringify({ ...template.policy, reviewed: true, transitions: template.policy.transitions.map((t) => ({ ...t, newBase: `sha256:${"a".repeat(64)}` })) }));
  const report = join(f.root, "stale.json");
  expect(await main(["rebase", f.options.image, "--old-base", f.options.oldBase, "--base", f.options.base, "--compatibility-policy", path, "--dry-run", "--report", report])).toBe(3);
  expect(JSON.parse(await readFile(report, "utf8")).reason).toBe("policy-transition-missing");
});
test("discovery requires explicit old-base for cross-repository transitions", async () => {
  const f = await fixture(), mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  await pushLayout(f.next.directory, "registry.test/replacement", ["latest"], registry);
  const result = await baseStatus([{ image: f.options.image, base: "registry.test/replacement:latest" }], registry);
  expect(result.results[0]).toMatchObject({ status: "unknown", reason: "explicit-old-base-required" });
  expect(mock.requests.every((r) => r.url.host === "registry.test")).toBe(true);
});

test("Action retains candidate details when the requested report copy fails", async () => {
  const root = await temporary(); paths.push(root); const bin = join(root, "bin"); await mkdir(bin);
  const helper = join(bin, "bunko"), output = join(root, "outputs");
  await writeFile(helper, `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='version'){console.log('0.10.0');process.exit(0);}await Bun.write(args[args.indexOf('--report')+1],JSON.stringify({schemaVersion:1,command:'rebase',decision:'compatible',status:'success',smoke:'passed',publication:{reference:'registry.test/app@sha256:candidate',tags:[],pendingTags:[]}}));`, { mode: 0o755 });
  const child = Bun.spawn([process.execPath, new URL("../rebase/run.ts", import.meta.url).pathname], { stdout: "ignore", stderr: "ignore", env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, BUNKO_INPUT_IMAGE: "image", BUNKO_INPUT_OLD_BASE: "old", BUNKO_INPUT_BASE: "base", BUNKO_INPUT_REPO: "registry.test/app", BUNKO_INPUT_DRY_RUN: "false", BUNKO_INPUT_SMOKE_COMMAND: '["/app/check"]', BUNKO_INPUT_REPORT: join(root, "missing", "report.json") } });
  expect(await child.exited).toBe(1); const text = await readFile(output, "utf8"); expect(text).toContain("candidate-reference=registry.test/app@sha256:candidate");
  const retained = text.split("\n").find((line) => line.startsWith("report="))!.slice(7);
  expect(JSON.parse(await readFile(retained, "utf8")).publication.reference).toContain("candidate");
  await rm(join(retained, ".."), { recursive: true, force: true });
});


test("rebase Action forwards attestation choices and validates booleans", () => {
  const input = { image: "image", "old-base": "old", base: "base", sbom: "true", provenance: "true" };
  expect(rebaseArguments(input, "/report")).toContain("--sbom=true");
  expect(rebaseArguments(input, "/report")).toContain("--provenance=true");
  expect(() => rebaseArguments({ ...input, sbom: "invalid" }, "/report")).toThrow("sbom");
});

test("unavailable Docker daemon fails before registry access", async () => {
  const f = await fixture(), bin = join(f.root, "bin"); await mkdir(bin);
  const path = process.env.PATH;
  try {
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nprocess.exit(23);`, { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    const mock = new MockRegistry(), report = join(f.root, "preflight.json");
    await expect(rebase({ ...f.options, base: f.options.oldBase, repo: "registry.test/app", smokeCommand: ["/app/check"], report, registry: { fetcher: mock.fetch, credentials: async () => undefined } })).rejects.toThrow("Docker preflight failed (exit 23)");
    expect(mock.requests).toHaveLength(0);
    expect(JSON.parse(await readFile(report, "utf8")).publication).toBeUndefined();
  } finally { process.env.PATH = path; }
});


test("base-status reuses downloaded image metadata during assessment", async () => {
  const f = await fixture(), mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  const image = await pushLayout(f.image.layout!, "registry.test/app", [], registry);
  const next = await pushLayout(f.next.directory, "registry.test/base", [], registry);
  const start = mock.requests.length;
  const result = await baseStatus([{ image: image.reference, oldBase: f.options.oldBase, base: next.reference }], registry);
  expect(result.results[0]!.decision).toBe("requires-policy");
  const gets = mock.requests.slice(start).filter((r) => r.method === "GET" && r.url.pathname.includes("/manifests/"));
  const roots = gets.filter((r) => r.url.pathname.endsWith(image.reference.split("@")[1]!));
  // One pinning request plus one immutable input snapshot, with no assessment re-fetch.
  expect(roots.length).toBe(2);
});


test("load deadlines are explicit, bounded and forwarded only with smoke acceptance", async () => {
  const input = { image: "image", "old-base": "old", base: "base", "smoke-load-timeout": "600" };
  expect(rebaseArguments(input, "/report")).not.toContain("--smoke-load-timeout");
  const args = rebaseArguments({ ...input, "smoke-command": '["/app/check"]' }, "/report");
  expect(args[args.indexOf("--smoke-load-timeout") + 1]).toBe("600");
  for (const value of [0, -1, 1.5, 3601, NaN]) await expect(rebase({ image: "image", oldBase: "old", base: "base", dryRun: true, smokeCommand: ["/app/check"], smokeLoadTimeoutSeconds: value })).rejects.toThrow("1..3600");
});


test("base-status reports future capsule versions without calling them current or transport failures", async () => {
  const f = await fixture(), store = new BlobStore(f.image.layout!);
  const image = await resolveBase(new LayoutSource(f.image.layout!), { os: "linux", architecture: "amd64" }, store);
  const config = structuredClone(image.config), label = "org.bunko.rebase.metadata";
  config.config!.Labels![label] = JSON.stringify({ ...JSON.parse(config.config!.Labels![label]!), version: 2, future: true });
  const configDescriptor = await store.put(canonicalJSON(config), media.config);
  const manifest = await store.put(canonicalJSON({ ...image.manifest, config: configDescriptor }), media.manifest);
  const output = join(f.root, "future-image");
  await exportLayout(store, output, manifest, [manifest, configDescriptor, ...image.manifest.layers], "future");
  const result = await baseStatus([
    { image: `layout:${output}`, oldBase: f.options.oldBase, base: f.options.oldBase },
    { image: `layout:${output}` },
  ]);
  for (const item of result.results) expect(item).toMatchObject({ status: "not-rebaseable", reason: "unsupported-format", format: "rebase-capsule", formatVersion: 2, supportedVersions: [1] });
});
