import { workerCode } from "../packages/bunko/worker-code.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve CommonJS location globals at runtime. Otherwise Bun embeds the
 * dependency checkout path (including the build user's home) in the CLI. */
export async function bundleCLI(output: string) {
  return Bun.build({
    entrypoints: [fileURLToPath(new URL("../packages/bunko/cli.ts", import.meta.url))],
    target: "bun", throw: false, naming: "bunko.js", outdir: output, minify: true,
    define: { BUNKO_WORKER_CODE: JSON.stringify(await workerCode()), __dirname: "import.meta.dir", __filename: "import.meta.path" },
  });
}

if (import.meta.main) {
  const result = await bundleCLI(resolve(process.argv[2] ?? "dist"));
  if (!result.success) throw new Error(`CLI bundle failed: ${result.logs.join("\n")}`);
}
