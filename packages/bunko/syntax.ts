import { forEachChild, is, member, moduleSpecifier, parseSource, propertyName, stringValue, type Node, type SourceFile } from "./parser.ts";

/** Parse syntax only: never resolve imports, transform code, or execute macros. */
export function rejectMacroSyntax(code: string, name: string, analysis?: () => SourceFile): { specifier: string; loader: "json" | "text" | "file" | "toml" }[] {
  const ordinary = new Set<string>();
  const data: { specifier: string; loader: "json" | "text" | "file" | "toml" }[] = [];
  if (!/import|export|require|\\/.test(code)) return data;
  const source = analysis?.() ?? parseSource(code, name), pending: Node[] = [source];
  while (pending.length) {
    const node = pending.pop()!;
    const declaration = is(node, "ImportDeclaration") || is(node, "ExportNamedDeclaration") || is(node, "ExportAllDeclaration") ? node : undefined;
    const dynamic = is(node, "CallExpression") && is(node.callee, "Import") ? node : undefined;
    if (declaration && "phase" in declaration && declaration.phase === "defer") throw new Error(`Deferred imports are not supported: ${name}`);
    if (is(node, "ImportExpression") && node.phase === "defer") throw new Error(`Deferred imports are not supported: ${name}`);
    const specifier = moduleSpecifier(node), text = stringValue(specifier);
    let unsafeAttributes = false, dataLoader: string | undefined;
    const supported = (key: string | undefined, value: Node) => {
      const text = stringValue(value);
      if (text === undefined) return false;
      if (key === "type" && ["json", "text", "file", "toml"].includes(text)) { dataLoader = text; return true; }
      return key === "resolution-mode" && ["import", "require"].includes(text);
    };
    const attributes = declaration?.attributes ?? declaration?.assertions;
    if (attributes?.length) unsafeAttributes = attributes.length !== 1 || attributes.some((item) => !supported(propertyName(item.key), item.value));
    // Babel uses [] both for absent attributes and an explicit empty block.
    // Inspect only trivia after this parsed module specifier, never arbitrary text.
    if (declaration?.source && attributes?.length === 0) {
      let tail = code.slice(declaration.source.end!, declaration.end!);
      for (;;) {
        tail = tail.trimStart();
        if (tail.startsWith("/*")) { const end = tail.indexOf("*/", 2); if (end < 0) break; tail = tail.slice(end + 2); continue; }
        if (tail.startsWith("//")) { const end = tail.search(/[\r\n\u2028\u2029]/); if (end < 0) { tail = ""; break; } tail = tail.slice(end + 1); continue; }
        break;
      }
      if (/^(?:with|assert)\b/.test(tail)) unsafeAttributes = true;
    }
    if (dynamic && dynamic.arguments.length > 1) {
      const options = dynamic.arguments[1]; unsafeAttributes = true;
      if (dynamic.arguments.length === 2 && is(options, "ObjectExpression") && options.properties.length === 1) {
        const prop = options.properties[0]!;
        if (is(prop, "ObjectProperty") && !prop.computed && ["with", "assert"].includes(propertyName(prop.key) ?? "") && is(prop.value, "ObjectExpression") && prop.value.properties.length === 1) {
          const attr = prop.value.properties[0]!;
          unsafeAttributes = !(is(attr, "ObjectProperty") && !attr.computed && supported(propertyName(attr.key), attr.value));
        }
      }
    }
    if (unsafeAttributes || text?.startsWith("macro:")) throw new Error(`Import attributes / macros are not supported: ${name}`);
    if (dataLoader) {
      if (text === undefined) throw new Error(`Data import attributes require literal specifiers: ${name}`);
      data.push({ specifier: text, loader: dataLoader as "json" | "text" | "file" | "toml" });
    } else if (text !== undefined) ordinary.add(text);
    forEachChild(node, (child) => { pending.push(child); });
  }
  if (data.some((item) => ordinary.has(item.specifier))) throw new Error("A file cannot mix data-loader and ordinary imports");
  if (source.errors?.length) throw new Error(`Unsupported or invalid executable syntax: ${name}`);
  return data;
}

/** Reject computed application loads structurally, without inspecting comments. */
export function rejectApplicationImports(code: string, name: string, analysis?: () => SourceFile): void {
  if (!/import|require|\\/.test(code)) return;
  const pending: Node[] = [analysis?.() ?? parseSource(code, name)];
  while (pending.length) {
    const node = pending.pop()!;
    if (is(node, "CallExpression") || is(node, "OptionalCallExpression")) {
      const access = member(node.callee);
      if ((is(node.callee, "Import") || is(node.callee, "Identifier") && node.callee.name === "require" || access && is(access.base, "Identifier") && access.base.name === "require" && access.name === "resolve") && stringValue(node.arguments[0]) === undefined) throw new Error(`Computed require/import is not supported in application source: ${name}`);
    }
    if (is(node, "ImportExpression") && node.phase === "defer") throw new Error(`Deferred imports are not supported in application source: ${name}`);
    forEachChild(node, (child) => { pending.push(child); });
  }
}
