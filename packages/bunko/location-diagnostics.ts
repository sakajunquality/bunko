import * as ts from "typescript";

export const locationMessage = "Bundling may relocate this module-relative path. Use an explicit runtime asset root and verify file reads in the image.";
export interface LocationWarning { code: "BUNKO_MODULE_LOCATION"; file: string; line: number; column: number; expression: string }
/** A flagged dependency package: declared by the target itself, or reached through the declared dependencies in `via`. */
export interface LocationPackage { name: string; declared: boolean; via: string[] }
export interface LocationDiagnostics { total: number; warnings: LocationWarning[]; packages?: LocationPackage[] }
const packageName = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/;
const expressions = new Set(["dir", "dirname", "path", "filename", "url"]);
const globals = new Set(["__dirname", "__filename"]);
export const diagnosticLimit = 100;

/** Advisory syntax analysis only; neither imports nor application code are executed. */
export function moduleLocations(code: string, file: string): LocationWarning[] {
  // Escaped identifiers also need parsing, even when their spelling hides a location API.
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
        || (ts.isBindingElement(p) && p.propertyName === node) || (ts.isEnumMember(p) && p.name === node) || (ts.isJsxAttribute(p) && p.name === node)
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

/** Package owning a context-relative file, or undefined for application code. Isolated layouts nest packages as node_modules/.bun/<id>/node_modules/<name>, so the final node_modules segment is authoritative. */
export function locationPackage(file: string): string | undefined {
  const parts = file.split("/"), index = parts.lastIndexOf("node_modules");
  if (index < 0) return undefined;
  const width = parts[index + 1]?.startsWith("@") ? 2 : 1, name = parts.slice(index + 1, index + 1 + width).join("/");
  return parts.length > index + 1 + width && packageName.test(name) && !name.startsWith(".") ? name : undefined;
}

/** Resolve flagged packages against the target's declared dependencies using package-level import edges; an undefined importer is application code. */
export function locationPackages(flagged: Iterable<string>, declared: Iterable<string>, edges: Iterable<[importer: string | undefined, imported: string]>): LocationPackage[] {
  const known = new Set(declared), direct = new Set<string>(), graph = new Map<string, Set<string>>();
  for (const [importer, imported] of edges) {
    if (importer === undefined) { if (known.has(imported)) direct.add(imported); continue; }
    if (importer !== imported) (graph.get(importer) ?? graph.set(importer, new Set()).get(importer)!).add(imported);
  }
  const reach = new Map<string, Set<string>>();
  for (const root of direct) {
    const seen = new Set<string>(), queue = [root];
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) if (!seen.has(name)) { seen.add(name); queue.push(...graph.get(name) ?? []); }
    reach.set(root, seen);
  }
  return [...new Set(flagged)].sort().map((name) => ({ name, declared: known.has(name), via: known.has(name) ? [] : [...reach].filter(([, seen]) => seen.has(name)).map(([root]) => root).sort() }));
}

/** One actionable sentence naming the declared dependencies to externalize, or undefined when no dependency package was flagged. */
export function locationHint(packages: LocationPackage[] | undefined): string | undefined {
  if (!packages?.length) return undefined;
  const externals = new Set<string>(), reached = new Map<string, string[]>(), unknown: string[] = [];
  for (const item of packages) {
    if (item.declared) externals.add(item.name);
    else if (item.via.length) { const key = item.via.join(", "); for (const name of item.via) externals.add(name); (reached.get(key) ?? reached.set(key, []).get(key)!).push(item.name); }
    else unknown.push(item.name);
  }
  const quoted = (names: Iterable<string>) => [...names].sort().map((name) => JSON.stringify(name)).join(", ");
  const parts: string[] = [];
  if (externals.size) parts.push(`Add ${quoted(externals)} to bunko.external so ${externals.size === 1 ? "it stays" : "they stay"} in node_modules with ${externals.size === 1 ? "its" : "their"} module-relative files${reached.size ? ` (${[...reached].map(([via, names]) => `${names.join(", ")} reached through ${via}`).join("; ")})` : ""}`);
  if (unknown.length) parts.push(`${quoted(unknown)} ${unknown.length === 1 ? "is" : "are"} flagged inside node_modules without a declared dependency path; externalize the declared dependency that loads ${unknown.length === 1 ? "it" : "them"}`);
  return parts.join(". ");
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
  if (value.packages !== undefined) {
    if (!Array.isArray(value.packages) || value.packages.length > 10_000) throw new Error("Invalid module-location packages");
    let previous = "";
    for (const item of value.packages) {
      if (!item || typeof item.name !== "string" || !packageName.test(item.name) || item.name <= previous || typeof item.declared !== "boolean" || !Array.isArray(item.via) || item.via.length > 10_000
        || item.via.some((name, index) => typeof name !== "string" || !packageName.test(name) || index && name <= item.via[index - 1]!) || item.declared && item.via.length) throw new Error("Invalid module-location package");
      previous = item.name;
    }
  }
  return value;
}
