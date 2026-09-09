import { isBuiltin } from "node:module";
import { posix } from "node:path";
import { object } from "../oci/digest.ts";
import type { Project } from "./config.ts";

export type UndeclaredImportPolicy = "warn" | "error" | "off";
export interface UndeclaredImport { code: "BUNKO_UNDECLARED_IMPORT"; package: string; version: string; path: string; name: string; file: string }
/** Files above this size are skipped: they are almost always bundles, and a native scan of them is not free. */
export const undeclaredImportSizeLimit = 4 * 1024 * 1024;
export const undeclaredImportLimit = 100;
const scannable = /\.[cm]?js$/;
const transpiler = new Bun.Transpiler({ loader: "js" });
/** Directories and file names that hold tests and benchmarks packages ship by accident; consulted only when a package has no resolvable entry point. */
const testDirectories = new Set(["test", "tests", "__tests__", "spec", "bench", "benchmark", "browser-test", "system-test"]);
const testFile = /(?:^|\.)(?:test|spec|bench)\.[cm]?js$/;

/** The strictest selected policy governs a shared closure, so one target cannot silence another's findings. */
export function undeclaredImportPolicy(projects: Pick<Project, "undeclaredImports">[]): UndeclaredImportPolicy {
  return projects.some((p) => p.undeclaredImports === "error") ? "error" : projects.some((p) => p.undeclaredImports === "warn") ? "warn" : "off";
}

export function undeclaredImportMessage(item: UndeclaredImport): string {
  return `${item.code} ${item.package}@${item.version} imports ${JSON.stringify(item.name)} without declaring it (${item.file}); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application's dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.`;
}

/** Package name of a bare specifier, or undefined for relative, absolute, protocol, subpath-import and malformed specifiers. */
export function bareSpecifierPackage(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || specifier === "bun" || isBuiltin(specifier) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return undefined;
  const match = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+(?=\/|$)/.exec(specifier);
  return match?.[0];
}

/** Names an instance may resolve without help: itself plus every declared dependency, optional dependency or peer (optional peers included). */
export function declaredNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (typeof manifest.name === "string") names.add(manifest.name);
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) for (const name of Object.keys(object(manifest[key] ?? {}, key))) names.add(name);
  return names;
}

export function scannableRuntimeFile(path: string, size: number): boolean {
  return scannable.test(path) && size <= undeclaredImportSizeLimit;
}

/** Files the reachability scan may consult: JavaScript modules and the package manifests that direct directory imports. */
export function candidateRuntimeFile(path: string): boolean {
  return scannable.test(path) || path === "package.json" || path.endsWith("/package.json");
}

/** Shipped test material, recognized by well-known directory names at any depth and by test, *.test, *.spec and *.bench file names. */
export function testLocation(file: string): boolean {
  const segments = file.split("/");
  return segments.slice(0, -1).some((segment) => testDirectories.has(segment)) || testFile.test(segments.at(-1)!);
}

