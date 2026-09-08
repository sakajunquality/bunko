import { fileURLToPath } from "node:url";

declare const BUNKO_WORKER_CODE: string | undefined;
let code: Promise<string> | undefined;

/** Distributed CLIs embed the trusted worker; source checkouts bundle it once. */
export function workerCode(): Promise<string> {
  if (typeof BUNKO_WORKER_CODE !== "undefined") return Promise.resolve(BUNKO_WORKER_CODE);
  return code ??= (async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./bundle-worker.ts", import.meta.url))],
      target: "bun", minify: true,
      define: { __dirname: "import.meta.dir", __filename: "import.meta.path" },
    });
    if (!result.success || result.outputs.length !== 1) throw new Error("Cannot prepare the trusted build worker");
    return result.outputs[0]!.text();
  })();
}
