import { children, is, parent, type Node, type SourceFile } from "./parser.ts";
export interface Scope { parent?: Scope; function: boolean; names: Set<string> }
const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod", "TSDeclareFunction", "TSDeclareMethod"]);
const runtimeTS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSNonNullExpression", "TSInstantiationExpression", "TSEnumDeclaration", "TSEnumMember", "TSModuleDeclaration", "TSModuleBlock", "TSImportEqualsDeclaration", "TSExternalModuleReference", "TSExportAssignment", "TSParameterProperty"]);

/** Collect value bindings before inspecting references, including hoisted declarations. */
export function lexicalScopes(source: SourceFile, includeClassHeritage = true) {
  const scopes = new Map<Node, Scope>(), bindings = new Set<Node>();
  const root: Scope = { function: true, names: new Set() };
  function bind(name: Node | null | undefined, scope: Scope) {
    if (is(name, "Identifier")) { scope.names.add(name.name); bindings.add(name); }
    else if (is(name, "ObjectPattern")) for (const prop of name.properties) bind(is(prop, "ObjectProperty") ? prop.value : prop.argument, scope);
    else if (is(name, "ArrayPattern")) for (const element of name.elements) bind(element, scope);
    else if (is(name, "RestElement")) bind(name.argument, scope);
    else if (is(name, "AssignmentPattern")) bind(name.left, scope);
    else if (is(name, "TSParameterProperty")) bind(name.parameter, scope);
  }
  function collect(node: Node, outer: Scope) {
    if (is(node, "ImportDeclaration") && node.importKind === "type" || is(node, "ImportSpecifier") && node.importKind === "type" || is(node, "TSImportEqualsDeclaration") && node.importKind === "type") return;
    if ((node.type.startsWith("TS") || ["VariableDeclaration", "ClassDeclaration", "FunctionDeclaration"].includes(node.type)) && (node as unknown as { declare?: boolean }).declare) return;
    if (node.type.startsWith("TS") && !runtimeTS.has(node.type)) return;
    let scope = outer;
    const fn = functions.has(node.type);
    if (node !== source && (fn || ["BlockStatement", "StaticBlock", "SwitchStatement", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement", "ClassExpression"].includes(node.type))) scope = { parent: outer, function: fn, names: new Set() };
    scopes.set(node, scope);
    if (is(node, "FunctionDeclaration") || is(node, "ClassDeclaration") || is(node, "TSEnumDeclaration")) bind(node.id, outer);
    if (is(node, "FunctionExpression") || is(node, "ClassExpression")) bind(node.id, scope);
    if (fn && "params" in node) for (const param of node.params) bind(param, scope);
    if (is(node, "CatchClause")) bind(node.param, scope);
    if (is(node, "VariableDeclarator")) {
      let target = scope; const p = parent(node);
      if (is(p, "VariableDeclaration") && p.kind === "var") while (!target.function && target.parent) target = target.parent;
      bind(node.id, target);
    }
    if (is(node, "ImportSpecifier") || is(node, "ImportDefaultSpecifier") || is(node, "ImportNamespaceSpecifier")) bind(node.local, scope);
    if (is(node, "TSImportEqualsDeclaration")) bind(node.id, scope);
    for (const child of children(node, true)) {
      if (!includeClassHeritage && (is(node, "ClassDeclaration") || is(node, "ClassExpression")) && child === node.superClass) continue;
      collect(child, scope);
    }
  }
  collect(source, root);
  return { scopes, bindings };
}
