import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Document, type Node, type Scalar } from "yaml";

function valueValid(value: string): boolean { return value.length <= 63 && (!value || /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(value)); }
function keyValid(key: string): boolean {
  const parts = key.split("/");
  if (parts.length > 2 || !parts.at(-1) || !valueValid(parts.at(-1)!)) return false;
  return parts.length === 1 || parts[0]!.length <= 253 && parts[0]!.split(".").every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part));
}

/** Kubernetes equality, existence and set requirements, combined with AND. */
export function labelSelector(selector: string): (labels: Record<string, string>) => boolean {
  if (!selector.trim() || selector.length > 16_384) throw new Error("Invalid label selector");
  const parts: string[] = []; let depth = 0, start = 0;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (character === "(") depth++; else if (character === ")") depth--;
    if (depth < 0 || depth > 1) throw new Error("Invalid label selector parentheses");
    if (character === "," && depth === 0) { parts.push(selector.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(selector.slice(start).trim());
  if (depth || parts.length > 128) throw new Error("Invalid label selector");
  const requirements = parts.map((part) => {
    const set = /^(\S+)\s+(in|notin)\s*\(([^()]*)\)$/.exec(part);
    const equal = /^([^\s!=(),]+)\s*(==|!=|=)\s*([^\s,()]*)$/.exec(part);
    const key = set?.[1] ?? equal?.[1] ?? part.replace(/^!/, "");
    if (!keyValid(key)) throw new Error(`Invalid label selector key: ${key}`);
    if (set) {
      const values = set[3]!.split(",").map((value) => value.trim());
      if (!set[3]!.trim() || !values.every(valueValid)) throw new Error("Invalid label selector set");
      return (labels: Record<string, string>) => set[2] === "in" ? Object.hasOwn(labels, key) && values.includes(labels[key]!) : !Object.hasOwn(labels, key) || !values.includes(labels[key]!);
    }
    if (equal) {
      const value = equal[3]!;
      if (!valueValid(value)) throw new Error("Invalid label selector value");
      return (labels: Record<string, string>) => equal[2] === "!=" ? !Object.hasOwn(labels, key) || labels[key] !== value : Object.hasOwn(labels, key) && labels[key] === value;
    }
    return (labels: Record<string, string>) => part.startsWith("!") ? !Object.hasOwn(labels, key) : Object.hasOwn(labels, key);
  });
  return (labels) => requirements.every((requirement) => requirement(labels));
}

/** Preserve validated float tokens instead of rounding through JavaScript numbers. */
class FloatLiteral {
  constructor(readonly source: string) {}
  toString() { return this.source; }
}

function mappingValue(node: unknown, key: string, document: Document, seen = new Set<unknown>()): unknown {
  if (seen.has(node)) throw new Error("Cyclic metadata label aliases");
  if (seen.size > 100) throw new Error("Excessive metadata label aliases");
  seen.add(node);
  if (isAlias(node)) return mappingValue(node.resolve(document), key, document, seen);
  if (!isMap(node)) return;
  if (node.has(key)) return node.get(key, true);
  for (const pair of node.items) if (isScalar(pair.key) && typeof pair.key.addToJSMap === "function") {
    const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const source of sources) {
      const value = mappingValue(source, key, document, new Set(seen));
      if (value !== undefined) return value;
    }
  }
}

/** Selection may normalize YAML formatting; unfiltered resolution stays lossless. */
export function selectDocuments(name: string, source: string, match: (labels: Record<string, string>) => boolean): string | undefined {
  const documents = parseAllDocuments(source, { prettyErrors: true, intAsBigInt: true, merge: true, logLevel: "silent",
    customTags: (tags) => tags.map((tag) => typeof tag !== "string" && tag.collection === undefined && tag.tag === "tag:yaml.org,2002:float" ? {
      ...tag, identify: (value: unknown) => value instanceof FloatLiteral,
      resolve: (value: string) => new FloatLiteral(value), stringify: (node: Scalar) => String(node.value),
    } : tag),
  });
  const selected = [];
  for (const document of documents) {
    if (document.errors.length || document.warnings.length) throw new Error(`${name}: ${[...document.errors, ...document.warnings][0]!.message}`);
    if (!document.contents || isScalar(document.contents) && document.contents.value === null) continue;
    const metadata = mappingValue(document.contents, "metadata", document);
    let labelsNode = mappingValue(metadata, "labels", document) as Node | undefined;
    const labelAliases = new Set<Node>();
    while (isAlias(labelsNode)) {
      if (labelAliases.has(labelsNode) || labelAliases.size >= 100) throw new Error(`${name}: cyclic or excessive label aliases`);
      labelAliases.add(labelsNode); labelsNode = labelsNode.resolve(document);
    }
    if (labelsNode && !(isScalar(labelsNode) && labelsNode.value === null) && !isMap(labelsNode)) throw new Error(`${name}: metadata.labels must be a string map`);
    const labels = labelsNode?.toJS(document, { maxAliasCount: 100 }) ?? {};
    if (!labels || typeof labels !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(labels)) || !Object.values(labels).every((value) => typeof value === "string")) throw new Error(`${name}: metadata.labels must be a string map`);
    if (match(labels)) selected.push(document);
  }
  if (!selected.length) return;
  try { JSON.parse(source); return source; } catch { /* YAML can contain several selected documents. */ }
  return selected.map((document) => {
    document.directives.docStart = true;
    document.directives.docEnd = true;
    return document.toString();
  }).join("");
}
