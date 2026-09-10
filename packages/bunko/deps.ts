import { validateInstallCertificates, npmCertificate, installNetworkEnvironment, type NpmCertificate } from "./install-network.ts";
import { ignoredInstallScripts } from "./install-scripts.ts";
import { installerCredentials, installerOutputTail } from "./install-diagnostics.ts";
import { readBunfig, installConfig, type InstallPolicy } from "./bunfig.ts";
import { catalogs } from "./catalogs.ts";
import { packageLicense } from "./inventory.ts";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJSON, object, sha256 } from "../oci/digest.ts";
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { Platform } from "../oci/types.ts";
import type { Workspace } from "./workspace.ts";
import type { Project } from "./config.ts";
import { fileEntries, hashFile, OUTPUT_DIRECTORY } from "./files.ts";
import { mapFiles } from "./concurrency.ts";
import type { Toolchain } from "./toolchain.ts";

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
export interface DependencyPlan { npmCertificate?: NpmCertificate; installPolicy?: InstallPolicy; manifest: Record<string, unknown>; workspace?: Workspace; workspaceSources?: Record<string, string>; lock?: Record<string, unknown>; npmrc?: string; registry: string; resolution: Record<string, string>; patches: Record<string, string> }
export interface InventoryEntry { path: string; name: string; version: string; license?: string; ignoredInstallScripts?: string[] }
export interface NativeBinary { path: string; architecture: string; needed: string[] }
export interface OmittedAddon { path: string; reason: "foreign-format" | "foreign-architecture" }

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const elfMachine = (platform: Platform) => platform.architecture === "amd64" ? 62 : 183;

/**
 * Packages such as @temporalio/core-bridge or snowflake-sdk ship one prebuilt
 * `.node` per supported platform inside a single tree and select one at
 * runtime. Only the target's little-endian ELF64 addon is packaged; a `.node`
 * file in a recognized foreign format or architecture cannot load on the target, so
 * it is omitted from the image instead of failing the build.
 */
export async function classifyAddon(path: string, platform: Platform): Promise<{ elf?: NativeBinary; omit?: OmittedAddon["reason"] }> {
  const file = await open(path, "r");
  const header = Buffer.alloc(64);
  let bytesRead: number;
  try { ({ bytesRead } = await file.read(header, 0, header.length, 0)); } finally { await file.close(); }
  if (!header.subarray(0, 4).equals(ELF_MAGIC)) {
    const magic = header.subarray(0, 4).toString("hex");
    const macho = ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
    const windows = bytesRead >= 2 && header.subarray(0, 2).toString() === "MZ";
    if (macho || windows) return { omit: "foreign-format" };
    throw new Error(`Unrecognized native addon format: ${path}`);
  }
  if (![1, 2].includes(header[4]!) || ![1, 2].includes(header[5]!) || bytesRead < (header[4] === 1 ? 52 : 64)) throw new Error(`Invalid native ELF header: ${path}`);
  if (header[4] !== 2 || header[5] !== 1 || ![0, 3].includes(header[7]!)) return { omit: "foreign-format" };
  if (header.readUInt16LE(18) !== elfMachine(platform)) return { omit: "foreign-architecture" };
  if (header.readUInt16LE(16) !== 3) throw new Error(`Native addon must be an ELF shared object: ${path}`);
  return { elf: await inspectELF(path, platform) };
}

