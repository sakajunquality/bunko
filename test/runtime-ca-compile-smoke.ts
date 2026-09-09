import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-compile-ca-"));
try {
  const source = join(directory, "source"), key = join(directory, "disposable.key");
  await mkdir(source);
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", join(source, "ca.pem")]);
  // The disposable server key is mounted only for execution, never packaged.
  await chmod(key, 0o444);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "compile-ca", module: "index.ts", bunko: { runtime: { caCertificates: ["ca.pem"] } } }));
  await writeFile(join(source, "index.ts"), `const server = Bun.serve({hostname:"127.0.0.1",port:0,tls:{key:await Bun.file("/fixtures/key.pem").text(),cert:await Bun.file(process.env.NODE_EXTRA_CA_CERTS!).text()},fetch:()=>new Response("compile runtime TLS works")});
try { console.log(await (await fetch("https://localhost:"+server.port)).text()); } finally { server.stop(true); }`);
  for (const platform of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) {
    const tarball = join(directory, `${platform.replace("/", "-")}.tar`);
    const result = await build({ path: source, mode: "compile", platform, tarball, push: false, localCache: false, gitMetadata: false });
    if (!result.runtimeCA || !result.images[0]!.compileRuntime) throw new Error("Missing compile/runtime CA metadata");
    const loaded = await command(["docker", "load", "--input", tarball]), image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw new Error("Docker did not load the compiled image");
    try {
      const output = await command(["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", "--user=65532:65532", "--mount", `type=bind,source=${key},target=/fixtures/key.pem,readonly`, image]);
      if (output !== "compile runtime TLS works") throw new Error("Compiled runtime did not trust the declared CA");
      console.log(`PASS: ${platform} compiled runtime trusts its declared CA with a read-only nonroot filesystem`);
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
