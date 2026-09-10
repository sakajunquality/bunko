import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { cacheKeys, cacheMode, cacheOutputs, cachePaths, cachePlan, formatOutputs, managedCacheRoot, outputDelimiter, resolvedCacheDir, runCachePlan } from "../build/cache.ts";
import { buildArguments } from "../build/run.ts";
import { temporary } from "./helpers.ts";

const actionPath = new URL("../build/action.yml", import.meta.url), cachePath = new URL("../build/cache.ts", import.meta.url);
/** The targets the build step would pass to the CLI, so the key can be compared against the real selection. */
const selectedTargets = (targets: string): string[] => {
  const { args } = buildArguments({ path: ".", targets }, "/tmp/bunko-action");
  return args.flatMap((value, index) => (args[index - 1] === "--target" ? [value] : []));
};
/** Stub CLI reporting a fixed version, the way the cache step reads the installed version. */
async function stubBunko(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "bunko"), "#!/bin/sh\necho 9.9.9-test\n", { mode: 0o755 });
  return bin;
}

const identity = { os: "Linux", arch: "X64", version: "0.4.0", hash: "abc123" };
// The two apps of one workspace that collided on a single key in production before targets entered it.
const backendTarget = "@ezo-mobile/backend", adminTarget = "@ezo-mobile/admin";

/** Parse a GITHUB_OUTPUT file the way the runner does, so serialization is checked end to end. */
function parseOutputs(rendered: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const source = rendered.split("\n");
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index]!;
    if (!line) continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (!heredoc) { const at = line.indexOf("="); parsed[line.slice(0, at)] = line.slice(at + 1); continue; }
    const value: string[] = [];
    for (index += 1; index < source.length && source[index] !== heredoc[2]; index += 1) value.push(source[index]!);
    parsed[heredoc[1]!] = value.join("\n");
  }
  return parsed;
}

test("build Action cache input accepts github and none and rejects anything else", () => {
  expect(cacheMode(undefined)).toBe("none"); expect(cacheMode("")).toBe("none"); expect(cacheMode(" none ")).toBe("none");
  expect(cacheMode("github")).toBe("github");
  for (const value of ["gha", "true", "GitHub", "registry"]) expect(() => cacheMode(value)).toThrow("use github or none");
  expect(cachePlan({ cache: "none", root: "/cache/bunko", ...identity })).toEqual({ enabled: false, paths: [], key: "", restoreKeys: [] });
});

test("cached directories keep the managed root and add only explicit directories outside it", () => {
  const root = join("/home/runner", ".cache", "bunko");
  expect(cachePaths(root)).toEqual([root]);
  expect(cachePaths(root, join(root, "v1"), join(root, "install", "v1"))).toEqual([root]);
  expect(cachePaths(root, "/tmp/layers", "/tmp/install")).toEqual([root, "/tmp/layers", "/tmp/install"]);
  // A custom layer directory must not drop the package download, asset and runtime caches still under the root.
  expect(cachePaths(root, "/tmp/layers")).toEqual([root, "/tmp/layers"]);
  expect(() => cachePaths(root, "/tmp/lay\ners")).toThrow("line breaks");
  expect(() => cachePaths("")).toThrow("at least one directory");
});

test("the default cache key carries os, architecture and CLI version and falls back to the hashless prefix", () => {
  expect(cacheKeys(identity)).toEqual({ key: "bunko-Linux-X64-0.4.0-all-abc123", restoreKeys: ["bunko-Linux-X64-0.4.0-all-"] });
  expect(cacheKeys({ ...identity, os: "macOS", arch: "ARM64", version: "0.5.0-rc.1" }).key).toBe("bunko-macOS-ARM64-0.5.0-rc.1-all-abc123");
  // hashFiles returns an empty string when no lockfile or manifest matches; the key must still differ from the prefix.
  expect(cacheKeys({ ...identity, hash: "" }).key).toBe("bunko-Linux-X64-0.4.0-all-nofiles");
  expect(cacheKeys({ ...identity, key: "custom-key" })).toEqual({ key: "custom-key", restoreKeys: [] });
  expect(cacheKeys({ ...identity, restoreKeys: "first-\n\nsecond-\n" }).restoreKeys).toEqual(["first-", "second-"]);
  for (const key of ["with,comma", "with space", "x".repeat(513)]) expect(() => cacheKeys({ ...identity, key })).toThrow("Invalid build Action cache-key");
  expect(() => cacheKeys({ ...identity, restoreKeys: "bad,prefix" })).toThrow("cache-restore-keys");
  expect(() => cacheKeys({ ...identity, version: "" })).toThrow("bunko version");
  expect(() => cacheKeys({ ...identity, os: "Linux Runner" })).toThrow("operating system");
});

