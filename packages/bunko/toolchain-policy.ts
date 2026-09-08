import { object } from "../oci/digest.ts";
import type { Toolchain } from "./toolchain.ts";

export interface ToolchainRequirements { version?: string; revision?: string; ranges: string[] }

/** Declarations constrain a selected local toolchain; they never download one. */
export function toolchainRequirements(manifests: Record<string, unknown>[], value?: unknown): ToolchainRequirements {
  const config = object(value ?? {}, "toolchain");
  if (Object.keys(config).some((key) => !["version", "revision"].includes(key))) throw new Error("toolchain accepts version and revision only");
  const versions: string[] = [], ranges: string[] = [];
  if (config.version !== undefined) {
    if (typeof config.version !== "string" || !/^1\.3\.\d+$/.test(config.version) || Number(config.version.split(".")[2]) < 11) throw new Error("toolchain.version must be an exact supported Bun 1.3 version");
    versions.push(config.version);
  }
  if (config.revision !== undefined && (typeof config.revision !== "string" || !/^[a-f0-9]{7,40}$/.test(config.revision))) throw new Error("toolchain.revision must be the exact revision printed by bun --revision");
  for (const manifest of manifests) {
    if (typeof manifest.packageManager === "string" && manifest.packageManager.startsWith("bun@")) {
      const version = manifest.packageManager.slice(4);
      if (!/^1\.3\.\d+$/.test(version) || Number(version.split(".")[2]) < 11) throw new Error("Bun packageManager must declare an exact supported version");
      versions.push(version);
    }
    const engines = object(manifest.engines ?? {}, "engines");
    if (engines.bun !== undefined) {
      if (typeof engines.bun !== "string" || !engines.bun.trim()) throw new Error("engines.bun must be a nonempty version range");
      ranges.push(engines.bun);
    }
  }
  if (new Set(versions).size > 1) throw new Error("Conflicting Bun toolchain version declarations");
  return { version: versions[0], revision: config.revision as string | undefined, ranges: [...new Set(ranges)] };
}

export function assertToolchain(requirements: ToolchainRequirements, selected: Toolchain): void {
  if (requirements.version && requirements.version !== selected.version) throw new Error("Selected Bun does not match the declared version; install it locally and select --bun-path");
  if (requirements.revision && requirements.revision !== selected.revision) throw new Error("Selected Bun does not match the declared revision");
  if (requirements.ranges.some((range) => !Bun.semver.satisfies(selected.version, range))) throw new Error("Selected Bun does not satisfy engines.bun");
}
