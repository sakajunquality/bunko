import { supportedBunVersion } from "./bun-version.ts";
import { object } from "../oci/digest.ts";
import type { Toolchain } from "./toolchain.ts";

/** Sources name the declaration behind each requirement (`bunko.toolchain.version`, `package.json#packageManager`, `services/api/package.json#engines.bun`) so mismatch messages can say what to change. `rangeSources[i]` describes `ranges[i]`. */
export interface ToolchainRequirements { version?: string; versionSource?: string; revision?: string; ranges: string[]; rangeSources?: string[] }

/** Declarations constrain a selected local toolchain; they never download one. `names[i]` labels `manifests[i]` in messages and defaults to `package.json`. */
export function toolchainRequirements(manifests: Record<string, unknown>[], value?: unknown, names: string[] = []): ToolchainRequirements {
  const config = object(value ?? {}, "toolchain");
  if (Object.keys(config).some((key) => !["version", "revision"].includes(key))) throw new Error("toolchain accepts version and revision only");
  const versions: { version: string; source: string }[] = [], ranges = new Map<string, string>();
  if (config.version !== undefined) {
    if (!supportedBunVersion(config.version)) throw new Error("toolchain.version must be an exact supported Bun version (>=1.3.13 <1.5)");
    versions.push({ version: config.version, source: "bunko.toolchain.version" });
  }
  if (config.revision !== undefined && (typeof config.revision !== "string" || !/^[a-f0-9]{7,40}$/.test(config.revision))) throw new Error("toolchain.revision must be the exact revision printed by bun --revision");
  manifests.forEach((manifest, index) => {
    const name = names[index] ?? "package.json";
    if (typeof manifest.packageManager === "string" && manifest.packageManager.startsWith("bun@")) {
      const version = manifest.packageManager.slice(4);
      if (!supportedBunVersion(version)) throw new Error(`Bun packageManager must declare an exact supported version (${name}#packageManager)`);
      versions.push({ version, source: `${name}#packageManager` });
    }
    const engines = object(manifest.engines ?? {}, "engines");
    if (engines.bun !== undefined) {
      if (typeof engines.bun !== "string" || !engines.bun.trim()) throw new Error(`engines.bun must be a nonempty version range (${name}#engines.bun)`);
      if (!ranges.has(engines.bun)) ranges.set(engines.bun, `${name}#engines.bun`);
    }
  });
  if (new Set(versions.map((entry) => entry.version)).size > 1) throw new Error(`Conflicting Bun toolchain version declarations: ${versions.map((entry) => `${entry.version} (${entry.source})`).join(", ")}`);
  return { version: versions[0]?.version, versionSource: versions[0]?.source, revision: config.revision as string | undefined, ranges: [...ranges.keys()], rangeSources: [...ranges.values()] };
}

/** Messages name the selected binary, both versions and the declaration source so the user can decide between installing another Bun and changing the pin. */
export function assertToolchain(requirements: ToolchainRequirements, selected: Toolchain): void {
  const binary = `Selected Bun ${selected.version} (${selected.path})`, fix = "select it with --bun-path, or change the declaration";
  if (requirements.version && requirements.version !== selected.version) throw new Error(`${binary} does not match the declared version ${requirements.version} (${requirements.versionSource ?? "package.json#packageManager"}). Install Bun ${requirements.version} and ${fix}.`);
  if (requirements.revision && requirements.revision !== selected.revision) throw new Error(`${binary} revision ${selected.revision} does not match the declared revision ${requirements.revision} (bunko.toolchain.revision). Install that Bun build and ${fix}.`);
  requirements.ranges.forEach((range, index) => {
    if (!Bun.semver.satisfies(selected.version, range)) throw new Error(`${binary} does not satisfy engines.bun ${range} (${requirements.rangeSources?.[index] ?? "package.json#engines.bun"}). Install a Bun version in that range and ${fix}.`);
  });
}
