import { ignoredInstallScripts } from "./install-scripts.ts";
import { packageLicense } from "./inventory.ts";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { object } from "../oci/digest.ts";
import type { TarEntry } from "../oci/tar.ts";
import type { Platform } from "../oci/types.ts";
import type { Project } from "./config.ts";
import { AddonLedger, dependencyInputs, includeRuntimeLink, inspectRuntimeFile, packageRoot, type DependencyPlan, type InventoryEntry, type NativeBinary } from "./deps.ts";
import { candidateRuntimeFile, reachableUndeclaredImports, undeclaredImportPolicy, type UndeclaredImport } from "./undeclared-imports.ts";
import type { Toolchain } from "./toolchain.ts";

export const closureDirectory = ".bunko-deps";
/** Projection layout of the content-addressed closure key; bumping it invalidates closure layers and plans alike. */
export const closureStrategy = "closure-v1";

/**
 * A selected target is the root of its own closure: the projection follows edges
 * from the target's declared externals, and the target's own files ship in the
 * application layer, hashed separately. Its source bytes normally cannot change
 * the projected closure, so they are dropped from the plan inputs — otherwise
 * any workspace whose other members declare the target as a dependency (which is
 * exactly what puts the target into `workspaceSources`) would miss the plan on
 * every application edit and re-run the Linux production install and the
 * projection. Workspace packages the closure can reach, such as a shared library
 * listed in `external`, keep their entry. `closureCoversTarget` catches every
 * projection this assumption does not hold for.
 */
export function closureSources(plan: DependencyPlan, projects: Project[]): DependencyPlan {
  const targets = new Set(projects.map((project) => project.targetPath).filter(Boolean));
  if (!plan.workspaceSources || !Object.keys(plan.workspaceSources).some((path) => targets.has(path))) return plan;
  return { ...plan, workspaceSources: Object.fromEntries(Object.entries(plan.workspaceSources).filter(([path]) => !targets.has(path))) };
}

/**
 * True when the projected closure contains any selected target's own package: a workspace
 * dependency cycle (a reachable member depending back on a target) or a self-referencing
 * external reaches one, and under sharedDeps one selected target may externalise another
 * with no cycle at all. The plan key omits the selected targets' sources, so such a closure
 * must be neither planned nor reused; the content-addressed deps key still covers it.
 */
export function closureCoversTarget(packages: Pick<ClosurePackage, "path">[], projects: Project[]): boolean {
  const targets = new Set(projects.map((project) => project.targetPath).filter(Boolean));
  return packages.some((pkg) => targets.has(pkg.path));
}

/**
 * Pre-install identity of a closure: every input that can change the projected
 * bytes, expressed without installing or projecting anything. It reuses the
 * production dependency serialization (manifest fields, full lock, patches,
 * noncredential registry settings, install policy, catalogs, reachable workspace
 * source bytes minus the targets' own, Bun version/revision, platform, base
 * digest, libc) and adds the closure-specific policy inputs. Bun's extracted
 * download cache stays a trusted build input here exactly as it is for
 * production dependency keys.
 */
export function closurePlanInputs(plan: DependencyPlan, toolchain: Toolchain, platform: Platform, base: string, projects: Project[]): Record<string, unknown> {
  return { ...dependencyInputs(closureSources(plan, projects), toolchain, platform, base, projects[0]!), strategy: closureStrategy, closureDirectory,
    targets: projects.map((project) => ({ targetPath: project.targetPath, mode: project.mode, depsStrategy: project.depsStrategy, external: project.external, allowIgnoredScripts: project.allowIgnoredScripts ?? [], undeclaredImports: project.undeclaredImports })),
    undeclaredImports: undeclaredImportPolicy(projects) };
}

/** `files` maps instance-relative paths of the regular files the undeclared-import scan may consult to their sizes; the scan reads only what the entry points reach. */
interface Instance { path: string; manifest: Record<string, unknown>; edges: Map<string, string>; files: Map<string, number>; via: string[]; bytes: number; count: number }
/** One packaged instance. `via` is the first-found dependency path from a declared external, own name last; peer contexts repeat a package as several instances. */
export interface ClosurePackage { name: string; version: string; path: string; bytes: number; files: number; via: string[] }
export interface ClosureDuplicate { name: string; bytes: number; versions: { version: string; instances: number; bytes: number }[] }

/** Group the packages that the closure carries under more than one version, largest total first. */
export function closureDuplicates(packages: ClosurePackage[]): ClosureDuplicate[] {
  const byName = new Map<string, Map<string, { version: string; instances: number; bytes: number }>>();
  for (const pkg of packages) {
    let versions = byName.get(pkg.name);
    if (!versions) { versions = new Map(); byName.set(pkg.name, versions); }
    let record = versions.get(pkg.version);
    if (!record) { record = { version: pkg.version, instances: 0, bytes: 0 }; versions.set(pkg.version, record); }
    record.instances++; record.bytes += pkg.bytes;
  }
  const duplicates: ClosureDuplicate[] = [];
  for (const [name, versions] of byName) {
    if (versions.size < 2) continue;
    const list = [...versions.values()].sort((a, b) => b.bytes - a.bytes || (a.version < b.version ? -1 : 1));
    duplicates.push({ name, bytes: list.reduce((total, version) => total + version.bytes, 0), versions: list });
  }
  return duplicates.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
}