test("the cache key separates the selected targets and ignores their order and repetition", () => {
  const backend = cacheKeys({ ...identity, targets: backendTarget }), admin = cacheKeys({ ...identity, targets: adminTarget });
  // Both apps hash the same lockfile and manifests, so only the targets can tell their entries apart.
  expect(backend.key).not.toBe(admin.key);
  expect(backend.restoreKeys).not.toEqual(admin.restoreKeys);
  // How the workflow happened to write the list is not a different selection.
  const both = cacheKeys({ ...identity, targets: `${backendTarget}\n${adminTarget}` });
  expect(cacheKeys({ ...identity, targets: `  ${adminTarget}  \r\n\n${backendTarget}\n${adminTarget}\n` })).toEqual(both);
  expect(both.key).not.toBe(backend.key);
  expect(both.key).not.toBe(admin.key);
  // The segment stays short and safe inside a cache key and a path.
  for (const { key } of [backend, admin, both]) expect(key).toMatch(/^bunko-Linux-X64-0\.4\.0-[0-9a-f]{12}-abc123$/);
});

test("an unselected build keeps the stable all segment and no restore prefix crosses selections", () => {
  // A single-project workflow selects nothing and must keep one predictable key, not a hash of emptiness.
  expect(cacheKeys({ ...identity, targets: "  \n\n" })).toEqual({ key: "bunko-Linux-X64-0.4.0-all-abc123", restoreKeys: ["bunko-Linux-X64-0.4.0-all-"] });
  const all = cacheKeys(identity), backend = cacheKeys({ ...identity, targets: backendTarget }), admin = cacheKeys({ ...identity, targets: adminTarget });
  expect(backend.key).not.toBe(all.key);
  // A prefix restore must never reach another selection's entry, in either direction.
  expect(backend.key.startsWith(admin.restoreKeys[0]!)).toBe(false);
  expect(admin.key.startsWith(backend.restoreKeys[0]!)).toBe(false);
  expect(backend.key.startsWith(all.restoreKeys[0]!)).toBe(false);
  expect(backend.key.startsWith(backend.restoreKeys[0]!)).toBe(true);
  expect(admin.key.startsWith(admin.restoreKeys[0]!)).toBe(true);
  // Overrides still replace the default key and prefixes outright.
  expect(cacheKeys({ ...identity, targets: backendTarget, key: "custom-key" })).toEqual({ key: "custom-key", restoreKeys: [] });
  expect(cacheKeys({ ...identity, targets: backendTarget, restoreKeys: "first-\nsecond-" }).restoreKeys).toEqual(["first-", "second-"]);
});

test("the cache-plan step is wired to the same targets input the build step builds from", async () => {
  // Every other test calls the module directly, so a missing binding here would key every selected build as `all`.
  const action = parse(await Bun.file(actionPath).text()) as { inputs: Record<string, unknown>; runs: { steps: { id?: string; env?: Record<string, string> }[] } };
  const step = (id: string) => action.runs.steps.find((entry) => entry.id === id)?.env ?? {};
  expect(action.inputs.targets).toBeDefined();
  expect(step("cache-plan").BUNKO_CACHE_TARGETS).toBe("${{ inputs.targets }}");
  // Both steps must read one input; a key derived from a different input would describe another build.
  expect(step("build").BUNKO_INPUT_TARGETS).toBe(step("cache-plan").BUNKO_CACHE_TARGETS);
});

