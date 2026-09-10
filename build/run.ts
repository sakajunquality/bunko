import { appendFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { escape, fitSummary, renderSummary, summaryBytes, summaryNote } from "./summary.ts";

type Inputs = Record<string, string | undefined>;
export interface ActionImage { target: string; digest: string; reference?: string }
const list = (value?: string) => (value ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false") throw new Error("Boolean build Action inputs must be true or false");
  return value === "true";
}
export function buildArguments(inputs: Inputs, root: string): { args: string[]; layout: string; report: string; references: string } {
  // An explicit report input keeps the report at a workflow-chosen path; the default stays in the Action temporary directory and the output reports whichever path was used.
  const push = boolean(inputs.push, false), report = inputs.report ? resolve(inputs.report) : join(root, "report.json"), references = push ? join(root, "references.txt") : "";
  if (/[\r\n]/.test(report)) throw new Error("Build Action report paths cannot contain line breaks");
  if (push && !inputs.repo) throw new Error("The build Action requires repo when push is true");
  const layout = !push || boolean(inputs["export-layout"], false) ? join(root, "layout") : "";
  const args = ["build", resolve(inputs.path || "."), `--push=${push}`, "--report", report];
  if (layout) args.push("--oci-layout", layout);
  if (references) args.push("--image-refs", references);
  if (boolean(inputs.bare, false)) args.push("--bare");
  for (const [input, flag] of [["repo", "repo"], ["platforms", "platform"], ["mode", "mode"], ["base", "base"], ["base-layout", "base-layout"], ["cache-dir", "cache-dir"], ["cache-repo", "cache-repo"], ["cache-export-error", "cache-export-error"], ["runtime-inject", "runtime-inject"], ["registry-config", "registry-config"], ["install-cache", "install-cache"], ["image-user", "image-user"]]) {
    if (inputs[input!]) args.push(`--${flag}`, inputs[input!]!);
  }
  for (const [input, flag] of [["targets", "target"], ["tags", "tag"], ["cache-from", "cache-from"], ["cache-to", "cache-to"], ["asset-contexts", "asset-context"], ["registry-mirrors", "registry-mirror"]]) for (const value of list(inputs[input!])) args.push(`--${flag}`, value);
  args.push(`--otel=${boolean(inputs.otel, false)}`, `--cache-write=${boolean(inputs["cache-write"], true)}`);
  return { args, layout, report, references };
}

export function imageResults(report: unknown): ActionImage[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Invalid build Action report");
  const record = report as Record<string, unknown>;
  if (record.status !== undefined && record.status !== "success") throw new Error("Build Action report describes a failed build");
  const targets = Array.isArray(record.targets) ? record.targets : [record];
  if (!targets.length) throw new Error("Build Action report has no targets");
  return targets.map((item) => {
    if (!item || typeof item !== "object" || typeof item.target !== "string" || !item.target || typeof item.root?.digest !== "string" || item.root.digest.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(item.root?.digest)) throw new Error("Invalid build Action target result");
    const reference = item.publication?.published ? item.publication.reference : undefined;
    if (reference !== undefined && (typeof reference !== "string" || /\s/.test(reference) || !reference.endsWith(`@${item.root.digest}`))) throw new Error("Invalid published image reference");
    return { target: item.target, digest: item.root.digest, ...reference ? { reference } : {} };
  });
}
export function buildSummary(images: ActionImage[]): string {
  return `## Bunko build\n\n| Target | Image digest | Published reference |\n| --- | --- | --- |\n${images.slice(0, 50).map((i) => `| ${escape(i.target)} | ${i.digest} | ${escape(i.reference ?? "Local OCI layout")} |`).join("\n")}\n${images.length > 50 ? `\n${images.length - 50} more image rows omitted.\n` : ""}`;
}

/** The job summary is diagnostic output: a step summary that cannot be written, or a report that
 * cannot be read, never changes the result of the build. Returns the bytes actually appended. */
async function appendSummary(destination: string, text: string): Promise<number> {
  try {
    const existing = await stat(destination).catch((error) => { if (error.code === "ENOENT") return { size: 0 }; throw error; });
    const fitted = fitSummary(text.split("\n"), Math.max(0, summaryBytes - existing.size));
    if (fitted) await appendFile(destination, fitted);
    return Buffer.byteLength(fitted);
  }
  catch (error) { process.stderr.write(`Bunko build Action could not write the job summary: ${error instanceof Error ? error.message : String(error)}\n`); return 0; }
}

/** Render the report into the step summary within `budget` bytes; GitHub rejects a step summary
 * over 1 MiB, and report strings are long enough to reach that on their own. */
export async function appendReportSummary(destination: string, report: string, budget = summaryBytes): Promise<void> {
  let section: string;
  try {
    section = (await stat(report)).size > 32 * 1024 * 1024
      ? summaryNote("The build report is too large to summarize; download the report artifact instead.")
      : renderSummary(await Bun.file(report).json(), Math.max(budget, 0));
  } catch {
    section = summaryNote("No readable build report was available for this summary.");
  }
  // A leading blank line keeps the section separate from anything the job already appended.
  await appendSummary(destination, `\n${section}`);
}

export async function runBuildAction(inputs: Inputs): Promise<void> {
  const executable = Bun.which("bunko", { PATH: process.env.PATH }); if (!executable) throw new Error("Install bunko with the setup Action before the build Action");
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "bunko-action-"));
  if (/[\r\n]/.test(root)) throw new Error("Invalid Action temporary directory");
  const invocation = buildArguments(inputs, root);
  const summary = boolean(inputs.summary, true);
  const outputs: Record<string, string> = { report: invocation.report };
  let appended = 0, failure: unknown;
  try {
    // Arguments are passed directly without shell interpolation or command echoing.
    const child = Bun.spawn([executable, ...invocation.args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0 || child.signalCode) throw new Error(`Bunko build failed (exit ${code}); inspect the report when present`);
    if ((await stat(invocation.report)).size > 32 * 1024 * 1024) throw new Error("Build Action report exceeds size limit");
    const images = imageResults(await Bun.file(invocation.report).json());
    const serialized = JSON.stringify(images);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error("Build Action results exceed the output limit; use the report file");
    Object.assign(outputs, { images: serialized, digest: images.length === 1 ? images[0]!.digest : "", reference: images.length === 1 ? images[0]!.reference ?? "" : "", layout: invocation.layout, "image-refs": invocation.references });
    if (summary && process.env.GITHUB_STEP_SUMMARY) appended = await appendSummary(process.env.GITHUB_STEP_SUMMARY, buildSummary(images));
  } catch (error) { failure = error; }
  // Preserve reports and layouts for subsequent upload-artifact steps, including failures. An output
  // write that fails on its own is the result of the step; it must not replace a build failure.
  try { if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join("")); }
  catch (error) {
    if (failure) process.stderr.write(`Bunko build Action could not write step outputs: ${error instanceof Error ? error.message : String(error)}\n`);
    else failure = error;
  }
  // Where the time went is most useful exactly when the build failed, so the section is written either way.
  if (summary && process.env.GITHUB_STEP_SUMMARY) await appendReportSummary(process.env.GITHUB_STEP_SUMMARY, invocation.report, summaryBytes - appended);
  if (failure) throw failure;
}
if (import.meta.main) {
  const inputs = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BUNKO_INPUT_")).map(([name, value]) => [name.slice(12).toLowerCase().replaceAll("_", "-"), value]));
  await runBuildAction(inputs);
}
