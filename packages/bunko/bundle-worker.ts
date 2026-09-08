import { moduleLocations, diagnosticLimit, type LocationDiagnostics } from "./location-diagnostics.ts";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { rejectApplicationImports, rejectMacroSyntax } from "./syntax.ts";
import { validateInputTsconfig } from "./tsconfig.ts";

export interface WorkerOptions {
  root: string;
  contextRoot: string;
  entrypoint: string;
  entrypoints?: Record<string, string>;
  outdir: string;
  external: string[];
  allowUnresolved?: string[];
  minify: boolean;
  sourcemap: "none" | "external";
  define: Record<string, string>;
}

export async function guardedBuild(options: WorkerOptions) {
  const context = await realpath(options.contextRoot);
  const sources = options.entrypoints ? Object.entries(options.entrypoints).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, path]) => path) : [options.entrypoint];
  const entrypoints = await Promise.all(sources.map((path) => realpath(resolve(options.root, path))));
  const executableEntries = new Set(entrypoints);
  const seenConfigs = new Set<string>();
  const dataLoaders = new Map<string, "json" | "text" | "file" | "toml">();
  const dataImports = new Map<string, Map<string, string>>();
  function contained(path: string): string {
    const local = relative(context, path);
    if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("Build input escaped the project snapshot");
    return local;
  }
  const locations: LocationDiagnostics = { total: 0, warnings: [] };
  const warned = new Set<string>();
  const validation = { parsed: 0, reused: 0, bytes: 0 };
  const result = await Bun.build({
    throw: false, entrypoints, splitting: options.entrypoints !== undefined, root: options.root,
    outdir: options.outdir, target: "bun", format: "esm", packages: "bundle", metafile: true,
    naming: "[dir]/[name].[ext]", env: "disable", allowUnresolved: options.allowUnresolved ?? [],
    external: options.external.flatMap((name) => [name, `${name}/*`]),
    minify: options.minify, sourcemap: options.sourcemap, define: options.define,
    plugins: [{ name: "bunko-input-validation", setup(builder) {
      builder.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const path = await realpath(args.path), local = contained(path);
        // Bun's onLoad default loader omits import-attribute overrides. Record
        // supported explicit file imports before returning the importer's bytes.
        const loader = dataLoaders.get(path) ?? args.loader;
        if (!loader) throw new Error("Unsupported build input loader");
        const contents = await readFile(path);
        if (["js", "jsx", "ts", "tsx"].includes(loader)) {
          const code = contents.toString("utf8");
          if (!warned.has(path)) {
            warned.add(path);
            const warnings = moduleLocations(code, local);
            locations.total += warnings.length;
            locations.warnings.push(...warnings);
            locations.warnings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column);
            locations.warnings.length = Math.min(locations.warnings.length, diagnosticLimit);
          }
          const imports = rejectMacroSyntax(code, path);
          dataImports.set(path, new Map(imports.map((item) => [item.specifier, item.loader])));
          validation.parsed++; validation.bytes += contents.length;
          for (const item of imports) {
            if (!item.specifier.startsWith("./") && !item.specifier.startsWith("../")) throw new Error("Data import attributes require explicit relative file paths");
            const target = await realpath(resolve(dirname(path), item.specifier));
            contained(target);
            if (executableEntries.has(target)) throw new Error("An entrypoint cannot also be a data import");
            const previous = dataLoaders.get(target);
            if (previous && previous !== item.loader) throw new Error("Conflicting data loaders for the same file");
            dataLoaders.set(target, item.loader);
          }
          if (!local.split("/").includes("node_modules")) {
            rejectApplicationImports(code, path);
            await validateInputTsconfig(context, path, seenConfigs);
          }
        }
        return { contents, loader };
      });
    } }],
  });
  if (result.success && result.metafile) {
    for (const [source, input] of Object.entries(result.metafile.inputs)) {
      const importer = await realpath(resolve(process.cwd(), source));
      for (const item of input.imports) {
        const candidates = [resolve(process.cwd(), item.path), resolve(dirname(importer), item.path)];
        // Bun sometimes retains the original specifier on a reused data import.
        // This check detects loader conflicts; it is not the macro safety guard.
        try { candidates.push(await realpath(Bun.resolveSync(item.original ?? item.path, dirname(importer)))); } catch { /* Builtins and virtual imports have no file path. */ }
        const target = candidates.find((path) => dataLoaders.has(path));
        if (target && dataImports.get(importer)?.get(item.original ?? item.path) !== dataLoaders.get(target)) throw new Error("A file cannot mix data-loader and ordinary imports");
      }
    }
  }
  return Object.assign(result, { validation, locations });
}

if (import.meta.main) {
  const directory = dirname(process.argv[2]!);
  try {
    const options = JSON.parse(await readFile(process.argv[2]!, "utf8")) as WorkerOptions;
    const result = await guardedBuild(options);
    if (!result.success) throw new Error(result.logs.map((error) => error.message).join("; "));
    await Bun.write(resolve(directory, "meta.json"), JSON.stringify(result.metafile));
    await Bun.write(resolve(directory, "validation.json"), JSON.stringify(result.validation));
    await Bun.write(resolve(directory, "locations.json"), JSON.stringify(result.locations));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Build worker failed";
    await Bun.write(resolve(directory, "errors.json"), JSON.stringify([message]));
    console.error(message);
    process.exitCode = 1;
  }
}
