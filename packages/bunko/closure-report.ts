import { assertSharedClosure, byteSize, dependencyClosure, type ClosureDuplicate, type ClosurePackage } from "./closure.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, loadProject, type BuildOptions } from "./config.ts";
import { assertLockToolchain, dependencyPlan, installDependencies } from "./deps.ts";
import { requiredInputs } from "./ignore.ts";
import { snapshot } from "./files.ts";
import { installCachePath } from "./install-cache.ts";
import { assertToolchain } from "./toolchain-policy.ts";
import { selectToolchain } from "./toolchain.ts";
import { discover } from "./workspace.ts";

export interface ClosureTarget { name: string; path: string; strategy: "production" | "closure"; shared: boolean; bytes: number; files: number; packages: ClosurePackage[]; duplicates: ClosureDuplicate[] }
export interface ClosureReport { schemaVersion: 1; bunko: string; platform: string; notes: string[]; targets: ClosureTarget[] }

/**
 * Enumerate what the dependency closure would package, with per-instance sizes
 * and the dependency path that pulls each instance in. The numbers come from a
 * real Linux production install of the project's own lockfile over the same
 * source snapshot a build takes — the host install is never measured — so the
 * command needs package registry access but never reads or writes an image
 * registry and never publishes anything.
 */
export async function closureReport(options: BuildOptions): Promise<ClosureReport> {
  const discovery = await discover(options);
  const rootConfig = discovery.workspace?.packages[0]?.manifest.bunko as Record<string, unknown> | undefined;
  if (rootConfig?.sharedDeps !== undefined && typeof rootConfig.sharedDeps !== "boolean") throw new Error("sharedDeps must be boolean");
  // Resolve sharing before loading targets, because it selects the closure strategy exactly as a build does.
  const sharedDeps = options.sharedDeps ?? rootConfig?.sharedDeps === true;
  options = { ...options, sharedDeps };
  const projects = await Promise.all(discovery.targets.map((pkg) => loadProject({ ...options, path: join(discovery.directory, pkg.path) }, discovery.workspace)));
  assertSharedClosure(projects, sharedDeps, Boolean(discovery.workspace));
  const platform = projects[0]!.platform;
  if (projects.some((project) => project.platforms.length !== 1 || project.platform.os !== platform.os || project.platform.architecture !== platform.architecture)) {
    throw new Error(`Closure diagnostics report one platform; select it with --platform, for example --platform ${platform.os}/${platform.architecture}`);
  }
  const toolchain = await selectToolchain(options.bunPath);
  for (const project of projects) assertToolchain(project.toolchainRequirements, toolchain);
  const notes: string[] = [];
  for (const project of projects.filter((p) => p.depsStrategy === "production")) notes.push(`${project.name} uses deps.strategy production: the image ships the whole Linux production install, and the closure reported here is what deps.strategy closure would package instead.`);
  for (const project of projects.filter((p) => !p.external.length)) notes.push(`${project.name} declares no bunko.external packages, so its runtime closure is empty; dependencies are bundled into the application layer.`);
  const installCache = await installCachePath(options);
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "bunko-closure-"));
  try {
    // Snapshot exactly as a build does, so .bunkoignore, excluded names, symlink
    // rejection and required inputs decide the measured bytes; a diagnostic never
    // writes into the project.
    const root = join(temporary, "source"), assetExclusions: string[] = [], exclusions = installCache ? [installCache] : [];
    const required = await requiredInputs(discovery.directory, projects, exclusions, assetExclusions);
    await snapshot(discovery.directory, root, exclusions, undefined, projects.filter((project) => project.dataPath).map((project) => join(project.targetPath, "bunkodata")), required, assetExclusions, projects.some((project) => project.mode === "source"));
    const plan = await dependencyPlan(projects[0]!, root, true);
    assertLockToolchain(plan, toolchain);
    await installDependencies(root, plan, toolchain, platform, installCache);
    const targets: ClosureTarget[] = [];
    for (const group of sharedDeps ? [projects] : projects.map((project) => [project])) {
      const content = await dependencyClosure(root, group[0]!.workdir.slice(1), platform, group);
      const bytes = content.packages.reduce((total, pkg) => total + pkg.bytes, 0), files = content.packages.reduce((total, pkg) => total + pkg.files, 0);
      for (const project of group) targets.push({ name: project.name, path: project.targetPath || ".", strategy: project.depsStrategy, shared: sharedDeps, bytes, files, packages: content.packages, duplicates: content.duplicates });
    }
    return { schemaVersion: 1, bunko: VERSION, platform: `${platform.os}/${platform.architecture}`, notes, targets: targets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Keep only the instances of one package, with totals recomputed for them; an absent package is an error, so scripts can branch on the exit code. */
export function whyPackage(report: ClosureReport, name: string): ClosureReport {
  const targets = report.targets.map((target) => {
    const packages = target.packages.filter((pkg) => pkg.name === name);
    return { ...target, bytes: packages.reduce((total, pkg) => total + pkg.bytes, 0), files: packages.reduce((total, pkg) => total + pkg.files, 0), packages, duplicates: target.duplicates.filter((item) => item.name === name) };
  });
  if (!targets.some((target) => target.packages.length)) throw new Error(`${name} is not in the dependency closure of ${report.targets.map((target) => target.name).join(", ")}`);
  return { ...report, targets };
}

/** Fixed-width columns; `right` names the columns padded on the left, and the last column is never padded. */
function table(rows: string[][], right: number[] = []): string {
  const width = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : right.includes(column) ? cell.padStart(width[column]!) : cell.padEnd(width[column]!)).join("  ").trimEnd() + "\n").join("");
}

