import * as ts from "typescript";
export interface Scope { parent?: Scope; function: boolean; names: Set<string> }

/** Collect value bindings before inspecting references, including hoisted declarations. */
export function lexicalScopes(source: ts.SourceFile) {
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
  return { scopes, bindings };
}
