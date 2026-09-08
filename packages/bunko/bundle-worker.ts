import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { rejectApplicationImports, rejectMacroSyntax } from "./syntax.ts";
import { validateInputTsconfig } from "./tsconfig.ts";

export interface WorkerOptions {
  root: string;
  contextRoot: string;
  entrypoint: string;
  outdir: string;
  external: string[];
  allowUnresolved?: string[];
  minify: boolean;
  sourcemap: "none" | "external";
  define: Record<string, string>;
}

export async function guardedBuild(options: WorkerOptions) {
  const context = await realpath(options.contextRoot);
  const seenConfigs = new Set<string>();
  const validation = { parsed: 0, reused: 0, bytes: 0 };
  const result = await Bun.build({
    throw: false, entrypoints: [resolve(options.root, options.entrypoint)], root: options.root,
    outdir: options.outdir, target: "bun", format: "esm", packages: "bundle", metafile: true,
    naming: "[dir]/[name].[ext]", env: "disable", allowUnresolved: options.allowUnresolved ?? [],
    external: options.external.flatMap((name) => [name, `${name}/*`]),
    minify: options.minify, sourcemap: options.sourcemap, define: options.define,
    plugins: [{ name: "bunko-input-validation", setup(builder) {
      builder.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const path = await realpath(args.path), local = relative(context, path);
        if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("Build input escaped the project snapshot");
        const contents = await readFile(path);
        const loader = args.loader;
        if (["js", "jsx", "ts", "tsx"].includes(loader)) {
          const code = contents.toString("utf8");
          rejectMacroSyntax(code, path);
          validation.parsed++; validation.bytes += contents.length;
          if (!local.split("/").includes("node_modules")) {
            rejectApplicationImports(code, path);
            await validateInputTsconfig(context, path, seenConfigs);
          }
        }
        return { contents, loader };
      });
    } }],
  });
  return Object.assign(result, { validation });
}

if (import.meta.main) {
  const options = JSON.parse(await readFile(process.argv[2]!, "utf8")) as WorkerOptions;
  const result = await guardedBuild(options);
  if (!result.success) {
    await Bun.write(resolve(dirname(process.argv[2]!), "errors.json"), JSON.stringify(result.logs.map((error) => error.message)));
    for (const error of result.logs) console.error(error.message);
    process.exitCode = 1;
  } else {
    await Bun.write(resolve(dirname(process.argv[2]!), "meta.json"), JSON.stringify(result.metafile));
    await Bun.write(resolve(dirname(process.argv[2]!), "validation.json"), JSON.stringify(result.validation));
  }
}