/** Records packaged and omitted `.node` files per package; a package that ships addons but none for the target still fails. */
export class AddonLedger {
  private readonly packages = new Map<string, { kept: number; omitted: OmittedAddon[] }>();
  constructor(private readonly platform: Platform, private readonly root: string) {}
  private async entry(file: string, path: string) {
    // Unnamed package.json files only establish module scope, not package ownership.
    // Never consult manifests outside the frozen runtime tree.
    let directory = dirname(file), depth = 0;
    while (true) {
      try {
        const manifest = object(JSON.parse(await readFile(join(directory, "package.json"), "utf8")), "Native addon package.json");
        if (typeof manifest.name === "string" && manifest.name.length) break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (directory === this.root || dirname(directory) === directory) { directory = dirname(file); depth = 0; break; }
      directory = dirname(directory); depth++;
    }
    const segments = path.split("/");
    const key = segments.slice(0, Math.max(0, segments.length - 1 - depth)).join("/") || ".";
    let record = this.packages.get(key);
    if (!record) { record = { kept: 0, omitted: [] }; this.packages.set(key, record); }
    return record;
  }
  async keep(file: string, path: string): Promise<void> { (await this.entry(file, path)).kept++; }
  async omit(file: string, path: string, reason: OmittedAddon["reason"]): Promise<void> { (await this.entry(file, path)).omitted.push({ path, reason }); }
  /** Returns every omitted addon in path order; throws when a package retains no addon for the target. */
  finish(): OmittedAddon[] {
    const omitted: OmittedAddon[] = [];
    for (const [pkg, record] of this.packages) {
      if (!record.kept) throw new Error(`Native addon package has no ${this.platform.os}/${this.platform.architecture} build: ${pkg} (omitted ${record.omitted.map((o) => o.path).join(", ")})`);
      omitted.push(...record.omitted);
    }
    return omitted.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  }
}

/** Inspects a runtime file for the target; returns null when a `.node` file built for another platform was omitted. */
export async function inspectRuntimeFile(file: string, path: string, platform: Platform, ledger: AddonLedger): Promise<NativeBinary | undefined | null> {
  if (!path.endsWith(".node")) return inspectELF(file, platform);
  const addon = await classifyAddon(file, platform);
  if (addon.omit) { await ledger.omit(file, path, addon.omit); return null; }
  await ledger.keep(file, path);
  return addon.elf;
}

/** Omit links to omitted addons as well, so the packaged tree has no dangling addon aliases. */
export async function includeRuntimeLink(file: string, path: string, target: string, platform: Platform, ledger: AddonLedger): Promise<boolean> {
  if ((!path.endsWith(".node") && !target.endsWith(".node")) || !(await lstat(target)).isFile()) return true;
  const addon = await classifyAddon(target, platform);
  if (addon.omit) { await ledger.omit(file, path, addon.omit); return false; }
  await ledger.keep(file, path);
  return true;
}

export function packageRoot(value: string): string {
  const match = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+/.exec(value);
  if (!match || (value[match[0].length] !== undefined && value[match[0].length] !== "/") || value.split("/").some((p) => !p || p === "." || p === "..")) throw new Error(`Invalid external package: ${value}`);
  return match[0];
}

function validateDeclarations(manifest: Record<string, unknown>, root: Record<string, unknown>): void {
  for (const field of dependencyFields) {
    if (Buffer.compare(Buffer.from(canonicalJSON(manifest[field] ?? {})), Buffer.from(canonicalJSON(root[field] ?? {})))) throw new Error(`package.json and bun.lock disagree on ${field}; run bun install first`);
  }
  const optionalPeers = Object.entries(object(manifest.peerDependenciesMeta ?? {}, "peerDependenciesMeta")).filter(([, value]) => object(value, "Peer metadata").optional === true).map(([name]) => name).sort();
  if (!Array.isArray(root.optionalPeers ?? []) || !(root.optionalPeers as unknown[] | undefined ?? []).every((name) => typeof name === "string") || JSON.stringify(optionalPeers) !== JSON.stringify([...(root.optionalPeers as string[] | undefined ?? [])].sort())) throw new Error("package.json and bun.lock disagree on optional peers");
}

export function validateLock(manifest: Record<string, unknown>, input: unknown, workspace?: Workspace): Record<string, unknown> {
  const lock = object(input, "bun.lock");
  if ((lock.lockfileVersion !== 1 && lock.lockfileVersion !== 2) || (lock.configVersion !== undefined && lock.configVersion !== 1)) throw new Error("Unsupported bun.lock schema; use a supported Bun text lockfile (version 1 or 2)");
  const workspaces = object(lock.workspaces, "bun.lock workspaces");
  const packages = workspace?.packages ?? [{ path: "", manifest }];
  if (JSON.stringify(Object.keys(workspaces).sort()) !== JSON.stringify(packages.map((p) => p.path).sort())) throw new Error("Workspace membership and bun.lock disagree; run bun install first");
  for (const pkg of packages) {
    const record = object(workspaces[pkg.path], "bun.lock workspace");
    validateDeclarations(pkg.manifest, record);
    if (workspace && (record.name !== pkg.manifest.name || record.version !== pkg.manifest.version)) throw new Error(`Workspace name/version and bun.lock disagree: ${pkg.path || "."}`);
  }
  const definitions = catalogs(manifest);
  for (const [field, expected] of [["catalog", definitions.catalog], ["catalogs", definitions.catalogs], ["overrides", manifest.overrides ?? manifest.resolutions ?? {}], ["patchedDependencies", manifest.patchedDependencies ?? {}]] as const) {
    if (Buffer.compare(Buffer.from(canonicalJSON(expected)), Buffer.from(canonicalJSON(lock[field] ?? {})))) throw new Error(`package.json and bun.lock disagree on ${field}`);
  }
  for (const [id, record] of Object.entries(object(lock.packages, "bun.lock packages"))) {
    if (workspace && Array.isArray(record) && record.length === 1 && typeof record[0] === "string" && record[0].includes("@workspace:")) {
      const [name, path] = record[0].split("@workspace:");
      if (!workspace.packages.some((p) => p.path && p.path === path && p.manifest.name === name) || id !== name) throw new Error(`Invalid workspace lock entry: ${id}`);
      continue;
    }
    if (!Array.isArray(record) || record.length !== 4 || typeof record[0] !== "string" || !/^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:[-+].+)?$/.test(record[0])
      || typeof record[1] !== "string" || typeof record[3] !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(record[3])) throw new Error(`Unsupported non-registry or integrity-free lock entry: ${id}`);
    object(record[2], "Lock package metadata");
    if (record[1]) {
      const url = new URL(record[1]);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Lock package URLs must use HTTPS without credentials or query parameters");
    }
  }
  return lock;
}
/** Top-level `bun.lock` fields the reachability walk models directly. */
const narrowableLockFields = new Set(["lockfileVersion", "configVersion", "workspaces", "packages"]);
/**
 * Fields that steer resolution or rewrite content, but only for the packages they name.
 * Each is hashed in full elsewhere in the plan key — `catalog`/`catalogs` as `catalogs`,
 * the rest through the manifest fields `dependencyInputs` serialises, patch bytes through
 * `patches` — so a change to one always moves the key. What the walk cannot model is a
 * redirect landing on a package it reached, so narrowing survives these fields exactly
 * while none of the names they mention is reachable. Any other field, present and
 * non-empty, is a lock the walk does not understand at all.
 */
