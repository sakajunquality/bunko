/** Dedicated local registry/worker benchmark. Never prunes a user's builder. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { RegistrySource } from "../packages/oci/source.ts";
import { command } from "./command.ts";
import { writeReport } from "../packages/bunko/build.ts";

const output = resolve(process.argv[2] ?? "builder-comparison.json");
const root = await mkdtemp(join(tmpdir(), "bunko-compare-")), id = `bunko-compare-${randomUUID().slice(0, 8)}`;
const source = join(root, "source"), cli = join(root, "bunko.js");
const samples: Record<string, unknown>[] = [];
async function timed(argv: string[], cwd?: string) {
  const start = performance.now(), child = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exit) throw Error(stderr);
  return { milliseconds: performance.now() - start, clientResources: child.resourceUsage() };
}
try {
  await command([process.execPath, "build", resolve("packages/bunko/cli.ts"), "--target=bun", "--minify", "--outfile", cli]);
  await command(["docker", "run", "--detach", "--name", id, "--publish", "127.0.0.1::5000", "registry:3"]);
  const port = (await command(["docker", "port", id, "5000/tcp"])).split(":").at(-1)!;
  const local = `localhost:${port}`, worker = `host.docker.internal:${port}`;
  await command(["docker", "buildx", "create", "--name", id, "--driver", "docker-container", "--driver-opt", "image=moby/buildkit:v0.33.0"]);
  await command(["docker", "buildx", "inspect", id, "--bootstrap"]);
  const bases = [];
  for (const tag of ["slim", "distroless"]) {
    const reference = `oven/bun:1.3.11-${tag}`;
    bases.push(`oven/bun@${(await new RegistrySource(reference).root()).descriptor.digest}`);
  }
  await mkdir(join(source, "packages/app/src"), { recursive: true });
  await mkdir(join(source, "packages/app/public"));
  await mkdir(join(source, "packages/other"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "comparison", private: true, workspaces: ["packages/*"] }));
  await writeFile(join(source, "packages/other/package.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
  await writeFile(join(source, ".dockerignore"), "node_modules\n**/node_modules\n.bunko-build\n");
  await writeFile(join(source, ".bunkoignore"), "Dockerfile\n.dockerignore\n");
  const builderBase = bases[0]!;
  await writeFile(join(source, "Dockerfile"), `ARG BASE\nFROM ${builderBase} AS build\nWORKDIR /src\nCOPY package.json bun.lock ./\nCOPY packages/app/package.json packages/app/package.json\nCOPY packages/other/package.json packages/other/package.json\nRUN bun install --frozen-lockfile --ignore-scripts\nCOPY . .\nWORKDIR /src/packages/app\nRUN bun build ./src/server.ts --target=bun --format=esm --packages=bundle --root=. --outdir=/out --entry-naming=[dir]/[name].[ext] --minify --env=disable --no-env-file\nFROM $BASE\nWORKDIR /app\nCOPY packages/app/public /app/public\nCOPY --from=build /out /app\nUSER 65532:65532\nENV NODE_ENV=production\nENTRYPOINT ["/usr/local/bin/bun","/app/src/server.js"]\n`);
  for (let repetition = 0; repetition < 3; repetition++) {
    let base = bases[0]!, version = "7.0.0", revision = 0;
    const cacheRepo = `cache-${repetition}`;
    for (const scenario of ["cold", "warm", "fresh-runner-remote-warm", "app-edit", "unrelated-edit", "asset-edit", "dependency-edit", "base-edit"]) {
      if (scenario === "cold") {
        await command(["docker", "buildx", "prune", "--builder", id, "--all", "--force"]);
        await rm(join(root, "install"), { recursive: true, force: true });
        await writeFile(join(source, "packages/app/public/message.txt"), "asset");
        await writeFile(join(source, "packages/other/index.ts"), "export const unused = 0;");
      }
      if (scenario === "fresh-runner-remote-warm") {
        await command(["docker", "buildx", "prune", "--builder", id, "--all", "--force"]);
        await rm(join(root, "install"), { recursive: true, force: true });
      }
      if (scenario === "app-edit") revision++;
      if (scenario === "unrelated-edit") await writeFile(join(source, "packages/other/index.ts"), "export const unused = 1;");
      if (scenario === "asset-edit") await writeFile(join(source, "packages/app/public/message.txt"), "asset changed");
      if (scenario === "dependency-edit") version = "6.0.0";
      if (scenario === "base-edit") base = bases[1]!;
      await writeFile(join(source, "packages/app/package.json"), JSON.stringify({ name: "app", module: "src/server.ts", dependencies: { "is-number": version }, bunko: { assets: ["public"] } }));
      await writeFile(join(source, "packages/app/src/server.ts"), `import number from "is-number"; console.log(number(42), ${revision});`);
      await timed([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], source);
      const report = join(root, `${repetition}-${scenario}.json`);
      const commands: [string, string[]][] = [
        ["bunko", [process.execPath, cli, "build", join(source, "packages/app"), "--base", base, "--platform", "linux/arm64", "--repo", `${local}/run-${repetition}/bunko`, "--tag", "sample", "--insecure-registry", local, "--no-local-cache", "--cache-repo", `${local}/${cacheRepo}/bunko`, "--install-cache", join(root, "install"), "--git-metadata=false", "--report", report]],
        ["buildkit", ["docker", "buildx", "build", "--builder", id, "--platform", "linux/arm64", "--build-arg", `BASE=${base}`, "--provenance=false", "--output", `type=image,name=${worker}/run-${repetition}/buildkit:sample,push=true,registry.insecure=true,oci-mediatypes=true`, "--cache-to", `type=registry,ref=${worker}/${cacheRepo}/buildkit:cache,mode=max,registry.insecure=true`, ...scenario === "cold" ? [] : ["--cache-from", `type=registry,ref=${worker}/${cacheRepo}/buildkit:cache,registry.insecure=true`], source]],
      ];
      if (repetition % 2) commands.reverse();
      for (const [builder, argv] of commands) {
        const measurement = await timed(argv);
        const result = builder === "bunko" ? JSON.parse(await readFile(report, "utf8")) : undefined;
        samples.push({ repetition, scenario, builder, ...measurement, cache: result?.cache, transfers: result?.publication?.transfers });
        console.error(`${repetition + 1}/3 ${scenario} ${builder}: ${Math.round(measurement.milliseconds)}ms`);
      }
    }
  }
  const groups = new Map<string, number[]>();
  for (const s of samples) { const key = `${s.scenario}/${s.builder}`; groups.set(key, [...groups.get(key) ?? [], s.milliseconds as number]); }
  const summary = Object.fromEntries([...groups].map(([key, times]) => { times.sort((a, b) => a - b); return [key, { minMs: times[0], medianMs: times[1], maxMs: times[2] }]; }));
  await writeReport(output, { schemaVersion: 1, bunkoArtifact: new Bun.CryptoHasher("sha256").update(await readFile(cli)).digest("hex"), bun: Bun.version, buildkit: "v0.33.0", buildx: await command(["docker", "buildx", "version"]), host: { os: process.platform, architecture: process.arch }, platform: "linux/arm64", mode: "bundle", bases, repetitions: 3,
    limits: ["Local registry; public npm and base downloads use the available network", "No filesystem/page-cache flushing", "Client resource usage excludes worker/daemon resource consumption", "Only Bunko payload counters are reported; metadata bytes and total wire traffic are not measured", "Independent implementations have different image metadata and layer boundaries; timings are not byte-for-byte output equivalence"], samples, summary });
} finally {
  await command(["docker", "buildx", "rm", id]).catch(() => {});
  await command(["docker", "rm", "--force", id]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
