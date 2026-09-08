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
  platform: Platform;
  platforms: Platform[];
  external: string[];
  depsStrategy: "production" | "closure";
  base?: string;
  workdir: string;
  bunPath: string;
  user?: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  dataPath?: string;
  ports?: number[];
  args: string[];
  assets: string[];
  build: { minify: boolean; sourcemap: "none" | "external"; define: Record<string, string> };
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
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(object(manifest[field] ?? {}, field))) {
      packageRoot(name);
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        if (!workspace?.packages.some((p) => p.path && p.manifest.name === name) || /[\/\\\0]/.test(specifier.slice(10)) || !specifier.slice(10)) throw new Error(`Invalid workspace dependency: ${name}`);
        continue;
      }
      if (typeof specifier !== "string" || !specifier || /^(?:file:|link:|workspace:|catalog:|git|github:|https?:|\.|\/)/.test(specifier) || (specifier.includes("/") && !specifier.startsWith("npm:"))) throw new Error(`Bunko supports registry dependencies only: ${name}`);
    }
  }
}

export async function loadProject(options: BuildOptions, workspace?: Workspace): Promise<Project> {
  const directory = await realpath(resolve(options.path.replace(/^bunko:\/\//, "")));
  const manifestText = await readFile(join(directory, "package.json"), "utf8");
  const manifest = object(JSON.parse(manifestText), "package.json");
  if (manifest.workspaces !== undefined && !workspace) throw new Error("Workspace root requires target discovery");
  validateDependencySpecs(manifest, workspace);
  if (await Bun.file(join(directory, "bunfig.toml")).exists()) throw new Error("Project bunfig.toml is not supported");
  const config = manifest.bunko === undefined ? {} : object(manifest.bunko, "bunko");
  knownKeys(config, ["entrypoint", "mode", "base", "platforms", "assets", "external", "env", "ports", "user", "workdir", "labels", "annotations", "args", "build", "runtime", "imageName", "enabled", "deps", "sharedDeps"], "bunko");
  if (config.enabled !== undefined && config.enabled !== true) throw new Error("Target is disabled or bunko.enabled is not true");
  const mode = options.mode ?? config.mode ?? "bundle";
  if (mode !== "bundle" && mode !== "compile") throw new Error("mode must be bundle or compile");
  const external = [...new Set(strings(config.external, "external").map(packageRoot))].sort();
  if (mode === "compile" && external.length) throw new Error("Compile mode currently requires bundled JavaScript dependencies; runtime externals are unsupported");
  const production = { ...object(manifest.dependencies ?? {}, "dependencies"), ...object(manifest.optionalDependencies ?? {}, "optionalDependencies"), ...object(manifest.peerDependencies ?? {}, "peerDependencies") };
  for (const name of external) if (!(name in production)) throw new Error(`External ${name} must be a declared production dependency`);
  const deps = object(config.deps ?? {}, "deps");
  knownKeys(deps, ["strategy"], "deps");
  if (config.sharedDeps !== undefined && typeof config.sharedDeps !== "boolean") throw new Error("sharedDeps must be boolean");
  const depsStrategy = options.depsStrategy ?? deps.strategy ?? (options.sharedDeps ? "closure" : "production");
  if (depsStrategy !== "production" && depsStrategy !== "closure") throw new Error("deps.strategy must be production or closure");
  const build = config.build === undefined ? {} : object(config.build, "build");
  knownKeys(build, ["minify", "sourcemap", "define", "bytecode", "target"], "build");
  if (build.target !== undefined && build.target !== "bun") throw new Error("build.target must be bun");
  if (build.bytecode !== undefined && build.bytecode !== false) throw new Error("Bytecode is not supported");
  if (build.minify !== undefined && typeof build.minify !== "boolean") throw new Error("build.minify must be boolean");
  if (build.sourcemap !== undefined && !["none", "external"].includes(String(build.sourcemap))) throw new Error("Supported sourcemaps: none, external");
  if (mode === "compile" && build.sourcemap && build.sourcemap !== "none") throw new Error("Compile mode does not support external sourcemaps");
  const runtime = config.runtime === undefined ? {} : object(config.runtime, "runtime");
  knownKeys(runtime, ["bunPath", "libc"], "runtime");
  if (runtime.libc !== undefined && runtime.libc !== "glibc") throw new Error("Only glibc runtime bases are supported");
  const env = stringMap(config.env, "env");
  if (!Object.keys(env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("Invalid environment variable name");
  const labels = { ...stringMap(config.labels, "labels"), ...stringMap(options.imageLabels, "image labels") };
  const annotations = { ...stringMap(config.annotations, "annotations"), ...stringMap(options.imageAnnotations, "image annotations") };
  if (Object.keys(annotations).some((key) => !key || /[\x00-\x1f]/.test(key) || key.startsWith("org.bunko.") || key === "org.opencontainers.image.ref.name")) throw new Error("Invalid or reserved image annotation key");
  if (Object.keys(labels).some((key) => !key || /[\x00-\x1f]/.test(key) || key.startsWith("org.bunko.") || ["org.opencontainers.image.created", "org.opencontainers.image.revision"].includes(key))) throw new Error("Cannot override bunko's reserved labels");
  let entrypoint = optionalString(config.entrypoint, "entrypoint");
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
  return {
    mode, directory, manifestText, workspace, targetPath: workspace ? relative(workspace.directory, directory) : "", name, entrypoint, platform: selected[0]!, platforms: selected, external, depsStrategy,
    base: options.base ?? process.env.BUNKO_DEFAULT_BASE ?? optionalString(config.base, "base"),
    workdir, dataPath, annotations,
    bunPath: absolutePath(optionalString(runtime.bunPath, "runtime.bunPath") ?? "/usr/local/bin/bun", "runtime.bunPath"),
    user: optionalString(options.imageUser, "image user") ?? optionalString(config.user, "user"), env, labels, ports,
    args: strings(config.args, "args"),
    assets: [...new Set([...strings(config.assets, "assets").map((p) => relativePath(p, "assets pattern")), ...(dataPath ? ["bunkodata"] : [])])],
    build: { minify: build.minify as boolean | undefined ?? true, sourcemap: build.sourcemap as "none" | "external" | undefined ?? "none", define: stringMap(build.define, "build.define") },
  };
}