const scopedLockFields = new Set(["overrides", "resolutions", "catalog", "catalogs", "patchedDependencies", "trustedDependencies"]);
/**
 * Edges the walk follows. `devDependencies` is deliberately absent: the closure install is
 * `--production`, so a dev-only package is never installed and never projected. A dev
 * declaration that shares a name with a runtime one still resolves to the same lock id,
 * which the walk reaches through the runtime edge.
 */
const closureEdgeFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

const emptyLockField = (value: unknown): boolean =>
  value === undefined || value === null || (Array.isArray(value) ? !value.length : typeof value === "object" ? !Object.keys(value as object).length : false);
const lockRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The package a lock entry actually installs, which is not its lock id: an alias entry is
 * keyed by the alias (`"alias": ["real@1.0.0", ...]`) and a nested entry by its owner path.
 * A scoped field names the canonical package, so narrowing must compare against this.
 */
function entryName(record: unknown[]): string | undefined {
  const value = record[0];
  if (typeof value !== "string") return undefined;
  const workspace = value.indexOf("@workspace:");
  const version = value.indexOf("@", value.startsWith("@") ? 1 : 0);
  if (workspace < 0 && version < 1) return undefined;
  const name = value.slice(0, workspace < 0 ? version : workspace);
  try { return packageRoot(name) === name ? name : undefined; } catch { return undefined; }
}

/** The package names a `scopedLockFields` entry mentions, or undefined when its shape is unrecognised. */
function scopedNames(field: string, value: unknown): string[] | undefined {
  if (field === "trustedDependencies") return Array.isArray(value) && value.every((name) => typeof name === "string") ? value as string[] : undefined;
  const record = lockRecord(value);
  if (!record) return undefined;
  if (field === "catalogs") {
    const names: string[] = [];
    for (const group of Object.values(record)) {
      const entries = lockRecord(group);
      if (!entries) return undefined;
      names.push(...Object.keys(entries));
    }
    return names;
  }
  if (field !== "patchedDependencies") return Object.keys(record);
  // Patch keys are `name@version`, and a scoped name is worthless unless it parses exactly.
  const names: string[] = [];
  for (const key of Object.keys(record)) {
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    try { if (packageRoot(name) !== name) return undefined; } catch { return undefined; }
    names.push(name);
  }
  return names;
}

export interface ReachableLock {
  /** The lock to hash: the reachable subset, or the whole lock when the walk falls back. */
  lock?: Record<string, unknown>;
  /** Reachable workspace member paths, or undefined when the walk fell back and every member counts. */
  members?: Set<string>;
  /**
   * Names a reachable package declares that no lock entry anywhere installs — an unsatisfied
   * optional peer, almost always. They are recorded rather than resolved, and hashing the
   * record is what makes the absence itself part of the plan key: should any later lock
   * supply one of these names, that name either resolves into the package subset or forces
   * the whole-lock fallback, and the key moves either way.
   */
  absent?: string[];
}

