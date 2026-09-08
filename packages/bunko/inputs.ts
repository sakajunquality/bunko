import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { isBuiltin } from "node:module";
import { preProcessFile } from "typescript";
import type { Project } from "./config.ts";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import type { Digest } from "../oci/types.ts";
import { hashFile } from "./files.ts";

/** Keep all root inputs and whole reachable members. Unknown resolution uses
 * the full snapshot; this is not a replacement for Bun's module resolver. */
export async function targetInputs(root: string, project: Project, fallback: Digest): Promise<{ digest: Digest; paths?: Set<string> }> {
  if (!project.workspace || !project.targetPath) return { digest: fallback };
  const members = project.workspace.packages.filter((p) => p.path);
  if (project.workspace.packages.some((p) => p.text.includes("../"))) return { digest: fallback };
  const owner = (path: string) => members.find((p) => path === p.path || path.startsWith(`${p.path}/`));
  const selected = new Set([project.targetPath]);
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = posix.join(path, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  await walk(""); files.sort();
  // Config-based aliases may reach arbitrary members. Preserve correctness.
  for (const path of files.filter((p) => /\.jsonc?$/.test(p))) {
    const config = await readFile(join(root, path), "utf8");
    if (/"(?:paths|baseUrl)"\s*:/.test(config)) return { digest: fallback };
  }
  const scanned = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of files) {
      const member = owner(path);
      if (member && !selected.has(member.path) || scanned.has(path)) continue;
      scanned.add(path);
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) continue;
      const code = await readFile(join(root, path), "utf8");
      // Escaped specifiers and HTML/CSS loaders need the conservative path.
      if (code.includes("\\")) return { digest: fallback };
      for (const ref of preProcessFile(code, true, true).importedFiles) {
        const specifier = ref.fileName;
        let dependency;
        if (specifier.startsWith(".")) dependency = owner(posix.normalize(posix.join(dirname(path), specifier)));
        else {
          dependency = members.find((p) => specifier === p.manifest.name || specifier.startsWith(`${p.manifest.name}/`));
          if (!dependency && !isBuiltin(specifier) && !/^bun(?::|$)/.test(specifier)) {
            return { digest: fallback };
          }
        }
        if (/\.(?:html|css)$/.test(specifier)) return { digest: fallback };
        if (dependency && !selected.has(dependency.path)) { selected.add(dependency.path); changed = true; }
      }
    }
  }
  const included = files.filter((path) => !owner(path) || selected.has(owner(path)!.path) || /\.jsonc?$/.test(path));
  const records = [];
  for (const path of included) records.push({ path, digest: await hashFile(join(root, path)), executable: Boolean((await stat(join(root, path))).mode & 0o111) });
  return { digest: sha256(canonicalJSON({ format: "member-inputs-v1", records })), paths: new Set(included) };
}
