import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import { hashFile } from "./files.ts";
import { VERSION } from "./config.ts";

let identity: Promise<{ version: string; digest: string; kind: "bundle" | "source" }> | undefined;
export function builderIdentity() {
  return identity ??= (async () => {
    const file = import.meta.path;
    if (!file.endsWith("/packages/bunko/identity.ts")) return { version: VERSION, digest: await hashFile(file), kind: "bundle" as const };
    const root = resolve(dirname(file), "../.."), records = [];
    const paths = [...await Array.fromAsync(new Bun.Glob("packages/**/*.ts").scan({ cwd: root })), "package.json", "bun.lock"].sort();
    for (const path of paths) records.push({ path, digest: sha256(await readFile(join(root, path))) });
    return { version: VERSION, digest: sha256(canonicalJSON(records)), kind: "source" as const };
  })();
}
