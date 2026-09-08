/** Execute an explicit benchmark matrix. Commands are argv arrays, never shell
 * strings. Use disposable builders/caches; setup is outside measured time. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeReport } from "../packages/bunko/build.ts";

interface Command { argv: string[]; cwd?: string }
interface Case { name: string; setup?: Command[]; builders: Record<string, Command> }
interface Matrix { baseline: Record<string, unknown>; repetitions: number; cases: Case[] }
const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw Error("Usage: bun scripts/compare-builders.ts MATRIX.json OUTPUT.json");
const matrix = JSON.parse(await readFile(input, "utf8")) as Matrix;
if (!Number.isSafeInteger(matrix.repetitions) || matrix.repetitions < 3 || matrix.repetitions > 30 || !Array.isArray(matrix.cases)) throw Error("Use 3–30 repetitions and an explicit case matrix");
async function run(command: Command) {
  if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some((arg) => typeof arg !== "string")) throw Error("Commands require argv arrays");
  const started = performance.now();
  const child = Bun.spawn(command.argv, { cwd: command.cwd, stdout: "ignore", stderr: "inherit" });
  if (await child.exited) throw Error("Benchmark command failed; no success report written");
  return { milliseconds: performance.now() - started, clientResourceUsage: child.resourceUsage() };
}
const samples: { scenario: string; builder: string; repetition: number; milliseconds: number; clientResourceUsage?: Bun.ResourceUsage }[] = [];
for (let repetition = 0; repetition < matrix.repetitions; repetition++) {
  for (const scenario of matrix.cases) {
    for (const command of scenario.setup ?? []) await run(command);
    const builders = Object.entries(scenario.builders);
    if (repetition % 2) builders.reverse();
    for (const [builder, command] of builders) samples.push({ scenario: scenario.name, builder, repetition, ...await run(command) });
  }
}
const groups = new Map<string, number[]>();
for (const sample of samples) { const key = `${sample.scenario}/${sample.builder}`; groups.set(key, [...groups.get(key) ?? [], sample.milliseconds]); }
const summary = Object.fromEntries([...groups].map(([name, values]) => {
  values.sort((a, b) => a - b); const middle = Math.floor(values.length / 2);
  return [name, { medianMs: values.length % 2 ? values[middle] : (values[middle - 1]! + values[middle]!) / 2, minMs: values[0], maxMs: values.at(-1) }];
}));
await writeReport(resolve(output), { schemaVersion: 1, baseline: matrix.baseline, host: { os: process.platform, architecture: process.arch, bun: Bun.version },
  limits: ["Resource usage is for the client process, not BuildKit workers or total system usage", "Payload, metadata and wire traffic require independent registry instrumentation; this runner does not infer them from logs"], samples, summary });
