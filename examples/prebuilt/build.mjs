import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = fileURLToPath(new URL(".", import.meta.url));
const output = new URL("dist/", import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: directory,
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
});
await cp(new URL("public/", import.meta.url), new URL("public/", output), { recursive: true });

// The image context needs no package installation: all npm packages are bundled.
await writeFile(new URL("package.json", output), JSON.stringify({
  name: "prebuilt",
  version: "1.0.0",
  private: true,
  type: "module",
  bunko: {
    mode: "source",
    entrypoint: "server.mjs",
    assets: ["public"],
    ports: [3000],
  },
}, null, 2) + "\n");

// Retain the license of the dependency included in the bundle.
await cp(new URL("node_modules/is-number/LICENSE", import.meta.url), new URL("LICENSE-is-number", output));