/** Binary units, one decimal above a kibibyte. */
export function byteSize(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** The shared-closure contract: one union layer requires a workspace, the closure strategy everywhere, and identical packaging inputs. */
export function assertSharedClosure(projects: Project[], sharedDeps: boolean, workspace: boolean): void {
  if (!sharedDeps) return;
  if (!workspace || projects.some((project) => project.depsStrategy !== "closure")) throw new Error("sharedDeps requires a workspace and closure strategy for every target");
  if (new Set(projects.map((project) => JSON.stringify(project.allowIgnoredScripts ?? []))).size !== 1) throw new Error("sharedDeps requires matching deps.allowIgnoredScripts policies");
  if (new Set(projects.map((project) => JSON.stringify([project.workdir, project.base, project.platforms]))).size !== 1) throw new Error("sharedDeps requires matching workdir, base, and platforms");
}

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
  async function visit(path: string, via: string[]) {
    if (instances.has(path)) return;
    const manifest = object(JSON.parse(await readFile(join(root, path, "package.json"), "utf8")), "Runtime package.json");
    for (const project of projects) ignoredInstallScripts(manifest, project.allowIgnoredScripts);
    const instance: Instance = { path, manifest, edges: new Map(), files: new Map(), via, bytes: 0, count: 0 };
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
      await visit(target, [...via, name]);
    }
  }
  const roots = new Map<string, Map<string, string>>();
  for (const project of projects) {
    const edges = new Map<string, string>(); roots.set(project.targetPath, edges);
    for (const name of project.external) {
      const target = await resolvePackage(project.targetPath, name);
      if (!target) throw new Error(`External ${name} is absent from the Linux production install`);
      edges.set(name, target); await visit(target, [name]);
      // A declared external explains itself, even when a peer context reached the same instance first.
      instances.get(target)!.via = [name];
    }
  }
  const destination = (path: string) => `${prefix}/${closureDirectory}/${path}`;
  const entries: TarEntry[] = [], inventory: InventoryEntry[] = [], native: NativeBinary[] = [], undeclared: UndeclaredImport[] = [], optionalUndeclared: UndeclaredImport[] = [], packages: ClosurePackage[] = [];
  const ledger = new AddonLedger(platform, root);
  // Each instance resolves only what it declares, so an undeclared bare import that hoisting masks elsewhere fails at runtime here.
  const scan = undeclaredImportPolicy(projects) !== "off";
  async function walk(path: string, instance: Instance) {
    const file = join(root, path), info = await lstat(file);
    if (info.isSymbolicLink()) {
      const target = local(await realpath(file));
      if (![...instances.keys()].some((pkg) => target === pkg || target.startsWith(`${pkg}/`) && !relative(pkg, target).split("/").includes("node_modules"))) throw new Error(`Dependency symlink escapes the selected closure: ${path}`);
      if (!await includeRuntimeLink(file, path, join(root, target), platform, ledger)) return;
      entries.push({ type: "symlink", path: destination(path), target: relative(dirname(destination(path)), destination(target)) });
    } else if (info.isDirectory()) {
      entries.push({ type: "directory", path: destination(path) });
      for (const child of (await readdir(file)).sort()) if (child !== "node_modules") await walk(`${path}/${child}`, instance);
    } else if (info.isFile()) {
      const elf = await inspectRuntimeFile(file, path, platform, ledger);
      if (elf === null) return;
      if (elf) native.push({ ...elf, path: destination(path) });
      entries.push({ type: "file", path: destination(path), source: file, size: info.size, executable: Boolean(info.mode & 0o111) });
      // The walk already visits every packaged file, so per-instance accounting costs no extra I/O.
      instance.bytes += info.size; instance.count++;
      // Only recorded here: symlinks and nested node_modules never enter the map, so the reachability scan cannot follow imports into them.
      if (scan) { const local = relative(instance.path, path); if (candidateRuntimeFile(local)) instance.files.set(local, info.size); }
    } else throw new Error(`Unsupported runtime file: ${path}`);
  }
  async function scanInstance(instance: Instance) {
    const findings = await reachableUndeclaredImports(instance.manifest, instance.files, (file) => readFile(join(root, instance.path, file), "utf8"));
    // Names the package guards itself are carried separately: only the strict policy reports them.
    for (const { name, file, optional } of findings) (optional ? optionalUndeclared : undeclared).push({ code: optional ? "BUNKO_OPTIONAL_IMPORT" : "BUNKO_UNDECLARED_IMPORT", package: String(instance.manifest.name ?? ""), version: String(instance.manifest.version ?? ""), path: instance.path, name, file });
    instance.files.clear();
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
    await walk(path, instance);
    const { name, version } = inventory[inventory.length - 1]!;
    packages.push({ name, version, path, bytes: instance.bytes, files: instance.count, via: instance.via });
    if (scan) await scanInstance(instance);
    entries.push(...aliases(instance.edges, `${destination(path)}/node_modules`));
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  native.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { entries, inventory, native, undeclared, optionalUndeclared, packages, duplicates: closureDuplicates(packages), omitted: ledger.finish(), aliases: new Map([...roots].map(([path, edges]) => [path, aliases(edges, `${prefix}/node_modules`)])) };
}
