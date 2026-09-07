import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {canonicalJSON} from "../packages/oci/digest.ts";
import {project} from "./helpers.ts";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

/** Author-owned packages in an isolated Bun download-cache fixture: no network. */
export async function dependencyFixture(root: string, external = true) {
  const source = await project(join(root, "app"), { dependencies: { "fixture-msg": "1.0.0" }, devDependencies: { "fixture-dev": "1.0.0" },
    scripts: { postinstall: "touch must-not-exist" }, bunko: { external: external ? ["fixture-msg"] : [], assets: ["public"] } }, 'import message from "fixture-msg"; console.log(message);\n');
  const cache = join(root, "npm-cache");
  for (const name of ["fixture-msg", "fixture-dev"]) {
    const path = join(cache, `${name}@1.0.0@@@1`);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    await writeFile(join(path, "index.js"), `module.exports = "${name} works";\n`);
  }
  const lock = { lockfileVersion: 1, configVersion: 1, workspaces: { "": { name: "hello", dependencies: { "fixture-msg": "1.0.0" }, devDependencies: { "fixture-dev": "1.0.0" } } },
    packages: { "fixture-msg": ["fixture-msg@1.0.0", "", {}, integrity], "fixture-dev": ["fixture-dev@1.0.0", "", {}, integrity] } };
  await writeFile(join(source, "bun.lock"), canonicalJSON(lock));
  await mkdir(join(source, "public")); await writeFile(join(source, "public/message.txt"), "stable asset");
  return { source, cache, lock };
}

