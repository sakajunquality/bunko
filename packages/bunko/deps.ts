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
export interface DependencyPlan { manifest: Record<string, unknown>; workspace?: Workspace; workspaceSources?: Record<string, string>; lock?: Record<string, unknown>; npmrc?: string; registry: string; resolution: Record<string, string>; patches: Record<string, string> }
export interface InventoryEntry { path: string; name: string; version: string }
export interface NativeBinary { path: string; architecture: string; needed: string[] }

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
  if (lock.lockfileVersion !== 1 || (lock.configVersion !== undefined && lock.configVersion !== 1)) throw new Error("Unsupported bun.lock schema; regenerate a text lock with Bun 1.3.11");
  const workspaces = object(lock.workspaces, "bun.lock workspaces");
  const packages = workspace?.packages ?? [{ path: "", manifest }];
  if (JSON.stringify(Object.keys(workspaces).sort()) !== JSON.stringify(packages.map((p) => p.path).sort())) throw new Error("Workspace membership and bun.lock disagree; run bun install first");
  for (const pkg of packages) {
    const record = object(workspaces[pkg.path], "bun.lock workspace");
    validateDeclarations(pkg.manifest, record);
    if (workspace && (record.name !== pkg.manifest.name || record.version !== pkg.manifest.version)) throw new Error(`Workspace name/version and bun.lock disagree: ${pkg.path || "."}`);
  }
  for (const [field, expected] of [["overrides", manifest.overrides ?? manifest.resolutions ?? {}], ["patchedDependencies", manifest.patchedDependencies ?? {}]] as const) {
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

export async function dependencyPlan(project: Project, root: string): Promise<DependencyPlan> {
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
      const value = line.slice(equals + 1).trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
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
    const referenced = new Set<string>();
    const references = [...workspace.packages.map((p) => p.manifest), ...Object.values(object(lock!.packages, "packages")).filter(Array.isArray).map((r) => r[2] ?? {})];
    for (const value of references) for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(object(object(value, "Package metadata")[field] ?? {}, field))) referenced.add(name);
    }
    for (const pkg of workspace.packages.filter((p) => p.path && referenced.has(String(p.manifest.name)))) {
      const entries = await fileEntries(join(root, pkg.path), pkg.path);
      workspaceSources[pkg.path] = sha256(canonicalJSON(await mapFiles(entries, async (entry) => entry.type === "file" ? { path: entry.path, executable: entry.executable, digest: "source" in entry ? await hashFile(entry.source) : sha256(entry.content) } : entry)));
    }
  }
  return { manifest, workspace, workspaceSources, lock, npmrc, registry: resolution.registry ?? "https://registry.npmjs.org", resolution, patches };
}

export async function installDependencies(root: string, plan: DependencyPlan, toolchain: Toolchain, target?: Platform, cacheDirectory?: string): Promise<void> {
  if (!plan.lock) return;
  const config = join(root, OUTPUT_DIRECTORY, "install.toml");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, "[install]\nlinker = \"isolated\"\n");
  const auth = join(root, ".npmrc");
  if (plan.npmrc) await writeFile(auth, plan.npmrc, { mode: 0o600 });
  const args = [toolchain.path, "install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated", "--backend=copyfile", "--no-progress", `--config=${config}`, `--registry=${plan.registry}`];
  if (target) args.push("--production", "--os=linux", `--cpu=${target.architecture === "amd64" ? "x64" : "arm64"}`);
  // Keep downloads outside node_modules even in the intentionally HOME-free environment.
  args.push(`--cache-dir=${cacheDirectory ?? join(root, OUTPUT_DIRECTORY, "install-cache")}`);
  const originalLock = await readFile(join(root, "bun.lock"), "utf8");
  const originals = await Promise.all((plan.workspace?.packages.map((p) => p.path) ?? [""]).map(async (path) => ({ path: join(root, path, "package.json"), text: await readFile(join(root, path, "package.json"), "utf8") })));
  try {
    const child = Bun.spawn(args, { cwd: root, env: {
      PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C", LC_ALL: "C", NODE_ENV: target ? "production" : "development",
      BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: "1", BUN_FEATURE_FLAG_DISABLE_IGNORE_SCRIPTS: "1",
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
    }, stdout: "pipe", stderr: "pipe" });
    const [, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Installer diagnostics may contain private URLs or credentials. The caller
    // gets the operation and exit code, never raw authentication-bearing output.
    if (code !== 0) throw new Error(`Bun ${target ? "Linux production" : "build"} dependency install failed (exit ${code}); check the lock, registry access, and package availability`);
    if (await readFile(join(root, "bun.lock"), "utf8") !== originalLock) throw new Error("Frozen install changed bun.lock");
    for (const original of originals) if (await readFile(original.path, "utf8") !== original.text) throw new Error("Frozen install changed package.json");
  } finally { await rm(auth, { force: true }); }
}

