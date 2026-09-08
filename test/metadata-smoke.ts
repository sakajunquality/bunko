import { mkdtemp, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "../packages/bunko/build.ts";
import { signImages, verifyImage } from "../packages/bunko/attest.ts";
import { exportMetadata } from "../packages/bunko/metadata.ts";
import { packDependencies } from "../packages/bunko/external-deps.ts";
import { pushLayout } from "../packages/bunko/push-layout.ts";
import { command } from "./command.ts";
import { baseLayout, project } from "./helpers.ts";

const cosign = process.env.BUNKO_COSIGN_PATH ?? Bun.which("cosign");
if (!cosign) throw new Error("Set BUNKO_COSIGN_PATH to cosign v3.1.3");
const directory = await mkdtemp(join(tmpdir(), "bunko-metadata-smoke-")), container = `bunko-metadata-${randomUUID()}`;
const output = resolve(process.argv[2] ?? join(directory, "metadata"));
let started = false;
process.env.COSIGN_PASSWORD = randomUUID();
try {
  for (const name of ["producer", "wrong"]) await command([cosign, "generate-key-pair", "--output-key-prefix", join(directory, name)]);
  await command(["docker", "run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::5000", "registry:3"]); started = true;
  const host = `localhost:${(await command(["docker", "port", container, "5000/tcp"])).split(":").at(-1)}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://${host}/v2/`)).ok) break; } catch { /* Wait for this registry. */ }
    if (i === 50) throw new Error("Registry did not start"); await Bun.sleep(100);
  }
  const source = await project(join(directory, "source"), { dependencies: { prepared: "1.0.0" }, bunko: { external: ["prepared"] } }, 'console.log(require("prepared"));');
  await mkdir(join(source, "node_modules/prepared"), { recursive: true });
  await writeFile(join(source, "node_modules/prepared/package.json"), JSON.stringify({ name: "prepared", version: "1.0.0", main: "index.js", license: "MIT" }));
  await writeFile(join(source, "node_modules/prepared/index.js"), 'module.exports="generated fixture";');
  const lock = { lockfileVersion: 1, workspaces: { "": { name: "hello", dependencies: { prepared: "1.0.0" } } }, packages: { prepared: ["prepared@1.0.0", "", {}, "sha512-" + Buffer.alloc(64).toString("base64")] } };
  await writeFile(join(source, "bun.lock"), JSON.stringify(lock));
  const installCache = join(directory, "npm-cache");
  await mkdir(installCache);
  await cp(join(source, "node_modules/prepared"), join(installCache, "prepared@1.0.0@@@1"), { recursive: true });
  const deps = join(directory, "deps"), registry = { insecure: [host], credentials: async () => undefined };
  await packDependencies(source, join(source, "bun.lock"), { os: "linux", architecture: "amd64" }, deps);
  const published = await pushLayout(deps, `${host}/deps`, [], registry);
  const options = { path: source, baseLayout: await baseLayout(join(directory, "base")), repo: `${host}/image`, bare: true, localCache: false, registryCache: false, gitMetadata: false, installCache,
    sbom: true, provenance: true, reproducible: true, supplyChainPolicy: "ci" as const, signKey: join(directory, "producer.key"), cosignPath: cosign,
    depsVerifyKey: join(directory, "producer.pub"), externalDeps: { "linux/amd64": published.reference }, registry };
  let rejected = 0;
  async function mustReject(key: string) { try { await build({ ...options, depsVerifyKey: key }); } catch (error) { if (!String(error).includes("cosign verify failed")) throw error; rejected++; return; } throw new Error("Untrusted dependency was accepted"); }
  await mustReject(options.depsVerifyKey);
  await signImages([published.reference], options.signKey, cosign, [host]);
  await mustReject(join(directory, "wrong.pub"));
  const result = await build(options);
  for (const d of [result.root, ...result.attestations!.map((a) => a.manifest)]) await verifyImage(`${host}/image@${d.digest}`, options.depsVerifyKey, true, cosign, [host]);
  const exported = await exportMetadata(`${host}/image@${result.root.digest}`, output, registry);
  const report = { schemaVersion: 1, cosign: "3.1.3", registry: "Distribution 3", signatureRejections: rejected, exportedArtifacts: exported.records.length,
    builderKind: result.builder!.kind, builderDigest: result.builder!.digest, transparencyLogUpload: false, scope: "Synthetic prepared dependency and base metadata fixtures; no runtime or OS scanner claim" };
  await writeFile(join(output, "validation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { if (started) await command(["docker", "rm", "--force", container]); await rm(directory, { recursive: true, force: true }); }
