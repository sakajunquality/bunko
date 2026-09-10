import { assertToolchain, type ToolchainRequirements } from "./toolchain-policy.ts";
import { assertAssetRuntime, inspectAssetMappings, normalizeAssetContexts, type AssetMapping } from "./asset-contexts.ts";
import { join } from "node:path";
import { VERSION, loadProject, type BuildOptions } from "./config.ts";
import { assertLockToolchain, dependencyPlan } from "./deps.ts";
import { discover } from "./workspace.ts";
import { selectToolchain } from "./toolchain.ts";
import type { FileMode } from "../oci/tar.ts";
import type { Platform } from "../oci/types.ts";

/** One selected target as reported by check-config and doctor. Rendered by diagnostics-format.ts. */
export interface DiagnosticTarget {
  inheritedDefaults: string[];
  lockfileVersion?: number;
  entrypoints?: Record<string, string>;
  defaultEntrypoint?: string;
  assetMappings: AssetMapping[];
  assetInputs: { entries: number; contexts: string[] };
  name: string;
  path: string;
  entrypoint: string;
  mode: "bundle" | "compile" | "source";
  platforms: Platform[];
  dependencyStrategy: "production" | "closure";
  external: string[];
  base?: string;
  user?: string;
  ports?: number[];
  workdir: string;
  runtimePath: string;
  runtimeInjection?: "release";
  assets: string[];
  runtimeCertificateCount: number;
  assetExcludes: string[];
  assetMode?: FileMode;
  toolchainRequirements: ToolchainRequirements;
  runtimeArgumentCount: number;
  environmentKeys: string[];
  defineKeys: string[];
  unmatchedAllowances: string[];
}

/** Offline configuration diagnostics. Never expose env, define or npmrc values. */
export async function checkConfig(options: BuildOptions) {
  const contexts = normalizeAssetContexts(options.assetContexts);
  const discovery = await discover(options);
  const projects: DiagnosticTarget[] = [];
  for (const target of discovery.targets) {
    const project = await loadProject({ ...options, path: join(discovery.directory, target.path) }, discovery.workspace);
    const plan = await dependencyPlan(project, discovery.directory, false);
    assertAssetRuntime(project.assetMappings, project.bunPath);
    const assetInputs = await inspectAssetMappings(project.assetMappings, contexts);
    const locked = lockedPackageNames(plan.lock), unmatchedAllowances = (project.allowIgnoredScripts ?? []).filter((name) => !locked.has(name));
    projects.push({ inheritedDefaults: project.inheritedDefaults, lockfileVersion: plan.lock?.lockfileVersion as number | undefined, entrypoints: project.entrypoints, defaultEntrypoint: project.defaultEntrypoint, assetMappings: project.assetMappings, assetInputs, name: project.name, path: target.path || ".", entrypoint: project.entrypoint, mode: project.mode,
      platforms: project.platforms, dependencyStrategy: project.depsStrategy, external: project.external, base: project.base, user: project.user, ports: project.ports,
      workdir: project.workdir, runtimePath: project.bunPath, runtimeInjection: project.runtimeInject, assets: project.assets,
      runtimeCertificateCount: project.runtimeCAs.length, assetExcludes: project.assetExcludes, assetMode: project.assetMode, toolchainRequirements: project.toolchainRequirements, runtimeArgumentCount: project.runtimeArgs.length,
      environmentKeys: Object.keys(project.env).sort(), defineKeys: Object.keys(project.build.define).sort(), unmatchedAllowances });
  }
  if (new Set(projects.map((project) => project.name)).size !== projects.length) throw new Error("Selected targets have an image name collision");
  return { schemaVersion: 1, status: "valid", bunko: VERSION, workspace: Boolean(discovery.workspace), targets: projects,
    unchecked: ["project asset availability and generated build outputs", "asset collisions with bundled output and runtime dependencies", "source syntax, bundling and module-relative runtime file access", "dependency installation and native compatibility", "base image runtime", "registry credentials and connectivity"] };
}

/** Resolved package names in a validated bun.lock; an allowance naming none of them is probably a typo. */
function lockedPackageNames(lock: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  for (const record of Object.values(lock?.packages && typeof lock.packages === "object" ? lock.packages as Record<string, unknown> : {})) {
    const id = Array.isArray(record) && typeof record[0] === "string" ? record[0] : "";
    names.add(id.includes("@workspace:") ? id.split("@workspace:")[0]! : id.slice(0, id.lastIndexOf("@")));
  }
  return names;
}

export async function doctor(options: BuildOptions) {
  const config = await checkConfig(options), toolchain = await selectToolchain(options.bunPath);
  for (const project of config.targets) {
    assertToolchain(project.toolchainRequirements, toolchain);
    assertLockToolchain({ lock: { lockfileVersion: project.lockfileVersion } }, toolchain);
  }
  return { ...config, toolchain: { version: toolchain.version, revision: toolchain.revision, path: toolchain.path },
    host: { os: process.platform, architecture: process.arch, runtime: Bun.version },
    optionalTools: Object.fromEntries(["docker", "kubectl", "cosign", "gpgv"].map((name) => [name, Boolean(Bun.which(name === "cosign" ? options.cosignPath ?? name : name))])),
    advice: ["Use check-base --run to verify a base in Docker.", "Use build --push=false --oci-layout DIR for a complete local build check."] };
}
