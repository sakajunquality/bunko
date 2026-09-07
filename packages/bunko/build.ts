import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { assembleImage } from "../oci/image.ts";
import { assertOutputAvailable, canonicalOutput, exportLayout } from "../oci/layout.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../oci/source.ts";
import { packLayer } from "../oci/tar.ts";
import type { Descriptor, Digest, Layer } from "../oci/types.ts";
import { epoch, loadProject, VERSION, type BuildOptions } from "./config.ts";
import { assetEntries, assertNoLayerCollision, fileEntries, snapshot } from "./files.ts";
import { bundle, selectToolchain } from "./toolchain.ts";

export interface BuildResult {
  schemaVersion: 1;
  target: string;
  layout: string;
  platform: string;
  root: Descriptor;
  manifest: Descriptor;
  config: Descriptor;
  sourceDigest: Digest;
  baseDigest: Digest;
  baseRuntimeVerified: false;
  toolchain: { version: string; revision: string };
  layers: Layer[];
  verifiedDeterministic: boolean;
}

async function gitLabels(directory: string): Promise<Record<string, string>> {
  const git = Bun.which("git");
  if (!git) return {};
  const run = async (args: string[]) => {
    const child = Bun.spawn([git, "-C", directory, ...args], { stdout: "pipe", stderr: "ignore" });
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exit === 0 ? stdout.trim() : undefined;
  };
  const revision = await run(["rev-parse", "HEAD"]);
  if (!revision || !/^[a-f0-9]{40,64}$/.test(revision)) return {};
  const status = await run(["status", "--porcelain", "--untracked-files=normal"]);
  return { "org.opencontainers.image.revision": revision, "org.bunko.git.dirty": String(Boolean(status)) };
}

async function assertReportAvailable(report: string, output: string) {
  if (report === output || report.startsWith(`${output}/`)) throw new Error("Report must be outside the OCI layout");
  try { await lstat(report); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Report already exists: ${report}`);
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => { });
  const output = await canonicalOutput(options.output);
  const report = options.report ? await canonicalOutput(options.report) : undefined;
  await assertOutputAvailable(output);
  if (report) await assertReportAvailable(report, output);
  if (options.base && options.baseLayout) throw new Error("--base and --base-layout are mutually exclusive");
  const timestamp = epoch();
  const project = await loadProject(options);
  const toolchain = await selectToolchain(options.bunPath);
  const baseRef = project.base ?? `oven/bun:${toolchain.version}-distroless`;
  if (options.reproducible && !options.baseLayout && !/@sha256:[a-f0-9]{64}$/.test(baseRef)) {
    throw new Error("--reproducible requires --base with a sha256 digest, or --base-layout");
  }
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "bunko-")));
  try {
    const store = new BlobStore(join(temporary, "store"));
    const snapshotRoot = join(temporary, "source");
    log(`Snapshotting ${project.name}\n`);
    const sourceDigest = await snapshot(project.directory, snapshotRoot, [output, ...(report ? [report] : [])]);
    if (await readFile(join(snapshotRoot, "package.json"), "utf8") !== project.manifestText) throw new Error("package.json changed while creating the snapshot; retry the build");
    const git = options.gitMetadata === false ? {} : await gitLabels(project.directory);
    log(`Resolving base ${options.baseLayout ?? baseRef}\n`);
    const source = options.baseLayout ? new LayoutSource(resolve(options.baseLayout)) : new RegistrySource(baseRef);
    const base = await resolveBase(source, project.platform, store);

    async function runBuild(iteration: number) {
      const root = join(temporary, `build-${iteration}`);
      await cp(snapshotRoot, root, { recursive: true });
      const prefix = project.workdir.slice(1);
      const assets = await assetEntries(root, project.assets, prefix);
      log(`Bundling ${project.entrypoint}${iteration > 1 ? " (determinism verification)" : ""}\n`);
      const application = await bundle(project, toolchain, root, log);
      const app = await fileEntries(application.outdir, prefix);
      assertNoLayerCollision([assets, app]);
      const layers: Layer[] = [];
      for (const [entries, kind] of [[assets, "assets"], [app, "app"]] as const) {
        const layer = await packLayer(store, entries, kind, timestamp);
        if (layer) layers.push(layer);
      }
      const image = await assembleImage(store, base, layers, {
        platform: project.platform, epoch: timestamp,
        entrypoint: [project.bunPath, `${project.workdir}/${application.entry}`],
        args: project.args, workdir: project.workdir, user: project.user,
        env: project.env, ports: project.ports,
        labels: {
          ...project.labels, ...git,
          "org.bunko.version": VERSION,
          "org.bunko.mode": "bundle",
          "org.bunko.base.digest": base.descriptor.digest,
          ...(base.indexDigest ? { "org.bunko.base.index.digest": base.indexDigest } : {}),
          "org.bunko.source.digest": sourceDigest,
          "org.bunko.bun.version": toolchain.version,
          "org.bunko.bun.revision": toolchain.revision,
          "org.bunko.pack.format": `tar-gzip-v1/bun-${Bun.version}-${Bun.revision}`,
        },
      }, options.noIndex);
      return { ...image, layers };
    }

    const first = await runBuild(1);
    if (options.verifyDeterministic) {
      const second = await runBuild(2);
      if (Buffer.compare(Buffer.from(canonicalJSON(first)), Buffer.from(canonicalJSON(second))) !== 0) throw new Error("Determinism verification failed: layers or image descriptors differ between isolated builds");
      log("Determinism verified: layers, config, manifest and image index match\n");
    }
    await exportLayout(store, output, first.root, [
      ...base.manifest.layers, ...first.layers.map((layer) => layer.descriptor), first.config, first.manifest,
    ], `${project.name}:latest`);
    const result: BuildResult = {
      schemaVersion: 1, target: project.name, layout: output,
      platform: `${project.platform.os}/${project.platform.architecture}`,
      root: first.root, manifest: first.manifest, config: first.config,
      sourceDigest, baseDigest: base.descriptor.digest, baseRuntimeVerified: false,
      toolchain: { version: toolchain.version, revision: toolchain.revision },
      layers: first.layers, verifiedDeterministic: Boolean(options.verifyDeterministic),
    };
    if (report) {
      await mkdir(dirname(report), { recursive: true });
      const tempReport = await mkdtemp(join(dirname(report), ".bunko-report-"));
      try {
        await writeFile(join(tempReport, "report.json"), canonicalJSON(result));
        await assertReportAvailable(report, output);
        await rename(join(tempReport, "report.json"), report);
      } finally { await rm(tempReport, { recursive: true, force: true }); }
    }
    log(`OCI layout: ${output}\nImage: ${first.root.digest}\n`);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
