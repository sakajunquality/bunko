import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJSON } from "../packages/oci/digest.ts";

export async function workspaceFixture(root: string) {
  const source = join(root, "workspace"), cache = join(root, "npm-cache");
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const manifests: Record<string, Record<string, unknown>> = {
    "": { name: "workspace-fixture", private: true, workspaces: ["services/*", "packages/*"], devDependencies: { "fixture-dev": "1.0.0" }, scripts: { postinstall: "touch must-not-exist" } },
    "packages/shared": { name: "@fixture/shared", version: "1.0.0", type: "module", module: "index.ts", bunko: { enabled: false } },
  };
  for (const [service, version] of [["api", "1.0.0"], ["worker", "2.0.0"]]) {
    manifests[`services/${service}`] = { name: `@fixture/${service}`, module: "src/server.ts", dependencies: { "@fixture/shared": "workspace:*", "fixture-msg": version, "fixture-adapter": "1.0.0" }, bunko: { external: ["fixture-msg", "fixture-adapter", ...(service === "worker" ? ["@fixture/shared"] : [])], assets: ["public"], build: { sourcemap: "external" } } };
    await mkdir(join(source, "services", service!, "src"), { recursive: true });
    await mkdir(join(source, "services", service!, "public"), { recursive: true });
    await writeFile(join(source, "services", service!, "public/message.txt"), "stable asset");
    await writeFile(join(source, "services", service!, "src/server.ts"), `import {message} from '@fixture/shared'; import msg from 'fixture-msg'; import peer from 'fixture-adapter'; console.log('${service}', message, msg, peer);\n`);
  }
  for (const [path, manifest] of Object.entries(manifests)) {
    await mkdir(join(source, path), { recursive: true });
    await writeFile(join(source, path, "package.json"), canonicalJSON(manifest));
  }
  await writeFile(join(source, "packages/shared/index.ts"), 'export const message = "shared";\n');
  await writeFile(join(source, "tsconfig.json"), '{"compilerOptions":{"target":"ESNext"}}');
  for (const service of ["api", "worker"]) await writeFile(join(source, "services", service, "tsconfig.json"), '{"extends":"../../tsconfig.json"}');
  for (const [name, version, code, extra] of [
    ["fixture-msg", "1.0.0", 'module.exports="one";', {}],
    ["fixture-msg", "2.0.0", 'module.exports="two";', {}],
    ["fixture-adapter", "1.0.0", 'module.exports=require("fixture-msg");', { peerDependencies: { "fixture-msg": "*" } }],
    ["fixture-dev", "1.0.0", 'throw Error("dev dependency leaked");', {}],
  ] as const) {
    const dir = join(cache, `${name}@${version}@@@1`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), canonicalJSON({ name, version, main: "index.js", ...extra }));
    await writeFile(join(dir, "index.js"), code);
  }
  const lock = { lockfileVersion: 1, configVersion: 1,
    workspaces: Object.fromEntries(Object.entries(manifests).map(([path, m]) => [path, Object.fromEntries(["name", "version", "dependencies", "devDependencies"].filter((key) => m[key] !== undefined).map((key) => [key, m[key]]))])),
    packages: {
      "@fixture/api": ["@fixture/api@workspace:services/api"], "@fixture/worker": ["@fixture/worker@workspace:services/worker"], "@fixture/shared": ["@fixture/shared@workspace:packages/shared"],
      "fixture-msg": ["fixture-msg@1.0.0", "", {}, integrity], "@fixture/worker/fixture-msg": ["fixture-msg@2.0.0", "", {}, integrity],
      "fixture-adapter": ["fixture-adapter@1.0.0", "", { peerDependencies: { "fixture-msg": "*" } }, integrity], "fixture-dev": ["fixture-dev@1.0.0", "", {}, integrity],
    } };
  await writeFile(join(source, "bun.lock"), canonicalJSON(lock));
  return { source, cache, manifests, lock };
}