/**
 * The part of the lock a selected target can actually install, computed from the lock
 * graph alone so it is available before any install. The walk starts at the root member
 * (whose packages occupy the top-level lock ids the target resolves against) and at each
 * selected target, follows `dependencies`, `optionalDependencies` and `peerDependencies`
 * through every transitive edge, and resolves each name the way Bun's nested lock ids do:
 * `<owner id>/<name>` first, then the same probe against each enclosing scope, then the
 * top-level id. A `workspace:` edge resolves to the member's own lock entry and the walk
 * continues through that member's dependency fields. A name no probe resolves — an
 * unsatisfied optional peer, typically — is reported in `absent`, but only when no lock
 * entry anywhere installs that package: Bun's isolated linker exposes a
 * `node_modules/.bun/node_modules` fallback tree that the projector's ancestor search can
 * reach, so any entry under that name could still supply it.
 *
 * Narrowing is a pure optimisation, so every construct the walk does not fully model
 * falls back to the whole lock: an unsupported `lockfileVersion`/`configVersion`; any
 * top-level lock field outside `narrowableLockFields` and `scopedLockFields`; a
 * `scopedLockFields` entry (catalog, override/resolution, patch, trusted package, in the
 * lock or in the manifest) whose shape does not parse or that names a package the walk
 * reached, canonical alias names included; a workspace or package entry that is not a
 * recognised lock record or whose installed package name cannot be derived; workspace
 * members nested inside one another, whose physical resolution order the lock ids do not
 * express; a selected target absent from the lock; and an unresolved name that some other
 * lock entry installs, which the isolated linker's fallback tree could supply. The fallback
 * is silent: it only costs a re-plan.
 */
export function reachableLock(plan: Pick<DependencyPlan, "lock" | "manifest">, targets: string[]): ReachableLock {
  const lock = plan.lock;
  const full: ReachableLock = { lock };
  if (!lock) return full;
  if (lock.lockfileVersion !== 1 && lock.lockfileVersion !== 2) return full;
  if (lock.configVersion !== undefined && lock.configVersion !== 1) return full;
  const definitions = catalogs(plan.manifest);
  // Collect every name a resolution-steering field mentions, from the lock and from the
  // manifest alike: `validateLock` keeps the two in step, but the walk must not depend on it.
  const scoped: string[] = [];
  for (const [field, value] of [...Object.entries(lock), ["catalog", definitions.catalog], ["catalogs", definitions.catalogs],
    ["overrides", plan.manifest.overrides], ["resolutions", plan.manifest.resolutions], ["patchedDependencies", plan.manifest.patchedDependencies]] as [string, unknown][]) {
    if (narrowableLockFields.has(field) || emptyLockField(value)) continue;
    if (!scopedLockFields.has(field)) return full;
    const names = scopedNames(field, value);
    if (!names) return full;
    scoped.push(...names);
  }

  const members = lockRecord(lock.workspaces), entries = lockRecord(lock.packages);
  if (!members || !entries) return full;
  const workspaces = members, packages = entries, paths = Object.keys(workspaces);
  // A member directory inside another member makes the upward node_modules walk ambiguous.
  if (paths.some((path) => path && paths.some((other) => other && other !== path && path.startsWith(`${other}/`)))) return full;

  const memberIds = new Map<string, string>([["", ""]]), memberPaths = new Map<string, string>(), byName = new Map<string, string[]>();
  for (const [id, record] of Object.entries(packages)) {
    if (!Array.isArray(record)) return full;
    const name = entryName(record);
    if (!name) return full;
    byName.set(name, [...byName.get(name) ?? [], id]);
    if (record.length === 1) {
      const marker = typeof record[0] === "string" ? record[0].indexOf("@workspace:") : -1;
      if (marker < 0) return full;
      const path = (record[0] as string).slice(marker + "@workspace:".length);
      if (!path || !Object.hasOwn(workspaces, path) || memberIds.has(path) || memberPaths.has(id)) return full;
      memberIds.set(path, id); memberPaths.set(id, path);
    } else if (record.length !== 4 || typeof record[0] !== "string" || !lockRecord(record[2])) return full;
  }
  for (const path of paths) if (!memberIds.has(path)) return full;
  for (const target of targets) if (!memberIds.has(target)) return full;

  const reachedMembers = new Set<string>(), reached = new Set<string>(), visited = new Set<string>(), reachedNames = new Set<string>(), absent = new Set<string>();
  const pending: { scopes: string[]; record: Record<string, unknown> }[] = [];
  function enqueueMember(path: string): boolean {
    if (reachedMembers.has(path)) return true;
    const record = lockRecord(workspaces[path]);
    if (!record) return false;
    reachedMembers.add(path);
    const id = memberIds.get(path)!;
    if (id) { reached.add(id); visited.add(id); reachedNames.add(id); }
    pending.push({ scopes: id ? ["", id] : [""], record });
    return true;
  }
  // The root member always installs: its packages own the top-level ids every target resolves against.
  if (!enqueueMember("")) return full;
  for (const target of targets) if (!enqueueMember(target)) return full;
  while (pending.length) {
    const node = pending.pop()!;
    for (const field of closureEdgeFields) {
      if (node.record[field] === undefined) continue;
      const edges = lockRecord(node.record[field]);
      if (!edges) return full;
      for (const name of Object.keys(edges)) {
        try { if (packageRoot(name) !== name) return full; } catch { return full; }
        reachedNames.add(name);
        let id: string | undefined, scopes: string[] | undefined;
        for (let index = node.scopes.length - 1; index >= 0; index--) {
          const scope = node.scopes[index]!, candidate = scope ? `${scope}/${name}` : name;
          if (Object.hasOwn(packages, candidate)) { id = candidate; scopes = [...node.scopes.slice(0, index + 1), candidate]; break; }
        }
        // Nothing in the lock provides the name today. An unrelated member could add it at the
        // top level tomorrow and change what this target installs, so the absence is recorded
        // and hashed: supplying the name later moves it out of `absent` and into the subset.
        if (!id) { absent.add(name); continue; }
        if (visited.has(id)) continue;
        visited.add(id); reached.add(id);
        const member = memberPaths.get(id);
        if (member !== undefined) { if (!enqueueMember(member)) return full; continue; }
        pending.push({ scopes: scopes!, record: lockRecord((packages[id] as unknown[])[2])! });
      }
    }
  }
  // A reached entry is named by the package it installs, not by its lock id, so an alias
  // (`"alias": ["real@1.0.0", ...]`) puts `real` here too: a scoped field naming the
  // canonical package must trigger the fallback even when nothing declares that name.
  for (const id of reached) reachedNames.add(entryName(packages[id] as unknown[])!);
  // An absent name is only genuinely absent when no lock entry anywhere installs that
  // package. Bun's isolated linker exposes a `node_modules/.bun/node_modules` fallback tree
  // holding installed packages, and the projector's ancestor search reaches it, so any entry
  // under that name — including one belonging to a member the targets cannot reach — could
  // supply the package and then resolve its own dependencies inside that tree, which the
  // lock ids do not describe. Nothing narrower than the whole lock covers those bytes.
  for (const name of absent) if (byName.has(name)) return full;
  // A catalog, override or patch that names a reachable package could change what the walk
  // resolved — a patch can add arbitrary dependencies to an installed manifest, which no lock
  // walk models — so the whole lock is hashed instead. One that names nothing reachable cannot.
  if (scoped.some((name) => reachedNames.has(name))) return full;
  return { members: reachedMembers, absent: [...absent].sort(), lock: { lockfileVersion: lock.lockfileVersion, ...(lock.configVersion === undefined ? {} : { configVersion: lock.configVersion }),
    workspaces: Object.fromEntries(paths.filter((path) => reachedMembers.has(path)).map((path) => [path, workspaces[path]])),
    packages: Object.fromEntries(Object.keys(packages).filter((id) => reached.has(id)).map((id) => [id, packages[id]])) } };
}

