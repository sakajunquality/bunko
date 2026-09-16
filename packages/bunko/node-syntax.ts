import * as ts from "typescript";
import { lexicalScopes } from "./lexical-scopes.ts";
import { sourceAnalysis } from "./source-analysis.ts";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Conservative static guard, not proof of compatibility for dynamically constructed APIs. */
export function rejectBunRuntime(code: string, file: string, analysis = sourceAnalysis(code, file), sourceMode = false): void {
  if (!/Bun|\bbun\b|\bimport\b|\\/.test(code) && !(sourceMode && /\.[cm]?tsx?[\'"`]/.test(code))) return;
  const source = analysis(), { scopes, bindings } = lexicalScopes(source);
  const unbound = (node: ts.Identifier) => { for (let s = scopes.get(node); s; s = s.parent) if (s.names.has(node.text)) return false; return !bindings.has(node); };
  function visit(node: ts.Node) {
    if (!scopes.has(node)) return;
    let incompatible = false;
    if (ts.isIdentifier(node) && node.text === "Bun" && unbound(node)) {
      const p = node.parent;
      incompatible = !((ts.isPropertyAccessExpression(p) && p.name === node) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node) || ts.isTypeOfExpression(p) || ts.isBindingElement(p) && p.propertyName === node || ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = node.expression, name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (ts.isMetaProperty(base) && base.keywordToken === ts.SyntaxKind.ImportKeyword && ["require", "dir", "path"].includes(name ?? "")) incompatible = true;
      if (ts.isIdentifier(base) && ["globalThis", "global"].includes(base.text) && unbound(base) && name === "Bun") incompatible = true;
    }
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isExternalModuleReference(node)) specifier = node.expression;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require" && unbound(node.expression))) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier) && (specifier.text === "bun" || specifier.text.startsWith("bun:"))) incompatible = true;
    if (sourceMode && specifier && ts.isStringLiteralLike(specifier) && /\.[cm]?tsx?$/.test(specifier.text)) throw new Error("Node source mode does not support TypeScript imports; prebuild to JavaScript");
    if (incompatible) { const point = source.getLineAndCharacterOfPosition(node.getStart(source)); throw new Error(`Bun-only runtime API in ${file}:${point.line + 1}; use Node-compatible APIs for runtime.kind node`); }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
/** Scan only an already sanitized snapshot; do not follow dependency symlinks. */
export async function checkNodeSources(root: string, sourceMode: boolean, dependencies = false): Promise<void> {
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".bunko-output", ".bunko-build"].includes(entry.name) || entry.name === "node_modules" && !dependencies) continue;
      const path = join(directory, entry.name), local = relative(root, path);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) {
        if (sourceMode && !local.split("/").includes("node_modules") && !/\.[cm]?js$/.test(entry.name)) throw new Error("Node source mode accepts JavaScript source only; prebuild TypeScript/JSX and exclude original sources");
        const code = await readFile(path, "utf8"); rejectBunRuntime(code, local, undefined, sourceMode);
      }
    }
  }
  await walk(root);
}

/** Inspect packaged external JavaScript even on cache hits or imported dependency artifacts. */
export async function checkNodeDependencyLayer(store: import("../oci/blob-store.ts").BlobStore, base: import("../oci/types.ts").BaseImage, layer: import("../oci/types.ts").Layer, temporary: string): Promise<void> {
  const { applyLayers } = await import("./runtime-layer.ts");
  const input = { ...base, manifest: { ...base.manifest, layers: [layer.descriptor] }, config: { ...base.config, rootfs: { type: "layers" as const, diff_ids: [layer.diffId] } } };
  await applyLayers(store, input, temporary, async (_index, path, node, stream) => {
    if (!stream || node.type !== "file" || !/\.[cm]?js$/.test(path)) return;
    if (node.size > 64 * 1024 * 1024) throw new Error("Node dependency source exceeds static validation limit");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of stream) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 64 * 1024 * 1024) throw new Error("Node dependency source exceeds static validation limit"); chunks.push(bytes); }
    rejectBunRuntime(Buffer.concat(chunks).toString("utf8"), path, undefined, true);
  });
}

/** Entry-only preflight avoids rejecting unused test/development files in bundle mode. */
export async function checkNodeApplication(root: string, entries: string[], sourceMode: boolean): Promise<void> {
  if (sourceMode) return checkNodeSources(root, true);
  for (const entry of entries) rejectBunRuntime(await readFile(join(root, entry), "utf8"), entry);
}
