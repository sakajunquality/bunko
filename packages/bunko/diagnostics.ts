import { configurationPlan } from "./configuration-plan.ts";
import { lstat } from "node:fs/promises";
import { snapshot } from "./files.ts";
import { requiredInputs } from "./ignore.ts";
import { assertToolchain, type ToolchainRequirements } from "./toolchain-policy.ts";
import { inspectAssetMappings, normalizeAssetContexts, type AssetMapping } from "./asset-contexts.ts";
import { join } from "node:path";
import { VERSION, type BuildOptions } from "./config.ts";
import { assertLockToolchain, dependencyPlan } from "./deps.ts";
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
  assetInputs: { entries: number; contexts: string[]; external: number };
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
  runtimeSystemCaTrust: boolean;
  explicitAssetsOverrideGitignore: boolean;
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
  const { discovered: discovery, projects: selected } = await configurationPlan(options);
  const projects: DiagnosticTarget[] = [];
  for (const [index, project] of selected.entries()) {
    const target = discovery.targets[index]!;
    // The project directory is a working tree, not a build snapshot, so the plan is
    // taken without workspace source digests: hashing members here walked files no
    // build packages (node_modules, .git, ignored and asset-excluded paths) and failed
    // on the symlinks bun install leaves behind. --deep validates the source tree with
    // the build's own walker below, which is the only place the exclusions are known.
    const plan = await dependencyPlan(project, discovery.directory, false, undefined, false);
    const assetInputs = await inspectAssetMappings(project.assetMappings, contexts, options.deep);
    if (options.deep) {
      const assetExclusions: string[] = [], explicitAssets = new Set<string>();
      const required = await requiredInputs(discovery.directory, [project], [], assetExclusions, explicitAssets);
      for (const entry of Object.values(project.entrypoints ?? { default: project.entrypoint })) {
        const file = join(project.directory, entry);
        const info = await lstat(file).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Entrypoint must be a regular file: ${entry}`);
      }
      await snapshot(discovery.directory, "", [], undefined, project.dataPath ? [join(project.targetPath, "bunkodata")] : [], required, assetExclusions, project.mode === "source", explicitAssets, true);
    }
    const locked = lockedPackageNames(plan.lock), unmatchedAllowances = (project.allowIgnoredScripts ?? []).filter((name) => !locked.has(name));
    projects.push({ inheritedDefaults: project.inheritedDefaults, lockfileVersion: plan.lock?.lockfileVersion as number | undefined, entrypoints: project.entrypoints, defaultEntrypoint: project.defaultEntrypoint, assetMappings: project.assetMappings, assetInputs, name: project.name, path: target.path || ".", entrypoint: project.entrypoint, mode: project.mode,
      platforms: project.platforms, dependencyStrategy: project.depsStrategy, external: project.external, base: project.base, user: project.user, ports: project.ports,
      workdir: project.workdir, runtimePath: project.bunPath, runtimeInjection: project.runtimeInject, assets: project.assets,
      runtimeCertificateCount: project.runtimeCAs.length, runtimeSystemCaTrust: project.runtimeSystemCaTrust, explicitAssetsOverrideGitignore: project.mode === "source", assetExcludes: project.assetExcludes, assetMode: project.assetMode, toolchainRequirements: project.toolchainRequirements, runtimeArgumentCount: project.runtimeArgs.length,
      environmentKeys: Object.keys(project.env).sort(), defineKeys: Object.keys(project.build.define).sort(), unmatchedAllowances });
  }
  return { schemaVersion: 1, status: "valid", depth: options.deep ? "deep" : "configuration", bunko: VERSION, workspace: Boolean(discovery.workspace), targets: projects,
    unchecked: [...(options.deep ? ["remote image/URL asset contents (not fetched); future generated outputs"] : ["project asset availability and generated build outputs"]), "asset collisions with bundled output and runtime dependencies", "source syntax, bundling and module-relative runtime file access", "dependency installation and native compatibility", "base image runtime", "registry credentials and connectivity"] };
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