const heading = (target: ClosureTarget, report: ClosureReport) => `${target.name} (${target.path}) — ${report.platform}, deps.strategy ${target.strategy}${target.shared ? ", shared closure" : ""}\n`;
const source = (pkg: ClosurePackage) => pkg.via.length > 1 ? pkg.via.slice(0, -1).join(" > ") : "(declared external)";

export function formatClosureInfo(report: ClosureReport, top: number): string {
  let output = "";
  for (const target of report.targets) {
    output += heading(target, report);
    output += `${target.packages.length} packages, ${byteSize(target.bytes)}, ${target.files} files; ${target.duplicates.length} duplicated package(s)\n`;
    const largest = [...target.packages].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, top);
    if (largest.length) {
      output += `\nLargest packages (${largest.length} of ${target.packages.length})\n`;
      output += table([["SIZE", "FILES", "PACKAGE", "VERSION", "VIA"], ...largest.map((pkg) => [byteSize(pkg.bytes), String(pkg.files), pkg.name, pkg.version, source(pkg)])], [0, 1]);
    }
    if (target.duplicates.length) {
      output += "\nDuplicate versions (largest first)\n";
      output += table([["SIZE", "PACKAGE", "VERSIONS"], ...target.duplicates.map((item) => [byteSize(item.bytes), item.name,
        item.versions.map((version) => `${version.version} (${byteSize(version.bytes)}${version.instances > 1 ? `, ${version.instances} instances` : ""})`).join(", ")])], [0]);
    }
    output += "\n";
  }
  for (const note of report.notes) output += `Note: ${note}\n`;
  if (report.targets.some((target) => target.duplicates.length)) output += "Trim duplicates with package.json overrides, a dependency update, or a narrower bunko.external; see docs/APPLICATION_COMPATIBILITY.md.\n";
  return output;
}

export function formatWhy(report: ClosureReport, name: string): string {
  let output = "";
  for (const target of report.targets) {
    output += `${name} in ${heading(target, report)}`;
    output += `${target.packages.length} instance(s), ${byteSize(target.bytes)}\n`;
    if (target.packages.length) output += table([["VERSION", "SIZE", "FILES", "PATH", "VIA"], ...target.packages.map((pkg) => [pkg.version, byteSize(pkg.bytes), String(pkg.files), pkg.path, source(pkg)])], [1, 2]);
    output += "\n";
  }
  for (const note of report.notes) output += `Note: ${note}\n`;
  return output;
}
