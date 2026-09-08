/** Opt-in conformance against an explicitly supplied, dedicated repository.
 * Remote image/cache tags are retained. Only local resources are cleaned up. */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, writeReport, type BuildResult } from "../packages/bunko/build.ts";
import { platform as parsePlatform } from "../packages/bunko/config.ts";
import { assertFileAvailable, exportDockerArchive, loadArchive } from "../packages/oci/archive.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { dockerCredentials } from "../packages/oci/credentials.ts";
import { PublicationError, repository, repositoryName } from "../packages/oci/publish.ts";
import { RegistrySource, resolveBase } from "../packages/oci/source.ts";
import { command } from "./command.ts";
import { pullImage } from "./docker-pull.ts";

export type Vendor = "ghcr" | "gar" | "dockerhub" | "ecr" | "distribution";
export interface ConformanceOptions {
  vendor: Vendor; repo: string; cacheRepo?: string; requireCache: boolean;
  runtimePlatforms: string[]; report: string; installCache?: string;
  insecure?: string[]; archivePull?: boolean;
}

export async function cliBuild(args: string[], output: string): Promise<BuildResult> {
  const child = Bun.spawn(args, { env: process.env, stdout: "ignore", stderr: "inherit" });
  const code = await child.exited;
  const result = await Bun.file(output).json().catch(() => undefined);
  if (code !== 0) {
    const message = `Released CLI build failed (exit ${code})`;
    if (result?.publication) throw new PublicationError(message, result.publication);
    throw new Error(message);
  }
  if (!result || result.status === "failed") throw new Error("Released CLI did not produce a successful build report");
  return result;
}

export function validateRepository(vendor: Vendor, value: string): string {
  if (!value.includes("/") || !/[.:]/.test(value.split("/")[0]!)) throw new Error("Use a fully qualified, dedicated image repository");
  const ref = repository(value);
  const paths = ref.repository.split("/");
  const valid = {
    ghcr: ref.registry === "ghcr.io" && paths.length >= 2,
    gar: /^[a-z0-9-]+-docker\.pkg\.dev$/.test(ref.registry) && paths.length >= 3,
    dockerhub: ref.registry === "registry-1.docker.io" && paths.length === 2 && paths[0] !== "library",
    ecr: /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(ref.registry),
    distribution: /^(?:localhost|127\.0\.0\.1):\d+$/.test(ref.registry),
  };
  if (!valid[vendor]) throw new Error(`Repository does not match selected registry: ${vendor}`);
  return repositoryName(ref);
}