/**
 * `workspaceSourceDigests` hashes the referenced workspace members under `root`,
 * which every build and closure report needs as a cache input. It requires `root`
 * to be a source snapshot: only a snapshot has already applied the exclusions that
 * decide which member files reach the image, and reproducing them over a working
 * tree is impossible before the required inputs and explicitly selected assets are
 * known. Offline diagnostics use the plan for its lock and npm policy alone, so
 * they turn the hashing off rather than walk a tree a build would never package.
 */
export async function dependencyPlan(project: Project, root: string, validateCredentials = true, certificate?: NpmCertificate, workspaceSourceDigests = true): Promise<DependencyPlan> {
  const workspace = project.workspace;
  const manifest = workspace?.packages[0]!.manifest ?? object(JSON.parse(project.manifestText), "package.json");
  const hasDependencies = dependencyFields.some((field) => Object.keys(object(manifest[field] ?? {}, field)).length);
  let lock: Record<string, unknown> | undefined;
  if (hasDependencies || workspace) {
    let text: string;
    try { text = await readFile(join(root, "bun.lock"), "utf8"); } catch { throw new Error("Dependencies require a text bun.lock; run bun install first (bun.lockb is not supported)"); }
    lock = validateLock(manifest, Bun.JSONC.parse(text), workspace);
  }
  const patches: Record<string, string> = {};
  for (const path of Object.values(object(manifest.patchedDependencies ?? {}, "patchedDependencies"))) {
    if (typeof path !== "string") throw new Error("Invalid patch path");
    archivePath(path);
    patches[path] = await hashFile(join(root, path));
  }
  const resolution: Record<string, string> = {};
  let npmrc: string | undefined;
  try { npmrc = await readFile(join(workspace?.directory ?? project.directory, ".npmrc"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (npmrc) {
    const lines: string[] = [];
    for (const line of npmrc.split(/\r?\n/)) {
      if (!line.trim() || /^[#;]/.test(line.trim())) continue;
      const equals = line.indexOf("=");
      if (equals < 1) throw new Error("Unsupported .npmrc line");
      const key = line.slice(0, equals).trim();
      if (key === "cafile") continue;
      const value = line.slice(equals + 1).trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        if (!validateCredentials && !/^(?:@[^:]+:)?registry$/.test(key)) return "bunko-credential-placeholder";
        const value = process.env[name];
        if (value === undefined || /[\r\n]/.test(value)) throw new Error(`Missing or invalid .npmrc environment variable: ${name}`);
        return value;
      });
      if (/^(?:@[^:]+:)?registry$/.test(key)) {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("npm registries must use HTTPS without embedded credentials");
        resolution[key] = url.toString();
      } else if (!/^(?:\/\/[^\s=]+:)?(?:_authToken|_auth|username|_password|always-auth)$/.test(key)) throw new Error(`Unsupported .npmrc option: ${key}`);
      lines.push(`${key}=${value}`);
    }
    npmrc = lines.join("\n") + "\n";
  }
  const workspaceSources: Record<string, string> = {};
  if (workspace) {
    // Collecting the references validates every manifest and lock dependency map, which
    // is a contract check on the plan itself: it runs at every depth, hashed or not.
    const referenced = new Set<string>();
    const references = [...workspace.packages.map((p) => p.manifest), ...Object.values(object(lock!.packages, "packages")).filter(Array.isArray).map((r) => r[2] ?? {})];
    for (const value of references) for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(object(object(value, "Package metadata")[field] ?? {}, field))) referenced.add(name);
    }
    for (const pkg of workspaceSourceDigests ? workspace.packages.filter((p) => p.path && referenced.has(String(p.manifest.name))) : []) {
      const entries = await fileEntries(join(root, pkg.path), pkg.path);
      workspaceSources[pkg.path] = sha256(canonicalJSON(await mapFiles(entries, async (entry) => entry.type === "file" ? { path: entry.path, executable: entry.executable, digest: "source" in entry ? await hashFile(entry.source) : sha256(entry.content) } : entry)));
    }
  }
  const installPolicy = await readBunfig(root);
  return { npmCertificate: certificate ?? await npmCertificate(workspace?.directory ?? project.directory, validateCredentials), installPolicy, manifest, workspace, workspaceSources, lock, npmrc, registry: resolution.registry ?? "https://registry.npmjs.org", resolution, patches };
}

export function assertLockToolchain(plan: Pick<DependencyPlan, "lock">, toolchain: Toolchain): void {
  if (plan.lock?.lockfileVersion === 2 && !Bun.semver.satisfies(toolchain.version, ">=1.4.0")) throw new Error("bun.lock version 2 requires Bun >=1.4.0; select a compatible --bun-path");
}

/**
 * Bun filter values are patterns, not literal paths: `*` globs, a leading `!`
 * negates, and a trailing `...` selects a package's dependency relations, so a
 * member directory spelled with any of them would silently select the wrong
 * packages (or none, with only a warning). Only plain path segments are
 * filtered; anything else falls back to the full install.
 */
const plainPathSegment = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** Only explicit workspace edges establish a guaranteed filtered install scope.
 * Ambiguous semver/catalog edges conservatively trigger the full-install fallback. */
export function bundleOutsideBuildScope(plan: DependencyPlan, targetPath: string, inputs: string[]): boolean {
  const members = plan.workspace?.packages ?? [];
  const included = new Set(["", targetPath]);
  const pending = members.filter((member) => included.has(member.path));
  for (const member of pending) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(object(member.manifest[field] ?? {}, field))) {
        if (typeof version !== "string" || !version.startsWith("workspace:")) continue;
        const dependency = members.find((candidate) => candidate.manifest.name === name);
        if (dependency && !included.has(dependency.path)) { included.add(dependency.path); pending.push(dependency); }
      }
    }
  }
  const owners = members.filter((member) => member.path).sort((a, b) => b.path.length - a.path.length);
  return inputs.some((input) => {
    const owner = owners.find((member) => input === member.path || input.startsWith(`${member.path}/`));
    return owner !== undefined && !included.has(owner.path);
  });
}

