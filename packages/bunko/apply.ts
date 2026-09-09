import { referenceOutput } from "./references.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDocuments, type ResolveOptions } from "./resolve.ts";
import { assertReportWritable, writeReport } from "./build.ts";
import { canonicalOutput } from "../oci/layout.ts";

export interface ApplyOptions extends ResolveOptions {
  kubectlPath?: string; kubeContext?: string; namespace?: string; serverSide?: boolean;
  fieldManager?: string; kubeDryRun?: "none" | "client" | "server";
}

/** Resolve and publish all targets before starting kubectl. Kubernetes itself
 * does not provide an atomic multi-resource apply transaction. */
export async function applyDocuments(options: ApplyOptions): Promise<{ exit: number; stdout: string; stderr: string }> {
  if (options.local) throw new Error("apply requires --kind for local cluster loading; use resolve --local for Docker");
  if (options.kind) {
    const context = `kind-${options.kind}`;
    if (options.kubeContext && options.kubeContext !== context) throw new Error("--kube-context must match the selected kind cluster");
    options = { ...options, kubeContext: context };
  }
  await referenceOutput(options.imageRefs, [options.report]);
  const kubectl = Bun.which(options.kubectlPath ?? "kubectl");
  if (!kubectl) throw new Error("apply requires kubectl on PATH or --kubectl-path");
  if (options.kubeDryRun !== undefined && !["none", "client", "server"].includes(options.kubeDryRun)) throw new Error("--kube-dry-run must be none, client or server");
  const report = options.report ? await canonicalOutput(options.report) : undefined;
  if (report) await assertReportWritable(report);
  const written = new Set<string>();
  const temporary = await mkdtemp(join(tmpdir(), "bunko-apply-report-"));
  const resolutionReport = join(temporary, "resolve.json");
  let phase = "resolve";
  let resolution: unknown;
  try {
    const resolved = await resolveDocuments({ ...options, report: resolutionReport });
    resolution = JSON.parse(await readFile(resolutionReport, "utf8")); phase = "apply";
    if (!resolved.output.trim()) {
      if (report) await writeReport(report, { schemaVersion: 5, command: "apply", status: "success", phase: "skipped", exit: 0, resolution }, written);
      return { exit: 0, stdout: "", stderr: "" };
    }
    const args = [kubectl, "apply", "-f", "-"];
    for (const [flag, value] of [["--context", options.kubeContext], ["--namespace", options.namespace], ["--field-manager", options.fieldManager]]) if (value !== undefined) args.push(flag!, value);
    if (options.serverSide) args.push("--server-side");
    if (options.kubeDryRun) args.push(`--dry-run=${options.kubeDryRun}`);
    const child = Bun.spawn(args, { env: process.env, stdin: new Blob([resolved.output]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (report) {
      try { await writeReport(report, { schemaVersion: 5, command: "apply", status: exit === 0 ? "success" : "failed", phase, exit, resolution }, written); }
      catch { return { exit: exit || 1, stdout, stderr: `${stderr}bunko: Could not write apply report; kubectl output is preserved\n` }; }
    }
    return { exit, stdout, stderr };
  } catch (error) {
    if (await Bun.file(resolutionReport).exists()) resolution = JSON.parse(await readFile(resolutionReport, "utf8"));
    if (report && !written.has(report)) await writeReport(report, { schemaVersion: 5, command: "apply", status: "failed", phase, resolution, error: error instanceof Error ? error.message : "Apply failed" });
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
