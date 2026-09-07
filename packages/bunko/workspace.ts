import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { object } from "../oci/digest.ts";
import type { BuildOptions } from "./config.ts";

export interface WorkspacePackage {
  path: string;
  text: string;
  manifest: Record<string, unknown>;
}
export interface Workspace {
  directory: string;
  packages: WorkspacePackage[]; // root first, then members in path order
}

export async function readPackage(directory: string, path = ""): Promise<WorkspacePackage> {
  const text = await readFile(join(directory, path, "package.json"), "utf8");
  return { path, text, manifest: object(JSON.parse(text), "package.json") };
}

// Glob.scan accepts leading ./ segments, but Glob.match does not. Use the
// same spelling for discovery and membership checks without resolving globs.
function workspacePattern(pattern: string): string {
  return pattern.replace(/^(?:\.\/+)+/, "").replace(/\/+$/, "") || ".";
}

export async function workspaceAt(directory: string, root: WorkspacePackage): Promise<Workspace> {
  const patterns = root.manifest.workspaces;
  if (!Array.isArray(patterns) || !patterns.length || !patterns.every((p) => typeof p === "string" && p && !isAbsolute(p) && !/[\\\0]/.test(p) && !p.split("/").includes("..") && !p.startsWith("!"))) throw new Error("M2a requires a non-empty workspaces array of relative, positive glob patterns");
  const paths = new Set<string>();
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(`${workspacePattern(pattern)}/package.json`).scan({ cwd: directory, dot: false, followSymlinks: false })) {
      if (path.split("/").some((p) => ["node_modules", ".git", ".bunko-output", ".bunko-build"].includes(p))) continue;
      const member = dirname(path);
      if (member === ".") throw new Error("A workspace cannot include its own root as a member");
      if (await realpath(join(directory, member)) !== join(directory, member)) throw new Error("Workspace member paths must not contain symlinks");
      paths.add(member);
    }
  }
  const packages = [root];
  const names = new Set<string>();
  for (const path of [...paths].sort()) {
    if ([...paths].some((other) => path !== other && path.startsWith(`${other}/`))) throw new Error("Nested workspace members are not supported in M2a");
    const pkg = await readPackage(directory, path);
    const name = pkg.manifest.name;
    if (typeof name !== "string" || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) || names.has(name)) throw new Error(`Workspace members require unique package names: ${path}`);
    if (pkg.manifest.workspaces !== undefined) throw new Error("Nested workspace roots are not supported in M2a");
    names.add(name);
    packages.push(pkg);
  }
  if (!paths.size) throw new Error("Workspace patterns matched no packages");
  return { directory, packages };
}

/** Find the enclosing declared workspace, even when invoked from a member. */
export async function discover(options: BuildOptions): Promise<{ directory: string; workspace?: Workspace; targets: WorkspacePackage[] }> {
  const directory = await realpath(resolve(options.path.replace(/^bunko:\/\//, "")));
  const selected = await readPackage(directory);
  let cursor = directory;
  while (true) {
    let pkg: WorkspacePackage | undefined;
    try { pkg = cursor === directory ? selected : await readPackage(cursor); }
    catch { /* An unreadable or malformed ancestor cannot establish membership. */ }
    const localPath = relative(cursor, directory);
    const patterns = pkg?.manifest.workspaces;
    const declared = cursor === directory || Array.isArray(patterns) && patterns.some((pattern) => typeof pattern === "string" && new Bun.Glob(workspacePattern(pattern)).match(localPath));
    if (pkg?.manifest.workspaces !== undefined && declared) {
      const workspace = await workspaceAt(cursor, pkg);
      const local = relative(cursor, directory);
      const member = workspace.packages.find((p) => p.path === local);
      if (!member) throw new Error("Selected path is not a declared workspace member");
      if (options.targets?.length) {
        if (local) throw new Error("--target must be used with the workspace root");
        const chosen = options.targets.map((selector) => {
          const path = selector.replace(/^\.\//, "").replace(/\/$/, "");
          const matches = workspace.packages.filter((p) => p.path === (path === "." ? "" : path) || p.manifest.name === selector);
          if (matches.length !== 1) throw new Error(`Unknown or ambiguous workspace target: ${selector}`);
          return matches[0]!;
        });
        return { directory: cursor, workspace, targets: [...new Set(chosen)].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
      }
      if (local) return { directory: cursor, workspace, targets: [member] };
      const enabled = workspace.packages.slice(1).filter((p) => p.manifest.bunko === undefined || object(p.manifest.bunko, "bunko").enabled !== false);
      const explicit = enabled.filter((p) => p.manifest.bunko !== undefined);
      const targets = explicit.length ? explicit : enabled.filter((p) => p.manifest.bin !== undefined || p.manifest.module !== undefined);
      if (!targets.length) throw new Error("Workspace has no enabled build targets; set bunko or use --target");
      return { directory: cursor, workspace, targets };
    }
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  if (options.targets?.length) throw new Error("--target requires a workspace root");
  return { directory, targets: [selected] };
}