/**
 * Host build installs only need the bundled target's dependency subtree, so a
 * workspace member is installed with `--filter`. Bun also installs the root
 * package and every workspace package the target depends on, which is exactly
 * what the isolated linker exposes to the bundler; unrelated members and their
 * trees are skipped. Filters are paths so a member never has to be named.
 */
export function buildDependencyFilters(plan: DependencyPlan, targetPath: string): string[] | undefined {
  const path = targetPath.replace(/^\.?\/+|\/+$/g, "");
  if (!plan.workspace || !path || !plan.workspace.packages.some((pkg) => pkg.path === path)) return undefined;
  return path.split("/").every((segment) => plainPathSegment.test(segment)) ? [".", `./${path}`] : undefined;
}

export async function installDependencies(root: string, plan: DependencyPlan, toolchain: Toolchain, target?: Platform, cacheDirectory?: string, offline = false, filters?: string[]): Promise<void> {
  if (!plan.lock) return;
  assertLockToolchain(plan, toolchain);
  if (offline) throw new Error("Offline dependency installation is unavailable; prepare matching application/dependency caches while online");
  const config = join(root, OUTPUT_DIRECTORY, "install.toml");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, installConfig(plan.installPolicy ?? {}));
  const home = join(root, OUTPUT_DIRECTORY, "install-home");
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
  const auth = join(root, ".npmrc");
  if (plan.npmrc) await writeFile(auth, plan.npmrc, { mode: 0o600 });
  const args = [toolchain.path, "install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated", "--backend=copyfile", "--no-progress", `--config=${config}`, `--registry=${plan.registry}`];
  if (target) args.push("--production", "--os=linux", `--cpu=${target.architecture === "amd64" ? "x64" : "arm64"}`);
  else for (const filter of filters ?? []) args.push(`--filter=${filter}`);
  // Keep downloads outside node_modules even in the isolated installer environment.
  args.push(`--cache-dir=${cacheDirectory ?? join(root, OUTPUT_DIRECTORY, "install-cache")}`);
  const certificateFile = join(home, "npm-ca.pem");
  const originalLock = await readFile(join(root, "bun.lock"), "utf8");
  const originals = await Promise.all((plan.workspace?.packages.map((p) => p.path) ?? [""]).map(async (path) => ({ path: join(root, path, "package.json"), text: await readFile(join(root, path, "package.json"), "utf8") })));
  const network = installNetworkEnvironment();
  try {
    const extra = await validateInstallCertificates(network);
    if (plan.npmCertificate) {
      await writeFile(certificateFile, plan.npmCertificate.pem + "\n" + extra, { mode: 0o600, flag: "wx" });
      // Bun 1.3.11 also needs process-level trust for TLS inside CONNECT tunnels.
      network.NODE_EXTRA_CA_CERTS = certificateFile;
      args.push(`--cafile=${certificateFile}`);
    }
    const child = Bun.spawn(args, { cwd: root, env: {
      HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C", LC_ALL: "C", NODE_ENV: target ? "production" : "development",
      BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: "1", BUN_FEATURE_FLAG_DISABLE_IGNORE_SCRIPTS: "1",
      ...network,
    }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Installer diagnostics may contain private URLs or credentials, so the caller
    // gets the operation, exit code and only a redacted tail of the output; raw
    // authentication-bearing text is never surfaced.
    if (code !== 0) throw new Error(`Bun ${target ? "Linux production" : "build"} dependency install failed (exit ${code}); check the lock, registry access, and package availability${installerOutputTail(stderr, stdout, root, 20, installerCredentials(plan.npmrc))}`);
    if (await readFile(join(root, "bun.lock"), "utf8") !== originalLock) throw new Error("Frozen install changed bun.lock");
    for (const original of originals) if (await readFile(original.path, "utf8") !== original.text) throw new Error("Frozen install changed package.json");
  } finally { await Promise.all([rm(auth, { force: true }), rm(certificateFile, { force: true })]); }
}

/** Read ELF64 metadata without loading or executing a target binary. */
export async function inspectELF(path: string, platform: Platform): Promise<NativeBinary | undefined> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, 64, 0);
    if (bytesRead < 4 || !header.subarray(0, 4).equals(ELF_MAGIC)) return;
    if (bytesRead < 64 || header[4] !== 2 || header[5] !== 1) throw new Error("Only little-endian ELF64 binaries are supported");
    const machine = header.readUInt16LE(18);
    if (machine !== elfMachine(platform)) throw new Error(`Native ELF architecture mismatch: ${path}`);
    const offset = Number(header.readBigUInt64LE(32)), count = header.readUInt16LE(56), size = header.readUInt16LE(54);
    if (!Number.isSafeInteger(offset) || size < 56 || count > 4096) throw new Error("Invalid ELF program headers");
    const segments: { type: number; offset: number; address: number; size: number }[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = Buffer.alloc(size);
      if ((await file.read(bytes, 0, size, offset + i * size)).bytesRead !== size) throw new Error("Truncated ELF segment");
      segments.push({ type: bytes.readUInt32LE(0), offset: Number(bytes.readBigUInt64LE(8)), address: Number(bytes.readBigUInt64LE(16)), size: Number(bytes.readBigUInt64LE(32)) });
    }
    const dynamic = segments.find((s) => s.type === 2);
    const needed: number[] = [];
    let strings = 0, stringSize = 0;
    if (dynamic) {
      if (dynamic.size > 1024 * 1024) throw new Error("ELF dynamic table is too large");
      const bytes = Buffer.alloc(dynamic.size);
      await file.read(bytes, 0, bytes.length, dynamic.offset);
      for (let i = 0; i + 16 <= bytes.length; i += 16) {
        const tag = Number(bytes.readBigInt64LE(i)), value = Number(bytes.readBigUInt64LE(i + 8));
        if (tag === 0) break;
        if (tag === 1) needed.push(value);
        if (tag === 5) strings = value;
        if (tag === 10) stringSize = value;
      }
    }
    const names: string[] = [];
    if (needed.length) {
      const segment = segments.find((s) => s.type === 1 && strings >= s.address && strings < s.address + s.size);
      if (!segment || stringSize <= 0 || stringSize > 16 * 1024 * 1024) throw new Error("Invalid ELF string table");
      const bytes = Buffer.alloc(stringSize);
      if ((await file.read(bytes, 0, bytes.length, segment.offset + strings - segment.address)).bytesRead !== bytes.length) throw new Error("Truncated ELF string table");
      for (const start of needed) {
        const end = bytes.indexOf(0, start);
        if (start < 0 || start >= bytes.length || end < 0) throw new Error("Invalid ELF dependency name");
        names.push(bytes.subarray(start, end).toString());
      }
    }
    return { path, architecture: platform.architecture, needed: [...new Set(names)].sort() };
  } finally { await file.close(); }
}

