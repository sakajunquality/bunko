import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyDocuments } from "../packages/bunko/apply.ts";
import { build } from "../packages/bunko/build.ts";
import { project } from "./helpers.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-local-resolve-")), name = `bunko-${randomUUID().slice(0, 8)}`;
const kubeconfig = join(directory, "kubeconfig"), previous = process.env.KUBECONFIG;
let created = false;
try {
  const source = await project(join(directory, "source"), {}, 'console.log("local image verified"); setInterval(() => {}, 1000);');
  const baseLayout = join(directory, "base");
  await build({ path: source, output: baseLayout, push: false, platform: "linux/arm64", localCache: false });
  created = true;
  await command(["kind", "create", "cluster", "--name", name, "--kubeconfig", kubeconfig, "--wait", "120s"]);
  process.env.KUBECONFIG = kubeconfig;
  const manifest = join(directory, "pod.yaml");
  await writeFile(manifest, 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: local-test\n  labels: {app: smoke}\nspec:\n  containers:\n    - name: app\n      image: bunko://./source\n      imagePullPolicy: Never\n');
  const result = await applyDocuments({ files: [manifest], context: directory, kind: name, selector: "app=smoke", platform: "linux/arm64", baseLayout,
    localCache: false, registryCache: false, registry: { fetcher: async () => { throw new Error("Unexpected registry request during local resolution"); } } });
  if (result.exit) throw new Error(result.stderr);
  await command(["kubectl", "--context", `kind-${name}`, "wait", "--for=condition=Ready", "pod/local-test", "--timeout=90s"]);
  const log = await command(["kubectl", "--context", `kind-${name}`, "logs", "local-test"]);
  if (!log.includes("local image verified")) throw new Error("Local image did not run");
  console.log(JSON.stringify({ result: "PASS", registryRequestsDuringResolve: 0, platform: "linux/arm64", kindApply: true }));
} finally {
  if (created) await command(["kind", "delete", "cluster", "--name", name, "--kubeconfig", kubeconfig]).catch(() => {});
  if (previous === undefined) delete process.env.KUBECONFIG; else process.env.KUBECONFIG = previous;
  await rm(directory, { recursive: true, force: true });
}
