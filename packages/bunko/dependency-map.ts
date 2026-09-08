import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { object } from "../oci/digest.ts";

export async function canonicalDependencyMap(map: Record<string, Record<string, string>>): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [path, references] of Object.entries(map)) {
    const target = await realpath(path);
    if (result[target]) throw new Error("Duplicate canonical dependency target");
    result[target] = references;
  }
  return result;
}

export async function dependencyMap(file: string): Promise<Record<string, Record<string, string>>> {
  const map = object(JSON.parse(await readFile(file, "utf8")), "Dependency map"), result: Record<string, Record<string, string>> = {};
  for (const [path, raw] of Object.entries(map)) {
    const target = await realpath(resolve(dirname(file), path));
    if (result[target]) throw new Error("Duplicate canonical dependency target");
    const values = object(raw, "Dependency platforms"), references: Record<string, string> = {};
    if (!Object.keys(values).length) throw new Error("Dependency platform map cannot be empty");
    for (const [platform, ref] of Object.entries(values)) {
      if (!["linux/amd64", "linux/arm64"].includes(platform) || typeof ref !== "string" || !ref) throw new Error("Invalid dependency platform reference");
      if (!ref.startsWith("layout:") && !/@sha256:[a-f0-9]{64}$/.test(ref)) throw new Error("Dependency artifacts must be layouts or digest-pinned references");
      references[platform] = ref.startsWith("layout:") ? `layout:${await realpath(resolve(dirname(file), ref.slice(7)))}` : ref;
    }
    result[target] = references;
  }
  return result;
}
