import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import { object } from "../oci/digest.ts";
import type { Platform } from "../oci/types.ts";

export const VERSION = "0.0.1";

export interface BuildOptions {
  path: string;
  output: string;
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
  directory: string;
  manifestText: string;
  name: string;
  entrypoint: string;
  platform: Platform;
  base?: string;
  workdir: string;
  bunPath: string;
  user?: string;
  env: Record<string, string>;
  labels: Record<string, string>;
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

function absolutePath(value: string, name: string): string {
  if (!posix.isAbsolute(value) || value === "/" || posix.normalize(value) !== value || value.includes("\\") || /[\x00-\x1f]/.test(value)) throw new Error(`${name} must be a normalized absolute path other than /`);
  return value;
}

export function platform(value: string): Platform {
  if (value === "linux/amd64") return { os: "linux", architecture: "amd64" };
  if (value === "linux/arm64" || value === "linux/arm64/v8") return { os: "linux", architecture: "arm64", variant: "v8" };
  throw new Error(`This milestone supports one platform: linux/amd64 or linux/arm64 (received ${value})`);
}

export function epoch(value = process.env.SOURCE_DATE_EPOCH): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 253402300799) throw new Error("SOURCE_DATE_EPOCH is outside the supported RFC3339 range");
  return number;
}

export async function loadProject(options: BuildOptions): Promise<Project> {
  const directory = await realpath(resolve(options.path.replace(/^bunko:\/\//, "")));
  const manifestText = await readFile(join(directory, "package.json"), "utf8");
  const manifest = object(JSON.parse(manifestText), "package.json");
  if (manifest.workspaces !== undefined) throw new Error("Workspaces are not supported in M0a; select a dependency-free package");
  for (const name of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (manifest[name] !== undefined && Object.keys(object(manifest[name], name)).length) {
      throw new Error(`M0a supports dependency-free projects only (${name} is non-empty)`);
    }
  }
  if (await Bun.file(join(directory, "bunfig.toml")).exists()) throw new Error("Project bunfig.toml is not supported in M0a");
  const config = manifest.bunko === undefined ? {} : object(manifest.bunko, "bunko");
  knownKeys(config, ["entrypoint", "mode", "base", "platforms", "assets", "external", "env", "ports", "user", "workdir", "labels", "args", "build", "runtime", "imageName", "enabled"], "bunko");
  if (config.enabled !== undefined && config.enabled !== true) throw new Error("Target is disabled or bunko.enabled is not true");
  if (config.mode !== undefined && config.mode !== "bundle") throw new Error("Only bundle mode is supported in M0a");
  if (strings(config.external, "external").length) throw new Error("Runtime external dependencies are not supported in M0a");
  const build = config.build === undefined ? {} : object(config.build, "build");
  knownKeys(build, ["minify", "sourcemap", "define", "bytecode", "target"], "build");
  if (build.target !== undefined && build.target !== "bun") throw new Error("build.target must be bun");
  if (build.bytecode !== undefined && build.bytecode !== false) throw new Error("Bytecode is not supported in M0a");
  if (build.minify !== undefined && typeof build.minify !== "boolean") throw new Error("build.minify must be boolean");
  if (build.sourcemap !== undefined && !["none", "external"].includes(String(build.sourcemap))) throw new Error("Supported sourcemaps: none, external");
  const runtime = config.runtime === undefined ? {} : object(config.runtime, "runtime");
  knownKeys(runtime, ["bunPath", "libc"], "runtime");
  if (runtime.libc !== undefined && runtime.libc !== "glibc") throw new Error("Only glibc runtime bases are supported in M0a");
  const env = stringMap(config.env, "env");
  if (!Object.keys(env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("Invalid environment variable name");
  const labels = stringMap(config.labels, "labels");
  if (Object.keys(labels).some((key) => key.startsWith("org.bunko.") || ["org.opencontainers.image.created", "org.opencontainers.image.revision"].includes(key))) throw new Error("Cannot override bunko's reserved labels");
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
  const name = optionalString(config.imageName, "imageName") ?? optionalString(manifest.name, "package name")?.replace(/^@/, "").replaceAll("/", "-") ?? basename(directory);
  if (!/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(name)) throw new Error("Invalid image name; set bunko.imageName");
  let ports: number[] | undefined;
  if (config.ports !== undefined) {
    if (!Array.isArray(config.ports) || !config.ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error("ports must contain integers from 1 to 65535");
    ports = [...new Set(config.ports as number[])].sort((a, b) => a - b);
  }
  return {
    directory, manifestText, name, entrypoint, platform: platform(selectedPlatform),
    base: options.base ?? process.env.BUNKO_DEFAULT_BASE ?? optionalString(config.base, "base"),
    workdir: absolutePath(optionalString(config.workdir, "workdir") ?? "/app", "workdir"),
    bunPath: absolutePath(optionalString(runtime.bunPath, "runtime.bunPath") ?? "/usr/local/bin/bun", "runtime.bunPath"),
    user: optionalString(config.user, "user"), env, labels, ports,
    args: strings(config.args, "args"),
    assets: strings(config.assets, "assets").map((p) => relativePath(p, "assets pattern")),
    build: { minify: build.minify as boolean | undefined ?? true, sourcemap: build.sourcemap as "none" | "external" | undefined ?? "none", define: stringMap(build.define, "build.define") },
  };
}
