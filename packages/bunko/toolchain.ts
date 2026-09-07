import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { canonicalJSON, object } from "../oci/digest.ts";
import type { Project } from "./config.ts";
import { packageRoot } from "./deps.ts";
import { OUTPUT_DIRECTORY, rejectMacros } from "./files.ts";

export interface Toolchain { path: string; version: string; revision: string }

function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith("../");
}

async function validateTsconfigs(root: string): Promise<void> {
  const seen = new Set<string>();
  async function visit(path: string) {
    if (!inside(root, path)) throw new Error("tsconfig extends must stay inside the project snapshot");
    if (seen.has(path)) return;
    seen.add(path);
    const config = object(Bun.JSONC.parse(await readFile(path, "utf8")), "tsconfig");
    if (config.extends === undefined) return;
    const parents = Array.isArray(config.extends) ? config.extends : [config.extends];
    for (const parent of parents) {
      if (typeof parent !== "string" || !parent.startsWith(".")) throw new Error("M1 supports only relative tsconfig extends inside the project");
      let candidate = resolve(dirname(path), parent);
      if (!candidate.endsWith(".json")) candidate += ".json";
      await visit(candidate);
    }
  }
  for await (const path of new Bun.Glob("**/tsconfig.json").scan({ cwd: root, dot: true })) if (!path.split("/").includes("node_modules")) await visit(join(root, path));
}

export async function selectToolchain(path?: string): Promise<Toolchain> {
  const executable = path ? resolve(path) : Bun.which("bun");
  if (!executable) throw new Error("Bun is required; install Bun 1.3.11 or set --bun-path");
  const child = Bun.spawn([executable, "--revision"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Cannot run Bun: ${stderr.trim()}`);
  const match = /^(1\.3\.(\d+))\+([a-f0-9]+)$/.exec(stdout.trim());
  if (!match || Number(match[2]) < 11) throw new Error(`Supported toolchain: Bun >=1.3.11 <1.4 (received ${stdout.trim()})`);
  return { path: executable, version: match[1]!, revision: match[3]! };
}

export async function bundle(project: Project, toolchain: Toolchain, root: string, log: (message: string) => void, contextRoot = root): Promise<{ outdir: string; entry: string }> {
  await validateTsconfigs(contextRoot);
  for await (const path of new Bun.Glob("**/node_modules/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scan({ cwd: contextRoot, dot: true, followSymlinks: false })) await rejectMacros(join(contextRoot, path), path);
  const outdir = join(root, OUTPUT_DIRECTORY, "out");
  await mkdir(outdir, { recursive: true });
  const args = [toolchain.path, "build", `./${project.entrypoint}`, "--target=bun", "--format=esm", "--packages=bundle", "--root=.",
    `--outdir=${OUTPUT_DIRECTORY}/out`, `--metafile=${OUTPUT_DIRECTORY}/meta.json`,
    "--entry-naming=[dir]/[name].[ext]", "--env=disable", "--no-env-file", "--reject-unresolved",
    `--sourcemap=${project.build.sourcemap}`];
  for (const name of project.external) args.push("--external", name, "--external", `${name}/*`);
  if (project.build.minify) args.push("--minify");
  for (const [key, value] of Object.entries(project.build.define).sort(([a], [b]) => a.localeCompare(b))) args.push("--define", `${key}=${value}`);
  // Use an explicit empty config and a small environment without global overrides.
  await writeFile(join(root, OUTPUT_DIRECTORY, "bunfig.toml"), "");
  args.push(`--config=${OUTPUT_DIRECTORY}/bunfig.toml`);
  const child = Bun.spawn(args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", TZ: "UTC", LANG: "C", LC_ALL: "C" },
    stdout: "pipe", stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log(decoder.decode(chunk, { stream: true }));
    const last = decoder.decode();
    if (last) log(last);
  };
  const [, , exit] = await Promise.all([drain(child.stdout), drain(child.stderr), child.exited]);
  if (exit !== 0) throw new Error(`Bun build failed (exit ${exit})`);
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
  // Bun's metafile omits sourcemap files in 1.3.11. Enumerate the emitted tree.
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
  return { outdir, entry: relative(outdir, resolve(outdir, candidates[0]![0])) };
}