export function conformanceOptions(env: Record<string, string | undefined> = process.env): ConformanceOptions {
  const vendor = env.BUNKO_SMOKE_VENDOR as Vendor;
  if (!["ghcr", "gar", "dockerhub", "ecr", "distribution"].includes(vendor)) throw new Error("Set BUNKO_SMOKE_VENDOR to ghcr, gar, dockerhub, ecr, or distribution");
  const repo = validateRepository(vendor, env.BUNKO_SMOKE_REPO ?? "");
  const cacheRepo = env.BUNKO_SMOKE_CACHE_REPO ? validateRepository(vendor, env.BUNKO_SMOKE_CACHE_REPO) : undefined;
  if (cacheRepo && repository(cacheRepo).registry !== repository(repo).registry) throw new Error("Conformance cache must use the same registry host");
  if (env.BUNKO_DOCKER_CONFIG) throw new Error("Conformance uses Docker and bunko together; use DOCKER_CONFIG instead of BUNKO_DOCKER_CONFIG");
  const runtimePlatforms = (env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64").split(",");
  runtimePlatforms.forEach(parsePlatform);
  if (new Set(runtimePlatforms).size !== runtimePlatforms.length) throw new Error("Duplicate runtime platform");
  if (env.BUNKO_SMOKE_REQUIRE_CACHE && !["true", "false"].includes(env.BUNKO_SMOKE_REQUIRE_CACHE)) throw new Error("BUNKO_SMOKE_REQUIRE_CACHE must be true or false");
  if (!env.BUNKO_SMOKE_REPORT) throw new Error("Set BUNKO_SMOKE_REPORT to a new JSON report file");
  return { vendor, repo, cacheRepo, requireCache: env.BUNKO_SMOKE_REQUIRE_CACHE !== "false", runtimePlatforms,
    report: resolve(env.BUNKO_SMOKE_REPORT), installCache: env.BUNKO_SMOKE_NPM_CACHE,
    insecure: vendor === "distribution" ? [repository(repo).registry] : undefined };
}

export function verifyWarm(first: BuildResult, second: BuildResult, requireCache: boolean) {
  if (first.root.digest === second.root.digest) throw new Error("Source edit did not change the image");
  if (!second.publication?.published || second.publication.pendingTags.length) throw new Error("Warm publication was incomplete");
  const relevant = second.cache.filter((event) => ["deps", "assets"].includes(event.kind));
  const cacheVerified = relevant.length >= 3 && relevant.every((event) => event.status === "registry");
  if (requireCache && !cacheVerified) throw new Error("Registry cache reuse was not verified");
  if (first.images.length !== 2 || second.images.length !== 2) throw new Error("Expected two platform images");
  for (const image of second.images) {
    const before = first.images.find((candidate) => candidate.platform.architecture === image.platform.architecture);
    if (!before) throw new Error("Warm build changed the platform set");
    for (const kind of ["deps", "assets"] as const) {
      const layer = image.layers.find((l) => l.kind === kind), prior = before.layers.find((l) => l.kind === kind);
      if (!layer || !prior || layer.descriptor.digest !== prior.descriptor.digest) throw new Error(`${kind} layer changed or is absent after a source-only edit`);
    }
  }
  if (second.publication.transfers.some((t) => ["deps", "assets"].includes(t.kind) && t.uploaded !== 0)) throw new Error("Unchanged deps/assets were uploaded again");
  return cacheVerified;
}

export async function registryConformance(options: ConformanceOptions) {
  options.repo = validateRepository(options.vendor, options.repo);
  await assertFileAvailable(options.report, "Report");
  const cliDigest = process.env.BUNKO_TEST_CLI ? sha256(await Bun.file(resolve(process.env.BUNKO_TEST_CLI)).bytes()) : undefined;
  const temporary = await mkdtemp(join(tmpdir(), "bunko-conformance-"));
  const runId = randomUUID(), containers = new Set<string>(), localImages = new Set<string>();
  const base = process.env.BUNKO_TEST_BASE ?? "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9";
  const tags = [`bunko-smoke-${runId}-first`, `bunko-smoke-${runId}-warm`];
  const results: BuildResult[] = [], runtime: unknown[] = [];
  const report = { schemaVersion: 1, vendor: options.vendor, repository: options.repo, cacheRepository: options.cacheRepo ?? options.repo,
    runId, base, tags, invocation: cliDigest ? { kind: "cli", digest: cliDigest } : { kind: "source" },
    status: "running", cacheVerified: false, directDockerPull: !options.archivePull,
    tokenExpiryTest: "not-run", partialPublication: undefined as PublicationError["result"] | undefined, results, runtime, error: undefined as string | undefined };
  try {
    const source = join(temporary, "source"), installCache = options.installCache ?? join(temporary, "npm-cache");
    await cp(resolve("examples/dependencies"), source, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
    const app = join(source, "src/server.ts");
    const original = await readFile(app, "utf8");
    await writeFile(app, original.replace("Hello from bunko dependencies!", `bunko conformance ${runId} first`));
    const common = { path: source, base, platform: "linux/amd64,linux/arm64", push: true, repo: options.repo, bare: true,
      cacheRepo: options.cacheRepo, gitMetadata: false, localCache: false, registryCache: true, installCache,
      registry: { insecure: options.insecure }, log: (message: string) => process.stderr.write(message) };
    const runBuild = async (tag: string, deterministic = false): Promise<BuildResult> => {
      if (!process.env.BUNKO_TEST_CLI) return build({ ...common, tags: [tag], verifyDeterministic: deterministic });
      const output = join(temporary, `${tag}.json`);
      const args = [process.execPath, resolve(process.env.BUNKO_TEST_CLI), "build", source, "--base", base,
        "--platform", common.platform, "--repo", options.repo, "--bare", "--tag", tag,
        "--no-git-metadata", "--no-local-cache", "--install-cache", installCache, "--report", output];
      if (options.cacheRepo) args.push("--cache-repo", options.cacheRepo);
      if (deterministic) args.push("--verify-deterministic");
      for (const host of options.insecure ?? []) args.push("--insecure-registry", host);
      const result = await cliBuild(args, output);
      if (result.builder.kind !== "bundle" || result.builder.digest !== cliDigest) throw new Error("Released CLI builder fingerprint mismatch");
      return result;
    };
    results.push(await runBuild(tags[0]!, true));
    const expected = `bunko conformance ${runId} warm`;
    await writeFile(app, original.replace("Hello from bunko dependencies!", expected));
    results.push(await runBuild(tags[1]!));
    report.cacheVerified = verifyWarm(results[0]!, results[1]!, options.requireCache);
    const reference = results[1]!.publication!.reference;
    for (const [index, platform] of options.runtimePlatforms.entries()) {
      const name = `bunko-conformance-${runId}-${index}`, tag = `bunko.local/${name}:smoke`;
      const store = new BlobStore(join(temporary, `pull-${index}`));
      // Independent authenticated client and complete digest-verified pull.
      const pulled = await resolveBase(new RegistrySource(reference, { insecure: options.insecure, credentials: dockerCredentials() }), parsePlatform(platform), store);
      const expectedImage = results[1]!.images.find((i) => i.platform.architecture === parsePlatform(platform).architecture)!;
      if (pulled.descriptor.digest !== expectedImage.manifest.digest || pulled.manifest.config.digest !== expectedImage.config.digest) throw new Error("Pulled platform descriptors differ from the published image");
      if (options.archivePull) {
        const archive = join(temporary, `${index}.tar`);
        await exportDockerArchive(store, pulled.descriptor, archive, tag, 0);
        await loadArchive(archive, tag);
      } else {
        const platformReference = `${options.repo}@${expectedImage.manifest.digest}`;
        localImages.add(platformReference);
        await pullImage(platformReference, platform);
        await command(["docker", "tag", platformReference, tag]);
      }
      localImages.add(tag);
      const image = JSON.parse(await command(["docker", "image", "inspect", tag]))[0];
      // Docker's containerd store may expose a manifest/index digest as Id.
      // Verify the actual exported config bytes instead of interpreting Id.
      const saved = join(temporary, `docker-${index}.tar`);
      await command(["docker", "image", "save", "--output", saved, tag]);
      const savedManifest = JSON.parse(await command(["tar", "-xOf", saved, "manifest.json"]));
      const configPath = savedManifest[0]?.Config;
      if (savedManifest.length !== 1 || typeof configPath !== "string" || !/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(configPath)) throw new Error("Unexpected Docker archive config");
      const extraction = Bun.spawn(["tar", "-xOf", saved, configPath], { stdout: "pipe", stderr: "pipe" });
      const [bytes, diagnostic, exit] = await Promise.all([new Response(extraction.stdout).bytes(), new Response(extraction.stderr).text(), extraction.exited]);
      if (exit || diagnostic || sha256(bytes) !== expectedImage.config.digest) throw new Error("Docker stored a different image config");
      await rm(saved);
      containers.add(name);
      await command(["docker", "run", "--detach", "--name", name, "--platform", platform, "--pull=never", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid", "--cap-drop=ALL", "--publish", "127.0.0.1::3000", tag]);
      const info = JSON.parse(await command(["docker", "inspect", name]))[0];
      if (info.Config.User !== "65532:65532") throw new Error("Expected nonroot image");
      const port = info.NetworkSettings.Ports["3000/tcp"][0].HostPort;
      let body: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { body = await response.json() as Record<string, unknown>; break; } } catch { /* startup */ }
        await Bun.sleep(100);
      }
      if (body?.message !== expected || body.hash !== 510391394 || body.number !== true) throw new Error(`Runtime response mismatch for ${platform}`);
      await command(["docker", "stop", "--time", "5", name]);
      const state = JSON.parse(await command(["docker", "inspect", name]))[0].State;
      if (state.ExitCode !== 0) throw new Error(`SIGTERM failed for ${platform}`);
      runtime.push({ platform, manifest: pulled.descriptor.digest, config: expectedImage.config.digest, dockerId: image.Id, body, user: info.Config.User, readOnly: true, exitCode: state.ExitCode });
    }
    report.status = "success";
  } catch (error) {
    if (error instanceof PublicationError) report.partialPublication = error.result;
    report.status = "failed"; report.error = error instanceof Error ? error.message : "Conformance failed";
    throw error;
  } finally {
    try { await writeReport(options.report, report); }
    finally {
      for (const name of containers) await command(["docker", "rm", "--force", name]).catch(() => {});
      for (const tag of [...localImages].reverse()) await command(["docker", "image", "rm", tag]).catch(() => {});
      await rm(temporary, { recursive: true, force: true });
    }
  }
  console.log(`PASS: ${options.vendor} publication, cache=${report.cacheVerified}, verified pull and runtime; report=${options.report}`);
}

if (import.meta.main) await registryConformance(conformanceOptions());
