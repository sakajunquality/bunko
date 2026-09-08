import { assetMappings, type AssetMapping } from "./asset-contexts.ts";
import { readBunfig } from "./bunfig.ts";
import { catalogs, catalogSpecifier, registrySpecifier } from "./catalogs.ts";
import packageMetadata from "../../package.json";
import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import { object } from "../oci/digest.ts";
import { packageRoot } from "./deps.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import type { Platform } from "../oci/types.ts";
import type { Workspace } from "./workspace.ts";

export const VERSION = packageMetadata.version;

export interface BuildOptions {
  path: string;
  assetContexts?: Record<string, string>;
  progress?: (event: import("./progress.ts").ProgressEvent) => void;
  imageLabels?: Record<string, string>;
  imageAnnotations?: Record<string, string>;
  imageUser?: string;
  imageRefs?: string;
  mode?: string;
  jobs?: number;
  appCache?: boolean;
  targets?: string[];
  sbom?: boolean;
  baseSBOMs?: Record<string, string>;
  depsVerifyKey?: string;
  supplyChainPolicy?: "ci";
  provenance?: boolean;
  signKey?: string;
  cosignPath?: string;
  depsStrategy?: string;
  externalDeps?: Record<string, string>;
  externalDepsByTarget?: Record<string, Record<string, string>>;
  sharedDeps?: boolean;
  output?: string;
  push?: boolean;
  repo?: string;
  bare?: boolean;
  tags?: string[];
  tarball?: string;
  local?: boolean;
  kind?: string;
  dryRun?: boolean;
  cacheDir?: string;
  localCache?: boolean;
  cacheRepo?: string;
  cacheFrom?: string[];
  cacheWrite?: boolean;
  registryCache?: boolean;
  registry?: RegistryOptions;
  installCache?: string;
  runtimeCache?: string;
  runtimeInject?: string;
  base?: string;
  baseLayout?: string;
  platform?: string;
  bunPath?: string;
  report?: string;
  reproducible?: boolean;
  verifyDeterministic?: boolean;
  noIndex?: boolean;
  gitMetadata?: boolean;
  log?: (message: string) => void;
}

export interface Project {
  mode: "bundle" | "compile";
  directory: string;
  manifestText: string;
  workspace?: Workspace;
  targetPath: string;
  name: string;
  entrypoint: string;
  entrypoints?: Record<string, string>;
  defaultEntrypoint?: string;
  platform: Platform;
  platforms: Platform[];
  external: string[];
  depsStrategy: "production" | "closure";
  base?: string;
  workdir: string;
  bunPath: string;
  runtimeInject?: "release";
  user?: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  inheritBaseOciLabels?: boolean;
  allowIgnoredScripts?: string[];
  annotations: Record<string, string>;
  dataPath?: string;
  ports?: number[];
  args: string[];
  assets: string[];
  assetMappings: AssetMapping[];
  build: { allowUnresolved?: string[]; minify: boolean; sourcemap: "none" | "external"; define: Record<string, string> };
}

