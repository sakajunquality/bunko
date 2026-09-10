import { supportedBunVersion } from "./bun-version.ts";
import { releaseRevision, type downloadRuntime } from "./runtime-download.ts";
import { runtimeNotices } from "./runtime-notices.ts";
import { validateLocations, type LocationDiagnostics } from "./location-diagnostics.ts";
import { workerCode } from "./worker-code.ts";
import { packageLicense } from "./inventory.ts";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { canonicalJSON, object } from "../oci/digest.ts";
import type { Project } from "./config.ts";
import { type InventoryEntry, inspectELF, packageRoot } from "./deps.ts";
import type { SyntaxCache } from "./syntax-cache.ts";
import { OUTPUT_DIRECTORY } from "./files.ts";

export interface Toolchain { path: string; version: string; revision: string }

function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith("../");
}

export interface BundleDiagnostic { name: string; message: string }
function bundleDiagnostics(value: unknown): BundleDiagnostic[] {
  return Array.isArray(value) ? value.map((entry) => ({ name: String(object(entry, "Build diagnostic").name ?? ""), message: String(object(entry, "Build diagnostic").message ?? "") })) : [];
}

/**
 * Bun classifies an unresolvable module as a `ResolveMessage`, so a caller can
 * recover from it by widening the installed dependency tree. A `BuildMessage`
 * about a file that merely happens to be named like one is a different failure
 * and must not be retried, which is why the class, not the concatenated error
 * text, decides.
 */
export function unresolvedBundleImport(error: unknown): boolean {
  const diagnostics = (error as { diagnostics?: unknown })?.diagnostics;
  return bundleDiagnostics(diagnostics).some((entry) => entry.name === "ResolveMessage" && entry.message.startsWith("Could not resolve"));
}

