import { baseCapabilities } from "./base-capabilities.ts";
import type { NativeBinary } from "./deps.ts";
import { downloadRuntime, type InjectedRuntime } from "./runtime-download.ts";
import { baseFilesystem, injectedLayer } from "./runtime-layer.ts";
import { assembleImage } from "../oci/image.ts";
import { exportDockerArchive } from "../oci/archive.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryName } from "../oci/publish.ts";
import { BlobStore } from "../oci/blob-store.ts";
import { dockerCredentials } from "../oci/credentials.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../oci/source.ts";
import { platform, type BuildOptions } from "./config.ts";
import { selectToolchain } from "./toolchain.ts";

export async function checkBase(options: Pick<BuildOptions, "base" | "baseLayout" | "platform" | "registry" | "bunPath" | "runtimeInject" | "runtimeCache" | "log"> & { run?: boolean; runtimePath?: string; requirementsReport?: string }) {
  if (options.base && options.baseLayout) throw new Error("Select --base or --base-layout");
  if (options.runtimeInject !== undefined && options.runtimeInject !== "release") throw new Error("runtime injection must be release");
  if (options.runtimeInject && !options.base && !options.baseLayout) throw new Error("Runtime injection requires an explicit base or base layout");
  if (options.run && options.baseLayout && !options.runtimeInject) throw new Error("Runtime base checks require a registry base reference");
  if (options.run && !Bun.which("docker")) throw new Error("Runtime base checks require Docker");
  const toolchain = await selectToolchain(options.bunPath);
  const reference = options.base ?? `oven/bun:${toolchain.version}-distroless`;
  const source = options.baseLayout ? new LayoutSource(resolve(options.baseLayout)) : new RegistrySource(reference,
    { ...options.registry, credentials: options.registry?.credentials ?? dockerCredentials() });
  const requirements = options.requirementsReport ? await reportRequirements(options.requirementsReport) : undefined;
  const pinned = await source.root();
  const directory = await mkdtemp(join(tmpdir(), "bunko-check-base-"));
  try {
    const results = [];
    for (const value of (options.platform ?? "linux/amd64").split(",")) {
      const selected = platform(value.trim());
      const store = new BlobStore(directory);
      const base = await resolveBase({ root: async () => pinned, blob: source.blob.bind(source) }, selected, store, true);
      if (requirements && !requirements.has(selected.architecture)) throw new Error(`Requirements report has no ${selected.os}/${selected.architecture} image`);
      const tree = await baseFilesystem(store, base, directory);
      const capabilities = baseCapabilities(tree, base.config.config ?? {}, undefined, (requirements?.get(selected.architecture) ?? []));
      let runtimeRevision: string | undefined;
      let runtime: InjectedRuntime | undefined;
      let composed: string | undefined;
      try {
        if (options.runtimeInject) {
          const downloaded = await downloadRuntime(toolchain, selected, { cache: options.runtimeCache, log: options.log ?? ((message) => process.stderr.write(message)) });
          runtime = { ...downloaded.metadata, path: options.runtimePath ?? "/usr/local/bin/bun" };
          const injected = await injectedLayer(store, runtime, downloaded.executable, tree, 0);
          const image = await assembleImage(store, base, [injected.layer], { platform: selected, epoch: 0, entrypoint: [runtime.path], args: ["--revision"], workdir: "/", env: {}, labels: {}, user: "65532:65532" }, true);
          if (options.run) {
            composed = `bunko.local/runtime-check:${randomUUID()}`;
            const archive = join(directory, `runtime-${selected.architecture}.tar`);
            await exportDockerArchive(store, image.manifest, archive, composed, 0);
            const load = Bun.spawn(["docker", "load", "--input", archive], { stdout: "ignore", stderr: "ignore" });
            if (await load.exited) throw new Error("Docker could not load the composed runtime image");
          }
        }
        if (options.run && (composed || source instanceof RegistrySource)) {
          const image = composed ?? `${repositoryName((source as RegistrySource).ref)}@${base.descriptor.digest}`;
          if (!composed) {
            const pull = Bun.spawn(["docker", "pull", "--platform", `${selected.os}/${selected.architecture}`, image], { stdout: "ignore", stderr: "ignore" });
            if (await pull.exited) throw new Error("Docker could not pull the pinned base for runtime verification");
          }
          const container = `bunko-check-${randomUUID()}`;
          const child = Bun.spawn(["docker", "run", "--name", container, "--rm", "--pull=never", "--platform", `${selected.os}/${selected.architecture}`,
            "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m",
            "--user=65532:65532", "--entrypoint", options.runtimePath ?? "/usr/local/bin/bun", image, "--revision"],
          { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
          const timer = setTimeout(() => child.kill(), 30_000);
          try {
            const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
            if (code || text.trim() !== `${toolchain.version}+${toolchain.revision}`) throw new Error("Bun runtime execution failed or revision mismatched; check shared-library/symbol requirements, CPU, permissions and emulation (the loader path check alone is insufficient)");
            runtimeRevision = text.trim();
          } finally {
            clearTimeout(timer);
            const cleanup = Bun.spawn(["docker", "rm", "--force", container], { stdout: "ignore", stderr: "ignore" });
            await cleanup.exited;
          }
        }
        results.push({ capabilities, runtime: runtime ? { ...runtime, revisionVerified: Boolean(runtimeRevision) } : undefined, platform: selected, digest: base.descriptor.digest, user: base.config.config?.User ?? "",
          layers: base.manifest.layers.length, runtimeVerified: Boolean(runtimeRevision), runtimeRevision });
      } finally {
        if (composed) { const cleanup = Bun.spawn(["docker", "image", "rm", composed], { stdout: "ignore", stderr: "ignore" }); await cleanup.exited; }
      }
    }
    return { schemaVersion: 1, indexDigest: pinned.descriptor.digest, toolchain: { version: toolchain.version, revision: toolchain.revision }, platforms: results };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Read only native requirements from an existing single/multi-target build report. */
async function reportRequirements(path: string): Promise<Map<string, NativeBinary[]>> {
  const file = Bun.file(path);
  if (file.size > 16 * 1024 * 1024) throw new Error("Requirements report exceeds 16 MiB");
  const report = JSON.parse(await readFile(path, "utf8"));
  const targets = report?.schemaVersion === 2 ? [report] : [3, 4].includes(report?.schemaVersion) && Array.isArray(report.targets) ? report.targets : [];
  if (!targets.length) throw new Error("Requirements report must be a Bunko build report");
  const result = new Map<string, NativeBinary[]>();
  let count = 0;
  for (const target of targets) {
    if (!Array.isArray(target?.images)) throw new Error("Requirements report has no platform images");
    for (const image of target.images) {
      if (image?.platform?.os !== "linux" || !["amd64", "arm64"].includes(image.platform.architecture)) throw new Error("Invalid requirements report platform");
      if (!result.has(image.platform.architecture)) result.set(image.platform.architecture, []);
      if (!Array.isArray(image.native)) throw new Error("Requirements report has no native inventory");
      for (const item of image.native) {
        if (!item || item.architecture !== image.platform.architecture || typeof item.path !== "string" || !item.path || item.path.length > 4096 || /[\x00-\x1f\x7f]/.test(item.path)
          || !Array.isArray(item.needed) || item.needed.length > 1024 || !item.needed.every((name: unknown) => typeof name === "string" && name.length > 0 && name.length < 4096 && !/[\x00-\x1f\x7f]/.test(name))) throw new Error("Invalid native requirements in report");
        result.get(item.architecture)!.push({ path: item.path, architecture: item.architecture, needed: item.needed });
        if (++count > 10000) throw new Error("Too many native requirements");
      }
    }
  }
  return result;
}