function knownKeys(value: Record<string, unknown>, allowed: string[], name: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${name} setting: ${key}`);
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && !item.includes("\0"))) throw new Error(`${name} must be an array of strings without NUL characters`);
  return value;
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const result = object(value, name);
  if (!Object.values(result).every((item) => typeof item === "string" && !item.includes("\0"))) throw new Error(`${name} values must be strings without NUL characters`);
  return result as Record<string, string>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function relativePath(value: string, name: string): string {
  if (isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").includes("..")) throw new Error(`${name} must stay inside the project: ${value}`);
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../")) throw new Error(`Invalid ${name}: ${value}`);
  return normalized;
}

export function absolutePath(value: string, name: string): string {
  if (!posix.isAbsolute(value) || value === "/" || posix.normalize(value) !== value || value.includes("\\") || /[\x00-\x1f]/.test(value)) throw new Error(`${name} must be a normalized absolute path other than /`);
  return value;
}

export function platform(value: string): Platform {
  if (value === "linux/amd64") return { os: "linux", architecture: "amd64" };
  if (value === "linux/arm64" || value === "linux/arm64/v8") return { os: "linux", architecture: "arm64", variant: "v8" };
  throw new Error(`Supported platforms: linux/amd64 or linux/arm64 (received ${value})`);
}

export function epoch(value = process.env.SOURCE_DATE_EPOCH): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 253402300799) throw new Error("SOURCE_DATE_EPOCH is outside the supported RFC3339 range");
  return number;
}

export function validateDependencySpecs(manifest: Record<string, unknown>, workspace?: Workspace): void {
  const definitions = workspace ? catalogs(workspace.packages[0]!.manifest) : undefined;
  if (!workspace && (manifest.catalog !== undefined || manifest.catalogs !== undefined)) throw new Error("Catalogs require a workspace");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(object(manifest[field] ?? {}, field))) {
      packageRoot(name);
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        if (!workspace?.packages.some((p) => p.path && p.manifest.name === name) || /[\/\\\0]/.test(specifier.slice(10)) || !specifier.slice(10)) throw new Error(`Invalid workspace dependency: ${name}`);
        continue;
      }
      if (typeof specifier === "string" && specifier.startsWith("catalog:")) {
        if (!workspace) throw new Error("Catalogs require a workspace");
        catalogSpecifier(definitions!, name, specifier);
      } else registrySpecifier(name, specifier);
    }
  }
}

export async function loadProject(options: BuildOptions, workspace?: Workspace): Promise<Project> {
  const directory = await realpath(resolve(options.path.replace(/^bunko:\/\//, "")));
  const manifestText = await readFile(join(directory, "package.json"), "utf8");
  const manifest = object(JSON.parse(manifestText), "package.json");
  if (manifest.workspaces !== undefined && !workspace) throw new Error("Workspace root requires target discovery");
  validateDependencySpecs(manifest, workspace);
  await readBunfig(directory);
  const config = manifest.bunko === undefined ? {} : object(manifest.bunko, "bunko");
  knownKeys(config, ["entrypoint", "entrypoints", "defaultEntrypoint", "mode", "base", "platforms", "assets", "assetMappings", "external", "env", "ports", "user", "workdir", "labels", "annotations", "args", "build", "runtime", "imageName", "enabled", "deps", "sharedDeps", "inheritBaseOciLabels"], "bunko");
  if (config.enabled !== undefined && config.enabled !== true) throw new Error("Target is disabled or bunko.enabled is not true");
  const mode = options.mode ?? config.mode ?? "bundle";
  if (mode !== "bundle" && mode !== "compile") throw new Error("mode must be bundle or compile");
  const external = [...new Set(strings(config.external, "external").map(packageRoot))].sort();
  if (mode === "compile" && external.length) throw new Error("Compile mode currently requires bundled JavaScript dependencies; runtime externals are unsupported");
  const production = { ...object(manifest.dependencies ?? {}, "dependencies"), ...object(manifest.optionalDependencies ?? {}, "optionalDependencies"), ...object(manifest.peerDependencies ?? {}, "peerDependencies") };
  for (const name of external) if (!(name in production)) throw new Error(`External ${name} must be a declared production dependency`);
  const deps = object(config.deps ?? {}, "deps");
  knownKeys(deps, ["strategy", "allowIgnoredScripts"], "deps");
  const allowIgnoredScripts = [...new Set(strings(deps.allowIgnoredScripts, "deps.allowIgnoredScripts"))].sort();
  if (allowIgnoredScripts.some((name) => packageRoot(name) !== name)) throw new Error("deps.allowIgnoredScripts requires exact package names");
  if (config.inheritBaseOciLabels !== undefined && typeof config.inheritBaseOciLabels !== "boolean") throw new Error("inheritBaseOciLabels must be boolean");
  if (config.sharedDeps !== undefined && typeof config.sharedDeps !== "boolean") throw new Error("sharedDeps must be boolean");
  const depsStrategy = options.depsStrategy ?? deps.strategy ?? (options.sharedDeps ? "closure" : "production");
  if (depsStrategy !== "production" && depsStrategy !== "closure") throw new Error("deps.strategy must be production or closure");
  const build = config.build === undefined ? {} : object(config.build, "build");
  knownKeys(build, ["minify", "sourcemap", "define", "bytecode", "target", "allowUnresolved"], "build");
  if (build.allowUnresolved !== undefined && (!Array.isArray(build.allowUnresolved) || !build.allowUnresolved.every((value) => typeof value === "string" && !/[\x00-\x1f]/.test(value)))) throw new Error("build.allowUnresolved must be an array of specifier patterns");
  if (build.target !== undefined && build.target !== "bun") throw new Error("build.target must be bun");
  if (build.bytecode !== undefined && build.bytecode !== false) throw new Error("Bytecode is not supported");
  if (build.minify !== undefined && typeof build.minify !== "boolean") throw new Error("build.minify must be boolean");
  if (build.sourcemap !== undefined && !["none", "external"].includes(String(build.sourcemap))) throw new Error("Supported sourcemaps: none, external");
  if (mode === "compile" && build.sourcemap && build.sourcemap !== "none") throw new Error("Compile mode does not support external sourcemaps");
  const runtime = config.runtime === undefined ? {} : object(config.runtime, "runtime");
  knownKeys(runtime, ["bunPath", "libc", "inject"], "runtime");
  const runtimeInject = options.runtimeInject ?? runtime.inject;
  if (runtimeInject !== undefined && runtimeInject !== "release") throw new Error("runtime.inject must be release");
  if (runtimeInject && (options.mode ?? config.mode ?? "bundle") !== "bundle") throw new Error("Runtime injection requires bundle mode");
  if (runtimeInject && !(options.base ?? process.env.BUNKO_DEFAULT_BASE ?? config.base) && !options.baseLayout) throw new Error("Runtime injection requires an explicit base or base layout");
  if (runtime.libc !== undefined && runtime.libc !== "glibc") throw new Error("Only glibc runtime bases are supported");
  const env = stringMap(config.env, "env");
  if (!Object.keys(env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("Invalid environment variable name");
  const labels = { ...stringMap(config.labels, "labels"), ...stringMap(options.imageLabels, "image labels") };
  const annotations = { ...stringMap(config.annotations, "annotations"), ...stringMap(options.imageAnnotations, "image annotations") };
  if (Object.keys(annotations).some((key) => !key || /[\x00-\x1f]/.test(key) || key.startsWith("org.bunko.") || key === "org.opencontainers.image.ref.name")) throw new Error("Invalid or reserved image annotation key");
  if (Object.keys(labels).some((key) => !key || /[\x00-\x1f]/.test(key) || key.startsWith("org.bunko.") || ["org.opencontainers.image.created", "org.opencontainers.image.revision"].includes(key))) throw new Error("Cannot override bunko's reserved labels");
  const entrypoints = config.entrypoints === undefined ? undefined : stringMap(config.entrypoints, "entrypoints");
  let defaultEntrypoint = optionalString(config.defaultEntrypoint, "defaultEntrypoint");
  if (defaultEntrypoint && !entrypoints) throw new Error("defaultEntrypoint requires entrypoints");
  if (entrypoints) {
    const names = Object.keys(entrypoints).sort();
    if (!names.length || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) || new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error("entrypoints requires unique names containing letters, numbers, underscores or hyphens");
    if (config.entrypoint !== undefined) throw new Error("Use entrypoint or named entrypoints, not both");
    if (mode === "compile") throw new Error("Named entrypoints currently require bundle mode");
    defaultEntrypoint ??= names.length === 1 ? names[0] : undefined;
    if (!defaultEntrypoint || !Object.hasOwn(entrypoints, defaultEntrypoint)) throw new Error("Select a defaultEntrypoint from entrypoints");
    const outputs = new Set<string>();
    for (const name of names) {
      const path = relativePath(entrypoints[name]!, "entrypoint");
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) throw new Error("Entrypoint must be a JavaScript or TypeScript file");
      const file = await realpath(join(directory, path)).catch(() => { throw new Error(`Missing named entrypoint: ${name}`); });
      if (relative(directory, file).startsWith("..") || !(await stat(file)).isFile()) throw new Error("Entrypoint must be a file inside the project");
      const output = path.replace(/\.[^.]+$/, ".js").toLowerCase();
      if (outputs.has(output)) throw new Error("Named entrypoints have colliding output paths (case-insensitive)");
      outputs.add(output); entrypoints[name] = path;
    }
  }
  let entrypoint = entrypoints ? entrypoints[defaultEntrypoint!] : optionalString(config.entrypoint, "entrypoint");
  if (!entrypoint && manifest.bin !== undefined) {
    if (typeof manifest.bin === "string") entrypoint = optionalString(manifest.bin, "bin");
    else {
      const bins = Object.values(object(manifest.bin, "bin"));
      if (bins.length !== 1) throw new Error("Multiple bin entries require bunko.entrypoint");
      entrypoint = optionalString(bins[0], "bin entry");
    }
  }
  entrypoint ??= optionalString(manifest.module, "module") ?? optionalString(manifest.main, "main");
  if (!entrypoint) {
    for (const candidate of ["src/index.ts", "index.ts"]) {
      if (await Bun.file(join(directory, candidate)).exists()) { entrypoint = candidate; break; }
    }
  }
  if (!entrypoint) throw new Error("No entrypoint found; set package.json bunko.entrypoint");
  entrypoint = relativePath(entrypoint, "entrypoint");
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entrypoint)) throw new Error("Entrypoint must be a JavaScript or TypeScript file");
  const resolvedEntry = await realpath(join(directory, entrypoint));
  if (relative(directory, resolvedEntry).startsWith("..") || !(await stat(resolvedEntry)).isFile()) throw new Error("Entrypoint must be a file inside the project");
  const platforms = strings(config.platforms, "platforms");
  const selectedPlatform = options.platform ?? process.env.BUNKO_DEFAULT_PLATFORMS ?? (platforms.length ? platforms.join(",") : "linux/amd64");
  const selected = selectedPlatform.split(",").map((value) => platform(value.trim()));
  if (new Set(selected.map((p) => p.architecture)).size !== selected.length) throw new Error("Duplicate target platform");
  selected.sort((a, b) => a.architecture.localeCompare(b.architecture));
  if (options.noIndex && selected.length !== 1) throw new Error("--no-index requires a single platform");
  if ((options.local || options.kind || options.tarball) && selected.length !== 1) throw new Error("Local/kind/tarball output requires a single platform");
  const name = optionalString(config.imageName, "imageName") ?? optionalString(manifest.name, "package name")?.replace(/^@/, "").replaceAll("/", "-") ?? basename(directory);
  if (!/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(name)) throw new Error("Invalid image name; set bunko.imageName");
  let ports: number[] | undefined;
  if (config.ports !== undefined) {
    if (!Array.isArray(config.ports) || !config.ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error("ports must contain integers from 1 to 65535");
    ports = [...new Set(config.ports as number[])].sort((a, b) => a - b);
  }
  const workdir = absolutePath(optionalString(config.workdir, "workdir") ?? "/app", "workdir");
  let dataPath: string | undefined;
  try {
    const info = await lstat(join(directory, "bunkodata"));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("bunkodata must be a real directory");
    dataPath = `${workdir}/bunkodata`;
    if (env.BUNKO_DATA_PATH !== undefined && env.BUNKO_DATA_PATH !== dataPath) throw new Error("BUNKO_DATA_PATH is reserved when bunkodata exists");
    env.BUNKO_DATA_PATH = dataPath;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const runtimePath = absolutePath(optionalString(runtime.bunPath, "runtime.bunPath") ?? "/usr/local/bin/bun", "runtime.bunPath");
  if (runtimeInject && (runtimePath === workdir || ["node_modules", ".bunko-workspace", ".bunko-deps"].some((part) => runtimePath === `${workdir}/${part}` || runtimePath.startsWith(`${workdir}/${part}/`)))) throw new Error("Runtime injection overlaps an application dependency namespace");
  return {
    inheritBaseOciLabels: config.inheritBaseOciLabels as boolean | undefined, allowIgnoredScripts,
    mode, directory, manifestText, workspace, targetPath: workspace ? relative(workspace.directory, directory) : "", name, entrypoint, entrypoints, defaultEntrypoint, platform: selected[0]!, platforms: selected, external, depsStrategy,
    base: options.base ?? process.env.BUNKO_DEFAULT_BASE ?? optionalString(config.base, "base"),
    workdir, dataPath, annotations,
    runtimeInject: runtimeInject as "release" | undefined,
    bunPath: runtimePath,
    user: optionalString(options.imageUser, "image user") ?? optionalString(config.user, "user"), env, labels, ports,
    args: strings(config.args, "args"),
    assetMappings: assetMappings(config.assetMappings),
    assets: [...new Set([...strings(config.assets, "assets").map((p) => relativePath(p, "assets pattern")), ...(dataPath ? ["bunkodata"] : [])])],
    build: { allowUnresolved: build.allowUnresolved as string[] | undefined, minify: build.minify as boolean | undefined ?? true, sourcemap: build.sourcemap as "none" | "external" | undefined ?? "none", define: stringMap(build.define, "build.define") },
  };
}
