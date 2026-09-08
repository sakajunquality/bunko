import { object } from "../oci/digest.ts";

export function registrySpecifier(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || /^(?:file:|link:|workspace:|catalog:|git|github:|https?:|\.|\/)/.test(value) || (value.includes("/") && !value.startsWith("npm:"))) throw new Error(`Bunko supports registry dependencies only: ${name}`);
}

export function catalogs(manifest: Record<string, unknown>): { catalog: Record<string, string>; catalogs: Record<string, Record<string, string>> } {
  const workspace = manifest.workspaces !== undefined && !Array.isArray(manifest.workspaces) ? object(manifest.workspaces, "workspaces") : {};
  function field(name: string): unknown {
    if (manifest[name] !== undefined && workspace[name] !== undefined) throw new Error(`Define ${name} at the root or inside workspaces, not both`);
    return manifest[name] ?? workspace[name] ?? {};
  }
  function entries(value: unknown): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    for (const [name, version] of Object.entries(object(value, "catalog"))) {
      if (name.split("/").some((part) => part === "." || part === "..") || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid catalog package name");
      registrySpecifier(name, version);
      result[name] = version;
    }
    return result;
  }
  const named: Record<string, Record<string, string>> = Object.create(null);
  for (const [name, value] of Object.entries(object(field("catalogs"), "catalogs"))) {
    if (!name || name.trim() !== name || /[\s\x00-\x1f]/.test(name)) throw new Error("Invalid catalog name");
    named[name] = entries(value);
  }
  return { catalog: entries(field("catalog")), catalogs: named };
}

export function catalogSpecifier(definitions: ReturnType<typeof catalogs>, name: string, reference: string): string {
  const group = reference.slice("catalog:".length).trim();
  const values = group ? definitions.catalogs[group] : definitions.catalog;
  if (!values || !Object.hasOwn(values, name)) throw new Error(`Missing catalog dependency: ${name}`);
  return values[name]!;
}
