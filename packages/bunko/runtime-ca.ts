import { lstat, realpath } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { sha256 } from "../oci/digest.ts";
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { Digest } from "../oci/types.ts";
import type { Project } from "./config.ts";
import type { BaseFilesystem } from "./runtime-layer.ts";
import { certificatePEM } from "./install-network.ts";
import { sourceIgnore, sourceOmissions } from "./ignore.ts";

export interface RuntimeCA { path: string; digest: Digest; certificates: number }

/** Validate data destinations against base metadata without following host or image links. */
export function assertBaseDataPaths(tree: BaseFilesystem, entries: TarEntry[]): void {
  const implicit = new Set<string>();
  for (const path of tree.keys()) for (let parent = posix.dirname(path); parent !== "." && !tree.has(parent) && !implicit.has(parent); parent = posix.dirname(parent)) implicit.add(parent);
  for (const entry of entries) {
    archivePath(entry.path);
    for (let parent = posix.dirname(entry.path); parent !== "."; parent = posix.dirname(parent)) {
      const existing = tree.get(parent);
      if (existing && existing.type !== "directory") throw new Error("Data destination has a non-directory or symlink parent in the base");
    }
    const existing = tree.get(entry.path)?.type ?? (implicit.has(entry.path) ? "directory" : undefined);
    if (existing && existing !== entry.type) throw new Error("Data destination overlaps an incompatible base entry");
  }
}

/** Runtime trust is an explicit application input, separate from host transport trust. */
export async function runtimeCA(project: Project): Promise<{ metadata: RuntimeCA; entry: TarEntry; files: string[] } | undefined> {
  if (!project.runtimeCAs.length) return;
  const root = await realpath(project.directory), ignored = await sourceIgnore(project.workspace?.directory ?? root), files: string[] = [], bundles: string[] = [];
  for (const path of project.runtimeCAs) {
    try {
    for (const [index] of path.split("/").entries()) {
      const part = path.split("/").slice(0, index + 1).join("/");
      if (part.split("/").some((name) => sourceOmissions.has(name) || name.startsWith(".env")) || ignored(join(project.targetPath, part))) throw new Error("Runtime CA input is excluded from the source context");
      if ((await lstat(join(root, part))).isSymbolicLink()) throw new Error("Runtime CA input must not traverse symlinks");
    }
    const file = await realpath(join(root, path)), local = relative(root, file);
    if (local === ".." || local.startsWith("../")) throw new Error("Runtime CA input escapes the source context");
    bundles.push(await certificatePEM(file, "Runtime CA")); files.push(file);
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === "string") throw new Error("Runtime CA input must be a readable regular certificate file inside the project");
      throw error;
    }
  }
  const content = Buffer.from(bundles.join("\n"));
  if (content.length > 1024 * 1024) throw new Error("Combined runtime CA bundle exceeds 1 MiB");
  const path = `${project.workdir}/.bunko-ca/roots.pem`;
  return { metadata: { path, digest: sha256(content), certificates: (content.toString().match(/-----BEGIN CERTIFICATE-----/g) ?? []).length }, entry: { type: "file", path: path.slice(1), content, executable: false, mode: 0o444 }, files };
}

/** Application layers must not inherit stale files or directory layouts from an earlier app. */
export function assertBaseWorkdir(tree: BaseFilesystem, workdir: string): void {
  const path = archivePath(workdir.slice(1));
  for (let parent = path; parent !== "."; parent = posix.dirname(parent)) {
    const existing = tree.get(parent);
    if (existing && existing.type !== "directory") throw new Error("Application workdir has a non-directory or symlink path in the base");
  }
  for (const existing of tree.keys()) if (existing.startsWith(`${path}/`)) throw new Error("Base application workdir is not empty; choose an empty workdir instead of inheriting application files");
}
