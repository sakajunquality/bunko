import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn, cleanupSpawn } from "../runtime/invocation.ts";
import { exportDockerArchive } from "../oci/archive.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { Descriptor, Platform } from "../oci/types.ts";

export function smokeArguments(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 || value.some((v) => typeof v !== "string" || !v || v.length > 4096 || /[\x00\r\n]/.test(v)) || !value[0].startsWith("/")) throw new Error("--smoke-command must be a JSON argv array starting with an absolute container executable");
}
async function command(args: string[], stage: string, timeoutMs: number, cleanup = false): Promise<void> {
  const child = (cleanup ? cleanupSpawn : spawn)([Bun.which(args[0]!, { PATH: process.env.PATH }) ?? args[0]!, ...args.slice(1)], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeoutMs);
  try { const code = await child.exited; if (code || expired || child.signalCode) throw new Error(`Rebase smoke ${stage} ${expired ? `timed out after ${timeoutMs / 1000}s` : child.signalCode ? `terminated by ${child.signalCode}` : `failed (exit ${code})`}`); }
  finally { clearTimeout(timer); }
}
/** Check the engine before any source fetch or publication. Dry runs do not need Docker. */
export async function preflightRebaseSmoke(): Promise<void> {
  if (!Bun.which("docker", { PATH: process.env.PATH })) throw new Error("Rebase smoke requires Docker");
  await command(["docker", "info", "--format", "{{.ServerVersion}}"], "Docker preflight", 10_000);
}
/** Commands execute only inside the candidate container, never through a host shell. */
export async function smokeRebase(store: BlobStore, images: { manifest: Descriptor; platform: Platform }[], argv: string[], temporary: string, loadTimeoutSeconds = 300): Promise<void> {
  smokeArguments(argv);
  if (!Bun.which("docker", { PATH: process.env.PATH })) throw new Error("Rebase smoke requires Docker");
  for (const image of images) {
    const id = randomUUID(), reference = `bunko.local/rebase-smoke:${id}`, container = `bunko-rebase-${id}`;
    const platform = `${image.platform.os}/${image.platform.architecture}`;
    const archive = join(temporary, `smoke-${image.platform.architecture}.tar`);
    await exportDockerArchive(store, image.manifest, archive, reference, 0);
    try {
      await command(["docker", "load", "--input", archive], `${platform} load`, loadTimeoutSeconds * 1000);
      await command(["docker", "run", "--rm", "--name", container, "--pull=never", "--platform", `${image.platform.os}/${image.platform.architecture}`, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--network=none", "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m", "--entrypoint", argv[0]!, reference, ...argv.slice(1)], `${platform} run`, 60_000);
    } finally {
      for (const args of [["docker", "rm", "--force", container], ["docker", "image", "rm", reference]]) try { await command(args, `${platform} cleanup`, 10_000, true); } catch { /* Preserve the acceptance result; resources have unique names. */ }
    }
  }
}
