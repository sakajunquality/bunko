import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRuntimeArgs } from "../packages/bunko/runtime-args.ts";

test("compile arguments reject ambiguous or source-only flags", () => {
  expect(compileRuntimeArgs(["--smol", "--cpu-prof-dir=/tmp"])).toEqual(["--smol", "--cpu-prof-dir=/tmp"]);
  for (const args of [["--watch"], ["--preload=./hook.js"], ["--title=two words"], ["--title='quoted'"]]) expect(() => compileRuntimeArgs(args)).toThrow("Compile runtime.args");
});

test("supported Bun embeds runtime arguments separately from application argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-compile-args-"));
  try {
    const source = join(root, "app.ts"), executable = join(root, "app");
    await writeFile(source, 'console.log(JSON.stringify({exec:process.execArgv,args:process.argv.slice(2)}));');
    const build = Bun.spawn([process.execPath, "build", source, "--compile", "--compile-exec-argv=--smol --no-install", `--outfile=${executable}`], { stdout: "ignore", stderr: "pipe" });
    const error = await new Response(build.stderr).text(); if (await build.exited) throw new Error(error);
    const child = Bun.spawn([executable, "app-value"], { stdout: "pipe", stderr: "pipe" });
    const value = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0); expect(value.exec).toContain("--smol"); expect(value.exec).toContain("--no-install"); expect(value.args).toEqual(["app-value"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