/** Every literal specifier the transpiler finds: static import/export sources, require() literals and import() literals. A shebang line is dropped first; unparseable files yield nothing. */
export function importSpecifiers(code: string): string[] {
  if (!/\b(?:require|import|export)\b/.test(code)) return [];
  try { return transpiler.scanImports(code.replace(/^#![^\n]*/, "")).map((item) => item.path); } catch { return []; }
}

/** Advisory syntax scan of one file: bare specifiers that are neither builtins nor declared, sorted. */
export function undeclaredImports(code: string, declared: Set<string>): string[] {
  const missing = new Set<string>();
  for (const path of importSpecifiers(code)) {
    const name = bareSpecifierPackage(path);
    if (name && !declared.has(name)) missing.add(name);
  }
  return [...missing].sort();
}

/** Package-relative entry points in manifest order: main, module, every string leaf of exports (all conditions, nested objects and arrays,
 * null leaves skipped), bin values and a string browser field. A leaf with `*` is expanded against the instance's files the way Node
 * substitutes it: the first `*` matches any characters including `/`, later ones are literal. Nothing here is resolved yet. */
export function manifestEntryPoints(manifest: Record<string, unknown>, files: Iterable<string>): string[] {
  const entries: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const star = value.indexOf("*");
    if (star < 0) { entries.push(value); return; }
    const prefix = inside(value.slice(0, star)), suffix = value.slice(star + 1);
    if (prefix === undefined) return;
    for (const file of files) if (file.startsWith(prefix) && file.endsWith(suffix) && file.length >= prefix.length + suffix.length) entries.push(file);
  };
  const leaves = (value: unknown) => { if (Array.isArray(value)) value.forEach(leaves); else if (value && typeof value === "object") Object.values(value).forEach(leaves); else add(value); };
  add(manifest.main); add(manifest.module); leaves(manifest.exports);
  if (typeof manifest.bin === "string") add(manifest.bin); else if (manifest.bin && typeof manifest.bin === "object") Object.values(manifest.bin).forEach(add);
  add(manifest.browser);
  return entries;
}

/** Normalize a package-relative path; undefined when it is absolute, leaves the package or enters a nested node_modules. */
function inside(path: string): string | undefined {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("node_modules")) return undefined;
  return normalized === "." || normalized === "./" ? "" : normalized;
}

export interface ReachableFinding { name: string; file: string }

/** Scan the files of one package instance that its entry points reach through relative imports.
 * `files` maps package-relative paths of regular files (see candidateRuntimeFile) to sizes; `read` returns one of them as text.
 * Bare specifiers are checked against the declared names; relative ones are resolved with Node-style probing (exact file, `.js`/`.cjs`/`.mjs`,
 * a directory's package.json `main`, then its index) inside the instance, each file visited once in breadth-first order from the entry points.
 * A package with no resolvable entry point falls back to every JavaScript file outside well-known test locations, in sorted order. */
export async function reachableUndeclaredImports(manifest: Record<string, unknown>, files: Map<string, number>, read: (file: string) => Promise<string>): Promise<ReachableFinding[]> {
  const declared = declaredNames(manifest);
  const probe = (target: string) => { for (const candidate of [target, `${target}.js`, `${target}.cjs`, `${target}.mjs`]) if (scannable.test(candidate) && files.has(candidate)) return candidate; return undefined; };
  const index = (directory: string) => probe(posix.join(directory, "index"));
  async function resolve(target: string): Promise<string | undefined> {
    const file = probe(target); if (file) return file;
    const nested = posix.join(target, "package.json");
    if (files.has(nested) && nested !== "package.json") {
      let main: unknown;
      try { main = JSON.parse(await read(nested)).main; } catch { main = undefined; }
      if (typeof main === "string") { const path = inside(posix.join(target, main)); const found = path === undefined ? undefined : probe(path) ?? index(path); if (found) return found; }
    }
    return index(target);
  }
  const visited = new Set<string>(), queue: string[] = [], seen = new Set<string>(), findings: ReachableFinding[] = [];
  const enqueue = (file: string) => { if (!visited.has(file)) { visited.add(file); queue.push(file); } };
  for (const entry of manifestEntryPoints(manifest, files.keys())) { const path = inside(entry); const file = path === undefined ? undefined : await resolve(path); if (file) enqueue(file); }
  if (!visited.size) { const file = index(""); if (file) enqueue(file); }
  if (!visited.size) for (const file of [...files.keys()].sort()) if (scannable.test(file) && !testLocation(file)) enqueue(file);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!scannableRuntimeFile(file, files.get(file)!)) continue;
    const missing = new Set<string>();
    for (const specifier of importSpecifiers(await read(file))) {
      if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
        const path = inside(posix.join(posix.dirname(file), specifier)), target = path === undefined ? undefined : await resolve(path);
        if (target) enqueue(target);
        continue;
      }
      const name = bareSpecifierPackage(specifier);
      if (name && !declared.has(name)) missing.add(name);
    }
    // One finding per instance and missing name; the first file reached from the entry points is the witness.
    for (const name of [...missing].sort()) if (!seen.has(name)) { seen.add(name); findings.push({ name, file }); }
  }
  return findings;
}