/** Read ELF64 metadata without loading or executing a target binary. */
export async function inspectELF(path: string, platform: Platform): Promise<NativeBinary | undefined> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, 64, 0);
    if (bytesRead < 4 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return;
    if (bytesRead < 64 || header[4] !== 2 || header[5] !== 1) throw new Error("Only little-endian ELF64 binaries are supported");
    const machine = header.readUInt16LE(18);
    if (machine !== (platform.architecture === "amd64" ? 62 : 183)) throw new Error(`Native ELF architecture mismatch: ${path}`);
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

export async function runtimeEntries(root: string, prefix: string, platform: Platform): Promise<{ entries: TarEntry[]; inventory: InventoryEntry[]; native: NativeBinary[] }> {
  const modules = await realpath(join(root, "node_modules"));
  const entries: TarEntry[] = [];
  const inventory: InventoryEntry[] = [];
  const native: NativeBinary[] = [];
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
      entries.push({ type: "symlink", path: destination, target: isAbsolute(original) ? relative(dirname(file), target) : original });
    } else if (info.isDirectory()) {
      entries.push({ type: "directory", path: destination });
      for (const child of (await readdir(file)).sort()) await walk(path ? `${path}/${child}` : child);
    } else if (info.isFile()) {
      if (path.endsWith("/package.json")) {
        const pkg = object(JSON.parse(await readFile(file, "utf8")), "Dependency package.json");
        if (typeof pkg.name === "string" && typeof pkg.version === "string") {
          inventory.push({ path: dirname(path), name: pkg.name, version: pkg.version });
          const scripts = object(pkg.scripts ?? {}, "Dependency scripts");
          if (["preinstall", "install", "postinstall"].some((key) => scripts[key])) throw new Error(`Runtime package ${pkg.name} declares install scripts; M1 requires packages that ship ready-to-run files`);
        }
      }
      const elf = await inspectELF(file, platform);
      if (path.endsWith(".node") && !elf) throw new Error(`Native addon is not Linux ELF64: ${path}`);
      if (elf) native.push({ ...elf, path: destination });
      entries.push({ type: "file", path: destination, source: file, size: info.size, executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Unsupported dependency file type: ${path}`);
  }
  await walk("");
  return { entries, inventory, native };
}

export function dependencyInputs(plan: DependencyPlan, toolchain: Toolchain, platform: Platform, base: string, project: Project): Record<string, unknown> {
  // Production strategy fingerprints all manifests/lock. Workspace source bytes
  // are included only when the package can appear in the installed runtime tree.
  const fields = [...dependencyFields, "peerDependenciesMeta", "overrides", "resolutions", "patchedDependencies", "trustedDependencies", "name", "version", "os", "cpu"];
  const relevant = (manifest: Record<string, unknown>) => Object.fromEntries(fields.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
  const manifests = plan.workspace ? Object.fromEntries(plan.workspace.packages.map((pkg) => [pkg.path, relevant(pkg.manifest)])) : relevant(plan.manifest);
  return { manifests, workspaceSources: plan.workspaceSources, targetPath: project.targetPath || undefined, layout: plan.workspace ? "workspace-v2" : "standalone-v2", lock: plan.lock, patches: plan.patches, resolution: plan.resolution, registry: plan.registry, toolchain: { version: toolchain.version, revision: toolchain.revision }, platform, base, libc: "glibc", strategy: "production", linker: "isolated", scripts: false, external: project.external };
}
