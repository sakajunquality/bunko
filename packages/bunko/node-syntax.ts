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
  const unknown = Symbol("unknown");
  function value(node: ts.Expression): string | boolean | typeof unknown {
    if (ts.isParenthesizedExpression(node)) return value(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Bun" && unbound(node.expression)) return "undefined";
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) { const inner = value(node.operand); return inner === unknown ? unknown : !inner; }
    if (ts.isBinaryExpression(node)) {
      const left = value(node.left), right = value(node.right);
      if (left === unknown || right === unknown) return unknown;
      if (typeof left === "string" && typeof right === "string") {
        if (node.operatorToken.kind === ts.SyntaxKind.LessThanToken) return left < right;
        if (node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) return left <= right;
        if (node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken) return left > right;
        if (node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken) return left >= right;
      }
      if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)) return left === right;
      if ([ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return left !== right;
    }
    return unknown;
  }
  function visit(node: ts.Node) {
    if (!scopes.has(node)) return;
    if (ts.isConditionalExpression(node) || ts.isIfStatement(node)) {
      visit(ts.isIfStatement(node) ? node.expression : node.condition);
      const condition = ts.isIfStatement(node) ? node.expression : node.condition, result = value(condition);
      const yes = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
      const no = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
      if (result === unknown || Boolean(result)) visit(yes);
      if (no && (result === unknown || !result)) visit(no);
      return;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      visit(node.left); const left = value(node.left);
      if (left === unknown || (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? Boolean(left) : !left)) visit(node.right);
      return;
    }
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

/** Entry-only preflight avoids rejecting unused test/development files in bundle mode. */
export async function checkNodeApplication(root: string, entries: string[], sourceMode: boolean): Promise<void> {
  if (sourceMode) return checkNodeSources(root, true);
  for (const entry of entries) rejectBunRuntime(await readFile(join(root, entry), "utf8"), entry);
}