test("the cache entrypoint keys on the targets it reads from the step environment", async () => {
  const root = await temporary(), output = join(root, "outputs"), bin = await stubBunko(root);
  try {
    const run = async (targets?: string) => {
      await rm(output, { force: true });
      const child = Bun.spawn(["bun", fileURLToPath(cachePath)], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, XDG_CACHE_HOME: join(root, "xdg"), GITHUB_OUTPUT: output, BUNKO_CACHE_MODE: "github", BUNKO_CACHE_OS: "Linux", BUNKO_CACHE_ARCH: "X64", BUNKO_CACHE_HASH: "abc123", ...targets === undefined ? {} : { BUNKO_CACHE_TARGETS: targets } },
      });
      expect(await child.exited).toBe(0);
      return parseOutputs(await readFile(output, "utf8"));
    };
    const version = { os: "Linux", arch: "X64", version: "9.9.9-test", hash: "abc123" };
    expect((await run(backendTarget)).key).toBe(cacheKeys({ ...version, targets: backendTarget }).key);
    expect((await run(backendTarget)).key).not.toContain("-all-");
    expect((await run(adminTarget)).key).toBe(cacheKeys({ ...version, targets: adminTarget }).key);
    // An unset variable is the single-project workflow, which keeps the stable segment.
    expect((await run()).key).toBe("bunko-Linux-X64-9.9.9-test-all-abc123");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the cache key parses targets exactly as the build step parses them", () => {
  const many = Array.from({ length: 200 }, (_, index) => `@ezo-mobile/app-${index}`);
  const cases: { name: string; input: string; parsed: string[] }[] = [
    // A comma belongs to a target name; only line breaks separate, in the key as in the build step.
    { name: "comma", input: "@ezo-mobile/backend,admin", parsed: ["@ezo-mobile/backend,admin"] },
    { name: "spaces", input: "my target", parsed: ["my target"] },
    // A workspace may genuinely contain a target named `all`; it must not read as the empty selection.
    { name: "literal all", input: "all", parsed: ["all"] },
    { name: "CRLF", input: `${backendTarget}\r\n${adminTarget}`, parsed: [backendTarget, adminTarget] },
    { name: "blank lines and padding", input: `\n  ${backendTarget}  \n\n`, parsed: [backendTarget] },
    { name: "long list", input: many.join("\n"), parsed: many },
  ];
  const keys = new Map<string, string>();
  for (const { name, input, parsed } of cases) {
    expect(selectedTargets(input)).toEqual(parsed);
    const key = cacheKeys({ ...identity, targets: input }).key;
    // Whatever the input contained, the segment stays 12 hex characters, so the key stays legal.
    expect(key).toMatch(/^bunko-Linux-X64-0\.4\.0-[0-9a-f]{12}-abc123$/);
    expect(key.length).toBeLessThanOrEqual(512);
    // Reordering and repeating the same selection is the same selection.
    expect(cacheKeys({ ...identity, targets: [...parsed].reverse().concat(parsed).join("\n") }).key).toBe(key);
    expect(keys.get(key) ?? name).toBe(name);
    keys.set(key, name);
  }
  expect(keys.size).toBe(cases.length);
  // A target named `all` and an empty selection are different builds and must not share an entry.
  expect(cacheKeys({ ...identity, targets: "all" }).key).toBe("bunko-Linux-X64-0.4.0-5ef5ef0364b6-abc123");
  expect(cacheKeys({ ...identity, targets: "all" }).key).not.toBe(cacheKeys(identity).key);
});

test("step outputs survive a round trip for multi-line paths and restore keys", () => {
  const plan = cachePlan({ cache: "github", root: "/cache/bunko", cacheDir: "/tmp/layers", ...identity, restoreKeys: "first-\nsecond-" });
  const outputs = cacheOutputs(plan);
  expect(outputs).toEqual({ enabled: "true", path: "/cache/bunko\n/tmp/layers", key: "bunko-Linux-X64-0.4.0-all-abc123", "restore-keys": "first-\nsecond-" });
  expect(parseOutputs(formatOutputs(outputs))).toEqual(outputs);
  expect(parseOutputs(formatOutputs(cacheOutputs(cachePlan({ cache: "none", root: "/cache/bunko" }))))).toEqual({ enabled: "false", path: "", key: "", "restore-keys": "" });
});

