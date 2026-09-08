import { assertToolchain } from "./toolchain-policy.ts";
import { assertAssetRuntime, inspectAssetMappings, normalizeAssetContexts } from "./asset-contexts.ts";
import { join } from "node:path";
import { VERSION, loadProject, type BuildOptions } from "./config.ts";
import { dependencyPlan } from "./deps.ts";
import { discover } from "./workspace.ts";
import { selectToolchain } from "./toolchain.ts";

/** Offline configuration diagnostics. Never expose env, define or npmrc values. */
export async function checkConfig(options: BuildOptions) {
  const contexts = normalizeAssetContexts(options.assetContexts);
  const discovery = await discover(options);
  const projects = [];
  for (const target of discovery.targets) {
    const project = await loadProject({ ...options, path: join(discovery.directory, target.path) }, discovery.workspace);
    await dependencyPlan(project, discovery.directory, false);
    assertAssetRuntime(project.assetMappings, project.bunPath);
    const assetInputs = await inspectAssetMappings(project.assetMappings, contexts);
    projects.push({ entrypoints: project.entrypoints, defaultEntrypoint: project.defaultEntrypoint, assetMappings: project.assetMappings, assetInputs, name: project.name, path: target.path || ".", entrypoint: project.entrypoint, mode: project.mode,
      platforms: project.platforms, dependencyStrategy: project.depsStrategy, external: project.external,
      workdir: project.workdir, runtimePath: project.bunPath, runtimeInjection: project.runtimeInject, assets: project.assets,
      runtimeCertificateCount: project.runtimeCAs.length, assetExcludes: project.assetExcludes, assetMode: project.assetMode, toolchainRequirements: project.toolchainRequirements, runtimeArgumentCount: project.runtimeArgs.length,
      environmentKeys: Object.keys(project.env).sort(), defineKeys: Object.keys(project.build.define).sort() });
  }
  if (new Set(projects.map((project) => project.name)).size !== projects.length) throw new Error("Selected targets have an image name collision");
  return { schemaVersion: 1, status: "valid", bunko: VERSION, workspace: Boolean(discovery.workspace), targets: projects,
    unchecked: ["project asset availability and generated build outputs", "asset collisions with bundled output and runtime dependencies", "source syntax, bundling and module-relative runtime file access", "dependency installation and native compatibility", "base image runtime", "registry credentials and connectivity"] };
}

export async function doctor(options: BuildOptions) {
  const config = await checkConfig(options), toolchain = await selectToolchain(options.bunPath);
  for (const project of config.targets) assertToolchain(project.toolchainRequirements, toolchain);
  return { ...config, toolchain: { version: toolchain.version, revision: toolchain.revision },
    host: { os: process.platform, architecture: process.arch, runtime: Bun.version },
    optionalTools: Object.fromEntries(["docker", "kubectl", "cosign", "gpgv"].map((name) => [name, Boolean(Bun.which(name === "cosign" ? options.cosignPath ?? name : name))])),
    advice: ["Use check-base --run to verify a base in Docker.", "Use build --push=false --oci-layout DIR for a complete local build check."] };
}
