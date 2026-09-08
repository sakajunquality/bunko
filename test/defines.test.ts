import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDefines } from "../packages/bunko/defines.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { build } from "../packages/bunko/build.ts";
import { checkConfig } from "../packages/bunko/diagnostics.ts";
import { baseLayout, cli, project, temporary } from "./helpers.ts";
import { runImage } from "./run-image.ts";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }

test("defines require explicit values, retain equals signs and reject duplicate or malformed keys without echoing values", () => {
  expect(parseDefines(['BUILD_VERSION="1=2"', "process.env.DEBUG=false"])).toEqual({ BUILD_VERSION: '"1=2"', "process.env.DEBUG": "false" });
  for (const value of ["MISSING", "EMPTY=", "bad key=private-value", "=private-value"]) {
    expect(() => parseDefines([value])).toThrow("requires KEY=VALUE");
    try { parseDefines([value]); } catch (error) { expect(String(error)).not.toContain("private-value"); }
  }
  expect(() => parseDefines(["SAME=1", "SAME=2"])).toThrow("Duplicate");
  expect(Object.hasOwn(parseDefines(["__proto__=null"]), "__proto__")).toBe(true);
});

test("invocation defines override package values and invalidate application cache without entering reports", async () => {
  const root = await fixture(), source = await project(join(root, "source"), { bunko: { build: { define: { BUILD_CONSTANT: '"package-value"', OTHER: "false" } } } }, "console.log(BUILD_CONSTANT);");
  const base = await baseLayout(join(root, "base")), define = { BUILD_CONSTANT: '"invocation-value"' };
  const selected = await loadProject({ path: source, define }); expect(selected.build.define).toEqual({ ...define, OTHER: "false" });
  expect(JSON.stringify(await checkConfig({ path: source, define }))).not.toContain("invocation-value");
  const options = { path: source, baseLayout: base, define, push: false, gitMetadata: false, cacheDir: join(root, "cache"), registryCache: false };
  const first = await build({ ...options, output: join(root, "first") });
  expect(await runImage(first, join(root, "run-first"))).toBe("invocation-value");
  expect(JSON.stringify(first)).not.toContain("invocation-value");
  const warm = await build({ ...options, output: join(root, "warm") });
  expect(warm.root.digest).toBe(first.root.digest); expect(warm.cache.find((c) => c.kind === "app")!.status).toBe("local");
  const changed = await build({ ...options, define: { BUILD_CONSTANT: '"changed-value"' }, output: join(root, "changed") });
  expect(changed.cache.find((c) => c.kind === "app")!.status).toBe("miss"); expect(changed.root.digest).not.toBe(first.root.digest);
  expect(await runImage(changed, join(root, "run-changed"))).toBe("changed-value");
});

test("CLI exposes define keys in offline diagnostics and rejects ignored define flags", async () => {
  const root = await fixture(), source = await project(join(root, "source"));
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "check-config", source, "--define", 'BUILD_CONSTANT="private-value"'], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const result = { stdout, stderr, exit };
  expect(result.exit).toBe(0); expect(JSON.parse(result.stdout).targets[0].defineKeys).toEqual(["BUILD_CONSTANT"]);
  expect(result.stdout + result.stderr).not.toContain("private-value");
  expect((await cli(["cache-info", "--define", "KEY=1"])).exit).toBe(1);
});
