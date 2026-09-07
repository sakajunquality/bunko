/** Measure the existing pre-bundle guard without executing dependency code. */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rejectMacros } from "../packages/bunko/files.ts";

const directory = resolve(process.argv[2] ?? "node_modules");
const repetitions = Number(process.argv[3] ?? 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("Use 1 to 20 repetitions");
if (!(await stat(directory)).isDirectory()) throw new Error("Expected a dependency directory");
const start = performance.now();
const files = (await Array.fromAsync(new Bun.Glob("**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scan({ cwd: directory, dot: true, followSymlinks: false }))).sort();
const discoveryMs = performance.now() - start;
let bytes = 0;
for (const file of files) bytes += (await stat(join(directory, file))).size;
const typescript = files.find((file) => file === "typescript/lib/typescript.js");
const typescriptReadAndParseMs: number[] = [], treeReadAndParseMs: number[] = [];
for (let i = 0; i < repetitions; i++) {
  if (typescript) {
    const before = performance.now();
    await rejectMacros(join(directory, typescript), typescript);
    typescriptReadAndParseMs.push(performance.now() - before);
  }
  const before = performance.now();
  for (const file of files) await rejectMacros(join(directory, file), file);
  treeReadAndParseMs.push(performance.now() - before);
}
console.log(JSON.stringify({ bun: Bun.version, platform: process.platform, architecture: process.arch,
  files: files.length, bytes, repetitions, discoveryMs, typescriptReadAndParseMs, treeReadAndParseMs }, null, 2));
