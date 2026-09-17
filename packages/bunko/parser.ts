/*! @babel/types 7.29.8, @babel/helper-string-parser 7.29.7, @babel/helper-validator-identifier 7.29.7
MIT License

Copyright (c) 2014-present Sebastian McKenzie and other contributors

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
/*! @babel/parser 7.29.8
Copyright (C) 2012-2014 by various contributors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import { parse, type ParseResult, type ParserOptions } from "@babel/parser";
import { VISITOR_KEYS, type Node as BabelNode } from "@babel/types";

export type Node = BabelNode;
export type SourceFile = ParseResult<Extract<Node, { type: "File" }>>;
const parents = new WeakMap<Node, Node>();
export function is<K extends Node["type"]>(node: Node | null | undefined, type: K): node is Extract<Node, { type: K }> { return node?.type === type; }
export function parent(node: Node): Node | undefined { return parents.get(node); }
export function children(node: Node, linkParents = false): Node[] {
  const result: Node[] = [];
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    const add = (child: unknown) => {
      if (child && typeof child === "object" && "type" in child && typeof child.type === "string") { if (linkParents) parents.set(child as Node, node); result.push(child as Node); }
    };
    if (Array.isArray(value)) for (const child of value) add(child);
    else add(value);
  }
  return result;
}
export function forEachChild(node: Node, visit: (node: Node) => void): void { for (const child of children(node)) visit(child); }
export function stringValue(node: Node | null | undefined): string | undefined {
  if (is(node, "StringLiteral")) return node.value;
  if (is(node, "TemplateLiteral") && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
}
export function propertyName(node: Node | null | undefined): string | undefined { return is(node, "Identifier") ? node.name : stringValue(node); }
export function member(node: Node): { base: Node; name?: string } | undefined {
  if (is(node, "JSXMemberExpression")) return { base: node.object, name: node.property.name };
  if (is(node, "MemberExpression") || is(node, "OptionalMemberExpression")) return { base: node.object, name: node.computed ? stringValue(node.property) : propertyName(node.property) };
}
export function isImportMeta(node: Node): boolean { return is(node, "MetaProperty") && node.meta.name === "import" && node.property.name === "meta"; }
export function moduleSpecifier(node: Node): Node | undefined {
  if (is(node, "ImportDeclaration") || is(node, "ExportNamedDeclaration") || is(node, "ExportAllDeclaration")) return node.source ?? undefined;
  if (is(node, "TSExternalModuleReference")) return node.expression;
  if ((is(node, "CallExpression") || is(node, "OptionalCallExpression")) && (is(node.callee, "Import") || is(node.callee, "Identifier") && node.callee.name === "require")) return node.arguments[0];
  if (is(node, "ImportExpression")) return node.source;
}
/** Parse only. No transforms, module resolution, plugins loaded from disk or code execution. */
export function parseSource(code: string, name: string): SourceFile {
  let source: SourceFile;
  try {
    const options: ParserOptions = { sourceFilename: name, sourceType: "unambiguous", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowUndeclaredExports: true,
      errorRecovery: true, attachComment: false, createImportExpressions: false, createParenthesizedExpressions: true,
      plugins: [.../\.tsx?$|\.mts$|\.cts$/.test(name) ? ["typescript" as const] : [], .../\.[cm]?jsx?$|\.tsx$/.test(name) ? ["jsx" as const] : [], "deferredImportEvaluation", "deprecatedImportAssert", "decorators-legacy", "decoratorAutoAccessors"] };
    source = parse(code, options);
    // Babel's recovery mode can retain errors from its initial module attempt
    // even after unambiguous parsing classifies a file as a sloppy script.
    if (source.program.sourceType === "script" && source.errors?.length) source = parse(code, { ...options, sourceType: "script" });
  } catch (error) { if (error instanceof RangeError) throw new Error(`Executable syntax exceeds parser limits: ${name}`, { cause: error }); throw new Error(`Unsupported or invalid executable syntax: ${name}`); }
  return source;
}

/** Property keys, labels and import/export syntax are not runtime references. */
export function isNonReferenceIdentifier(node: Node): boolean {
  const p = parent(node);
  if (!p) return false;
  if (is(p, "MemberExpression") || is(p, "OptionalMemberExpression")) return p.property === node && !p.computed;
  if (is(p, "ObjectProperty") || is(p, "ObjectMethod") || is(p, "ClassMethod") || is(p, "ClassProperty") || is(p, "ClassAccessorProperty")) return p.key === node && !p.computed;
  if (is(p, "TSEnumMember")) return p.id === node;
  return ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ExportSpecifier", "ExportNamespaceSpecifier", "LabeledStatement", "BreakStatement", "ContinueStatement"].includes(p.type);
}

export function isReferencedJSXName(node: Node): node is Extract<Node, { type: "JSXIdentifier" }> {
  if (!is(node, "JSXIdentifier")) return false;
  const p = parent(node);
  if (is(p, "JSXMemberExpression")) return p.object === node;
  return (is(p, "JSXOpeningElement") || is(p, "JSXClosingElement")) && p.name === node && !/^[a-z]/.test(node.name);
}
