/** Public, disposable runtime-injection smoke checks against the distributed CLI. */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../../packages/oci/blob-store.ts";
import { exportDockerArchive } from "../../packages/oci/archive.ts";
import { exportLayout } from "../../packages/oci/layout.ts";
import { RegistrySource, resolveBase } from "../../packages/oci/source.ts";
import { platform } from "../../packages/bunko/config.ts";
import type { BuildResult } from "../../packages/bunko/build.ts";

const base = "gcr.io/distroless/base-debian12@sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5";
const empty = "gcr.io/distroless/static-debian12@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab";
const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
for (const value of platforms) platform(value);
const cli = [process.execPath, resolve("dist/bunko.js")], root = await mkdtemp(join(tmpdir(), "bunko-injection-smoke-"));
const images = new Set<string>();
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }), timer = setTimeout(() => child.kill(), 300000);
  try { const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { out, err, code }; }
  finally { clearTimeout(timer); }
}
async function good(args: string[]) { const result = await run(args); if (result.code) throw new Error(result.err); return result.out; }
try {
  const check = JSON.parse(await good([...cli, "check-base", "--base", base, "--runtime-inject", "release", "--platform", platforms.join(","), "--run"]));
  if (check.platforms.some((p: { runtimeVerified: boolean }) => !p.runtimeVerified)) throw new Error("Injected revision was not verified");
  const rejected = await run([...cli, "check-base", "--base", empty, "--runtime-inject", "release", "--platform", platforms[0]!]);
  if (!rejected.code || !rejected.err.includes("glibc loader")) throw new Error("Static base was not rejected clearly");
  // Exercise local OCI input through the same composed runtime check.
  const store = new BlobStore(join(root, "store")), source = new RegistrySource(base), selected = await resolveBase(source, platform(platforms[0]!), store, true);
  const layout = join(root, "base");
  await exportLayout(store, layout, selected.descriptor, [selected.descriptor, selected.manifest.config, ...selected.manifest.layers], "base");
  const local = JSON.parse(await good([...cli, "check-base", "--base-layout", layout, "--runtime-inject", "release", "--platform", platforms[0]!, "--run"]));
  if (!local.platforms[0].runtimeVerified) throw new Error("Local base runtime was not verified");
  // A successful Bun-only check does not supply native-addon shared libraries.
  const project = join(root, "source");
  await cp(resolve("examples/application-validation"), project, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  manifest.bunko = { entrypoint: "src/server.ts", external: ["@node-rs/xxhash"], runtime: { inject: "release" } };
  await writeFile(join(project, "package.json"), JSON.stringify(manifest));
  await writeFile(join(project, "src/server.ts"), 'import { xxh32 } from "@node-rs/xxhash"; console.log(xxh32("bunko"));');
  const output = join(root, "native"), report = join(root, "report.json"), cache = join(root,"cache");
  const options = ["build", project, "--base", base, "--platform", platforms.join(","), "--push=false", "--git-metadata=false", "--cache-dir", cache, "--registry-cache=false", "--sbom", "--provenance"];
  await good([...cli, ...options, "--oci-layout", output, "--report", report]);
  const built = JSON.parse(await readFile(report, "utf8")) as BuildResult;
  const warmReport = join(root,"warm-report.json");
  await good([...cli, ...options, "--oci-layout", join(root,"warm"), "--report", warmReport]);
  const warm = JSON.parse(await readFile(warmReport,"utf8"));
  if (!warm.cache.some((e: {kind:string;status:string})=>e.kind==="runtime" && e.status==="local")) throw new Error("Runtime cache did not replay");
  for (const image of built.images) {
    if (!image.runtime || image.runtime.revisionVerified || image.layers[0]?.kind !== "runtime") throw new Error("Incorrect runtime report");
    const tag = `bunko.local/runtime-native:${randomUUID()}`, archive = join(root, `${image.platform.architecture}.tar`);
    await exportDockerArchive(new BlobStore(output), image.manifest, archive, tag, 0);
    images.add(tag); await good(["docker", "load", "--input", archive]);
    const attempt = await run(["docker", "run", "--rm", "--network=none", "--read-only", "--platform", `linux/${image.platform.architecture}`, tag]);
    if (!attempt.code || !attempt.err.includes("libgcc_s.so.1")) throw new Error("Expected the native addon to require libgcc_s beyond the minimal base");
  }
  console.log(JSON.stringify({ status: "passed", platforms, signedRelease: true, runtimeRevision: true, staticRejected: true, localBase: true, runtimeCache: true, nativeLibraryBoundary: true }));
} finally {
  for (const tag of images) await run(["docker", "image", "rm", tag]);
  await rm(root, { recursive: true, force: true });
}
