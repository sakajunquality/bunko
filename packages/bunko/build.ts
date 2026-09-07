import { cp, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { dockerCredentials } from "../oci/credentials.ts";
import { assertFileAvailable, exportDockerArchive, loadArchive } from "../oci/archive.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { assembleImage } from "../oci/image.ts";
import { assertOutputAvailable, canonicalOutput, exportLayout, exportLayouts } from "../oci/layout.ts";
import { Publisher, PublicationError, repository, repositoryName, type Publication } from "../oci/publish.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../oci/source.ts";
import { packLayer } from "../oci/tar.ts";
import { media, type BaseImage, type Descriptor, type Digest, type Layer, type Platform } from "../oci/types.ts";
import { epoch, loadProject, VERSION, type BuildOptions, type Project, validateDependencySpecs } from "./config.ts";
import { assetEntries, assertNoLayerCollision, fileEntries, snapshot } from "./files.ts";
import { bundle, selectToolchain, type Toolchain } from "./toolchain.ts";
import { dependencyInputs, dependencyPlan, installDependencies, runtimeEntries, type InventoryEntry, type NativeBinary, type DependencyPlan } from "./deps.ts";
import { discover, workspaceAt } from "./workspace.ts";
import { workspaceRuntime, workspaceDirectory } from "./workspace-runtime.ts";
import { assetInputs, cacheKey, LayerCache, packFormat, type CacheRecord, type CacheEvent } from "./cache.ts";

export interface PlatformResult {
  platform: Platform; manifest: Descriptor; config: Descriptor; layers: Layer[];
  baseDigest: Digest; inventory: InventoryEntry[]; native: NativeBinary[];
}
export interface BuildResult {
  schemaVersion: 2;
  target: string;
  targetPath?: string;
  layout?: string;
  tarball?: string;
  localReference?: string;
  platform: string;
  root: Descriptor;
  manifest: Descriptor;
  config: Descriptor;
  sourceDigest: Digest;
  baseDigest: Digest;
  baseRuntimeVerified: false;
  toolchain: { version: string; revision: string };
  layers: Layer[];
  images: PlatformResult[];
  cache: CacheEvent[];
  publication?: Publication;
  verifiedDeterministic: boolean;
  dryRun: boolean;
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

async function writeReport(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".bunko-report-"));
  try {
    const file = join(temporary, "report.json");
    await writeFile(file, canonicalJSON(value));
    await link(file, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

interface BuildContext {
  project: Project; source: string; sourceDigest: Digest; plan: DependencyPlan;
  toolchain: Toolchain; git: Record<string, string>; multiple: boolean;
  sources: Map<string, Promise<{ source: LayoutSource | RegistrySource; pinned: { bytes: Uint8Array; descriptor: Descriptor } }>>;
}
interface PreparedBuild {
  result: BuildResult; store: BlobStore; descriptors: Descriptor[]; refName: string;
  finish(): Promise<BuildResult>; dispose(): Promise<void>;
}

async function prepareBuild(options: BuildOptions, context: BuildContext): Promise<PreparedBuild> {
  const log = options.log ?? (() => {});
  const output = options.output ? await canonicalOutput(options.output) : undefined;
  const archive = options.tarball ? await canonicalOutput(options.tarball) : undefined;
  const report = options.report ? await canonicalOutput(options.report) : undefined;
  if (output) await assertOutputAvailable(output);
  if (archive) await assertFileAvailable(archive);
  if (report) await assertFileAvailable(report, "Report");
  if (options.local && options.kind) throw new Error("--local and --kind are mutually exclusive");
  for (const path of [archive, report].filter((p): p is string => Boolean(p))) if (output && (path === output || path.startsWith(`${output}/`))) throw new Error("Tarball and report must be outside the OCI layout");
  if (archive && archive === report) throw new Error("Tarball and report must have different paths");
  if (options.base && options.baseLayout) throw new Error("--base and --base-layout are mutually exclusive");
  const timestamp = epoch();
  const project = context.project;
  const push = options.local || options.kind ? false : options.push ?? (!output && !archive);
  const repo = options.repo ?? process.env.BUNKO_REPO;
  if (push && !repo) throw new Error("Registry push requires --repo or BUNKO_REPO");
  if (!push && !output && !archive && !options.local && !options.kind && !options.dryRun) throw new Error("--push=false requires --oci-layout, --tarball, --local, or --kind");
  const destination = repo ? repositoryName(repository(options.bare ? repo : `${repo}/${project.name}`)) : undefined;
  // Validate the prefix separately so a colon/tag cannot hide before /name.
  if (repo) repository(options.bare ? repo : `${repo}/bunko-validation`);
  const registry = { ...options.registry, credentials: options.registry?.credentials ?? dockerCredentials() };
  const cacheDirectory = options.localCache === false ? undefined : await canonicalOutput(options.cacheDir ?? process.env.BUNKO_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "v1"));
  const toolchain = context.toolchain;
  const baseRef = project.base ?? `oven/bun:${toolchain.version}-distroless`;
  if (options.reproducible && !options.baseLayout && !/@sha256:[a-f0-9]{64}$/.test(baseRef)) throw new Error("--reproducible requires --base with a sha256 digest, or --base-layout");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "bunko-")));
  try {
    const store = new BlobStore(join(temporary, "store"));
    const snapshotRoot = context.source;
    const sourceDigest = context.sourceDigest;
    const plan = context.plan;
    const git = context.git;
    const tags = [...new Set(options.tags ?? ["latest", ...(git["org.opencontainers.image.revision"] ? [git["org.opencontainers.image.revision"].slice(0, 12) + (git["org.bunko.git.dirty"] === "true" ? "-dirty" : "")] : [])])];
    for (const tag of tags) if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`Invalid image tag: ${tag}`);
    const cacheRepo = options.registryCache === false ? undefined : options.cacheRepo ?? process.env.BUNKO_CACHE_REPO ?? (push ? destination : undefined);
    const cache = new LayerCache(store, { directory: cacheDirectory, repository: cacheRepo, registry, log });
    log(`Resolving base ${options.baseLayout ?? baseRef}\n`);
    const sourceKey = options.baseLayout ? `layout:${resolve(options.baseLayout)}` : `registry:${baseRef}`;
    if (!context.sources.has(sourceKey)) context.sources.set(sourceKey, (async () => {
      const source = options.baseLayout ? new LayoutSource(resolve(options.baseLayout)) : new RegistrySource(baseRef, registry);
      return { source, pinned: await source.root() };
    })());
    const { source, pinned } = await context.sources.get(sourceKey)!;
    const fixedSource = { root: async () => pinned, blob: source.blob.bind(source) };
    const bases: BaseImage[] = [];
    for (const platform of project.platforms) {
      const base = await resolveBase(fixedSource, platform, store, true);
      if (source instanceof RegistrySource) for (const layer of base.manifest.layers) store.origins.set(layer.digest, source.ref);
      bases.push(base);
    }
    const prefix = project.workdir.slice(1);
    const assets = await assetEntries(join(snapshotRoot, project.targetPath), project.assets, prefix);
    const assetKey = cacheKey({ kind: "assets", packFormat, epoch: timestamp, destination: project.workdir, entries: await assetInputs(assets) });
    const records: CacheRecord[] = [];
    async function runBuild(iteration: number): Promise<PlatformResult[]> {
      const result: PlatformResult[] = [];
      let assetsLayer: Layer | undefined;
      if (assets.length) {
        const hit = await cache.get(assetKey, "assets", options.verifyDeterministic, { destination: project.workdir, platform: null });
        assetsLayer = hit?.layer ?? await packLayer(store, assets, "assets", timestamp);
        if (!hit && iteration === 1 && assetsLayer) records.push({ schemaVersion: 1, key: assetKey, kind: "assets", packFormat, destination: project.workdir, platform: null, layer: assetsLayer, inventory: [], native: [] });
      }
      for (const [index, platform] of project.platforms.entries()) {
        const base = bases[index]!;
        const root = join(temporary, `build-${iteration}-${platform.architecture}`);
        await cp(snapshotRoot, root, { recursive: true });
        log(`Preparing build dependencies (${platform.architecture})\n`);
        await installDependencies(root, plan, toolchain, undefined, options.installCache);
        let depsLayer: Layer | undefined;
        let inventory: InventoryEntry[] = [], native: NativeBinary[] = [];
        let depsEntries: Awaited<ReturnType<typeof runtimeEntries>>["entries"] = [];
        if (project.external.length) {
          const key = cacheKey({ kind: "deps", packFormat, epoch: timestamp, destination: `${project.workdir}/node_modules`, ...dependencyInputs(plan, toolchain, platform, base.descriptor.digest, project) });
          const hit = await cache.get(key, "deps", options.verifyDeterministic, { destination: `${project.workdir}/node_modules`, platform });
          if (hit) { depsLayer = hit.layer; inventory = hit.inventory; native = hit.native; }
          else {
            log(`Installing Linux production dependencies (${platform.architecture})\n`);
            const runtime = join(temporary, `runtime-${iteration}-${platform.architecture}`);
            await cp(snapshotRoot, runtime, { recursive: true });
            await installDependencies(runtime, plan, toolchain, platform, options.installCache);
            const content = project.workspace ? await workspaceRuntime(runtime, prefix, platform, plan, project) : await runtimeEntries(runtime, prefix, platform);
            depsEntries = content.entries; inventory = content.inventory; native = content.native;
            depsLayer = await packLayer(store, depsEntries, "deps", timestamp);
            if (iteration === 1 && depsLayer) records.push({ schemaVersion: 1, key, kind: "deps", packFormat, destination: `${project.workdir}/node_modules`, platform, layer: depsLayer, inventory, native });
          }
        }
        if (native.length && !project.base && !options.baseLayout) throw new Error("Native dependencies require an explicit --base or bunko.base containing their shared libraries; the default distroless base may not provide libgcc/libstdc++ (use a suitable Bun slim/custom base)");
        log(`Bundling ${project.entrypoint} for ${platform.os}/${platform.architecture}${iteration > 1 ? " (determinism verification)" : ""}\n`);
        const application = await bundle({ ...project, platform }, toolchain, join(root, project.targetPath), log, root);
        const app = await fileEntries(application.outdir, prefix);
        // Reserve node_modules even on a cache hit whose tree is never materialized.
        if (depsLayer && [...assets, ...app].some((e) => e.path === `${prefix}/node_modules` || e.path.startsWith(`${prefix}/node_modules/`) || e.path === `${prefix}/${workspaceDirectory}` || e.path.startsWith(`${prefix}/${workspaceDirectory}/`))) throw new Error("Assets/application overlap runtime node_modules");
        assertNoLayerCollision([depsEntries, assets, app]);
        const appLayer = await packLayer(store, app, "app", timestamp);
        const layers = [depsLayer, assetsLayer, appLayer].filter((l): l is Layer => Boolean(l));
        const image = await assembleImage(store, base, layers, {
          platform, epoch: timestamp, entrypoint: [project.bunPath, `${project.workdir}/${application.entry}`],
          args: project.args, workdir: project.workdir, user: project.user, env: project.env, ports: project.ports,
          labels: { ...project.labels, ...git, "org.bunko.version": VERSION, "org.bunko.mode": "bundle",
            "org.bunko.base.digest": base.descriptor.digest, ...(base.indexDigest ? { "org.bunko.base.index.digest": base.indexDigest } : {}),
            "org.bunko.source.digest": sourceDigest, "org.bunko.bun.version": toolchain.version, "org.bunko.bun.revision": toolchain.revision, "org.bunko.pack.format": packFormat },
        }, true);
        result.push({ platform, manifest: image.manifest, config: image.config, layers, baseDigest: base.descriptor.digest, inventory, native });
      }
      return result;
    }
    const images = await runBuild(1);
    if (options.verifyDeterministic) {
      const second = await runBuild(2);
      if (Buffer.compare(Buffer.from(canonicalJSON(images)), Buffer.from(canonicalJSON(second)))) throw new Error("Determinism verification failed: layers or image descriptors differ between isolated builds");
      log("Determinism verified: layers, config and platform manifests match\n");
    }
    for (const record of records) await cache.remember(record);
    const first = images[0]!;
    const root = options.noIndex ? first.manifest : await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: images.map((image) => ({ ...image.manifest, platform: image.platform })) }), media.index);
    const localReference = options.local || options.kind ? `${options.kind ? "kind.local" : "bunko.local"}/${project.name}:sha256-${root.digest.slice(7)}` : undefined;
    const result: BuildResult = {
      schemaVersion: 2, target: project.name, targetPath: project.targetPath || ".", layout: options.dryRun ? undefined : output, tarball: options.dryRun ? undefined : archive,
      platform: project.platforms.map((p) => `${p.os}/${p.architecture}`).join(","), root, manifest: first.manifest, config: first.config,
      sourceDigest, baseDigest: first.baseDigest, baseRuntimeVerified: false, toolchain: { version: toolchain.version, revision: toolchain.revision },
      layers: first.layers, images, cache: cache.events, verifiedDeterministic: Boolean(options.verifyDeterministic), dryRun: Boolean(options.dryRun),
    };
    const descriptors = [...bases.flatMap((base) => base.manifest.layers), ...images.flatMap((image) => [...image.layers.map((l) => l.descriptor), image.config, image.manifest])];
    const refName = `${destination ?? project.name}:latest`;
    return { result, store, descriptors, refName,
      dispose: () => rm(temporary, { recursive: true, force: true }),
      finish: async () => {
        if (!options.dryRun) {
          if (output && !context.multiple) await exportLayout(store, output, root, descriptors, refName);
          if (archive || localReference) {
            const archivePath = archive ?? join(temporary, "image.tar");
            await exportDockerArchive(store, first.manifest, archivePath, localReference ?? `${destination ?? `bunko.local/${project.name}`}:sha256-${root.digest.slice(7)}`, timestamp);
            if (localReference) { await loadArchive(archivePath, localReference, options.kind); result.localReference = localReference; }
          }
        }
        if (push && destination) {
          log(`${options.dryRun ? "Estimating transfer to" : "Publishing to"} ${destination}\n`);
          try { result.publication = await new Publisher(destination, registry).publish(store, root, tags, new Map(images.flatMap((image) => image.layers.map((l) => [l.descriptor.digest, l.kind] as const))), options.dryRun); }
          catch (error) {
            if (error instanceof PublicationError) result.publication = error.result;
            if (report && !context.multiple && error instanceof PublicationError) await writeReport(report, { ...result, status: "failed", publication: error.result, error: error.message });
            throw error;
          }
          if (!options.dryRun) await cache.publish();
        }
        if (report && !context.multiple) await writeReport(report, result);
        if (output && !options.dryRun) log(`OCI layout: ${output}\n`);
        log(`Image: ${root.digest}\n`);
        if (result.publication) log(`Layer/config bytes ${options.dryRun ? "estimated" : "uploaded"}: ${result.publication.transfers.reduce((sum, t) => sum + t.uploaded, 0)}\n`);
        return result;
      },
    };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