export async function runtimeEntries(root: string, prefix: string, platform: Platform, prepared = false, allowedScripts: string[] = []): Promise<{ entries: TarEntry[]; inventory: InventoryEntry[]; native: NativeBinary[]; omitted: OmittedAddon[] }> {
  const modules = await realpath(join(root, "node_modules"));
  const entries: TarEntry[] = [];
  const inventory: InventoryEntry[] = [];
  const native: NativeBinary[] = [];
  const ledger = new AddonLedger(platform, modules);
  async function walk(path: string) {
    const file = join(modules, path);
    const info = await lstat(file);
    const destination = `${prefix}/node_modules${path ? `/${path}` : ""}`;
    archivePath(destination);
    if (info.isSymbolicLink()) {
      const original = await readlink(file);
      const target = await realpath(file);
      const local = relative(modules, target);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) throw new Error(`Dependency symlink escapes node_modules: ${path}`);
      if (!await includeRuntimeLink(file, path, target, platform, ledger)) return;
      entries.push({ type: "symlink", path: destination, target: isAbsolute(original) ? relative(dirname(file), target) : original });
    } else if (info.isDirectory()) {
      entries.push({ type: "directory", path: destination });
      for (const child of (await readdir(file)).sort()) await walk(path ? `${path}/${child}` : child);
    } else if (info.isFile()) {
      if (path.endsWith("/package.json")) {
        const pkg = object(JSON.parse(await readFile(file, "utf8")), "Dependency package.json");
        if (typeof pkg.name === "string" && typeof pkg.version === "string") {
          inventory.push({ path: dirname(path), name: pkg.name, version: pkg.version, license: packageLicense(pkg.license) });
          if (!prepared) {
            const hooks = ignoredInstallScripts(pkg, allowedScripts);
            if (hooks.length) inventory[inventory.length - 1]!.ignoredInstallScripts = hooks;
          }
        }
      }
      const elf = await inspectRuntimeFile(file, path, platform, ledger);
      if (elf === null) return;
      if (elf) native.push({ ...elf, path: destination });
      entries.push({ type: "file", path: destination, source: file, size: info.size, executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Unsupported dependency file type: ${path}`);
  }
  await walk("");
  return { entries, inventory, native, omitted: ledger.finish() };
}

export function dependencyInputs(plan: DependencyPlan, toolchain: Toolchain, platform: Platform, base: string, project: Project): Record<string, unknown> {
  // Production strategy fingerprints all manifests/lock. Workspace source bytes
  // are included only when the package can appear in the installed runtime tree;
  // the closure path narrows that further through `closureSources`, because a target's
  // own files are its application layer rather than closure bytes.
  const fields = [...dependencyFields, "peerDependenciesMeta", "overrides", "resolutions", "patchedDependencies", "trustedDependencies", "name", "version", "os", "cpu"];
  const relevant = (manifest: Record<string, unknown>) => Object.fromEntries(fields.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
  const manifests = plan.workspace ? Object.fromEntries(plan.workspace.packages.map((pkg) => [pkg.path, relevant(pkg.manifest)])) : relevant(plan.manifest);
  const definitions = catalogs(plan.manifest);
  return { nativeAddonPolicy: "target-elf-v1", manifests, ...(Object.keys(plan.installPolicy ?? {}).length ? { installPolicy: plan.installPolicy } : {}), ...(Object.keys(definitions.catalog).length || Object.keys(definitions.catalogs).length ? { catalogs: definitions } : {}), workspaceSources: plan.workspaceSources, targetPath: project.targetPath || undefined, layout: plan.workspace ? "workspace-v2" : "standalone-v2", lock: plan.lock, patches: plan.patches, resolution: plan.resolution, registry: plan.registry, toolchain: { version: toolchain.version, revision: toolchain.revision }, platform, base, libc: "glibc", strategy: "production", linker: "isolated", scripts: false, ...(project.allowIgnoredScripts?.length ? { allowIgnoredScripts: project.allowIgnoredScripts } : {}), external: project.external };
}
