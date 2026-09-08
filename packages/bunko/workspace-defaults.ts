import { object } from "../oci/digest.ts";

const allowed = new Set(["mode", "base", "platforms", "assets", "assetMappings", "external", "env", "ports", "user", "workdir", "labels", "annotations", "args", "build", "runtime", "deps", "inheritBaseOciLabels", "toolchain"]);
const maps = ["env", "labels", "annotations", "build", "runtime", "deps", "toolchain"];

/** Shared defaults are explicit; arrays replace and configuration maps merge by key. */
export function workspaceDefaults(config: Record<string, unknown>, rootConfig?: unknown, isRoot = false): Record<string, unknown> {
  if (config.defaults !== undefined && !isRoot) throw new Error("bunko.defaults is only supported at a workspace root");
  const root = object(rootConfig ?? {}, "Workspace bunko"), defaults = object(root.defaults ?? {}, "bunko.defaults");
  if (Object.keys(defaults).some((key) => !allowed.has(key))) throw new Error("Unsupported workspace default option");
  const { defaults: _defaults, ...member } = config;
  const result = { ...defaults, ...member };
  for (const key of maps) {
    if (member[key] === null) result[key] = undefined;
    else if (defaults[key] !== undefined && member[key] !== undefined) result[key] = { ...object(defaults[key], `defaults.${key}`), ...object(member[key], key) };
  }
  if (defaults.build !== undefined && member.build !== undefined && member.build !== null) {
    const inherited = object(defaults.build, "defaults.build"), selected = object(member.build, "build");
    if (inherited.define !== undefined && selected.define !== undefined) (result.build as Record<string, unknown>).define = selected.define === null ? {} : { ...object(inherited.define, "defaults.build.define"), ...object(selected.define, "build.define") };
  }
  return result;
}
