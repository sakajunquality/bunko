import { gitSourceIgnore } from "./source-policy.ts";
import { assetExcluder } from "./asset-policy.ts";
import { object } from "../oci/digest.ts";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Project } from "./config.ts";

export const sourceOmissions = new Set([".git", ".cursor", "node_modules", ".bunko-output", ".bunko-build", ".npmrc", ".bunko-cache", ".docker", ".aws", ".config", ".yarnrc.yml", ".DS_Store", ".ssh", ".kube", ".gnupg", ".netrc", ".terraform", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "terraform.tfstate", "terraform.tfstate.backup"]);

/** Names snapshot() never packages, checked on every path segment: VCS, dependency, credential and internal output/cache entries. */
export function omittedSourceName(name: string): boolean {
  return sourceOmissions.has(name) || name.startsWith(".env");
}

/** Finder metadata is omitted from directory inputs, including declared assets. */
export function filesystemMetadata(path: string): boolean {
  return path.split("/").includes(".DS_Store");
}

export async function requiredInputs(root: string, projects: Project[], excluded: string[] = [], assetExclusions: string[] = [], explicitAssets = new Set<string>()): Promise<string[]> {
  const ignored = await sourceIgnore(root);
  const gitIgnored = projects.some((project) => project.mode === "source") ? gitSourceIgnore(root) : undefined;
  const isIgnored = (path: string) => path.split("/").some((_, i, parts) => ignored(parts.slice(0, i + 1).join("/")));
  const omitted = (path: string) => path.split("/").some((part) => sourceOmissions.has(part) || part.startsWith(".env")) || [...excluded, ...assetExclusions].some((p) => join(root, path) === p || join(root, path).startsWith(`${p}/`));
  const required = new Set<string>(["package.json", "bun.lock", "tsconfig.json", "jsconfig.json"]);
  for (const project of projects) {
    for (const entry of Object.values(project.entrypoints ?? { default: project.entrypoint })) required.add(join(project.targetPath, entry));
    for (const name of ["tsconfig.json", "jsconfig.json"]) required.add(join(project.targetPath, name));
    for (const pkg of project.workspace?.packages ?? []) required.add(join(pkg.path, "package.json"));
    const excludeAsset = assetExcluder(project.assetExcludes);
    async function asset(path: string) {
      if (filesystemMetadata(path)) return;
      if (excludeAsset(relative(project.targetPath || ".", path))) {
        if (project.mode === "source" && [...required].some((input) => input === path || input.startsWith(`${path}/`))) throw new Error(`Asset exclusion overlaps a required source input: ${path}`);
        assetExclusions.push(join(root, path)); return;
      }
      required.add(path);
      explicitAssets.add(path);
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${path}`);
      if (info.isDirectory()) for (const child of await readdir(join(root, path))) await asset(join(path, child));
      else if (!info.isFile()) throw new Error(`Unsupported asset file type: ${path}`);
    }
    for (const pattern of project.assets) {
      let matched = false;
      for await (const path of new Bun.Glob(pattern).scan({ cwd: join(root, project.targetPath), dot: true, onlyFiles: false, followSymlinks: false })) { if (filesystemMetadata(path)) continue; matched = true; await asset(join(project.targetPath, path)); }
      if (!matched) throw new Error(`Asset pattern matched no files: ${pattern}`);
    }
    for (const pkg of project.workspace?.packages ?? [{ manifest: JSON.parse(project.manifestText) }]) {
      for (const patch of Object.values(pkg.manifest.patchedDependencies ?? {})) if (typeof patch === "string") required.add(patch);
    }
  }
  const visited = new Set<string>();
  async function config(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    if (isIgnored(path) || await gitIgnored?.(path)) throw new Error(`Ignored required input: ${path}`);
    required.add(path);
    const value = object(Bun.JSONC.parse(await readFile(join(root, path), "utf8")), "tsconfig");
    for (const parent of value.extends === undefined ? [] : Array.isArray(value.extends) ? value.extends : [value.extends]) {
      if (typeof parent !== "string" || !parent.startsWith(".")) continue;
      const candidate = resolve(root, dirname(path), parent.endsWith(".json") ? parent : parent + ".json");
      const local = relative(root, candidate);
      if (local === ".." || local.startsWith("../")) throw new Error("tsconfig extends must stay inside the project snapshot");
      await config(local);
    }
  }
  for await (const path of new Bun.Glob("**/{tsconfig,jsconfig}.json").scan({ cwd: root, dot: true, followSymlinks: false })) {
    if (!omitted(path) && !isIgnored(path) && !await gitIgnored?.(path)) await config(path);
  }
  if (projects.some((project) => project.mode === "source")) {
    for (const path of required) if (assetExclusions.some((excluded) => join(root, path) === excluded || join(root, path).startsWith(`${excluded}/`))) throw new Error(`Asset exclusion overlaps a required source input: ${path}`);
  }
  return [...required];
}

/** Root-relative positive exclusions, deliberately smaller than gitignore. */
export async function sourceIgnore(root: string): Promise<(path: string) => boolean> {
  let text: string;
  try {
    const file = join(root, ".bunkoignore");
    if (!(await lstat(file)).isFile()) throw new Error(".bunkoignore must be a regular file");
    text = await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return () => false; throw error; }
  const patterns = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const pattern = line.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
    if (!pattern || pattern.startsWith("/") || pattern.startsWith("!") || /[\\\x00-\x1f]/.test(pattern) || pattern.split("/").includes("..")) throw new Error("Invalid .bunkoignore pattern");
    return new Bun.Glob(pattern);
  });
  return (path) => path !== ".bunkoignore" && patterns.some((glob) => glob.match(path));
}
