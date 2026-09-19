import { readConfigInput, parseConfigInput } from "./config-input.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../oci/digest.ts";

export interface InstallPolicy { networkConcurrency?: number; minimumReleaseAge?: number; minimumReleaseAgeExcludes?: string[] }

/** Only supported install settings are forwarded; test settings are never run. */
export async function readBunfig(directory: string): Promise<InstallPolicy> {
  let text: string;
  try { text = await readConfigInput(directory, "bunfig.toml"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const config = object(parseConfigInput(text, "bunfig.toml", Bun.TOML.parse), "bunfig.toml");
  for (const key of Object.keys(config)) if (!["install", "test"].includes(key)) throw new Error(`Unsupported bunfig.toml option: ${key}`);
  if (config.test !== undefined) object(config.test, "bunfig test");
  const install = object(config.install ?? {}, "bunfig install");
  for (const key of Object.keys(install)) if (!["minimumReleaseAge", "minimumReleaseAgeExcludes", "networkConcurrency"].includes(key)) throw new Error(`Unsupported bunfig.toml install option: ${key}`);
  const age = install.minimumReleaseAge, excludes = install.minimumReleaseAgeExcludes;
  if (age !== undefined && (typeof age !== "number" || !Number.isSafeInteger(age) || age < 0)) throw new Error("install.minimumReleaseAge must be a non-negative integer");
  if (excludes !== undefined && (!Array.isArray(excludes) || !excludes.every((name) => typeof name === "string" && name.length > 0 && !/[\x00-\x1f]/.test(name)))) throw new Error("install.minimumReleaseAgeExcludes must be package patterns");
  const networkConcurrency = install.networkConcurrency === undefined ? undefined : validateNetworkConcurrency(install.networkConcurrency, "install.networkConcurrency");
  return { ...(networkConcurrency === undefined ? {} : { networkConcurrency }), ...(age !== undefined ? { minimumReleaseAge: age as number } : {}), ...(excludes !== undefined ? { minimumReleaseAgeExcludes: excludes as string[] } : {}) };
}

/** Transport controls do not change dependency bytes or belong in Bun's TOML. */
export function resolutionPolicy(policy: InstallPolicy): Omit<InstallPolicy, "networkConcurrency"> {
  const { networkConcurrency: _, ...resolution } = policy;
  return resolution;
}

export function installConfig(policy: InstallPolicy): string {
  return '[install]\nlinker = "isolated"\n' + Object.entries(resolutionPolicy(policy)).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join("");
}

/** Keep transport tuning bounded and reject values without echoing environment contents. */
export function validateNetworkConcurrency(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return value;
}

export function installConcurrency(policy: InstallPolicy, environment: NodeJS.ProcessEnv = process.env): number | undefined {
  if (policy.networkConcurrency !== undefined) return policy.networkConcurrency;
  const value = environment.BUN_CONFIG_NETWORK_CONCURRENCY;
  if (value === undefined || value === "") return;
  return validateNetworkConcurrency(Number(value), "BUN_CONFIG_NETWORK_CONCURRENCY");
}
