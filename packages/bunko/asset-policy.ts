import { posix } from "node:path";
import type { FileMode, TarEntry } from "../oci/tar.ts";

export function assetMode(value: unknown): FileMode | undefined {
  if (value === undefined || value === "preserve") return;
  if (!["0444", "0555", "0644", "0755"].includes(String(value)) || typeof value !== "string") throw new Error("Asset mode must be preserve, 0444, 0555, 0644 or 0755");
  return parseInt(value, 8) as FileMode;
}

export function assetExcluder(patterns: string[]): (path: string) => boolean {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  return (path) => {
    for (let candidate = path; candidate !== "."; candidate = posix.dirname(candidate)) if (globs.some((glob) => glob.match(candidate))) return true;
    return false;
  };
}

/** Explicit modes affect files only; directories retain traversable normalized permissions. */
export function assetPolicy(entries: TarEntry[], prefix: string, excludes: string[], mode?: FileMode): TarEntry[] {
  const excluded = assetExcluder(excludes);
  return entries.filter((entry) => !excluded(entry.path.slice(prefix.length + 1))).map((entry) => entry.type === "file" && mode !== undefined ? { ...entry, mode, executable: Boolean(mode & 0o111) } : entry);
}
