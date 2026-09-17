import { forEachChild, is, isImportMeta, isNonReferenceIdentifier, isReferencedJSXName, member, moduleSpecifier, parent, stringValue, type Node } from "./parser.ts";
import { lexicalScopes } from "./lexical-scopes.ts";
import { sourceAnalysis } from "./source-analysis.ts";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Conservative static guard, not proof of compatibility for dynamically constructed APIs. */
export function rejectBunRuntime(code: string, file: string, analysis = sourceAnalysis(code, file), sourceMode = false): void {
  if (!/Bun|\bbun\b|\bimport\b|\\/.test(code) && !(sourceMode && /\.[cm]?tsx?[\'"`]/.test(code))) return;
  const source = analysis(), { scopes, bindings } = lexicalScopes(source);
  const unbound = (node: Node & { name: string }) => { for (let s = scopes.get(node); s; s = s.parent) if (s.names.has(node.name)) return false; return !bindings.has(node); };
  const unknown = Symbol("unknown");
  function value(node: Node): string | boolean | typeof unknown {
    if (is(node, "ParenthesizedExpression")) return value(node.expression);
    const text = stringValue(node); if (text !== undefined) return text;
    if (is(node, "BooleanLiteral")) return node.value;
    if (is(node, "UnaryExpression") && node.operator === "typeof" && is(node.argument, "Identifier") && node.argument.name === "Bun" && unbound(node.argument)) return "undefined";
    if (is(node, "UnaryExpression") && node.operator === "!") { const inner = value(node.argument); return inner === unknown ? unknown : !inner; }
    if (is(node, "BinaryExpression")) {
      const left = value(node.left), right = value(node.right);
      if (left === unknown || right === unknown) return unknown;
      if (typeof left === "string" && typeof right === "string") {
        if (node.operator === "<") return left < right;
        if (node.operator === "<=") return left <= right;
        if (node.operator === ">") return left > right;
        if (node.operator === ">=") return left >= right;
      }
      if (["==", "==="].includes(node.operator)) return left === right;
      if (["!=", "!=="].includes(node.operator)) return left !== right;
    }
    return unknown;
  }
  function visit(node: Node) {
    if (!scopes.has(node)) return;
    if (is(node, "ConditionalExpression") || is(node, "IfStatement")) {
      visit(node.test); const result = value(node.test);
      if (result === unknown || Boolean(result)) visit(node.consequent);
      if (node.alternate && (result === unknown || !result)) visit(node.alternate);
      return;
    }
    if (is(node, "LogicalExpression") && ["&&", "||"].includes(node.operator)) {
      visit(node.left); const left = value(node.left);
      if (left === unknown || (node.operator === "&&" ? Boolean(left) : !left)) visit(node.right);
      return;
    }
    let incompatible = false;
    if ((is(node, "Identifier") || isReferencedJSXName(node)) && node.name === "Bun" && unbound(node)) {
      const p = parent(node);
      incompatible = !isNonReferenceIdentifier(node) && !(is(p, "UnaryExpression") && p.operator === "typeof");
    }
    const access = member(node);
    if (access) {
      if (isImportMeta(access.base) && ["require", "dir", "path"].includes(access.name ?? "")) incompatible = true;
      if ((is(access.base, "Identifier") || isReferencedJSXName(access.base)) && ["globalThis", "global"].includes(access.base.name) && unbound(access.base) && access.name === "Bun") incompatible = true;
    }
    let specifier = moduleSpecifier(node);
    if ((is(node, "CallExpression") || is(node, "OptionalCallExpression")) && is(node.callee, "Identifier") && !unbound(node.callee)) specifier = undefined;
    const text = stringValue(specifier);
    if (text === "bun" || text?.startsWith("bun:")) incompatible = true;
    if (sourceMode && text !== undefined && /\.[cm]?tsx?$/.test(text)) throw new Error("Node source mode does not support TypeScript imports; prebuild to JavaScript");
    if (incompatible) throw new Error(`Bun-only runtime API in ${file}:${node.loc!.start.line}; use Node-compatible APIs for runtime.kind node`);
    forEachChild(node, visit);
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

/** Entry-only preflight avoids rejecting unused test/development files in bundle mode. */
export async function checkNodeApplication(root: string, entries: string[], sourceMode: boolean): Promise<void> {
  if (sourceMode) return checkNodeSources(root, true);
  for (const entry of entries) rejectBunRuntime(await readFile(join(root, entry), "utf8"), entry);
}
