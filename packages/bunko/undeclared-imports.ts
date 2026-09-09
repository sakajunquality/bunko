import { isBuiltin } from "node:module";
import { object } from "../oci/digest.ts";
import type { Project } from "./config.ts";

export type UndeclaredImportPolicy = "warn" | "error" | "off";
export interface UndeclaredImport { code: "BUNKO_UNDECLARED_IMPORT"; package: string; version: string; path: string; name: string; file: string }
/** Files above this size are skipped: they are almost always bundles, and a native scan of them is not free. */
export const undeclaredImportSizeLimit = 4 * 1024 * 1024;
export const undeclaredImportLimit = 100;
const scannable = /\.[cm]?js$/;
const transpiler = new Bun.Transpiler({ loader: "js" });

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

/** Advisory syntax scan only: static import/export sources, require() literals and import() literals. Unparseable files are skipped. */
export function undeclaredImports(code: string, declared: Set<string>): string[] {
  if (!/\b(?:require|import|export)\b/.test(code)) return [];
  let imports: { path: string }[];
  try { imports = transpiler.scanImports(code); } catch { return []; }
  const missing = new Set<string>();
  for (const { path } of imports) {
    const name = bareSpecifierPackage(path);
    if (name && !declared.has(name)) missing.add(name);
  }
  return [...missing].sort();
}
