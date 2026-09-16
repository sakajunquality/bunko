import { appendFile, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function rebaseArguments(inputs: Record<string, string | undefined>, report: string): string[] {
  for (const key of ["image", "old-base", "base"]) if (!inputs[key]) throw new Error(`Rebase Action requires ${key}`);
  if (!["true", "false", undefined, ""].includes(inputs["dry-run"])) throw new Error("dry-run must be true or false");
  if (inputs["tag-conflict"] && !["fail", "skip"].includes(inputs["tag-conflict"])) throw new Error("tag-conflict must be fail or skip");
  if (inputs.sign && !["none", "key", "keyless"].includes(inputs.sign)) throw new Error("sign must be none, key or keyless");
  const args = ["rebase", inputs.image!, "--old-base", inputs["old-base"]!, "--base", inputs.base!, "--report", report, "--tag-conflict", inputs["tag-conflict"] || "fail"];
  const dry = inputs["dry-run"] !== "false";
  if (dry) args.push("--dry-run");
  else if (!inputs.repo) throw new Error("Rebase Action requires repo for publication");
  for (const [name, flag] of [["repo", "repo"], ["platforms", "platform"], ["policy", "compatibility-policy"], ["sign-key", "sign-key"], ["smoke-command", "smoke-command"]]) if (inputs[name!] && (name !== "sign-key" || !dry)) args.push(`--${flag}`, inputs[name!]!);
  if (!dry && !inputs["smoke-command"]) throw new Error("Rebase Action requires an explicit smoke-command before publication");
  if (!dry) {
    if (inputs.sign && inputs.sign !== "none") args.push("--sign", inputs.sign);
    if (inputs["sigstore-config"]) args.push("--sigstore-config", inputs["sigstore-config"]);
  }
  if (inputs.repo) for (const tag of (inputs.tags ?? "").split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) args.push("--tag", tag);
  return args;
}
export function rebaseOutputs(result: any, code: number, dry: boolean) {
  if (!["compatible", "requires-policy", "requires-rebuild", "error"].includes(result?.decision)) return { decision: "error", digest: "", reference: "", "candidate-reference": "", tags: "[]", "skipped-tags": "[]", "pending-tags": "[]" };
  const skipped = result.publication?.skippedTags ?? [], pending = result.publication?.pendingTags ?? [];
  const accepted = !dry && code === 0 && result.status === "success" && result.smoke === "passed" && !skipped.length && !pending.length;
  return { decision: result.decision, digest: result.root?.digest ?? "", reference: accepted ? result.publication?.reference ?? "" : "", "candidate-reference": result.publication?.reference ?? "", tags: JSON.stringify(result.publication?.tags ?? []), "skipped-tags": JSON.stringify(skipped), "pending-tags": JSON.stringify(pending) };
}
if (import.meta.main) {
  const root = await mkdtemp(join(tmpdir(), "bunko-rebase-action-")), report = join(root, "report.json");
  const inputs = Object.fromEntries(["image", "old-base", "base", "repo", "platforms", "policy", "sign", "sigstore-config", "sign-key", "smoke-command", "tags", "tag-conflict", "dry-run", "report"].map((name) => [name, process.env[`BUNKO_INPUT_${name.replaceAll("-", "_").toUpperCase()}`]]));
  let copied = false;
  let result: any = { schemaVersion: 1, command: "rebase", status: "failed", decision: "error" }, code = 1;
  const destination = inputs.report ? resolve(inputs.report) : report;
  try {
    if (/[\r\n]/.test(destination)) throw new Error("Invalid report path");
    if (destination !== report) {
      try { await lstat(destination); throw new Error("Action report destination must be absent"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const child = Bun.spawn(["bunko", ...rebaseArguments(inputs, report)], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
    code = await child.exited;
    const file = Bun.file(report);
    if (file.size > 32 * 1024 * 1024) throw new Error("Rebase Action report exceeds limits");
    result = JSON.parse(await readFile(report, "utf8"));
    if (destination !== report) { await writeFile(destination, JSON.stringify(result), { flag: "wx", mode: 0o600 }); copied = true; }
  } catch { result = { schemaVersion: 1, command: "rebase", status: "failed", decision: "error" }; code = 1; }
  if (!(await Bun.file(report).exists())) await writeFile(report, JSON.stringify(result), { mode: 0o600, flag: "wx" });
  const dry = inputs["dry-run"] !== "false", outputs = rebaseOutputs(result, code, dry);
  if (process.env.GITHUB_OUTPUT) for (const [name, value] of Object.entries({ ...outputs, report: copied ? destination : report })) {
    if (typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Invalid rebase Action output");
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Rebase decision: **${outputs.decision}**. Exit code: ${code}. Skipped tags: ${result.publication?.skippedTags?.length ?? 0}.\n`);
  process.exitCode = outputs.decision === "error" && code === 0 ? 1 : dry && [3, 4].includes(code) ? 0 : !dry && code === 0 && !outputs.reference ? 1 : code;
}
