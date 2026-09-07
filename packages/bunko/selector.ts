import { parseAllDocuments } from "yaml";

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

/** Selection may normalize YAML formatting; unfiltered resolution stays lossless. */
export function selectDocuments(name: string, source: string, match: (labels: Record<string, string>) => boolean): string | undefined {
  const documents = parseAllDocuments(source, { prettyErrors: true, intAsBigInt: true, logLevel: "silent" });
  const selected = [];
  for (const document of documents) {
    if (document.errors.length || document.warnings.length) throw new Error(`${name}: ${[...document.errors, ...document.warnings][0]!.message}`);
    const value = document.toJS({ maxAliasCount: 100 });
    const labels = value?.metadata?.labels ?? {};
    if (!labels || typeof labels !== "object" || Array.isArray(labels) || !Object.values(labels).every((value) => typeof value === "string")) throw new Error(`${name}: metadata.labels must be a string map`);
    if (match(labels)) selected.push(document);
  }
  if (!selected.length) return;
  try { JSON.parse(source); return source; } catch { /* YAML can contain several selected documents. */ }
  return selected.map((document) => {
    document.directives.docStart = true;
    document.directives.docEnd = true;
    // Keep an inherited YAML version explicit after dropping earlier documents.
    document.directives.yaml.explicit = true;
    return document.toString();
  }).join("");
}
