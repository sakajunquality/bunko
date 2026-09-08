import { appendFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Inputs = Record<string, string | undefined>;
export interface ActionImage { target: string; digest: string; reference?: string }
const list = (value?: string) => (value ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false") throw new Error("Boolean build Action inputs must be true or false");
  return value === "true";
}
export function buildArguments(inputs: Inputs, root: string): { args: string[]; layout: string; report: string; references: string } {
  const push = boolean(inputs.push, false), report = join(root, "report.json"), references = push ? join(root, "references.txt") : "";
  if (push && !inputs.repo) throw new Error("The build Action requires repo when push is true");
  const layout = !push || boolean(inputs["export-layout"], false) ? join(root, "layout") : "";
  const args = ["build", resolve(inputs.path || "."), `--push=${push}`, "--report", report];
  if (layout) args.push("--oci-layout", layout);
  if (references) args.push("--image-refs", references);
  for (const [input, flag] of [["repo", "repo"], ["platforms", "platform"], ["mode", "mode"], ["base", "base"], ["base-layout", "base-layout"], ["cache-dir", "cache-dir"], ["cache-repo", "cache-repo"], ["runtime-inject", "runtime-inject"]]) {
    if (inputs[input!]) args.push(`--${flag}`, inputs[input!]!);
  }
  for (const [input, flag] of [["targets", "target"], ["tags", "tag"], ["cache-from", "cache-from"], ["asset-contexts", "asset-context"]]) for (const value of list(inputs[input!])) args.push(`--${flag}`, value);
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
    if (!item || typeof item !== "object" || typeof item.target !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.root?.digest)) throw new Error("Invalid build Action target result");
    const reference = item.publication?.published ? item.publication.reference : undefined;
    if (reference !== undefined && (typeof reference !== "string" || /\s/.test(reference) || !reference.endsWith(`@${item.root.digest}`))) throw new Error("Invalid published image reference");
    return { target: item.target, digest: item.root.digest, ...reference ? { reference } : {} };
  });
}
const escape = (value: string) => value.replace(/[&<>|`\r\n]/g, (c) => `&#${c.charCodeAt(0)};`);
export function buildSummary(images: ActionImage[]): string {
  return `## Bunko build\n\n| Target | Image digest | Published reference |\n| --- | --- | --- |\n${images.map((i) => `| ${escape(i.target)} | ${i.digest} | ${escape(i.reference ?? "Local OCI layout")} |`).join("\n")}\n`;
}

export async function runBuildAction(inputs: Inputs): Promise<void> {
  const executable = Bun.which("bunko", { PATH: process.env.PATH }); if (!executable) throw new Error("Install bunko with the setup Action before the build Action");
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "bunko-action-"));
  if (/[\r\n]/.test(root)) throw new Error("Invalid Action temporary directory");
  const invocation = buildArguments(inputs, root);
  const outputs: Record<string, string> = { report: invocation.report };
  try {
    // Arguments are passed directly without shell interpolation or command echoing.
    const child = Bun.spawn([executable, ...invocation.args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code) throw new Error(`Bunko build failed (exit ${code}); inspect the report when present`);
    if ((await stat(invocation.report)).size > 32 * 1024 * 1024) throw new Error("Build Action report exceeds size limit");
    const images = imageResults(await Bun.file(invocation.report).json());
    const serialized = JSON.stringify(images);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error("Build Action results exceed the output limit; use the report file");
    Object.assign(outputs, { images: serialized, digest: images.length === 1 ? images[0]!.digest : "", reference: images.length === 1 ? images[0]!.reference ?? "" : "", layout: invocation.layout, "image-refs": invocation.references });
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, buildSummary(images));
  } finally {
    // Preserve reports and layouts for subsequent upload-artifact steps, including failures.
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}
if (import.meta.main) {
  const inputs = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BUNKO_INPUT_")).map(([name, value]) => [name.slice(12).toLowerCase().replaceAll("_", "-"), value]));
  await runBuildAction(inputs);
}