/** Single-target API retained for callers that expect one BuildResult. */
export async function build(options: BuildOptions): Promise<BuildResult> {
  return (await buildTargets(options, true))[0]!;
}

export async function buildTargets(options: BuildOptions, single = false): Promise<BuildResult[]> {
  const discovered = await discover(options);
  if (single && discovered.targets.length !== 1) throw new Error("Multiple workspace targets require buildTargets(), or select one member path");
  const multiple = discovered.targets.length > 1;
  if (multiple && (options.bare || options.tarball)) throw new Error("--bare and --tarball require a single target");
  const projects = await Promise.all(discovered.targets.map((pkg) => loadProject({ ...options, path: join(discovered.directory, pkg.path) }, discovered.workspace)));
  if (new Set(projects.map((project) => project.name.toLowerCase())).size !== projects.length) throw new Error("Workspace image name collision; set distinct bunko.imageName values");
  if (discovered.workspace) for (const pkg of discovered.workspace.packages) {
    validateDependencySpecs(pkg.manifest, discovered.workspace);
    if (pkg.path && ["overrides", "resolutions", "patchedDependencies"].some((key) => pkg.manifest[key] !== undefined)) throw new Error("Workspace overrides/resolutions/patchedDependencies must be configured at the root");
    if (await Bun.file(join(discovered.directory, pkg.path, "bunfig.toml")).exists()) throw new Error("Workspace bunfig.toml is not supported in M2a");
    if (pkg.path && await Bun.file(join(discovered.directory, pkg.path, ".npmrc")).exists()) throw new Error("Workspace npm configuration must be in the root .npmrc");
  }
  const output = options.output ? await canonicalOutput(options.output) : undefined;
  const report = options.report ? await canonicalOutput(options.report) : undefined;
  const archive = options.tarball ? await canonicalOutput(options.tarball) : undefined;
  if (output) await assertOutputAvailable(output);
  if (report) await assertFileAvailable(report, "Report");
  if (archive) await assertFileAvailable(archive);
  for (const path of [archive, report].filter((p): p is string => Boolean(p))) if (output && (path === output || path.startsWith(`${output}/`))) throw new Error("Tarball and report must be outside the OCI layout");
  if (archive && archive === report) throw new Error("Tarball and report must have different paths");
  const cacheDirectory = options.localCache === false ? undefined : await canonicalOutput(options.cacheDir ?? process.env.BUNKO_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "v1"));
  const exclusions = [output, report, archive, cacheDirectory, options.installCache ? await canonicalOutput(options.installCache) : undefined].filter((p): p is string => Boolean(p));
  if (exclusions.some((path) => discovered.directory === path || discovered.directory.startsWith(`${path}/`))) throw new Error("Output/cache paths must not contain the source project");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "bunko-invocation-")));
  const prepared: PreparedBuild[] = [];
  const finished = new Set<string>();
  try {
    const source = join(temporary, "source");
    options.log?.(`Snapshotting ${discovered.workspace ? "workspace" : projects[0]!.name}\n`);
    const sourceDigest = await snapshot(discovered.directory, source, exclusions);
    for (const pkg of discovered.workspace?.packages ?? discovered.targets) {
      if (await readFile(join(source, pkg.path, "package.json"), "utf8") !== pkg.text) throw new Error("package.json changed while creating the snapshot; retry the build");
    }
    if (discovered.workspace) {
      const captured = await workspaceAt(source, discovered.workspace.packages[0]!);
      if (JSON.stringify(captured.packages.map((pkg) => pkg.path)) !== JSON.stringify(discovered.workspace.packages.map((pkg) => pkg.path))) throw new Error("Workspace membership changed while creating the snapshot; retry the build");
    }
    const plan = await dependencyPlan(projects[0]!, source), toolchain = await selectToolchain(options.bunPath);
    const git = options.gitMetadata === false ? {} : await gitLabels(discovered.directory);
    const sources: BuildContext["sources"] = new Map();
    const registry = { ...options.registry, credentials: options.registry?.credentials ?? dockerCredentials() };
    for (const project of projects) prepared.push(await prepareBuild({ ...options, registry }, { project, source, sourceDigest, plan, toolchain, git, multiple, sources }));
    // No target is exported or published until every selected build succeeds.
    if (multiple && output && !options.dryRun) await exportLayouts(output, prepared.map((item) => ({ source: item.store, root: item.result.root, all: item.descriptors, refName: item.refName })));
    for (const item of prepared) { await item.finish(); finished.add(item.result.target); }
    const results = prepared.map((item) => item.result);
    if (multiple && report) await writeReport(report, { schemaVersion: 3, status: "success", targets: results });
    return results;
  } catch (error) {
    if (multiple && report && !(await Bun.file(report).exists())) await writeReport(report, {
      schemaVersion: 3, status: "failed", error: error instanceof Error ? error.message : "Build failed",
      targets: prepared.map((item) => item.result),
      pendingTargets: projects.filter((project) => !finished.has(project.name)).map((project) => project.name),
    });
    throw error;
  } finally {
    await Promise.all(prepared.map((item) => item.dispose()));
    await rm(temporary, { recursive: true, force: true });
  }
}
