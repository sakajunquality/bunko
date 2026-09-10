import { systemFontPath, fontFileKind, validateFontFile } from "./font-assets.ts";
import { assetExcluder, assetMode } from "./asset-policy.ts";
import { chmod, copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { canonicalJSON, object, sha256 } from "../oci/digest.ts";
import { canonicalOutput } from "../oci/layout.ts";
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { Digest } from "../oci/types.ts";
import { assetInputs } from "./cache.ts";
import { assertNoLayerCollision } from "./files.ts";
import { sourceIgnore, sourceOmissions } from "./ignore.ts";
import { stageImageAsset } from "./image-assets.ts";
import { assetURL, urlAssetFile, type AssetFetcher } from "./url-assets.ts";
import { parseReference } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import type { Platform } from "../oci/types.ts";

export interface ContextAssetMapping { context: string; from: string; to: string; exclude?: string[]; mode?: string }
export interface ImageAssetMapping { image: string; from: string; to: string; mode?: string; platform?: string }
export interface UrlAssetMapping { url: string; sha256: string; to: string; mode?: string }
export type AssetMapping = ContextAssetMapping | ImageAssetMapping | UrlAssetMapping;
export type AssetMaterial = AssetMapping & { digest: Digest; resolved?: Digest; platforms?: string[] };
export interface ExternalAssetOptions {
  platform: Platform; registry?: RegistryOptions; cache?: string; offline?: boolean; reproducible?: boolean;
  fetcher?: AssetFetcher; limit?: number; entryLimit?: number; timeoutMs?: number; temporary?: string; log?: (message: string) => void;
}
export const contextMapping = (mapping: AssetMapping): mapping is ContextAssetMapping => "context" in mapping;
export const imageMapping = (mapping: AssetMapping): mapping is ImageAssetMapping => "image" in mapping;
const contextName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const protectedRoots = new Set(["bin", "boot", "dev", "etc", "home", "lib", "lib32", "lib64", "media", "mnt", "proc", "root", "run", "sbin", "sys", "usr", "var"]);

function validateDestination(path: string): void {
  archivePath(path);
  if (protectedRoots.has(path.split("/")[0]!.toLowerCase()) && !systemFontPath(path) || path.split("/").some((part) => ["node_modules", ".bunko-build", ".bunko-workspace", ".bunko-deps"].includes(part.toLowerCase()))) throw new Error("Asset mapping destination is reserved");
}

export function assetMappings(value: unknown): AssetMapping[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("assetMappings must be an array");
  return value.map((item) => {
    const row = object(item, "Asset mapping");
    const sources = ["context", "image", "url"].filter((key) => row[key] !== undefined);
    if (sources.length !== 1) throw new Error("Asset mappings require exactly one of context, image or url");
    const kind = sources[0]!;
    const keys = { context: ["context", "from", "to", "exclude", "mode"], image: ["image", "from", "to", "mode", "platform"], url: ["url", "sha256", "to", "mode"] }[kind]!;
    if (Object.keys(row).some((key) => !keys.includes(key)) || typeof row.to !== "string") throw new Error(`Asset mappings accept only ${keys.join(", ")} with a ${kind} source`);
    if (!row.to.startsWith("/")) throw new Error("Asset mapping to must be an absolute image path");
    validateDestination(row.to.slice(1));
    const mode = assetMode(row.mode);
    if (systemFontPath(row.to.slice(1)) && mode !== undefined && (mode & 0o111)) throw new Error("System font mappings require non-executable modes");
    const common = { to: row.to, ...(row.mode !== undefined ? { mode: row.mode as string } : {}) };
    if (kind === "url") {
      if (typeof row.url !== "string" || typeof row.sha256 !== "string") throw new Error("URL asset mappings require url and sha256 strings");
      assetURL(row.url);
      if (!/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error("Asset mapping sha256 must be 64 lowercase hexadecimal characters");
      return { url: row.url, sha256: row.sha256, ...common };
    }
    if (typeof row.from !== "string") throw new Error("Asset mappings require a from string");
    if (/[?*\[\]{}]/.test(row.from)) throw new Error("Asset mapping from must be an exact file or directory");
    if (kind === "image") {
      if (typeof row.image !== "string" || !row.from.startsWith("/")) throw new Error("Image asset mappings require an image reference and an absolute from path");
      parseReference(row.image);
      archivePath(row.from.slice(1));
      if (row.platform !== undefined && typeof row.platform !== "string") throw new Error("Asset mapping platform must be a string");
      return { image: row.image, from: row.from, ...common, ...(row.platform !== undefined ? { platform: row.platform as string } : {}) };
    }
    if (typeof row.context !== "string" || !contextName.test(row.context)) throw new Error("Asset mappings require context, from, and to strings");
    archivePath(row.from);
    if (row.exclude !== undefined && (!Array.isArray(row.exclude) || !row.exclude.every((item) => typeof item === "string"))) throw new Error("Asset mapping exclude must be an array of relative patterns");
    const exclude = (row.exclude as string[] | undefined)?.map((pattern) => archivePath(pattern.replace(/^\.\//, "")));
    return { context: row.context, from: row.from, ...common, ...(exclude ? { exclude } : {}) };
  });
}

export function normalizeAssetContexts(value: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, path] of Object.entries(object(value, "Asset contexts"))) {
    if (!contextName.test(name) || typeof path !== "string" || !path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Asset contexts require valid names and non-empty local paths");
    result[name] = resolve(path);
  }
  return result;
}

export function parseAssetContexts(values: string[] = []): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const value of values) {
    const equal = value.indexOf("="), name = value.slice(0, equal), path = value.slice(equal + 1);
    if (equal < 1 || !contextName.test(name) || !path || /[\x00-\x1f\x7f]/.test(path) || Object.hasOwn(result, name)) throw new Error("Use one --asset-context NAME=DIR per context");
    result[name] = resolve(path);
  }
  return result;
}

export function assertAssetRuntime(mappings: AssetMapping[], runtimePath: string): void {
  for (const mapping of mappings) {
    const destination = mapping.to.toLowerCase(), runtime = runtimePath.toLowerCase();
    if (runtime === destination || runtime.startsWith(`${destination}/`) || destination.startsWith(`${runtime}/`)) throw new Error("Asset mapping overlaps the configured Bun runtime");
  }
}

/** Check selected filesystem entries without staging, reading file contents or contacting a registry. */
export async function inspectAssetMappings(mappings: AssetMapping[], contexts: Record<string, string>) {
  const validated = assetMappings(mappings), local = validated.filter(contextMapping);
  const result = await selectedAssetMappings(local, contexts);
  return { entries: result.entries.length, contexts: [...new Set(local.map((mapping) => mapping.context))].sort(), external: validated.length - local.length };
}

/** Freeze selected inputs only. Host paths never enter material or cache records. */
export async function stageAssetMappings(mappings: AssetMapping[], contexts: Record<string, string>, stage: string, exclusions: string[] = [], external?: ExternalAssetOptions) {
  return selectedAssetMappings(mappings, contexts, stage, exclusions, external);
}

async function selectedAssetMappings(mappings: AssetMapping[], contexts: Record<string, string>, stage?: string, exclusions: string[] = [], external?: ExternalAssetOptions): Promise<{ entries: TarEntry[]; materials: AssetMaterial[] }> {
  const entries: TarEntry[] = [], materials: AssetMaterial[] = [];
  if (!mappings.length) return { entries, materials };
  mappings = assetMappings(mappings);
  contexts = normalizeAssetContexts(contexts);
  const matchers = new Map<string, Awaited<ReturnType<typeof sourceIgnore>>>();
  const excluded = await Promise.all(exclusions.map(canonicalOutput));
  for (const [index, entry] of mappings.entries()) {
    if (!contextMapping(entry)) {
      if (stage === undefined) continue;
      if (!external) throw new Error("Image and URL asset mappings require build options");
      const selected: TarEntry[] = [], mode = assetMode(entry.mode), work = join(stage, String(index));
      let resolved: Digest | undefined;
      if (imageMapping(entry)) {
        const staged = await stageImageAsset(entry, { ...external, stage: work, temporary: external.temporary ?? join(work, "work") }, validateDestination);
        selected.push(...staged.entries); resolved = staged.resolved;
      } else {
        const file = await urlAssetFile(entry.url, entry.sha256, { ...external, cache: external.cache ?? join(work, "cache"), destination: join(work, "asset") });
        selected.push({ type: "file", path: archivePath(entry.to.slice(1)), source: file.path, size: file.size, ...(mode !== undefined ? { mode } : {}), executable: Boolean((mode ?? 0o644) & 0o111) });
      }
      for (const entry of selected) if (entry.type === "file" && "source" in entry && systemFontPath(entry.path)) {
        const effective = entry.mode ?? (entry.executable ? 0o755 : 0o644);
        fontFileKind(entry.path, effective, entry.size);
        await validateFontFile(entry.source, entry.path, effective);
      }
      materials.push({ ...entry, ...(resolved ? { resolved } : {}), digest: sha256(canonicalJSON(await assetInputs(selected))) });
      entries.push(...selected);
      continue;
    }
    const mapping: ContextAssetMapping = entry;
    if (!Object.hasOwn(contexts, mapping.context)) throw new Error(`Missing asset context: ${mapping.context}`);
    let root: string;
    try { root = await realpath(contexts[mapping.context]!); if (!(await lstat(root)).isDirectory()) throw new Error(); }
    catch { throw new Error(`Asset context must be an accessible directory: ${mapping.context}`); }
    try {
      if (!matchers.has(root)) matchers.set(root, await sourceIgnore(root));
      const ignored = matchers.get(root)!;
      const selected: TarEntry[] = [];
      const excludeAsset = assetExcluder(mapping.exclude ?? []), mode = assetMode(mapping.mode);
      const forbidden = (path: string) => path.split("/").some((part) => sourceOmissions.has(part) || part.startsWith(".env")) || path.split("/").some((_, i, parts) => ignored(parts.slice(0, i + 1).join("/"))) || excluded.some((item) => join(root, path) === item || join(root, path).startsWith(`${item}/`));
      // Check every ancestor with lstat; never traverse an intermediate symlink.
      for (const [i] of mapping.from.split("/").entries()) {
        const path = mapping.from.split("/").slice(0, i + 1).join("/");
        if (forbidden(path)) throw new Error(`Excluded asset input: ${mapping.context}/${path}`);
        const info = await lstat(join(root, path)).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Missing asset input: ${mapping.context}/${path}`); throw error; });
        if (info.isSymbolicLink()) throw new Error(`Asset symlinks are not supported: ${mapping.context}/${path}`);
      }
      async function walk(path: string, destination: string) {
        if (path !== mapping.from && excludeAsset(path.slice(mapping.from.length + 1))) return;
        if (forbidden(path)) throw new Error(`Excluded asset input: ${mapping.context}/${path}`);
        validateDestination(destination);
        const input = join(root, path), info = await lstat(input);
        if (info.isSymbolicLink()) throw new Error(`Asset symlinks are not supported: ${mapping.context}/${path}`);
        const canonical = await realpath(input), local = relative(root, canonical);
        if (local === ".." || local.startsWith("../")) throw new Error("Asset input escaped its context");
        if (info.isDirectory()) {
          selected.push({ type: "directory", path: destination });
          for (const name of (await readdir(input)).sort()) await walk(`${path}/${name}`, `${destination}/${name}`);
        } else if (info.isFile()) {
          if (path === mapping.from && excludeAsset(basename(path))) return;
          if (systemFontPath(destination)) fontFileKind(destination, mode ?? info.mode, info.size);
          if (stage === undefined) {
            selected.push({ type: "file", path: destination, content: new Uint8Array(0), ...(mode !== undefined ? { mode } : {}), executable: Boolean((mode ?? info.mode) & 0o111) });
            return;
          }
          const copied = join(stage, String(index), destination);
          await mkdir(dirname(copied), { recursive: true });
          await copyFile(input, copied);
          await chmod(copied, mode ?? (info.mode & 0o111 ? 0o755 : 0o644));
          const captured = await lstat(copied);
          if (systemFontPath(destination)) await validateFontFile(copied, destination, mode ?? captured.mode);
          selected.push({ type: "file", path: destination, source: copied, size: captured.size, ...(mode !== undefined ? { mode } : {}), executable: Boolean((mode ?? info.mode) & 0o111) });
        } else throw new Error(`Unsupported asset input type: ${mapping.context}/${path}`);
      }
      await walk(mapping.from, mapping.to.slice(1));
      if (stage !== undefined) materials.push({ ...mapping, digest: sha256(canonicalJSON(await assetInputs(selected))) });
      entries.push(...selected);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (typeof code === "string") throw new Error(`Asset context filesystem error (${code}): ${mapping.context}`);
      throw error;
    }
  }
  assertNoLayerCollision([entries]);
  return { entries, materials };
}