test("a value containing the default heredoc delimiter cannot truncate the step outputs", () => {
  const delimiter = outputDelimiter([]);
  expect(delimiter).toBe("BUNKO_CACHE_OUTPUT_EOF");
  // A restore-key line equal to the delimiter would end the heredoc early and drop every later output.
  const outputs = { enabled: "true", path: "/cache/bunko\n/tmp/layers", key: "k", "restore-keys": `first-\n${delimiter}\nsecond-` };
  const rendered = formatOutputs(outputs);
  expect(rendered).not.toContain(`<<${delimiter}\n`);
  expect(parseOutputs(rendered)).toEqual(outputs);
  expect(outputDelimiter([`prefix\n${delimiter}`])).not.toBe(delimiter);
});

test("the managed root and the layer directory resolve exactly as the CLI does", () => {
  expect(managedCacheRoot({ XDG_CACHE_HOME: "/tmp/xdg" }, "/home/runner")).toBe(join("/tmp/xdg", "bunko"));
  expect(managedCacheRoot({}, "/home/runner")).toBe(join("/home/runner", ".cache", "bunko"));
  // The CLI uses `??`, so an empty XDG_CACHE_HOME gives a relative directory, not the home cache.
  expect(managedCacheRoot({ XDG_CACHE_HOME: "" }, "/home/runner")).toBe("bunko");
  // run.ts passes --cache-dir only for a non-empty input, so BUNKO_CACHE_DIR decides otherwise.
  expect(resolvedCacheDir("/tmp/input", { BUNKO_CACHE_DIR: "/tmp/env" })).toBe("/tmp/input");
  expect(resolvedCacheDir("", { BUNKO_CACHE_DIR: "/tmp/env" })).toBe("/tmp/env");
  expect(resolvedCacheDir(undefined, { BUNKO_CACHE_DIR: "/tmp/env" })).toBe("/tmp/env");
  expect(resolvedCacheDir("", {})).toBeUndefined();
});

test("the cache step reads the installed version, creates its directories and writes step outputs", async () => {
  const root = await temporary(), output = join(root, "outputs"), layers = join(root, "layers"), environmentLayers = join(root, "env-layers"), bin = await stubBunko(root);
  const old = { GITHUB_OUTPUT: process.env.GITHUB_OUTPUT, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, PATH: process.env.PATH, BUNKO_CACHE_DIR: process.env.BUNKO_CACHE_DIR };
  Object.assign(process.env, { GITHUB_OUTPUT: output, XDG_CACHE_HOME: join(root, "xdg"), PATH: `${bin}:${process.env.PATH ?? ""}` });
  try {
    // cache: none writes inert outputs, creates nothing and never consults the CLI.
    expect(await runCachePlan({ cache: "none", cacheDir: layers })).toEqual({ enabled: false, paths: [], key: "", restoreKeys: [] });
    expect(await readFile(output, "utf8")).toBe("enabled=false\npath=\nkey=\nrestore-keys=\n");
    await rm(output);
    const plan = await runCachePlan({ cache: "github", cacheDir: layers, os: "Linux", arch: "X64", hash: "abc123" });
    expect(plan).toEqual({ enabled: true, paths: [join(root, "xdg", "bunko"), layers], key: "bunko-Linux-X64-9.9.9-test-all-abc123", restoreKeys: ["bunko-Linux-X64-9.9.9-test-all-"] });
    for (const path of plan.paths) expect((await stat(path)).isDirectory()).toBe(true);
    expect(parseOutputs(await readFile(output, "utf8"))).toEqual({ enabled: "true", path: plan.paths.join("\n"), key: plan.key, "restore-keys": plan.restoreKeys.join("\n") });
    await rm(output);
    // The targets the build step receives reach the key through the same step input.
    const selected = await runCachePlan({ cache: "github", cacheDir: layers, os: "Linux", arch: "X64", hash: "abc123", targets: backendTarget });
    expect(selected.key).toMatch(/^bunko-Linux-X64-9\.9\.9-test-[0-9a-f]{12}-abc123$/);
    expect(selected.key).not.toBe(plan.key);
    await rm(output);
    // An environment-selected layer directory is persisted too, or its layers would never survive the job.
    process.env.BUNKO_CACHE_DIR = environmentLayers;
    expect((await runCachePlan({ cache: "github", os: "Linux", arch: "X64", hash: "abc123" })).paths).toEqual([join(root, "xdg", "bunko"), environmentLayers]);
    delete process.env.BUNKO_CACHE_DIR;
    await expect(runCachePlan({ cache: "buildkit" })).rejects.toThrow("use github or none");
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
