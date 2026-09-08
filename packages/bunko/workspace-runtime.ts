import { ignoredInstallScripts } from "./install-scripts.ts";
import { packageLicense } from "./inventory.ts";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { object } from "../oci/digest.ts";
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { Platform } from "../oci/types.ts";
import type { Project } from "./config.ts";
import { AddonLedger, includeRuntimeLink, inspectRuntimeFile, type DependencyPlan, type InventoryEntry, type NativeBinary } from "./deps.ts";

export const workspaceDirectory = ".bunko-workspace";

/** Keep Bun's installed topology under a private directory; expose only the
 * target's explicit external roots next to the emitted application. */
export async function workspaceRuntime(root: string, prefix: string, platform: Platform, plan: DependencyPlan, project: Project) {
  root = await realpath(root);
  const workspace = plan.workspace!;
  const entries: TarEntry[] = [], inventory: InventoryEntry[] = [], native: NativeBinary[] = [];
  const ledger = new AddonLedger(platform, root);
  const seen = new Set<string>();
  const sourcePaths = Object.keys(plan.workspaceSources ?? {});
  const modulePaths = workspace.packages.map((pkg) => pkg.path ? `${pkg.path}/node_modules` : "node_modules");
  const admitted = (path: string) => [...modulePaths, ...sourcePaths].some((part) => path === part || path.startsWith(`${part}/`));
  async function walk(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const file = join(root, path), info = await lstat(file);
    const destination = `${prefix}/${workspaceDirectory}/${path}`;
    archivePath(destination);
    if (info.isSymbolicLink()) {
      const target = await realpath(file), local = relative(root, target);
      if (!admitted(local) || isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error(`Workspace dependency symlink escapes the packaged runtime: ${path}`);
      if (!await includeRuntimeLink(file, path, target, platform, ledger)) return;
      entries.push({ type: "symlink", path: destination, target: relative(dirname(file), target) });
    } else if (info.isDirectory()) {
      entries.push({ type: "directory", path: destination });
      for (const child of (await readdir(file)).sort()) await walk(`${path}/${child}`);
    } else if (info.isFile()) {
      if (path.endsWith("/package.json")) {
        const pkg = object(JSON.parse(await readFile(file, "utf8")), "Runtime package.json");
        if (typeof pkg.name === "string") {
          inventory.push({ path: dirname(path), name: pkg.name, version: typeof pkg.version === "string" ? pkg.version : "", license: packageLicense(pkg.license) });
          const hooks = ignoredInstallScripts(pkg, project.allowIgnoredScripts);
          if (hooks.length) inventory[inventory.length - 1]!.ignoredInstallScripts = hooks;
        }
      }
      const elf = await inspectRuntimeFile(file, path, platform, ledger);
      if (elf === null) return;
      if (elf) native.push({ ...elf, path: destination });
      entries.push({ type: "file", path: destination, source: file, size: info.size, executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Unsupported runtime file: ${path}`);
  }
  for (const path of [...modulePaths, ...sourcePaths].sort()) {
    try { await lstat(join(root, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && modulePaths.includes(path)) continue; throw error; }
    await walk(path);
  }
  for (const name of project.external) {
    let directory = join(root, project.targetPath), target: string | undefined;
    while (true) {
      try { target = await realpath(join(directory, "node_modules", name)); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (directory === root) break;
      directory = dirname(directory);
    }
    if (!target || !admitted(relative(root, target))) throw new Error(`External ${name} is absent from the Linux production install`);
    const destination = `${prefix}/node_modules/${name}`;
    entries.push({ type: "symlink", path: destination, target: relative(dirname(destination), `${prefix}/${workspaceDirectory}/${relative(root, target)}`) });
  }
  inventory.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  native.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { entries, inventory, native, omitted: ledger.finish() };
}
