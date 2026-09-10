import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheKeys, cacheMode, cacheOutputs, cachePaths, cachePlan, formatOutputs, managedCacheRoot, outputDelimiter, resolvedCacheDir, runCachePlan } from "../build/cache.ts";
import { temporary } from "./helpers.ts";

const identity = { os: "Linux", arch: "X64", version: "0.4.0", hash: "abc123" };

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
  expect(cacheKeys(identity)).toEqual({ key: "bunko-Linux-X64-0.4.0-abc123", restoreKeys: ["bunko-Linux-X64-0.4.0-"] });
  expect(cacheKeys({ ...identity, os: "macOS", arch: "ARM64", version: "0.5.0-rc.1" }).key).toBe("bunko-macOS-ARM64-0.5.0-rc.1-abc123");
  // hashFiles returns an empty string when no lockfile or manifest matches; the key must still differ from the prefix.
  expect(cacheKeys({ ...identity, hash: "" }).key).toBe("bunko-Linux-X64-0.4.0-nofiles");
  expect(cacheKeys({ ...identity, key: "custom-key" })).toEqual({ key: "custom-key", restoreKeys: [] });
  expect(cacheKeys({ ...identity, restoreKeys: "first-\n\nsecond-\n" }).restoreKeys).toEqual(["first-", "second-"]);
  for (const key of ["with,comma", "with space", "x".repeat(513)]) expect(() => cacheKeys({ ...identity, key })).toThrow("Invalid build Action cache-key");
  expect(() => cacheKeys({ ...identity, restoreKeys: "bad,prefix" })).toThrow("cache-restore-keys");
  expect(() => cacheKeys({ ...identity, version: "" })).toThrow("bunko version");
  expect(() => cacheKeys({ ...identity, os: "Linux Runner" })).toThrow("operating system");
});

test("step outputs survive a round trip for multi-line paths and restore keys", () => {
  const plan = cachePlan({ cache: "github", root: "/cache/bunko", cacheDir: "/tmp/layers", ...identity, restoreKeys: "first-\nsecond-" });
  const outputs = cacheOutputs(plan);
  expect(outputs).toEqual({ enabled: "true", path: "/cache/bunko\n/tmp/layers", key: "bunko-Linux-X64-0.4.0-abc123", "restore-keys": "first-\nsecond-" });
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
  const root = await temporary(), output = join(root, "outputs"), layers = join(root, "layers"), bin = join(root, "bin"), environmentLayers = join(root, "env-layers");
  await mkdir(bin);
  await writeFile(join(bin, "bunko"), "#!/bin/sh\necho 9.9.9-test\n", { mode: 0o755 });
  const old = { GITHUB_OUTPUT: process.env.GITHUB_OUTPUT, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, PATH: process.env.PATH, BUNKO_CACHE_DIR: process.env.BUNKO_CACHE_DIR };
  Object.assign(process.env, { GITHUB_OUTPUT: output, XDG_CACHE_HOME: join(root, "xdg"), PATH: `${bin}:${process.env.PATH ?? ""}` });
  try {
    // cache: none writes inert outputs, creates nothing and never consults the CLI.
    expect(await runCachePlan({ cache: "none", cacheDir: layers })).toEqual({ enabled: false, paths: [], key: "", restoreKeys: [] });
    expect(await readFile(output, "utf8")).toBe("enabled=false\npath=\nkey=\nrestore-keys=\n");
    await rm(output);
    const plan = await runCachePlan({ cache: "github", cacheDir: layers, os: "Linux", arch: "X64", hash: "abc123" });
    expect(plan).toEqual({ enabled: true, paths: [join(root, "xdg", "bunko"), layers], key: "bunko-Linux-X64-9.9.9-test-abc123", restoreKeys: ["bunko-Linux-X64-9.9.9-test-"] });
    for (const path of plan.paths) expect((await stat(path)).isDirectory()).toBe(true);
    expect(parseOutputs(await readFile(output, "utf8"))).toEqual({ enabled: "true", path: plan.paths.join("\n"), key: plan.key, "restore-keys": plan.restoreKeys.join("\n") });
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
