import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { object } from "../oci/digest.ts";

/** Validate only configuration selected by an executable application input. */
export async function validateInputTsconfig(root: string, input: string, seen = new Set<string>()): Promise<void> {
  async function visit(file: string): Promise<void> {
    const path = await realpath(file), local = relative(root, path);
    if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("tsconfig extends must stay inside the project snapshot");
    if (seen.has(path)) return;
    seen.add(path);
    const config = object(Bun.JSONC.parse(await readFile(path, "utf8")), "tsconfig");
    if (config.extends === undefined) return;
    for (const parent of Array.isArray(config.extends) ? config.extends : [config.extends]) {
      if (typeof parent !== "string" || !parent.startsWith(".")) throw new Error("Bunko supports only relative tsconfig extends inside the project");
      const candidate = resolve(dirname(path), parent);
      await visit(candidate.endsWith(".json") ? candidate : `${candidate}.json`);
    }
  }
  let directory = dirname(input);
  while (true) {
    const candidate = resolve(directory, "tsconfig.json");
    if (await Bun.file(candidate).exists()) { await visit(candidate); return; }
    if (directory === root || dirname(directory) === directory) return;
    directory = dirname(directory);
  }
}
