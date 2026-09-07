import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryName } from "../oci/publish.ts";
import { BlobStore } from "../oci/blob-store.ts";
import { dockerCredentials } from "../oci/credentials.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../oci/source.ts";
import { platform, type BuildOptions } from "./config.ts";
import { selectToolchain } from "./toolchain.ts";

export async function checkBase(options: Pick<BuildOptions, "base" | "baseLayout" | "platform" | "registry" | "bunPath"> & { run?: boolean; runtimePath?: string }) {
  if (options.base && options.baseLayout) throw new Error("Select --base or --base-layout");
  if (options.run && options.baseLayout) throw new Error("Runtime base checks require a registry base reference");
  if (options.run && !Bun.which("docker")) throw new Error("Runtime base checks require Docker");
  const toolchain = await selectToolchain(options.bunPath);
  const reference = options.base ?? `oven/bun:${toolchain.version}-distroless`;
  const source = options.baseLayout ? new LayoutSource(resolve(options.baseLayout)) : new RegistrySource(reference,
    { ...options.registry, credentials: options.registry?.credentials ?? dockerCredentials() });
  const pinned = await source.root();
  const directory = await mkdtemp(join(tmpdir(), "bunko-check-base-"));
  try {
    const results = [];
    for (const value of (options.platform ?? "linux/amd64").split(",")) {
      const selected = platform(value.trim());
      const base = await resolveBase({ root: async () => pinned, blob: source.blob.bind(source) }, selected, new BlobStore(directory), true);
      let runtimeRevision: string | undefined;
      if (options.run && source instanceof RegistrySource) {
        const image = `${repositoryName(source.ref)}@${base.descriptor.digest}`;
        const pull = Bun.spawn(["docker", "pull", "--platform", `${selected.os}/${selected.architecture}`, image], { stdout: "ignore", stderr: "ignore" });
        if (await pull.exited) throw new Error("Docker could not pull the pinned base for runtime verification");
        const container = `bunko-check-${randomUUID()}`;
        const child = Bun.spawn(["docker", "run", "--name", container, "--rm", "--pull=never", "--platform", `${selected.os}/${selected.architecture}`,
          "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m",
          "--user=65532:65532", "--entrypoint", options.runtimePath ?? "/usr/local/bin/bun", image, "--revision"],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        const timer = setTimeout(() => child.kill(), 30_000);
        try {
          const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          if (code || text.trim() !== `${toolchain.version}+${toolchain.revision}`) throw new Error("Base Bun runtime does not match the selected toolchain or cannot run as nonroot/read-only");
          runtimeRevision = text.trim();
        } finally {
          clearTimeout(timer);
          const cleanup = Bun.spawn(["docker", "rm", "--force", container], { stdout: "ignore", stderr: "ignore" });
          await cleanup.exited;
        }
      }
      results.push({ platform: selected, digest: base.descriptor.digest, user: base.config.config?.User ?? "",
        layers: base.manifest.layers.length, runtimeVerified: Boolean(runtimeRevision), runtimeRevision });
    }
    return { schemaVersion: 1, indexDigest: pinned.descriptor.digest, toolchain: { version: toolchain.version, revision: toolchain.revision }, platforms: results };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
