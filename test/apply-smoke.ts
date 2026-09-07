import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyDocuments } from "../packages/bunko/apply.ts";
import { command } from "./command.ts";

const kind = process.env.BUNKO_KIND_PATH ?? Bun.which("kind");
if (!kind) throw new Error("Set BUNKO_KIND_PATH or install kind for the disposable apply test");
const directory = await mkdtemp(join(tmpdir(), "bunko-apply-smoke-"));
const name = `bunko-${randomUUID().slice(0, 8)}`, kubeconfig = join(directory, "kubeconfig");
let started = false;
const previous = process.env.KUBECONFIG;
try {
  started = true;
  await command([kind, "create", "cluster", "--name", name, "--kubeconfig", kubeconfig, "--wait", "120s"]);
  process.env.KUBECONFIG = kubeconfig;
  const manifest = join(directory, "config.yaml");
  await writeFile(manifest, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: bunko-apply-test\ndata:\n  message: verified\n");
  for (const kubeDryRun of ["server", "none"] as const) {
    const result = await applyDocuments({ files: [manifest], context: directory, kubeContext: `kind-${name}`, serverSide: true, kubeDryRun });
    if (result.exit) throw new Error(result.stderr);
  }
  const result = JSON.parse(await command(["kubectl", "--context", `kind-${name}`, "get", "configmap", "bunko-apply-test", "-o", "json"]));
  if (result.data.message !== "verified") throw new Error("Applied ConfigMap content mismatch");
  console.log("PASS: server dry-run and apply succeeded only in the disposable kind cluster");
} finally {
  if (started) await command([kind, "delete", "cluster", "--name", name, "--kubeconfig", kubeconfig]);
  if (previous === undefined) delete process.env.KUBECONFIG; else process.env.KUBECONFIG = previous;
  await rm(directory, { recursive: true, force: true });
}
