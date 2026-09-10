import { join } from "node:path";
import { loadProject, validateDependencySpecs, type BuildOptions } from "./config.ts";
import { discover } from "./workspace.ts";
import { assertSharedClosure } from "./closure.ts";
import { assertAssetRuntime } from "./asset-contexts.ts";
import { readBunfig } from "./bunfig.ts";

/** Shared offline target validation. Does not install, contact registries, or write outputs. */
export async function configurationPlan(options: BuildOptions, single = false) {
  const discovered = await discover(options);
  if (single && discovered.targets.length !== 1) throw new Error("Multiple workspace targets require buildTargets(), or select one member path");
  const rootConfig = discovered.workspace?.packages[0]?.manifest.bunko as Record<string, unknown> | undefined;
  if (rootConfig?.sharedDeps !== undefined && typeof rootConfig.sharedDeps !== "boolean") throw new Error("sharedDeps must be boolean");
  const sharedDeps = options.sharedDeps ?? rootConfig?.sharedDeps === true;
  options = { ...options, sharedDeps };
  const multiple = discovered.targets.length > 1;
  if (multiple && (options.bare || options.tarball)) throw new Error("--bare and --tarball require a single target");
  const projects = await Promise.all(discovered.targets.map((pkg) => loadProject({ ...options, path: join(discovered.directory, pkg.path) }, discovered.workspace)));
  for (const project of projects) assertAssetRuntime(project.assetMappings, project.bunPath);
  if (options.baseSBOMs && Object.keys(options.baseSBOMs).some((key) => !projects.some((p) => p.platforms.some((platform) => `${platform.os}/${platform.architecture}` === key)))) throw new Error("Base SBOM map contains an unselected platform");
  if (options.externalDeps && options.externalDepsByTarget) throw new Error("Use --deps-artifact or --deps-map, not both");
  if (options.externalDepsByTarget && Object.keys(options.externalDepsByTarget).some((path) => !projects.some((p) => p.directory === path))) throw new Error("Dependency map contains an unselected target");
  for (const project of projects) {
    const artifacts = options.externalDepsByTarget?.[project.directory] ?? options.externalDeps;
    if (!artifacts) continue;
    if (options.depsVerifyKey && Object.values(artifacts).some((ref) => !/@sha256:[a-f0-9]{64}$/.test(ref) || ref.startsWith("layout:"))) throw new Error("Dependency signature policy requires a digest-pinned registry artifact");
    if (sharedDeps || project.mode === "compile" || !project.external.length || options.externalDeps && multiple) throw new Error("Dependency artifacts require a bundle or source target with runtime dependencies and no sharedDeps");
    const required = project.platforms.map((p) => `${p.os}/${p.architecture}`);
    if (Object.keys(artifacts).length !== required.length || required.some((p) => !artifacts[p])) throw new Error("Supply exactly one dependency artifact for every selected platform");
  }
  assertSharedClosure(projects, sharedDeps, Boolean(discovered.workspace));
  if (new Set(projects.map((project) => project.name.toLowerCase())).size !== projects.length) throw new Error("Workspace image name collision; set distinct bunko.imageName values");
  if (discovered.workspace) for (const pkg of discovered.workspace.packages) {
    validateDependencySpecs(pkg.manifest, discovered.workspace);
    if (pkg.path && ["overrides", "resolutions", "patchedDependencies"].some((key) => pkg.manifest[key] !== undefined)) throw new Error("Workspace overrides/resolutions/patchedDependencies must be configured at the root");
    const installPolicy = await readBunfig(join(discovered.directory, pkg.path));
    if (pkg.path && Object.keys(installPolicy).length) throw new Error("Workspace bunfig install settings must be configured at the root");
    if (pkg.path && await Bun.file(join(discovered.directory, pkg.path, ".npmrc")).exists()) throw new Error("Workspace npm configuration must be in the root .npmrc");
  }
  return { discovered, projects, sharedDeps, multiple, options };
}
