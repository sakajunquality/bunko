#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { buildTargets } from "./build.ts";
import { VERSION } from "./config.ts";

const help = `bunko ${VERSION} — Bun to OCI images (M2a preview)

Usage:
  bunko build [path] --repo <registry/prefix> [options]
  bunko build [path] --push=false --oci-layout <directory>
  bunko version

Options:
  --target <name/path>     Select a workspace member; repeatable, root invocation only
  --repo <prefix>          Destination prefix (or BUNKO_REPO)
  --bare                   Use --repo as the exact image repository
  --tag <tag>              Repeatable tag (default: latest and Git revision)
  --push=false             Disable registry publication
  --oci-layout <dir>       Export a complete OCI layout
  --tarball <file>          Export a single-platform Docker archive
  --local                  Load a single-platform image into Docker
  --kind                   Load into a Docker-backed kind cluster
  --kind-cluster <name>    Cluster name (default: KIND_CLUSTER_NAME or kind)
  --base <reference>       OCI/Docker base (default: oven/bun:<Bun version>-distroless)
  --base-layout <dir>      Use a complete local OCI layout as the base
  --platform <list>        linux/amd64,linux/arm64 (default: linux/amd64)
  --bun-path <file>        Bun executable used for bundling and installation
  --cache-dir <dir>        Persistent layer cache (or BUNKO_CACHE_DIR)
  --cache-repo <repo>      Registry cache repository (default: image repository)
  --no-cache               Disable persistent local and registry layer caches
  --no-local-cache         Disable persistent local layer cache
  --no-registry-cache      Disable registry cache reads/writes
  --install-cache <dir>    Bun package download cache (separate from layer cache)
  --insecure-registry <host:port>  Allow HTTP for this registry; repeatable
  --dry-run                Build/estimate with registry reads only; no export/load/push
  --reproducible            Require a digest-pinned base or local base layout
  --verify-deterministic   Build twice independently, bypassing layer cache
  --git-metadata=false     Omit automatic Git labels and Git-derived tags
  --no-index               Produce one manifest (single platform only)
  --report <file>          Write a JSON result, including transfers/cache/partial publication
  --help                   Show this help

Authentication: Docker config auths, credHelpers, or credsStore.
GHCR, Google Artifact Registry, Docker Hub, ECR and OCI Distribution registries.
Supports standalone apps and Bun workspaces with production dependencies.
Dependency closure/compile/attestation support is planned for later milestones.
Logs go to stderr; successful publication prints one repo@digest line per target.
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv.map((arg) => arg.replace(/^--(push|git-metadata|cache|local-cache|registry-cache)=(true|false)$/, (_, key: string, value: string) => `--${value === "false" ? "no-" : ""}${key}`)),
      allowPositionals: true, strict: true, allowNegative: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        push: { type: "boolean", default: true },
        repo: { type: "string" },
        target: { type: "string", multiple: true },
        bare: { type: "boolean" },
        tag: { type: "string", multiple: true },
        tarball: { type: "string" },
        local: { type: "boolean" },
        kind: { type: "boolean" },
        "kind-cluster": { type: "string" },
        cache: { type: "boolean", default: true },
        "local-cache": { type: "boolean", default: true },
        "registry-cache": { type: "boolean", default: true },
        "cache-dir": { type: "string" },
        "cache-repo": { type: "string" },
        "install-cache": { type: "string" },
        "insecure-registry": { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
        "oci-layout": { type: "string" },
        "base-layout": { type: "string" },
        base: { type: "string" },
        platform: { type: "string" },
        "bun-path": { type: "string" },
        reproducible: { type: "boolean" },
        "verify-deterministic": { type: "boolean" },
        "git-metadata": { type: "boolean", default: true },
        index: { type: "boolean", default: true },
        report: { type: "string" },
      },
    });
    const { values, positionals } = parsed;
    if (values.help || !argv.length) { process.stdout.write(help); return 0; }
    const [command, path = ".", ...rest] = positionals;
    if (values.version || command === "version") { process.stdout.write(`${VERSION}\n`); return 0; }
    if (command !== "build") throw new Error(`Unknown command: ${command ?? "(missing)"}`);
    if (rest.length) throw new Error("Use one project path and repeat --target to select workspace members");
    if (values["kind-cluster"] && !values.kind) throw new Error("--kind-cluster requires --kind");
    const results = await buildTargets({
      targets: values.target,
      push: values.push, repo: values.repo, bare: values.bare, tags: values.tag,
      tarball: values.tarball, local: values.local,
      kind: values.kind ? values["kind-cluster"] ?? process.env.KIND_CLUSTER_NAME ?? "kind" : undefined,
      cacheDir: values["cache-dir"], cacheRepo: values["cache-repo"],
      localCache: values.cache && values["local-cache"], registryCache: values.cache && values["registry-cache"],
      installCache: values["install-cache"], registry: { insecure: values["insecure-registry"] }, dryRun: values["dry-run"],
      path, output: values["oci-layout"], base: values.base,
      baseLayout: values["base-layout"], platform: values.platform,
      bunPath: values["bun-path"], report: values.report,
      reproducible: values.reproducible, verifyDeterministic: values["verify-deterministic"],
      gitMetadata: values["git-metadata"], noIndex: !values.index,
      log: (message) => process.stderr.write(message),
    });
    for (const result of results) if (!result.dryRun) {
      if (result.publication?.published) process.stdout.write(`${result.publication.reference}\n`);
      else if (result.localReference) process.stdout.write(`${result.localReference}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`bunko: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