export async function selectToolchain(path?: string): Promise<Toolchain> {
  const executable = path ? resolve(path) : Bun.which("bun");
  if (!executable) throw new Error("Bun is required; install Bun 1.3.13 or set --bun-path");
  const child = Bun.spawn([executable, "--revision"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Cannot run Bun: ${stderr.trim()}`);
  const match = /^(1\.\d+\.\d+)\+([a-f0-9]+)$/.exec(stdout.trim());
  if (!match || !supportedBunVersion(match[1])) throw new Error(`Supported toolchain: Bun >=1.3.13 <1.5 (received ${stdout.trim()})`);
  return { path: executable, version: match[1]!, revision: match[2]! };
}

export async function bundle(project: Project, toolchain: Toolchain, root: string, log: (message: string) => void, contextRoot = root, syntax?: SyntaxCache, compileRuntime?: Awaited<ReturnType<typeof downloadRuntime>>): Promise<{ locations: LocationDiagnostics; outdir: string; entry: string; entrypoints?: Record<string, string>; inventory: InventoryEntry[]; inputs: string[] }> {
  const outdir = join(root, OUTPUT_DIRECTORY, "out");
  await mkdir(outdir, { recursive: true });
  const home = join(root, OUTPUT_DIRECTORY, "home");
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
  for (const file of ["errors.json", "meta.json", "validation.json", "locations.json"]) await rm(join(root, OUTPUT_DIRECTORY, file), { force: true });
  const worker = join(root, OUTPUT_DIRECTORY, "worker.js");
  const settings = join(root, OUTPUT_DIRECTORY, "worker.json");
  await writeFile(worker, await workerCode(), { mode: 0o600 });
  const manifest = object(JSON.parse(project.manifestText), "package.json");
  const dependencies = [...new Set(["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) => Object.keys(object(manifest[field] ?? {}, field))))].sort();
  await writeFile(settings, JSON.stringify({ root, contextRoot, outdir, entrypoint: project.entrypoint, entrypoints: project.entrypoints, external: project.external, minify: project.build.minify, sourcemap: project.build.sourcemap, define: project.build.define, allowUnresolved: project.build.allowUnresolved, dependencies }), { mode: 0o600 });
  await writeFile(join(root, OUTPUT_DIRECTORY, "bunfig.toml"), "");
  const args = [toolchain.path, "--no-env-file", `--config=${OUTPUT_DIRECTORY}/bunfig.toml`, worker, settings];
  await rm(join(root, OUTPUT_DIRECTORY, "errors.json"), { force: true });
  const child = Bun.spawn(args, {
    cwd: root,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: process.env.PATH ?? "", NODE_ENV: "production", TZ: "UTC", LANG: "C", LC_ALL: "C" },
    stdout: "pipe", stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log(decoder.decode(chunk, { stream: true }));
    const last = decoder.decode();
    if (last) log(last);
  };
  const [, , exit] = await Promise.all([drain(child.stdout), drain(child.stderr), child.exited]);
  if (exit !== 0) {
    const errors = Bun.file(join(root, OUTPUT_DIRECTORY, "errors.json"));
    const diagnostics = await errors.exists() ? bundleDiagnostics(await errors.json()) : [];
    const detail = diagnostics.map((entry) => entry.message).join("; ").slice(0, 8192);
    throw Object.assign(new Error(`Bun build failed (exit ${exit})${detail ? `: ${detail}` : ""}`), { diagnostics });
  }
  if (syntax) {
    const stats = object(JSON.parse(await readFile(join(root, OUTPUT_DIRECTORY, "validation.json"), "utf8")), "Worker validation statistics");
    if (![stats.parsed, stats.bytes].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid worker validation statistics");
    syntax.stats.parsed += stats.parsed as number; syntax.stats.bytes += stats.bytes as number;
  }
  const locations = validateLocations(JSON.parse(await readFile(join(root, OUTPUT_DIRECTORY, "locations.json"), "utf8")));
  const meta = object(JSON.parse(await readFile(join(root, OUTPUT_DIRECTORY, "meta.json"), "utf8")), "Bun metafile");
  const outputs = object(meta.outputs, "Bun metafile outputs");
  const inputs = new Set(Object.keys(object(meta.inputs, "Bun metafile inputs")).map((path) => resolve(root, path)));
  for (const path of inputs) {
    if (!inside(contextRoot, path)) throw new Error(`Build input escaped the project snapshot: ${path}`);
  }
  const candidates = Object.entries(outputs).filter(([path, value]) => {
    const output = object(value, "Bun output");
    return output.entryPoint === project.entrypoint && /\.[cm]?js$/.test(path);
  });
  if (candidates.length !== 1) throw new Error("Cannot identify the server entrypoint in Bun's metafile");
  let entrypoints: Record<string, string> | undefined;
  if (project.entrypoints) {
    entrypoints = {};
    for (const [name, source] of Object.entries(project.entrypoints).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const matches = Object.entries(outputs).filter(([path, output]) => object(output, "Bun output").entryPoint === source && /\.[cm]?js$/.test(path));
      if (matches.length !== 1) throw new Error(`Cannot identify emitted entrypoint: ${name}`);
      entrypoints[name] = relative(outdir, resolve(outdir, matches[0]![0]));
    }
  }
  for (const [path, value] of Object.entries(outputs)) {
    const full = resolve(outdir, path);
    if (relative(outdir, full).startsWith("..")) throw new Error("Bun output escaped the output directory");
    if (path.endsWith(".node")) throw new Error("Native modules must be declared in bunko.external");
    const output = object(value, "Bun output");
    if (Array.isArray(output.imports)) {
      for (const value of output.imports) {
        const item = object(value, "Bun output import");
        if (item.external && (typeof item.path !== "string" || (!isBuiltin(item.path) && !/^bun(?::|$)/.test(item.path) && !project.external.includes(packageRoot(item.path))))) throw new Error(`Unpackaged external import: ${String(item.path)}`);
      }
    }
  }
  // Bun's metafile still omits sourcemap files in 1.3.13. Enumerate the emitted tree.
  for await (const path of new Bun.Glob("**/*.{js,mjs,cjs,css}.map").scan({ cwd: outdir })) {
    const full = join(outdir, path);
    const map = object(JSON.parse(await readFile(full, "utf8")), "Sourcemap");
    if (!Array.isArray(map.sources) || !map.sources.every((s) => typeof s === "string")) throw new Error("Unsupported sourcemap structure");
    map.sources = map.sources.map((source) => {
      const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
      // Bun 1.3.11 can make sources relative to outdir even for nested .map files.
      const candidates = [...new Set([resolve(dirname(full), sourceRoot, source), resolve(outdir, sourceRoot, source)])].filter((path) => inputs.has(path));
      if (candidates.length !== 1) throw new Error(`Cannot resolve sourcemap source: ${source}`);
      const local = relative(contextRoot, candidates[0]!);
      if (local.startsWith("..")) throw new Error("Sourcemap source escaped the project");
      return `bunko:///${local}`;
    });
    delete map.sourceRoot;
    await writeFile(full, canonicalJSON(map));
  }
  const inventory: InventoryEntry[] = [];
  const packageDirectories = new Set<string>();
  for (const input of inputs) {
    if (!relative(contextRoot, input).split("/").includes("node_modules")) continue;
    let directory = dirname(input);
    while (inside(contextRoot, directory) && directory !== contextRoot) {
      if (packageDirectories.has(directory)) break;
      const manifest = Bun.file(join(directory, "package.json"));
      if (await manifest.exists()) {
        const pkg = object(await manifest.json(), "Bundled package");
        if (typeof pkg.name === "string" && typeof pkg.version === "string") {
          packageDirectories.add(directory);
          inventory.push({ path: relative(contextRoot, directory), name: pkg.name, version: pkg.version, license: packageLicense(pkg.license) });
          break;
        }
      }
      directory = dirname(directory);
    }
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  if (project.mode === "compile") {
    if (project.build.sourcemap !== "none") throw new Error("Compile mode does not support external sourcemaps");
    // Recompiling emitted JavaScript cannot embed Bun's serialized HTML manifest.
    // Additional outputs must not be silently discarded from the runtime image.
    if (Object.keys(outputs).length !== 1) throw new Error("Compile mode requires a single JavaScript output; use bundle mode for HTML, CSS or other emitted assets");
    if (!compileRuntime || compileRuntime.metadata.version !== toolchain.version || compileRuntime.metadata.expectedRevision !== toolchain.revision || compileRuntime.metadata.cpu !== (project.platform.architecture === "amd64" ? "x64-baseline" : "aarch64")) throw new Error("Compile mode requires a verified matching Bun release runtime");
    const runtimePath = join(root, OUTPUT_DIRECTORY, "compile-runtime");
    await writeFile(runtimePath, compileRuntime.executable, { mode: 0o600 });
    const executable = "bunko-app";
    const target = project.platform.architecture === "amd64" ? "bun-linux-x64-baseline" : "bun-linux-arm64";
    try {
      const compiled = Bun.spawn([toolchain.path, "build", `./${candidates[0]![0]}`, "--compile", `--target=${target}`, `--compile-executable-path=${runtimePath}`, ...(project.build.minify ? ["--minify"] : []), `--outfile=${executable}`, `--config=${join(root, OUTPUT_DIRECTORY, "bunfig.toml")}`, "--env=disable", "--no-env-file"],
        { cwd: outdir, env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C", LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" });
      const [, , code] = await Promise.all([drain(compiled.stdout), drain(compiled.stderr), compiled.exited]);
      if (code) throw new Error(`Bun compile failed (exit ${code})`);
    } finally { await rm(runtimePath, { force: true }); }
    // Bun 1.3.12+ rewrites ELF sections, so the runtime is not a byte-identical prefix.
    if (releaseRevision(await readFile(join(outdir, executable)), toolchain) !== compileRuntime.metadata.releaseRevision) throw new Error("Compiled application runtime revision differs from the authenticated release");
    if (!await inspectELF(join(outdir, executable), project.platform)) throw new Error("Compiled application is not a target Linux ELF executable");
    await chmod(join(outdir, executable), 0o755);
    for (const path of Object.keys(outputs)) await rm(resolve(outdir, path), { force: true });
    const notices = join(outdir, ".bunko-runtime");
    await mkdir(notices, { recursive: true });
    await writeFile(join(notices, "LICENSE.md"), runtimeNotices[toolchain.version]!);
    await writeFile(join(notices, "SOURCE.json"), canonicalJSON({ version: compileRuntime.metadata.version, revision: compileRuntime.metadata.releaseRevision, source: `https://github.com/oven-sh/bun/tree/${compileRuntime.metadata.releaseRevision}`, archive: compileRuntime.metadata.url, archiveDigest: compileRuntime.metadata.archiveDigest }));
    return { locations, outdir, inventory, inputs: [...inputs].map((path) => relative(contextRoot, path)), entry: executable };
  }
  return { locations, outdir, entrypoints, inventory, inputs: [...inputs].map((path) => relative(contextRoot, path)), entry: relative(outdir, resolve(outdir, candidates[0]![0])) };
}
