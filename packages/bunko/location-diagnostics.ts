import * as ts from "typescript";

export const locationMessage = "Bundling may relocate this module-relative path. Use an explicit runtime asset root and verify file reads in the image.";
export interface LocationWarning { code: "BUNKO_MODULE_LOCATION"; file: string; line: number; column: number; expression: string }
export interface LocationDiagnostics { total: number; warnings: LocationWarning[] }
const expressions = new Set(["dir", "dirname", "path", "filename", "url"]);
const globals = new Set(["__dirname", "__filename"]);
export const diagnosticLimit = 100;

/** Advisory syntax analysis only; neither imports nor application code are executed. */
export function moduleLocations(code: string, file: string): LocationWarning[] {
  if (!/import\s*\.|__dirname|__filename|\\/.test(code)) return [];
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  interface Scope { parent?: Scope; function: boolean; names: Set<string> }
  const scopes = new Map<ts.Node, Scope>(), bindings = new Set<ts.Node>();
  const root: Scope = { function: true, names: new Set() };
  function bind(name: ts.BindingName | ts.Identifier, scope: Scope) {
    if (ts.isIdentifier(name)) { scope.names.add(name.text); bindings.add(name); }
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, scope);
  }
  function collect(node: ts.Node, outer: Scope) {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly || ts.isImportSpecifier(node) && node.isTypeOnly || ts.isImportEqualsDeclaration(node) && node.isTypeOnly) return;
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    let scope = outer;
    const fn = ts.isFunctionLike(node);
    if (node !== source && (fn || ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isClassExpression(node))) {
      scope = { parent: outer, function: fn, names: new Set() };
    }
    scopes.set(node, scope);
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) { if (node.name) bind(node.name, outer); }
    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) { if (node.name) bind(node.name, scope); }
    if (ts.isParameter(node)) bind(node.name, scope);
    if (ts.isVariableDeclaration(node)) {
      let target = scope;
      if (ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) while (!target.function && target.parent) target = target.parent;
      bind(node.name, target);
    }
    if (ts.isImportClause(node) && !node.isTypeOnly && node.name) bind(node.name, scope);
    if (ts.isNamespaceImport(node) && !((node.parent as ts.ImportClause).isTypeOnly)) bind(node.name, scope);
    if (ts.isImportSpecifier(node) && !node.isTypeOnly && !(node.parent.parent as ts.ImportClause).isTypeOnly) bind(node.name, scope);
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) bind(node.name, scope);
    ts.forEachChild(node, (child) => collect(child, scope));
  }
  collect(source, root);
  const found = new Map<string, LocationWarning>();
  function visit(node: ts.Node) {
    const scope = scopes.get(node);
    if (!scope) return;
    let expression: string | undefined;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = node.expression;
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (ts.isMetaProperty(base) && base.keywordToken === ts.SyntaxKind.ImportKeyword && base.name.text === "meta" && name && expressions.has(name)) expression = `import.meta.${name}`;
    }
    if (ts.isIdentifier(node) && globals.has(node.text) && !bindings.has(node)) {
      const p = node.parent;
      const key = (ts.isPropertyAccessExpression(p) && p.name === node) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node)
        || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p);
      let shadowed = false;
      for (let s: Scope | undefined = scope; s; s = s.parent) if (s.names.has(node.text)) { shadowed = true; break; }
      if (!key && !shadowed) expression = node.text;
    }
    if (expression && !found.has(expression)) {
      const point = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.set(expression, { code: "BUNKO_MODULE_LOCATION", file, line: point.line + 1, column: point.character + 1, expression });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...found.values()];
}

export function validateLocations(input: unknown): LocationDiagnostics {
  const value = input as LocationDiagnostics;
  if (!value || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.warnings) || value.warnings.length !== Math.min(value.total, diagnosticLimit)) throw new Error("Invalid module-location diagnostics");
  const seen = new Set<string>();
  for (const item of value.warnings) {
    if (!item || item.code !== "BUNKO_MODULE_LOCATION" || typeof item.file !== "string" || !item.file || item.file.length > 4096 || /[\x00-\x1f\\]/.test(item.file) || item.file.startsWith("/") || item.file.split("/").some((s) => s === ".." || s === "." || !s)
      || !Number.isSafeInteger(item.line) || item.line < 1 || !Number.isSafeInteger(item.column) || item.column < 1 || ![...globals, ...[...expressions].map((s) => `import.meta.${s}`)].includes(item.expression)) throw new Error("Invalid module-location warning");
    const key = `${item.file}\0${item.expression}`;
    if (seen.has(key)) throw new Error("Duplicate module-location warning");
    seen.add(key);
  }
  return value;
}
