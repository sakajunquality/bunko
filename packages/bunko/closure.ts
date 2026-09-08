import { ignoredInstallScripts } from "./install-scripts.ts";
import { packageLicense } from "./inventory.ts";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { object } from "../oci/digest.ts";
import type { TarEntry } from "../oci/tar.ts";
import type { Platform } from "../oci/types.ts";
import type { Project } from "./config.ts";
import { AddonLedger, includeRuntimeLink, inspectRuntimeFile, packageRoot, type InventoryEntry, type NativeBinary } from "./deps.ts";

export const closureDirectory = ".bunko-deps";
interface Instance { path: string; manifest: Record<string, unknown>; edges: Map<string, string> }

/** Project the concrete Linux install, including Bun's peer contexts. No version
 * selection occurs here: every edge is resolved against the installed tree. */
export async function dependencyClosure(root: string, prefix: string, platform: Platform, projects: Project[]) {
  root = await realpath(root);
  function local(path: string) {
    const value = relative(root, path);
    if (isAbsolute(value) || value === ".." || value.startsWith("../")) throw new Error("Dependency link escapes the installed tree");
    return value;
  }
  async function resolvePackage(from: string, name: string): Promise<string | undefined> {
    if (packageRoot(name) !== name) throw new Error(`Invalid dependency name: ${name}`);
    let directory = join(root, from);
    while (true) {
      if (directory.split("/").at(-1) !== "node_modules") {
        const candidate = join(directory, "node_modules", name);
        try {
          await lstat(candidate);
          // A present but dangling link is an error, including optional deps.
          return local(await realpath(candidate));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try { await lstat(candidate); } catch { if (directory === root) break; directory = dirname(directory); continue; }
          throw new Error(`Dangling dependency link: ${from} -> ${name}`);
        }
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
    return undefined;
  }
  const instances = new Map<string, Instance>();
  async function visit(path: string) {
    if (instances.has(path)) return;
    const manifest = object(JSON.parse(await readFile(join(root, path, "package.json"), "utf8")), "Runtime package.json");
    for (const project of projects) ignoredInstallScripts(manifest, project.allowIgnoredScripts);
    const instance: Instance = { path, manifest, edges: new Map() };
    instances.set(path, instance);
    const required = object(manifest.dependencies ?? {}, "dependencies");
    const optional = object(manifest.optionalDependencies ?? {}, "optionalDependencies");
    const peers = object(manifest.peerDependencies ?? {}, "peerDependencies");
    const peerMeta = object(manifest.peerDependenciesMeta ?? {}, "peerDependenciesMeta");
    for (const name of Object.keys({ ...required, ...optional, ...peers }).sort()) {
      const target = await resolvePackage(path, name);
      const mayBeAbsent = Object.hasOwn(optional, name) || (!Object.hasOwn(required, name) && object(peerMeta[name] ?? {}, "peer metadata").optional === true);
      if (!target) { if (mayBeAbsent) continue; throw new Error(`Missing runtime dependency: ${path} -> ${name}`); }
      instance.edges.set(name, target);
      await visit(target);
    }
  }
  const roots = new Map<string, Map<string, string>>();
  for (const project of projects) {
    const edges = new Map<string, string>(); roots.set(project.targetPath, edges);
    for (const name of project.external) {
      const target = await resolvePackage(project.targetPath, name);
      if (!target) throw new Error(`External ${name} is absent from the Linux production install`);
      edges.set(name, target); await visit(target);
    }
  }
  const destination = (path: string) => `${prefix}/${closureDirectory}/${path}`;
  const entries: TarEntry[] = [], inventory: InventoryEntry[] = [], native: NativeBinary[] = [];
  const ledger = new AddonLedger(platform, root);
  async function walk(path: string) {
    const file = join(root, path), info = await lstat(file);
    if (info.isSymbolicLink()) {
      const target = local(await realpath(file));
      if (![...instances.keys()].some((pkg) => target === pkg || target.startsWith(`${pkg}/`) && !relative(pkg, target).split("/").includes("node_modules"))) throw new Error(`Dependency symlink escapes the selected closure: ${path}`);
      if (!await includeRuntimeLink(file, path, join(root, target), platform, ledger)) return;
      entries.push({ type: "symlink", path: destination(path), target: relative(dirname(destination(path)), destination(target)) });
    } else if (info.isDirectory()) {
      entries.push({ type: "directory", path: destination(path) });
      for (const child of (await readdir(file)).sort()) if (child !== "node_modules") await walk(`${path}/${child}`);
    } else if (info.isFile()) {
      const elf = await inspectRuntimeFile(file, path, platform, ledger);
      if (elf === null) return;
      if (elf) native.push({ ...elf, path: destination(path) });
      entries.push({ type: "file", path: destination(path), source: file, size: info.size, executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Unsupported runtime file: ${path}`);
  }
  function aliases(edges: Map<string, string>, modules: string): TarEntry[] {
    const result: TarEntry[] = [];
    for (const [name, target] of edges) {
      const path = `${modules}/${name}`;
      // Bundled dependencies already occupy their resolved nested path.
      if (path !== destination(target)) result.push({ type: "symlink", path, target: relative(dirname(path), destination(target)) });
    }
    // Preserve dependency executables without copying unrelated .bin entries.
    const bins = new Map<string, string>();
    for (const target of edges.values()) {
      const pkg = instances.get(target)!.manifest;
      const declared = typeof pkg.bin === "string" ? { [String(pkg.name).split("/").at(-1)!]: pkg.bin } : object(pkg.bin ?? {}, "bin");
      for (const [name, file] of Object.entries(declared)) {
        if (!name || /[/\\\x00-\x1f]/.test(name) || name === "." || name === ".." || typeof file !== "string" || isAbsolute(file) || file.includes("\\") || file.split("/").includes("..")) throw new Error("Unsafe runtime bin entry");
        const value = destination(join(target, file));
        if (bins.has(name) && bins.get(name) !== value) throw new Error(`Ambiguous runtime bin: ${name}`);
        bins.set(name, value);
      }
    }
    for (const [name, target] of bins) result.push({ type: "symlink", path: `${modules}/.bin/${name}`, target: relative(`${modules}/.bin`, target) });
    return result;
  }
  for (const [path, instance] of [...instances].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    inventory.push({ path, name: String(instance.manifest.name ?? ""), version: String(instance.manifest.version ?? ""), license: packageLicense(instance.manifest.license) });
    const hooks = ignoredInstallScripts(instance.manifest, projects[0]?.allowIgnoredScripts);
    if (hooks.length) inventory[inventory.length - 1]!.ignoredInstallScripts = hooks;
    await walk(path);
    entries.push(...aliases(instance.edges, `${destination(path)}/node_modules`));
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  native.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { entries, inventory, native, omitted: ledger.finish(), aliases: new Map([...roots].map(([path, edges]) => [path, aliases(edges, `${prefix}/node_modules`)])) };
}
