import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { Digest } from "../oci/types.ts";

export const OUTPUT_DIRECTORY = ".bunko-build";
const omitted = new Set([".git", "node_modules", ".bunko-output", OUTPUT_DIRECTORY, ".npmrc", ".bunko-cache", ".docker", ".aws", ".config", ".yarnrc.yml", ".DS_Store"]);

export async function rejectMacros(file: string, name: string): Promise<void> {
  const code = await readFile(file, "utf8");
  if (/\b(?:with|assert)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\{/.test(code) || /["']macro:/.test(code)) throw new Error(`Import attributes / macros are not supported in M1: ${name}`);
}

export async function hashFile(path: string): Promise<Digest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export async function snapshot(source: string, destination: string, excluded: string[] = []): Promise<Digest> {
  const records: { path: string; type: string; digest?: Digest; executable?: boolean }[] = [];
  const names = new Map<string, string>();
  const exclude = excluded.map((p) => resolve(p));
  async function walk(path: string) {
    const current = join(source, path);
    if (exclude.some((p) => current === p || current.startsWith(`${p}/`))) return;
    const name = path.split("/").at(-1)!;
    if (omitted.has(name) || name.startsWith(".env")) return;
    if (path) {
      archivePath(path);
      if (names.has(path.toLowerCase())) throw new Error(`Case-colliding source path: ${path}`);
      names.set(path.toLowerCase(), path);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Source symlinks are not supported in M1: ${path}`);
    if (info.isDirectory()) {
      await mkdir(join(destination, path), { recursive: true });
      if (path) records.push({ path, type: "directory" });
      for (const child of (await readdir(current)).sort()) await walk(path ? `${path}/${child}` : child);
    } else if (info.isFile()) {
      const copied = join(destination, path);
      await copyFile(current, copied);
      await chmod(copied, info.mode & 0o111 ? 0o755 : 0o644);
      // Bun 1.3.11's CLI does not reliably honor --no-macros. Reject import
      // attributes conservatively before invoking the bundler; no parser executes.
      if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) {
        await rejectMacros(copied, path);
        const code = (await readFile(copied, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
        if (/\b(?:require|import)\s*\(\s*(?![\s"'])/.test(code) || /\b(?:require|import)\s*\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*[^)\s]/.test(code)) throw new Error(`Computed require/import is not supported in application source: ${path}`);
      }
      records.push({ path, type: "file", digest: await hashFile(copied), executable: Boolean(info.mode & 0o111) });
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

export async function assetEntries(root: string, patterns: string[], prefix: string): Promise<TarEntry[]> {
  if (!patterns.length) return [];
  const selected = new Set<string>();
  for (const pattern of patterns) {
    const matches = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: false, dot: true, followSymlinks: false }));
    if (!matches.length) throw new Error(`Asset pattern matched no files: ${pattern}`);
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
  const paths = new Map<string, TarEntry>();
  for (const group of groups) for (const entry of group) {
    const previous = paths.get(entry.path);
    if (previous && (previous.type !== "directory" || entry.type !== "directory")) throw new Error(`Assets overlap application output: ${entry.path}`);
    for (const [path, value] of paths) {
      if (path.toLowerCase() === entry.path.toLowerCase() && path !== entry.path) throw new Error(`Case-colliding layer path: ${entry.path}`);
      if ((entry.path.startsWith(`${path}/`) && value.type !== "directory") || (path.startsWith(`${entry.path}/`) && entry.type !== "directory")) throw new Error(`File/directory collision between layers: ${entry.path}`);
    }
    paths.set(entry.path, entry);
  }
}
