import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDigest, canonicalJSON, object } from "../oci/digest.ts";
import type { Digest } from "../oci/types.ts";
import { cacheMetadataLimit } from "./cache.ts";
import { withCacheLock } from "./cache-lock.ts";
import { layerPath, type BaseFilesystem, type BaseNode } from "./runtime-layer.ts";

/**
 * Identity of the inspection logic, never of the base image. A base is addressed by an
 * immutable digest, so the tree `baseFilesystem()` derives from it is a pure function of
 * (base digest, inspection version) and can be replayed instead of decoding every layer again.
 *
 * **Bump this constant whenever anything that derivation depends on changes.** A record is
 * trusted to be what a fresh inspection would produce today, so the version covers the whole
 * pipeline, not only this file:
 * - the `tar-stream` dependency version, its entry-type names and how it maps tar typeflags
 *   onto them, and its PAX / GNU long-name and long-link handling — a record stores the type
 *   string and the expanded path verbatim;
 * - `applyLayers` in `runtime-layer.ts`: layer application order, `.wh.` / `.wh..wh..opq`
 *   whiteout and opaque semantics, and how directories a layer only implies are filled in;
 * - decoder acceptance limits: the 200,000-entry cap, `decodeLayer`'s decompressed size bound,
 *   and the raw/normalized/depth path limits, since a tightened limit must reject a base a
 *   looser one accepted rather than replay it;
 * - `layerPath` normalization and rejection rules, and the `BaseNode` shape itself.
 *
 * Records written under another version are never read — a mismatch is a miss and the build
 * re-inspects — and because the version is a path segment, superseded records are ordinary
 * prune candidates rather than dead weight.
 */
export const baseInspectVersion = "base-inspect-v3";
/** Managed-cache subdirectory holding `<baseInspectVersion>/<base digest>.json` records. */
export const baseInspectDirectory = "base-inspect";
/** Version directories `prune` recognizes; anything else is refused as an unknown namespace. */
export const baseInspectVersionPattern = /^base-inspect-v\d{1,4}$/;

/** Mirrors the entry types `tar-stream` reports, so a record can only name a type inspection could have produced. */
const entryTypes = new Set(["file", "link", "symlink", "character-device", "block-device", "directory", "fifo", "contiguous-file", "pax-header", "pax-global-header", "gnu-long-link-path", "gnu-long-path"]);
const maxEntries = 200_000;

export interface BaseInspection {
  schemaVersion: 1; kind: "base-inspect"; version: string; digest: Digest;
  entries: { path: string; type: string; mode: number; size: number; link?: string; muslSearchPath?: string }[];
}

export function baseInspectPath(directory: string, digest: Digest): string {
  assertDigest(digest);
  return join(directory, baseInspectDirectory, baseInspectVersion, `${digest.slice(7)}.json`);
}

/** Sorted by path so the same tree always serializes to the same bytes. */
export function baseInspection(digest: Digest, tree: BaseFilesystem): BaseInspection {
  assertDigest(digest);
  return {
    schemaVersion: 1, kind: "base-inspect", version: baseInspectVersion, digest,
    entries: [...tree].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      // `linkname` is absent (or null) for entries that are not links; only a real target is recorded.
      .map(([path, node]) => ({ path, type: node.type, mode: node.mode, size: node.size, ...(node.muslSearchPath !== undefined ? { muslSearchPath: node.muslSearchPath } : {}), ...(typeof node.link === "string" && node.link ? { link: node.link } : {}) })),
  };
}

/** Validate a stored record and rebuild the tree. Any inconsistency throws, and callers treat that as a miss. */
export function validateBaseInspection(input: unknown, digest: Digest): BaseFilesystem {
  const value = object(input, "Base inspection");
  if (value.schemaVersion !== 1 || value.kind !== "base-inspect" || value.version !== baseInspectVersion || value.digest !== digest) throw new Error("Unsupported or inconsistent base inspection metadata");
  if (!Array.isArray(value.entries) || value.entries.length > maxEntries) throw new Error("Invalid base inspection entries");
  const tree: BaseFilesystem = new Map();
  for (const raw of value.entries) {
    const entry = object(raw, "Base inspection entry");
    if (typeof entry.path !== "string" || !entry.path || layerPath(entry.path) !== entry.path) throw new Error("Invalid base inspection path");
    if (typeof entry.type !== "string" || !entryTypes.has(entry.type)) throw new Error("Invalid base inspection entry type");
    if (!Number.isSafeInteger(entry.mode) || (entry.mode as number) < 0 || (entry.mode as number) > 0xffff) throw new Error("Invalid base inspection entry mode");
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw new Error("Invalid base inspection entry size");
    if (entry.link !== undefined && (typeof entry.link !== "string" || entry.link.length > 4096)) throw new Error("Invalid base inspection link target");
    if (entry.muslSearchPath !== undefined && (typeof entry.muslSearchPath !== "string" || Buffer.byteLength(entry.muslSearchPath) > 4096 || Buffer.byteLength(entry.muslSearchPath) !== entry.size || entry.type !== "file" || !/^etc\/ld-musl-(?:x86_64|aarch64)\.path$/.test(entry.path))) throw new Error("Invalid musl search path metadata");
    if (tree.has(entry.path)) throw new Error("Duplicate path in base inspection");
    // A non-link carries no target; `baseNode` rejects a falsy target the same way for either shape.
    const node: BaseNode = { type: entry.type, link: entry.link as string | undefined, mode: entry.mode as number, size: entry.size as number };
    if (entry.muslSearchPath !== undefined) node.muslSearchPath = entry.muslSearchPath as string;
    tree.set(entry.path, node);
  }
  return tree;
}

/** A missing, stale or malformed record is a miss: the caller inspects the base again. */
export async function readBaseInspection(directory: string, digest: Digest, log: (message: string) => void): Promise<{ tree?: BaseFilesystem; invalid: boolean }> {
  const path = baseInspectPath(directory, digest);
  let found = false;
  try {
    const file = Bun.file(path);
    if (file.size > cacheMetadataLimit) throw new Error("Base inspection record exceeds size limit");
    const bytes = await file.bytes(); found = true;
    if (bytes.length > cacheMetadataLimit) throw new Error("Base inspection record exceeds size limit");
    return { tree: validateBaseInspection(JSON.parse(Buffer.from(bytes).toString()), digest), invalid: false };
  } catch (error) {
    if (!found && (error as NodeJS.ErrnoException).code === "ENOENT") return { invalid: false };
    log("Ignoring invalid local base inspection cache\n");
    return { invalid: true };
  }
}

/** Best effort: a record that cannot be written only costs the next build another inspection. */
export async function writeBaseInspection(directory: string, digest: Digest, tree: BaseFilesystem, persistence: { disabled?: boolean }, log: (message: string) => void): Promise<void> {
  const bytes = canonicalJSON(baseInspection(digest, tree));
  if (persistence.disabled || bytes.length > cacheMetadataLimit) return;
  const dir = join(directory, baseInspectDirectory, baseInspectVersion);
  const temporary = join(dir, `.tmp-${randomUUID()}`);
  try {
    await withCacheLock(directory, async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(temporary, bytes, { flag: "wx" });
      // The record is keyed by an immutable digest under a versioned path, so replacing an
      // existing one only ever rewrites identical content.
      await rename(temporary, baseInspectPath(directory, digest));
    }, () => !persistence.disabled);
  } catch { log("Could not persist the local base inspection cache; the next build inspects the base again\n"); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
