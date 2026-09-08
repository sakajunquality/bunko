import { stageAssetMappings, type AssetMaterial } from "./asset-contexts.ts";
import { readBunfig } from "./bunfig.ts";
import { validateCacheOptions } from "./cache-options.ts";
import { supplyChainOptions } from "./policy.ts";
import { baseInventory } from "./metadata.ts";
import { builderIdentity } from "./identity.ts";
import { canonicalDependencyMap } from "./dependency-map.ts";
import { requiredInputs } from "./ignore.ts";
import { targetInputs } from "./inputs.ts";
import { phase } from "./progress.ts";
import { referenceOutput, writeReferences, localImageReference } from "./references.ts";
import { cp, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { dockerCredentials } from "../oci/credentials.ts";
import { assertFileAvailable, exportDockerArchive, loadArchive } from "../oci/archive.ts";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import { assembleImage } from "../oci/image.ts";
import { assertOutputAvailable, canonicalOutput, exportLayout, exportLayouts } from "../oci/layout.ts";
import { Publisher, PublicationError, repository, repositoryName, type Publication } from "../oci/publish.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../oci/source.ts";
import { packLayer } from "../oci/tar.ts";
import { media, type BaseImage, type Descriptor, type Digest, type Layer, type Platform } from "../oci/types.ts";
import { epoch, loadProject, VERSION, type BuildOptions, type Project, validateDependencySpecs } from "./config.ts";
import { assetEntries, assertNoLayerCollision, fileEntries, hashFile, snapshot } from "./files.ts";
import { bundle, selectToolchain, type Toolchain } from "./toolchain.ts";
import { dependencyInputs, dependencyPlan, installDependencies, runtimeEntries, type InventoryEntry, type NativeBinary, type DependencyPlan } from "./deps.ts";
import { discover, workspaceAt } from "./workspace.ts";
import { dependencyClosure, closureDirectory } from "./closure.ts";
import { workspaceRuntime, workspaceDirectory } from "./workspace-runtime.ts";
import { assetInputs, cacheKey, LayerCache, packFormat, type CacheRecord, type CacheEvent } from "./cache.ts";

import { mapJobs } from "./concurrency.ts";
import { SyntaxCache } from "./syntax-cache.ts";
import { importDependencies } from "./external-deps.ts";
import { artifact, publishArtifacts, type Artifact } from "../oci/artifacts.ts";
import { spdx, provenance, sbomType, provenanceType, signImages, verifyImage } from "./attest.ts";

export interface PlatformResult {
  baseInventory?: { described: string[]; namespace: string; digest: Digest; artifactDigest: Digest; reference: string };
  entrypoints?: Record<string, string>;
  bundledInventory?: InventoryEntry[];
  dependencyArtifact?: Digest;
  platform: Platform; manifest: Descriptor; config: Descriptor; layers: Layer[];
  baseDigest: Digest; inventory: InventoryEntry[]; native: NativeBinary[];
}
export interface BuildResult {
  schemaVersion: 2;
  defaultEntrypoint?: string;
  builder?: Awaited<ReturnType<typeof builderIdentity>>;
  mode?: "bundle" | "compile";
  syntaxValidation?: { parsed: number; reused: number; bytes: number };
  supplyChain?: { status: "prepared" | "attaching" | "signing" | "complete" };
  attestations?: { subject: Descriptor; manifest: Descriptor }[];
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
  assetMaterials?: AssetMaterial[];
  baseDigest: Digest;
  baseRuntimeVerified: false;
  toolchain: { version: string; revision: string; digest?: string };
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

export async function writeReport(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".bunko-report-"));
  try {
    const file = join(temporary, "report.json");
    await writeFile(file, canonicalJSON(value));
    await link(file, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

interface BuildContext {
  mappedAssets: Awaited<ReturnType<typeof stageAssetMappings>>;
  syntax: SyntaxCache;
  toolchainDigest: Digest;
  inputDigest: Digest;
  builder: Awaited<ReturnType<typeof builderIdentity>>;
  inputPaths?: Set<string>;
  cachePersistence: { disabled?: boolean };
  project: Project; source: string; sourceDigest: Digest; plan: DependencyPlan;
  toolchain: Toolchain; git: Record<string, string>; multiple: boolean;
  closureProjects: Project[];
  closure: (projects: Project[], platform: Platform, iteration: number) => Promise<Awaited<ReturnType<typeof dependencyClosure>>>;
  sources: Map<string, Promise<{ source: LayoutSource | RegistrySource; pinned: { bytes: Uint8Array; descriptor: Descriptor } }>>;
}
interface PreparedBuild {
  result: BuildResult; store: BlobStore; descriptors: Descriptor[]; refName: string;
  finish(): Promise<BuildResult>; dispose(): Promise<void>;
}

async function prepareBuild(options: BuildOptions, context: BuildContext): Promise<PreparedBuild> {
  const log = options.log ? (message: string) => options.log!((options.jobs ?? 1) > 1 ? `[${context.project.name}] ${message}` : message) : () => {};
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
  if (options.signKey && !push) throw new Error("Signing requires registry publication");
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
    const cache = new LayerCache(store, { persistence: context.cachePersistence, directory: cacheDirectory, repository: options.cacheWrite === false ? undefined : cacheRepo, readRepositories: options.registryCache === false ? [] : [...options.cacheFrom ?? [], ...cacheRepo ? [cacheRepo] : []], registry, log });
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
    const baseInventories = await Promise.all(bases.map(async (base, i) => {
      const ref = options.baseSBOMs?.[`linux/${project.platforms[i]!.architecture}`];
      return ref ? await baseInventory(ref, [base.descriptor.digest], registry) : undefined;
    }));
    if (options.depsVerifyKey) for (const reference of new Set(Object.values(options.externalDepsByTarget?.[project.directory] ?? options.externalDeps ?? {}))) {
      await verifyImage(reference, options.depsVerifyKey, true, options.cosignPath, registry.insecure);
    }
    const prefix = project.workdir.slice(1);
    const assets = [...await assetEntries(join(snapshotRoot, project.targetPath), project.assets, prefix), ...context.mappedAssets.entries];
    assertNoLayerCollision([assets]);
    const assetKey = cacheKey({ kind: "assets", packFormat, epoch: timestamp, destination: project.workdir, ...(context.mappedAssets.materials.length ? { materials: context.mappedAssets.materials } : {}), entries: await assetInputs(assets) });
    const records: CacheRecord[] = [];
    async function runBuild(iteration: number): Promise<PlatformResult[]> {
      const result: PlatformResult[] = [];
      let sharedBundle: Awaited<ReturnType<typeof bundle>> | undefined;
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
        let depsLayer: Layer | undefined;
        let inventory: InventoryEntry[] = [], native: NativeBinary[] = [];
        let depsEntries: Awaited<ReturnType<typeof runtimeEntries>>["entries"] = [];
        let aliases: Awaited<ReturnType<typeof dependencyClosure>>["entries"] = [];
        let dependencyArtifactDigest: Digest | undefined;
        const dependencyArtifact = (options.externalDepsByTarget?.[project.directory] ?? options.externalDeps)?.[`${platform.os}/${platform.architecture}`];
        if (dependencyArtifact) {
          const content = await importDependencies(dependencyArtifact, platform, project.workdir, plan.lock, join(temporary, `external-${iteration}-${platform.architecture}`), registry, project.targetPath);
          dependencyArtifactDigest = content.artifactDigest;
          depsEntries = content.entries; inventory = content.inventory; native = content.native;
          for (const name of project.external) if (!inventory.some((item) => item.name === name)) throw new Error(`External artifact is missing runtime package: ${name}`);
          depsLayer = await packLayer(store, depsEntries, "deps", timestamp);
        } else if (project.depsStrategy === "closure" && context.closureProjects.some((p) => p.external.length)) {
          const content = await context.closure(context.closureProjects, platform, iteration);
          aliases = content.aliases.get(project.targetPath) ?? [];
          inventory = content.inventory; native = content.native;
          const key = cacheKey({ kind: "deps", packFormat, epoch: timestamp, destination: `${project.workdir}/node_modules`,
            strategy: "closure-v1", entries: await assetInputs(content.entries), platform, base: base.descriptor.digest,
            toolchain: { version: toolchain.version, revision: toolchain.revision }, libc: "glibc", scripts: false });
          const hit = await cache.get(key, "deps", options.verifyDeterministic, { destination: `${project.workdir}/node_modules`, platform });
          depsEntries = content.entries;
          depsLayer = hit?.layer ?? await packLayer(store, depsEntries, "deps", timestamp);
          if (!hit && iteration === 1 && depsLayer) records.push({ schemaVersion: 1, key, kind: "deps", packFormat, destination: `${project.workdir}/node_modules`, platform, layer: depsLayer, inventory, native });
        } else if (project.external.length) {
          const key = cacheKey({ kind: "deps", packFormat, epoch: timestamp, destination: `${project.workdir}/node_modules`, ...dependencyInputs(plan, toolchain, platform, base.descriptor.digest, project) });
          const hit = await cache.get(key, "deps", options.verifyDeterministic, { destination: `${project.workdir}/node_modules`, platform });
          if (hit) { depsLayer = hit.layer; inventory = hit.inventory; native = hit.native; }
          else {
            log(`Installing Linux production dependencies (${platform.architecture})\n`);
            const runtime = join(temporary, `runtime-${iteration}-${platform.architecture}`);
            await cp(snapshotRoot, runtime, { recursive: true });
            await installDependencies(runtime, plan, toolchain, platform, options.installCache);
            const content = project.workspace ? await workspaceRuntime(runtime, prefix, platform, plan, project) : await runtimeEntries(runtime, prefix, platform, false, project.allowIgnoredScripts);
            depsEntries = content.entries; inventory = content.inventory; native = content.native;
            depsLayer = await packLayer(store, depsEntries, "deps", timestamp);
            if (iteration === 1 && depsLayer) records.push({ schemaVersion: 1, key, kind: "deps", packFormat, destination: `${project.workdir}/node_modules`, platform, layer: depsLayer, inventory, native });
          }
        }
        if (native.length && !project.base && !options.baseLayout) throw new Error("Native dependencies require an explicit --base or bunko.base containing their shared libraries; the default distroless base may not provide libgcc/libstdc++ (use a suitable Bun slim/custom base)");
        const appKey = cacheKey({ kind: "app", format: "application-v2", builder: context.builder.digest, packFormat, epoch: timestamp,
          sourceDigest: context.inputDigest, toolchainExecutable: context.toolchainDigest, host: { os: process.platform, arch: process.arch }, targetPath: project.targetPath, entrypoint: project.entrypoint, entrypoints: project.entrypoints, defaultEntrypoint: project.defaultEntrypoint, mode: project.mode, build: project.build,
          destination: project.workdir, dependencies: depsLayer?.descriptor.digest, dependencyArtifact: dependencyArtifactDigest,
          aliases: await assetInputs(aliases), ...dependencyInputs(plan, toolchain, platform, base.descriptor.digest, project) });
        const namedOutputs = project.entrypoints ? Object.fromEntries(Object.entries(project.entrypoints).map(([name, path]) => [name, path.replace(/\.[^.]+$/, ".js")])) : undefined;
        const appHit = await cache.get(appKey, "app", options.appCache === false || options.verifyDeterministic, { destination: project.workdir, platform, ...(namedOutputs ? { application: { entry: namedOutputs[project.defaultEntrypoint!]!, entrypoints: namedOutputs } } : {}) });
        let application: { entry: string; entrypoints?: Record<string, string>; inventory: InventoryEntry[] };
        let app: Awaited<ReturnType<typeof fileEntries>>;
        let applicationMetadata: CacheRecord["application"];
        let cacheable = true;
        if (appHit) {
          applicationMetadata = appHit.application!;
          application = { entry: applicationMetadata.entry, entrypoints: applicationMetadata.entrypoints, inventory: appHit.inventory };
          app = applicationMetadata.entries.map((entry) => entry.type === "file" ? { ...entry, type: "file" as const, content: Buffer.alloc(0) } : { ...entry, type: "directory" as const });
          log(`Reusing application output (${platform.architecture})\n`);
        } else {
          log(`Preparing build dependencies (${platform.architecture})\n`);
          if (!sharedBundle) await installDependencies(root, plan, toolchain, undefined, options.installCache);
          log(`Bundling ${project.entrypoint} for ${platform.os}/${platform.architecture}${iteration > 1 ? " (determinism verification)" : ""}\n`);
          const built = sharedBundle ?? await bundle({ ...project, platform }, toolchain, join(root, project.targetPath), log, root, context.syntax);
          if (project.mode === "bundle") sharedBundle = built;
          cacheable = !context.inputPaths || built.inputs.every((path) => context.inputPaths!.has(path));
          if (!cacheable) log("Application input tracking could not account for all bundled inputs; skipping cache write\n");
          application = built;
          app = await fileEntries(built.outdir, prefix);
          applicationMetadata = { entry: built.entry, entrypoints: built.entrypoints, entries: app.map((entry) => ({ path: entry.path, type: entry.type as "file" | "directory" })) };
        }
        // Reserve runtime namespaces even when the corresponding trees are lazy.
        if (depsLayer && [...assets, ...app].some((e) => e.path === `${prefix}/node_modules` || e.path.startsWith(`${prefix}/node_modules/`) || e.path === `${prefix}/${workspaceDirectory}` || e.path.startsWith(`${prefix}/${workspaceDirectory}/`) || e.path === `${prefix}/${closureDirectory}` || e.path.startsWith(`${prefix}/${closureDirectory}/`))) throw new Error("Assets/application overlap runtime node_modules");
        app.push(...aliases);
        assertNoLayerCollision([depsEntries, assets, app]);
        const appLayer = appHit?.layer ?? await packLayer(store, app, "app", timestamp);
        if (!appHit && cacheable && options.appCache !== false && iteration === 1 && appLayer) records.push({ schemaVersion: 1, key: appKey, kind: "app", packFormat, destination: project.workdir, platform, layer: appLayer, inventory: application.inventory, native: [], application: applicationMetadata });
        const layers = [depsLayer, assetsLayer, appLayer].filter((l): l is Layer => Boolean(l));
        const image = await assembleImage(store, base, layers, {
          platform, epoch: timestamp, entrypoint: project.mode === "compile" ? [`${project.workdir}/${application.entry}`] : project.entrypoints ? [project.bunPath] : [project.bunPath, `${project.workdir}/${application.entry}`],
          inheritBaseOciLabels: project.inheritBaseOciLabels, annotations: project.annotations, args: project.entrypoints ? [`${project.workdir}/${application.entry}`, ...project.args] : project.args, workdir: project.workdir, user: project.user, env: project.env, ports: project.ports,
          labels: { ...project.labels, ...git, "org.bunko.version": VERSION, "org.bunko.builder.digest": context.builder.digest, "org.bunko.mode": project.mode,
            "org.bunko.base.digest": base.descriptor.digest, ...(base.indexDigest ? { "org.bunko.base.index.digest": base.indexDigest } : {}),
            "org.bunko.source.digest": sourceDigest, "org.bunko.bun.version": toolchain.version, "org.bunko.bun.revision": toolchain.revision, "org.bunko.pack.format": packFormat },
        }, true);
        const baseRef = options.baseSBOMs?.[`${platform.os}/${platform.architecture}`];
        const baseMetadata = baseInventories[index];
        result.push({ entrypoints: application.entrypoints ? Object.fromEntries(Object.entries(application.entrypoints).map(([name, path]) => [name, `${project.workdir}/${path}`])) : undefined, baseInventory: baseMetadata ? { described: baseMetadata.described, namespace: baseMetadata.document.documentNamespace as string, digest: baseMetadata.payload.digest, artifactDigest: baseMetadata.manifest.digest, reference: baseRef! } : undefined, platform, manifest: image.manifest, config: image.config, layers, baseDigest: base.descriptor.digest, inventory, native, bundledInventory: application.inventory, dependencyArtifact: dependencyArtifactDigest });
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
    await cache.persistHits();
    const first = images[0]!;
    const root = options.noIndex ? first.manifest : await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, ...(Object.keys(project.annotations).length ? { annotations: project.annotations } : {}), manifests: images.map((image) => ({ ...image.manifest, platform: image.platform })) }), media.index);
    const localReference = options.local || options.kind ? localImageReference(project.name, root.digest, options.kind) : undefined;
    const result: BuildResult = {
      schemaVersion: 2, defaultEntrypoint: project.defaultEntrypoint, mode: project.mode, target: project.name, targetPath: project.targetPath || ".", layout: options.dryRun ? undefined : output, tarball: options.dryRun ? undefined : archive,
      platform: project.platforms.map((p) => `${p.os}/${p.architecture}`).join(","), root, manifest: first.manifest, config: first.config,
      sourceDigest, ...(context.mappedAssets.materials.length ? { assetMaterials: context.mappedAssets.materials } : {}), baseDigest: first.baseDigest, baseRuntimeVerified: false, toolchain: { version: toolchain.version, revision: toolchain.revision, digest: context.toolchainDigest }, builder: context.builder,
      layers: first.layers, images, cache: cache.events, verifiedDeterministic: Boolean(options.verifyDeterministic), dryRun: Boolean(options.dryRun),
    };
    const attestations: Artifact[] = [];
    if (options.sbom) for (const image of images) attestations.push(await artifact(store, image.manifest, sbomType, spdx(project.name, image, timestamp, { version: toolchain.version, revision: toolchain.revision, embedded: project.mode === "compile" })));
    if (options.provenance) attestations.push(await artifact(store, root, provenanceType, provenance(result, plan.lock ? sha256(canonicalJSON(plan.lock)) : undefined)));
    if (attestations.length || options.signKey) result.supplyChain = { status: "prepared" };
    if (attestations.length) result.attestations = attestations.map(({ subject, manifest }) => ({ subject, manifest }));
    const descriptors = [...attestations.flatMap((item) => [item.manifest, ...item.blobs]), ...bases.flatMap((base) => base.manifest.layers), ...images.flatMap((image) => [...image.layers.map((l) => l.descriptor), image.config, image.manifest])];
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
          try {
            const publisher = new Publisher(destination, registry);
            result.publication = await publisher.publish(store, root, tags, new Map(images.flatMap((image) => image.layers.map((l) => [l.descriptor.digest, l.kind] as const))), options.dryRun);
            if (options.dryRun) {
              for (const item of attestations) {
                const estimate = await publisher.publish(store, item.manifest, [], new Map(item.blobs.map((d) => [d.digest, "attestation"])), true);
                result.publication.transfers.push(...estimate.transfers);
              }
            } else {
              if (result.supplyChain) result.supplyChain.status = "attaching";
              await publishArtifacts(publisher, store, attestations, (transfers) => result.publication!.transfers.push(...transfers));
              if (options.signKey && result.supplyChain) result.supplyChain.status = "signing";
              if (options.signKey) await signImages([root, ...images.map((image) => image.manifest), ...attestations.map((item) => item.manifest)].map((d) => `${destination}@${d.digest}`), options.signKey, options.cosignPath, options.registry?.insecure);
              if (result.supplyChain) result.supplyChain.status = "complete";
            }
          }
          catch (error) {
            if (error instanceof PublicationError && !result.publication) result.publication = error.result;
            if (report && !context.multiple) await writeReport(report, { ...result, status: "failed", error: error instanceof Error ? error.message : "Publication failed" });
            throw error;
          }
          if (!options.dryRun) await cache.publish();
        }
        if (!push && !options.dryRun && result.supplyChain) result.supplyChain.status = "complete";
        if (report && !context.multiple && !options.imageRefs) await writeReport(report, result);
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

export interface PreparedTargets {
  results: BuildResult[];
  finish(): Promise<BuildResult[]>;
  dispose(): Promise<void>;
}

export async function buildTargets(options: BuildOptions, single = false): Promise<BuildResult[]> {
  const prepared = await prepareTargets(options, single);
  try { return await prepared.finish(); }
  finally { await prepared.dispose(); }
}

/** Prepare independently from publication so resolve can validate/build every
 * source context before any image is published. Always dispose the returned batch. */
export async function prepareTargets(options: BuildOptions, single = false, sources: BuildContext["sources"] = new Map()): Promise<PreparedTargets> {
  options = supplyChainOptions(options);
  validateCacheOptions(options);
  if (options.externalDepsByTarget) options = { ...options, externalDepsByTarget: await canonicalDependencyMap(options.externalDepsByTarget) };
  const imageRefs = await referenceOutput(options.imageRefs, [options.report, options.output, options.tarball, options.cacheDir, options.installCache]);
  if (imageRefs && (options.dryRun || options.local || options.kind || !(options.push ?? (!options.output && !options.tarball)))) throw new Error("--image-refs requires Registry publication");
  const jobs = options.jobs ?? 1;
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 32) throw new Error("--jobs must be an integer from 1 to 32");
  if ((options.sbom || options.provenance) && (options.local || options.kind || options.tarball) && !options.output) throw new Error("SBOM/provenance output requires an OCI layout or registry-only publication");
  if (options.signKey && options.registry?.tls && Object.keys(options.registry.tls).length) throw new Error("Integrated signing cannot use Registry TLS configuration; publish first and sign with a separately configured cosign client");
  if (options.signKey && (options.push === false || options.local || options.kind || options.tarball || options.dryRun)) throw new Error("Signing requires registry publication and cannot be used with dry-run");
  if (options.cosignPath && !options.signKey && !options.depsVerifyKey) throw new Error("cosignPath requires signing or dependency verification");
  if ((options.signKey || options.depsVerifyKey) && !Bun.which(options.cosignPath ?? "cosign")) throw new Error("Signing or dependency verification requires cosign on PATH or --cosign-path");
  const discovered = await discover(options);
  if (single && discovered.targets.length !== 1) throw new Error("Multiple workspace targets require buildTargets(), or select one member path");
  const rootConfig = discovered.workspace?.packages[0]?.manifest.bunko as Record<string, unknown> | undefined;
  if (rootConfig?.sharedDeps !== undefined && typeof rootConfig.sharedDeps !== "boolean") throw new Error("sharedDeps must be boolean");
  const sharedDeps = options.sharedDeps ?? rootConfig?.sharedDeps === true;
  options = { ...options, sharedDeps };
  const multiple = discovered.targets.length > 1;
  if (multiple && (options.bare || options.tarball)) throw new Error("--bare and --tarball require a single target");
  const projects = await Promise.all(discovered.targets.map((pkg) => loadProject({ ...options, path: join(discovered.directory, pkg.path) }, discovered.workspace)));
  for (const project of projects) for (const mapping of project.assetMappings) {
    const destination = mapping.to.toLowerCase(), runtime = project.bunPath.toLowerCase();
    if (runtime === destination || runtime.startsWith(`${destination}/`)) throw new Error("Asset mapping overlaps the configured Bun runtime");
  }
  if (options.baseSBOMs && Object.keys(options.baseSBOMs).some((key) => !projects.some((p) => p.platforms.some((platform) => `${platform.os}/${platform.architecture}` === key)))) throw new Error("Base SBOM map contains an unselected platform");
  if (options.externalDeps && options.externalDepsByTarget) throw new Error("Use --deps-artifact or --deps-map, not both");
  if (options.externalDepsByTarget && Object.keys(options.externalDepsByTarget).some((path) => !projects.some((p) => p.directory === path))) throw new Error("Dependency map contains an unselected target");
  for (const project of projects) {
    const artifacts = options.externalDepsByTarget?.[project.directory] ?? options.externalDeps;
    if (!artifacts) continue;
    if (options.depsVerifyKey && Object.values(artifacts).some((ref) => !/@sha256:[a-f0-9]{64}$/.test(ref) || ref.startsWith("layout:"))) throw new Error("Dependency signature policy requires a digest-pinned registry artifact");
    if (sharedDeps || project.mode === "compile" || !project.external.length || options.externalDeps && multiple) throw new Error("Dependency artifacts require a bundle target with explicit externals and no sharedDeps");
    const required = project.platforms.map((p) => `${p.os}/${p.architecture}`);
    if (Object.keys(artifacts).length !== required.length || required.some((p) => !artifacts[p])) throw new Error("Supply exactly one dependency artifact for every selected platform");
  }
  if (sharedDeps && (!discovered.workspace || projects.some((p) => p.depsStrategy !== "closure"))) throw new Error("sharedDeps requires a workspace and closure strategy for every target");
  if (sharedDeps && new Set(projects.map((p) => JSON.stringify(p.allowIgnoredScripts ?? []))).size !== 1) throw new Error("sharedDeps requires matching deps.allowIgnoredScripts policies");
  if (sharedDeps && new Set(projects.map((p) => JSON.stringify([p.workdir, p.base, p.platforms]))).size !== 1) throw new Error("sharedDeps requires matching workdir, base, and platforms");
  if (new Set(projects.map((project) => project.name.toLowerCase())).size !== projects.length) throw new Error("Workspace image name collision; set distinct bunko.imageName values");
  if (discovered.workspace) for (const pkg of discovered.workspace.packages) {
    validateDependencySpecs(pkg.manifest, discovered.workspace);
    if (pkg.path && ["overrides", "resolutions", "patchedDependencies"].some((key) => pkg.manifest[key] !== undefined)) throw new Error("Workspace overrides/resolutions/patchedDependencies must be configured at the root");
    const installPolicy = await readBunfig(join(discovered.directory, pkg.path));
    if (pkg.path && Object.keys(installPolicy).length) throw new Error("Workspace bunfig install settings must be configured at the root");
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
  const signingFile = options.signKey && !/^[a-z][a-z0-9+.-]*:\/\//i.test(options.signKey) ? await canonicalOutput(options.signKey) : undefined;
  const exclusions = [signingFile, ...await Promise.all((options.registry?.sensitivePaths ?? []).map(canonicalOutput)), output, report, archive, imageRefs, cacheDirectory, ...Object.values(options.externalDepsByTarget ?? {}).flatMap((map) => Object.values(map)).concat(Object.values(options.externalDeps ?? {})).filter((value) => value.startsWith("layout:")).map((value) => resolve(value.slice(7))), options.installCache ? await canonicalOutput(options.installCache) : undefined].filter((p): p is string => Boolean(p));
  if (exclusions.some((path) => discovered.directory === path || discovered.directory.startsWith(`${path}/`))) throw new Error("Output/cache paths must not contain the source project");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "bunko-invocation-")));
  const prepared: PreparedBuild[] = [];
  const finished = new Set<string>();
  const dispose = async () => {
    await Promise.all(prepared.map((item) => item.dispose()));
    await rm(temporary, { recursive: true, force: true });
  };
  const failure = async (error: unknown) => {
    if (report && !(await Bun.file(report).exists())) await writeReport(report, {
      schemaVersion: 3, status: "failed", error: error instanceof Error ? error.message : "Build failed",
      targets: projects.flatMap((project) => prepared.filter((item) => item.result.target === project.name).map((item) => item.result)),
      pendingTargets: projects.filter((project) => !finished.has(project.name)).map((project) => project.name),
    });
  };
  try {
    const source = join(temporary, "source");
    options.log?.(`Snapshotting ${discovered.workspace ? "workspace" : projects[0]!.name}\n`);
    const syntax = new SyntaxCache();
    const sourceDigest = await phase(options.progress, "snapshot", async () => snapshot(discovered.directory, source, exclusions, syntax, projects.filter((project) => project.dataPath).map((project) => join(project.targetPath, "bunkodata")), await requiredInputs(discovered.directory, projects, exclusions)));
    for (const pkg of discovered.workspace?.packages ?? discovered.targets) {
      if (await readFile(join(source, pkg.path, "package.json"), "utf8") !== pkg.text) throw new Error("package.json changed while creating the snapshot; retry the build");
    }
    if (discovered.workspace) {
      const captured = await workspaceAt(source, discovered.workspace.packages[0]!);
      if (JSON.stringify(captured.packages.map((pkg) => pkg.path)) !== JSON.stringify(discovered.workspace.packages.map((pkg) => pkg.path))) throw new Error("Workspace membership changed while creating the snapshot; retry the build");
    }
    const mapped = new Map<string, Awaited<ReturnType<typeof stageAssetMappings>>>();
    for (const [index, project] of projects.entries()) mapped.set(project.directory, await stageAssetMappings(project.assetMappings, options.assetContexts ?? {}, join(temporary, "assets", String(index)), [...exclusions, temporary]));
    const plan = await dependencyPlan(projects[0]!, source), toolchain = await selectToolchain(options.bunPath);
    const toolchainDigest = await hashFile(toolchain.path), builder = await builderIdentity();
    const git = options.gitMetadata === false ? {} : await gitLabels(discovered.directory);
    const registry = { ...options.registry, credentials: options.registry?.credentials ?? dockerCredentials() };
    const closures = new Map<string, Promise<Awaited<ReturnType<typeof dependencyClosure>>>>();
    const closure: BuildContext["closure"] = (selected, platform, iteration) => {
      const key = JSON.stringify([selected.map((p) => p.targetPath), platform, iteration]);
      if (!closures.has(key)) closures.set(key, (async () => {
        const runtime = join(temporary, `closure-${closures.size}`);
        options.log?.(`Planning Linux dependency closure (${platform.architecture})\n`);
        await cp(source, runtime, { recursive: true });
        await installDependencies(runtime, plan, toolchain, platform, options.installCache);
        return dependencyClosure(runtime, selected[0]!.workdir.slice(1), platform, selected);
      })());
      return closures.get(key)!;
    };
    const cachePersistence = {};
    const ordered = await mapJobs(projects, jobs, async (project) => {
      const input = await targetInputs(source, project, sourceDigest);
      const item = await phase(options.progress, "prepare", () => prepareBuild({ ...options, registry }, { mappedAssets: mapped.get(project.directory)!, syntax, builder, inputDigest: input.digest, inputPaths: input.paths, toolchainDigest, cachePersistence, project, source, sourceDigest, plan, toolchain, git, multiple, sources, closure, closureProjects: sharedDeps ? projects : [project] }), project.name);
      prepared.push(item); return item;
    });
    prepared.splice(0, prepared.length, ...ordered);
    for (const item of prepared) item.result.syntaxValidation = { ...syntax.stats };
    const results = prepared.map((item) => item.result);
    let finishedOnce = false;
    return { results, dispose, finish: async () => {
      if (finishedOnce) throw new Error("Prepared targets may only be published once");
      finishedOnce = true;
      try {
        // No target is exported or published until every selected build succeeds.
        if (multiple && output && !options.dryRun) await exportLayouts(output, prepared.map((item) => ({ source: item.store, root: item.result.root, all: item.descriptors, refName: item.refName })));
        for (const item of prepared) { await phase(options.progress, "publish", () => item.finish(), item.result.target); finished.add(item.result.target); }
        if (imageRefs) await writeReferences(imageRefs, results.map((result) => result.publication!.reference));
        if (!multiple && report && imageRefs) await writeReport(report, results[0]);
        if (multiple && report) await writeReport(report, { schemaVersion: 3, status: "success", targets: results });
        return results;
      } catch (error) { await failure(error); throw error; }
    } };
  } catch (error) {
    try { await failure(error); } finally { await dispose(); }
    throw error;
  }
}
