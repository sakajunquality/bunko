import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "../packages/bunko/build.ts";
import { packDependencies } from "../packages/bunko/external-deps.ts";
import { platform } from "../packages/bunko/config.ts";
import { RegistrySource } from "../packages/oci/source.ts";
import { command } from "./command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-native-producer-")), builder = `bunko-producer-${randomUUID().slice(0, 8)}`;
try {
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "generated-native-test", module: "index.ts", dependencies: { "is-number": "7.0.0" }, bunko: { external: ["is-number"] } }));
  await writeFile(join(source, "index.ts"), 'import answer from "is-number"; console.log(answer());');
  const install = Bun.spawn([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], { cwd: source, stdout: "ignore", stderr: "pipe" });
  if (await install.exited) throw Error(await new Response(install.stderr).text());
  const base = `oven/bun@${(await new RegistrySource("oven/bun:1.3.13-slim").root()).descriptor.digest}`;
  // This fixture deliberately replaces an installed module with generated test
  // code. It is never published as an npm package or a production artifact.
  await writeFile(join(source, "addon.c"), `#include <stddef.h>\ntypedef void* napi_env; typedef void* napi_value; typedef void* napi_callback_info;\nextern int napi_create_int32(napi_env,int,napi_value*);\nextern int napi_create_function(napi_env,const char*,size_t,napi_value(*)(napi_env,napi_callback_info),void*,napi_value*);\nextern int napi_set_named_property(napi_env,napi_value,const char*,napi_value);\nstatic napi_value answer(napi_env env,napi_callback_info info){napi_value v;napi_create_int32(env,42,&v);return v;}\nnapi_value napi_register_module_v1(napi_env env,napi_value exports){napi_value fn;napi_create_function(env,"answer",6,answer,NULL,&fn);napi_set_named_property(env,exports,"answer",fn);return exports;}\n`);
  await writeFile(join(source, "generate.ts"), 'await Bun.write("node_modules/is-number/generated.json", JSON.stringify({increment:1})); await Bun.write("node_modules/is-number/index.js", `module.exports=()=>require("./addon.node").answer()+require("./generated.json").increment;`);');
  await writeFile(join(source, "Dockerfile"), `FROM ${base} AS prepare\nRUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*\nWORKDIR /prepared\nCOPY package.json bun.lock ./\nRUN bun install --production --frozen-lockfile --ignore-scripts --cache-dir /tmp/bun-cache\nCOPY addon.c generate.ts ./\nRUN gcc -shared -fPIC addon.c -o node_modules/is-number/addon.node && bun run generate.ts\nFROM scratch\nCOPY --from=prepare /prepared/node_modules /node_modules\n`);
  await command(["docker", "buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", "image=moby/buildkit:v0.33.0"]);
  for (const target of ["linux/amd64", "linux/arm64"]) {
    const p = platform(target), prepared = join(root, `prepared-${p.architecture}`), artifact = join(root, `artifact-${p.architecture}`);
    await command(["docker", "buildx", "build", "--builder", builder, "--platform", target, "--output", `type=local,dest=${prepared}`, source]);
    const packed = await packDependencies(prepared, join(source, "bun.lock"), p, artifact);
    if (!packed.native.length) throw Error("Native addon was not inventoried");
    const tarball = join(root, `${p.architecture}.tar`);
    await build({ path: source, base, platform: target, tarball, push: false, localCache: false, gitMetadata: false, externalDeps: { [target]: `layout:${artifact}` } });
    const loaded = await command(["docker", "load", "--input", tarball]), image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw Error("Image was not loaded");
    try {
      const result = await command(["docker", "run", "--rm", "--platform", target, "--network=none", "--read-only", "--cap-drop=ALL", image]);
      if (result !== "43") throw Error("Generated native dependency result mismatch");
      console.log(JSON.stringify({ platform: target, native: packed.native, result: "PASS" }));
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally {
  await command(["docker", "buildx", "rm", builder]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
