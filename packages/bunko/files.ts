import { assertNoSourcePrivateKey, gitSourceIgnore } from "./source-policy.ts";
import { filesystemMetadata, sourceIgnore, sourceOmissions } from "./ignore.ts";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, open } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { Digest } from "../oci/types.ts";
import type { SyntaxCache } from "./syntax-cache.ts";
import { rejectMacroSyntax } from "./syntax.ts";

export const OUTPUT_DIRECTORY = ".bunko-build";
const omitted = sourceOmissions;

export async function rejectMacros(file: string, name: string, cache?: SyntaxCache): Promise<void> {
  if (cache) return cache.check(file, name);
  const code = await readFile(file, "utf8");
  rejectMacroSyntax(code, name);
}

export async function hashFile(path: string): Promise<Digest> {
  const hash = createHash("sha256"), file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally { await file.close(); }
}

/** inspectOnly applies the same selection and validation without copying or producing a reusable content digest. */
export async function snapshot(source: string, destination: string, excluded: string[] = [], syntax?: SyntaxCache, strictAssetRoots: string[] = [], required: string[] = [], assetExclusions: string[] = [], sourceMode = false, explicitAssets = new Set<string>(), inspectOnly = false): Promise<Digest> {
  const ignored = await sourceIgnore(source);
  const gitIgnored = sourceMode ? gitSourceIgnore(source) : undefined;
  const assetParents = new Set<string>();
  for (const asset of explicitAssets) for (let parent = posix.dirname(asset); parent !== "."; parent = posix.dirname(parent)) assetParents.add(parent);
  const records: { path: string; type: string; digest?: Digest; executable?: boolean }[] = [];
  const names = new Map<string, string>();
  const exclude = excluded.map((p) => resolve(p));
  async function walk(path: string) {
    const current = join(source, path);
    if (filesystemMetadata(path)) {
      const input = required.find((item) => item === path || item.startsWith(`${path}/`));
      if (input) throw new Error(`Excluded required source input: ${input}`);
      return;
    }
    if (assetExclusions.some((excluded) => current === excluded || current.startsWith(`${excluded}/`))) {
      if (!required.some((input) => input === path || input.startsWith(`${path}/`))) return;
    }
    if (path && ignored(path)) {
      const input = required.find((item) => item === path || item.startsWith(`${path}/`));
      if (input) throw new Error(`Ignored required input: ${input}`);
      if (strictAssetRoots.some((root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))) throw new Error(`Ignored required asset: ${path}`);
      return;
    }
    const strictAsset = strictAssetRoots.some((root) => path === root || path.startsWith(`${root}/`));
    if (exclude.some((p) => current === p || current.startsWith(`${p}/`))) {
      const input = required.find((item) => item === path || item.startsWith(`${path}/`));
      if (sourceMode && input) throw new Error(`Output/cache exclusion overlaps required source input: ${input}`);
      if (strictAsset) throw new Error(`Output/cache exclusion overlaps bunkodata: ${path}`);
      return;
    }
    const name = path.split("/").at(-1)!;
    if (omitted.has(name) || name.startsWith(".env")) {
      if (strictAsset) throw new Error(`Excluded source name inside bunkodata: ${path}`);
      const input = required.find((item) => item === path || item.startsWith(`${path}/`));
      if (input && (sourceMode || explicitAssets.has(path))) throw new Error(`Excluded required source input: ${input}; credential and internal output/cache paths cannot be packaged`);
      return;
    }
    if (path) {
      archivePath(path);
      if (names.has(path.toLowerCase())) throw new Error(`Case-colliding source path: ${path}`);
      names.set(path.toLowerCase(), path);
    }
    const info = await lstat(current);
    if (path && !explicitAssets.has(path) && !(info.isDirectory() && assetParents.has(path)) && await gitIgnored?.(path, info.isDirectory())) {
      const input = required.find((item) => item === path || item.startsWith(`${path}/`));
      if (input) throw new Error(`Git-ignored required source input: ${input}`);
      if (strictAssetRoots.some((root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))) throw new Error(`Git-ignored required asset: ${path}`);
      return;
    }
    if (info.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${path}`);
    if (info.isDirectory()) {
      if (!inspectOnly) await mkdir(join(destination, path), { recursive: true });
      if (path) records.push({ path, type: "directory" });
      for (const child of (await readdir(current)).sort()) await walk(path ? `${path}/${child}` : child);
    } else if (info.isFile()) {
      const copied = inspectOnly ? current : join(destination, path);
      if (!inspectOnly) await copyFile(current, copied);
      if (sourceMode) await assertNoSourcePrivateKey(copied, path);
      if (!inspectOnly) await chmod(copied, info.mode & 0o111 ? 0o755 : 0o644);
      records.push({ path, type: "file", ...(inspectOnly ? {} : { digest: await hashFile(copied) }), executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Unsupported source file type: ${path}`);
  }
  await walk("");
  return sha256(canonicalJSON(records));
}

export async function fileEntries(root: string, prefix: string, selected?: Set<string>): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  async function walk(path: string) {
    const file = join(root, path);
    const info = await lstat(file);
    if (info.isDirectory()) {
      if (path && (!selected || selected.has(path))) entries.push({ type: "directory", path: `${prefix}/${path}` });
      for (const name of (await readdir(file)).sort()) await walk(path ? `${path}/${name}` : name);
    } else if (info.isFile()) {
      if (!selected || selected.has(path)) entries.push({ type: "file", path: `${prefix}/${path}`, source: file, size: info.size, executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Unsupported output file type: ${path}`);
  }
  await walk("");
  return entries;
}

export async function assetEntries(root: string, patterns: string[], prefix: string, allowEmpty = false): Promise<TarEntry[]> {
  if (!patterns.length) return [];
  const selected = new Set<string>();
  for (const pattern of patterns) {
    const matches = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: false, dot: true, followSymlinks: false }));
    if (!matches.length && !allowEmpty) throw new Error(`Asset pattern matched no files: ${pattern}`);
    for (const match of matches) {
      if (match === OUTPUT_DIRECTORY || match.startsWith(`${OUTPUT_DIRECTORY}/`)) throw new Error("Assets cannot include the build output directory");
      const path = relative(root, resolve(root, match));
      archivePath(path);
      selected.add(path);
      if ((await lstat(join(root, path))).isDirectory()) {
        for await (const child of new Bun.Glob("**/*").scan({ cwd: join(root, path), onlyFiles: false, dot: true, followSymlinks: false })) selected.add(`${path}/${child}`);
      }
    }
  }
  return fileEntries(root, prefix, selected);
}

export function assertNoLayerCollision(groups: TarEntry[][]): void {
  const paths = new Map<string, TarEntry["type"]>();
  const caseNames = new Map<string, string>();
  function add(path: string, type: TarEntry["type"]) {
    const lower = path.toLowerCase(), previous = paths.get(path);
    if (caseNames.has(lower) && caseNames.get(lower) !== path) throw new Error(`Case-colliding layer path: ${path}`);
    if (previous && (previous !== "directory" || type !== "directory")) throw new Error(`Assets overlap application output or file/directory collision: ${path}`);
    paths.set(path, type);
    caseNames.set(lower, path);
  }
  for (const group of groups) for (const entry of group) {
    archivePath(entry.path);
    add(entry.path, entry.type);
    // Record implicit parents so either insertion order catches collisions.
    for (let parent = posix.dirname(entry.path); parent !== "."; parent = posix.dirname(parent)) add(parent, "directory");
  }
}
