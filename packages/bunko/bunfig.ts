import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../oci/digest.ts";

export interface InstallPolicy { minimumReleaseAge?: number; minimumReleaseAgeExcludes?: string[] }

/** Only supported install settings are forwarded; test settings are never run. */
export async function readBunfig(directory: string): Promise<InstallPolicy> {
  let text: string;
  try { text = await readFile(join(directory, "bunfig.toml"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const config = object(Bun.TOML.parse(text), "bunfig.toml");
  for (const key of Object.keys(config)) if (!["install", "test"].includes(key)) throw new Error(`Unsupported bunfig.toml option: ${key}`);
  if (config.test !== undefined) object(config.test, "bunfig test");
  const install = object(config.install ?? {}, "bunfig install");
  for (const key of Object.keys(install)) if (!["minimumReleaseAge", "minimumReleaseAgeExcludes"].includes(key)) throw new Error(`Unsupported bunfig.toml install option: ${key}`);
  const age = install.minimumReleaseAge, excludes = install.minimumReleaseAgeExcludes;
  if (age !== undefined && (typeof age !== "number" || !Number.isSafeInteger(age) || age < 0)) throw new Error("install.minimumReleaseAge must be a non-negative integer");
  if (excludes !== undefined && (!Array.isArray(excludes) || !excludes.every((name) => typeof name === "string" && name.length > 0 && !/[\x00-\x1f]/.test(name)))) throw new Error("install.minimumReleaseAgeExcludes must be package patterns");
  return { ...(age !== undefined ? { minimumReleaseAge: age as number } : {}), ...(excludes !== undefined ? { minimumReleaseAgeExcludes: excludes as string[] } : {}) };
}

export function installConfig(policy: InstallPolicy): string {
  return '[install]\nlinker = "isolated"\n' + Object.entries(policy).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join("");
}
