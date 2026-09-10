#!/usr/bin/env bun
import { prepareBase } from "./prepare-base.ts";
import { selectRegistryMirrors } from "../oci/mirrors.ts";
import { parseDefines } from "./defines.ts";
import { Telemetry, telemetryConfig } from "./telemetry.ts";
import { parseAssetContexts } from "./asset-contexts.ts";
import { exportMetadata } from "./metadata.ts";
import { dependencyMap } from "./dependency-map.ts";
import { registryTLS } from "../oci/tls.ts";
/*! bunko — MIT License

Copyright (c) 2026 sakajunquality

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import { checkConfig, doctor } from "./diagnostics.ts";
import { closureReport, formatClosureInfo, formatWhy, whyPackage } from "./closure-report.ts";
import { diagnosticsFormat, diagnosticsOutput } from "./diagnostics-format.ts";
import { validateCommandOptions } from "./command-options.ts";
import { parseArgs } from "node:util";
import { buildTargets } from "./build.ts";
import { VERSION, type BuildOptions } from "./config.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { pushLayout } from "./push-layout.ts";
import { pruneLocal, pruneRegistry } from "./prune.ts";
import { applyDocuments } from "./apply.ts";
import { packDependencies } from "./external-deps.ts";
import { platform as parsePlatform } from "./config.ts";
import { checkBase } from "./check-base.ts";
import { verifyImage } from "./attest.ts";
import { resolveDocuments } from "./resolve.ts";

const help = `bunko ${VERSION} — Bun to OCI images (preview)

Usage:
  bunko build [path] --repo <registry/prefix> [options]
  bunko build [path] --push=false --oci-layout <directory>
  bunko resolve -f <file|directory|-> --repo <registry/prefix>
  bunko apply -f <file|directory|-> --repo <registry/prefix> [--kube-dry-run server]
  bunko push-layout <directory> --repo <exact-repository> [--tag <tag>]
  bunko cache-info [--cache-dir <directory>]
  bunko prune [--cache-dir <directory> | --cache-repo <repository>] [--execute]
  bunko pack-deps <prepared-directory> --lockfile <bun.lock> --oci-layout <directory>
  bunko prepare-base --base <reference> --oci-layout <dir> [--platform <list>]
  bunko check-base --base <reference> [--platform <list>] [--run]
  bunko verify <image@digest> --verify-key <public-key> [--private-signatures]
  bunko check-config [path] [--target <name/path>] [--asset-context <NAME=DIR>] [--format <json|text>]
  bunko doctor [path] [--bun-path <file>] [--asset-context <NAME=DIR>] [--format <json|text>]
  bunko why <package> [path] [--target <name/path>] [--json]
  bunko closure-info [path] [--target <name/path>] [--top <count>] [--json]
  bunko metadata <image@digest|layout:DIR> --metadata-dir <directory>
  bunko version

Options:
  -f, --filename <path>    Resolve YAML/JSON file, directory or stdin; repeatable
  --runtime-arg <value>    Bun option before the entrypoint; repeatable
  --offline               Build using local bases and prepared caches only
  --define <KEY=VALUE>     Override a build constant; repeatable, explicit values only
  --asset-context <NAME=DIR>  Named local asset input; repeatable
  --context <dir>         Base directory for bunko:// references (default: cwd)
  -l, --selector <query>  Select manifest documents by metadata.labels
  --recursive             Include nested input directories for resolve
  --target <name/path>     Select a workspace member; repeatable, root invocation only
  --execute               Execute prune deletions (default: preview only)
  --keep-bytes <bytes>     Local managed cache budget (exclusive with --older-than)
  --cache-from <repo>      Ordered cache read source; repeat to add more
  --cache-write=false     Disable registry cache writes; retain reads
  --older-than <seconds>  Local prune age (default: 604800)
  --kubectl-path <file>   kubectl executable for apply
  --kube-context <name>   Kubernetes context for apply
  --namespace <name>      Namespace for apply
  --server-side          Use server-side apply
  --field-manager <name> Field manager for apply
  --lockfile <file>       Text Bun lock for pack-deps
  --workdir <path>        Image workdir for pack-deps (default: /app)
  --run                  Execute check-base runtime validation through Docker
  --runtime-inject release  Inject a signed official Bun release (requires explicit base and gpgv)
  --runtime-cache <dir>    Verified Bun release download cache
  --runtime-path <path>  Runtime path checked by check-base
  --verify-key <file>     Public key for verify
  --private-signatures  Verify signatures without transparency-log evidence
  --kube-dry-run <mode>   apply only: client, server or none
  --deps-artifact <platform=ref>  Prepared dependency OCI artifact; repeat per platform
  --deps-strategy <name>   production (default) or closure
  --shared-deps           Share the union of selected workspace closures
  --image-label <key=value>       Image config label; repeatable
  --image-annotation <key=value>  OCI manifest/index annotation; repeatable
  --image-user <user>             Override the runtime user
  --image-refs <file>             Write published immutable references
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
  --no-cache               Disable persistent local/registry layer caches and download caches
  --no-app-cache           Disable reusable application output
  --no-local-cache         Disable persistent local layer and download caches
  --no-registry-cache      Disable registry cache reads/writes
  --install-cache <dir>    Bun package download cache (default: ~/.cache/bunko/install/v1)
  --insecure-registry <host:port>  Allow HTTP for this registry; repeatable
  --dry-run                Build/estimate with registry reads only; no export/load/push
  --reproducible            Require a digest-pinned base or local base layout
  --verify-deterministic   Build twice independently, bypassing layer cache
  --git-metadata=false     Omit automatic Git labels and Git-derived tags
  --no-index               Produce one manifest (single platform only)
  --jobs <count>          Concurrent target builds, 1–32 (default: 1 or BUNKO_JOBS)
  --mode <mode>           bundle (default) or compile (Linux executable)
  --module-locations <warn|error>  Fail on BUNKO_MODULE_LOCATION diagnostics (default: warn)
  --sbom                   Attach per-platform SPDX package inventories
  --provenance             Attach SLSA provenance to the image root
  --sign-key <key>         Sign image/artifact digests with cosign, without Rekor
  --cosign-path <file>     cosign executable (default: PATH)
  --base-sbom <linux/ARCH=ref>    Link an OCI SPDX artifact matching the base digest
  --deps-verify-key <key>   Require trusted signatures on dependency artifacts
  --supply-chain-policy ci Require reproducible input, metadata and signing
  --deps-map <file>         Per-target, per-platform prepared dependency artifacts
  --artifact-target <path>  Bind pack-deps output to a workspace member
  --registry-mirror <ORIGIN=MIRROR>  Pull digest content from a mirror; repeatable
  --tag-conflict <fail|skip>  Fail on immutable tag refusals, or report and skip them
  --registry-config <file>  Host-scoped CA/client certificate configuration
  --otel                   Export build traces/metrics via OTLP/HTTP JSON (opt-in)
  --top <count>            closure-info rows, largest first (default: 20)
  --json                   Machine-readable why/closure-info output
  --progress <plain|json>   Stage events on stderr (default: plain)
  --format <json|text>     check-config/doctor output (default: text on a terminal, json otherwise)
  --report <file>          Write a JSON result, including transfers/cache/partial publication; replaces an existing Bunko report (regular file)
  --help                   Show this help

Boolean options accept --flag, --no-flag, and --flag=true|false.

why and closure-info enumerate the closure from a real Linux production install
of bun.lock, so they need package registry access; they never contact an image
registry and never publish. A size is the packaged regular files' payload,
before compression, excluding tar headers, directories and links.

Authentication: Docker config auths, credHelpers, or credsStore.
GHCR, Google Artifact Registry, Docker Hub, ECR and OCI Distribution registries.
Supports standalone apps and Bun workspaces with production dependencies.
SBOM/provenance are opt-in. Private signing never uploads to transparency logs.
Logs go to stderr; successful publication prints one repo@digest line per target.
`;

/** Normalize explicit boolean values without rewriting option values or positionals. */
export function booleanArguments(argv: string[], options: Record<string, { type: "string" | "boolean"; short?: string }>): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { result.push(...argv.slice(i)); break; }
    const explicit = /^--(.*)=(true|false)$/.exec(arg);
    if (explicit) {
      const raw = explicit[1]!, negative = raw.startsWith("no-"), key = negative ? raw.slice(3) : raw;
      if (options[key]?.type === "boolean") {
        result.push(`--${(explicit[2] === "false") !== negative ? "no-" : ""}${key}`);
        continue;
      }
    }
    result.push(arg);
    const option = arg.startsWith("--") ? options[arg.slice(2)] : Object.values(options).find((option) => arg === `-${option.short}`);
    if (option?.type === "string" && i + 1 < argv.length) result.push(argv[++i]!);
  }
  return result;
}

export async function main(argv: string[]): Promise<number> {
  let jsonProgress = false;
  try {
    const options = {
      "image-label": { type: "string", multiple: true },
      "image-annotation": { type: "string", multiple: true },
      "image-user": { type: "string" },
      "image-refs": { type: "string" },
      filename: { type: "string", short: "f", multiple: true },
      context: { type: "string" },
      "asset-context": { type: "string", multiple: true },
      selector: { type: "string", short: "l" },
      recursive: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      push: { type: "boolean", default: true },
      repo: { type: "string" },
      "deps-strategy": { type: "string" },
      "shared-deps": { type: "boolean" },
      run: { type: "boolean" },
      "runtime-path": { type: "string" },
      "verify-key": { type: "string" },
      "private-signatures": { type: "boolean" },
      "deps-artifact": { type: "string", multiple: true },
      "kubectl-path": { type: "string" },
      "kube-context": { type: "string" },
      namespace: { type: "string" },
      "server-side": { type: "boolean" },
      "field-manager": { type: "string" },
      "kube-dry-run": { type: "string" },
      execute: { type: "boolean" },
      "older-than": { type: "string" },
      lockfile: { type: "string" },
      workdir: { type: "string" },
      "base-sbom": { type: "string", multiple: true },
      "metadata-dir": { type: "string" },
      "deps-verify-key": { type: "string" },
      "supply-chain-policy": { type: "string" },
      "deps-map": { type: "string" },
      "artifact-target": { type: "string" },
      "registry-mirror": { type: "string", multiple: true },
      "registry-config": { type: "string" },
      "tag-conflict": { type: "string" },
      progress: { type: "string" },
      format: { type: "string" },
      otel: { type: "boolean" },
      "app-cache": { type: "boolean", default: true },
      jobs: { type: "string" },
      mode: { type: "string" },
      "module-locations": { type: "string" },
      sbom: { type: "boolean" },
      provenance: { type: "boolean" },
      "sign-key": { type: "string" },
      "cosign-path": { type: "string" },
      target: { type: "string", multiple: true },
      bare: { type: "boolean" },
      tag: { type: "string", multiple: true },
      "runtime-arg": { type: "string", multiple: true },
      offline: { type: "boolean" },
      define: { type: "string", multiple: true },
      tarball: { type: "string" },
      local: { type: "boolean" },
      kind: { type: "boolean" },
      "kind-cluster": { type: "string" },
      cache: { type: "boolean", default: true },
      "local-cache": { type: "boolean", default: true },
      "registry-cache": { type: "boolean", default: true },
      "cache-dir": { type: "string" },
      "cache-repo": { type: "string" },
      "cache-from": { type: "string", multiple: true },
      "cache-write": { type: "boolean", default: true },
      "keep-bytes": { type: "string" },
      "install-cache": { type: "string" },
      "runtime-inject": { type: "string" }, "runtime-cache": { type: "string" },
      top: { type: "string" },
      json: { type: "boolean" },
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
    } as const;
    const parsed = parseArgs({
      args: booleanArguments(argv, options),
      allowPositionals: true, strict: true, allowNegative: true, tokens: true, options,
    });
    const { values, positionals } = parsed;
    const supplied = (name: string) => parsed.tokens.some((token) => token.kind === "option" && token.name.replace(/^no-/, "") === name);
    jsonProgress = values.progress === "json";
    if (values.help || !argv.length) { process.stdout.write(help); return 0; }
    const [command, path = ".", ...rest] = positionals;
    if (values.version || command === "version") { process.stdout.write(`${VERSION}\n`); return 0; }
    validateCommandOptions(command ?? "", parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name));
    if (values["tag-conflict"] !== undefined && !["fail", "skip"].includes(values["tag-conflict"])) throw new Error("Tag conflict policy must be fail or skip");
    const tagConflict = values["tag-conflict"] as "fail" | "skip" | undefined;
    if (values["module-locations"] !== undefined && !["warn", "error"].includes(values["module-locations"])) throw new Error("--module-locations must be warn or error");
    const tlsConfig = values["registry-config"] ? await registryTLS(values["registry-config"]) : undefined;
    const registry = { onMirrorFallback: (event: { mirror: string; reason: string }) => { process.stderr.write(`Registry mirror skipped (${event.reason}): ${event.mirror}\n`); }, mirrors: selectRegistryMirrors(values["registry-mirror"], process.env.BUNKO_REGISTRY_MIRRORS, tlsConfig?.mirrors), insecure: values["insecure-registry"], tls: tlsConfig?.hosts, sensitivePaths: tlsConfig?.files };
    if (command === "check-config" || command === "doctor") {
      if (rest.length) throw new Error("Use one project path and repeat --target to select workspace members");
      const format = diagnosticsFormat(values.format, Boolean(process.stdout.isTTY));
      const options = { path, runtimeArgs: values["runtime-arg"], define: parseDefines(values.define), assetContexts: parseAssetContexts(values["asset-context"]), targets: values.target, platform: values.platform, mode: values.mode, moduleLocations: values["module-locations"], depsStrategy: values["deps-strategy"], sharedDeps: values["shared-deps"], bunPath: values["bun-path"], cosignPath: values["cosign-path"] };
      process.stdout.write(diagnosticsOutput(await (command === "doctor" ? doctor(options) : checkConfig(options)), format)); return 0;
    }
    if (command === "why" || command === "closure-info") {
      const why = command === "why" ? positionals[1] : undefined;
      if (command === "why" && !why) throw new Error("why requires a package name");
      if (positionals.length > (command === "why" ? 3 : 2)) throw new Error("Use one project path and repeat --target to select workspace members");
      if (values.top !== undefined && !/^[1-9]\d*$/.test(values.top)) throw new Error("--top must be a positive integer");
      const projectPath = (command === "why" ? positionals[2] : positionals[1]) ?? ".";
      const found = await closureReport({ path: projectPath, targets: values.target, platform: values.platform, depsStrategy: values["deps-strategy"],
        sharedDeps: values["shared-deps"], bunPath: values["bun-path"], installCache: values["install-cache"], localCache: values.cache && values["local-cache"] });
      const report = why ? whyPackage(found, why) : found;
      process.stdout.write(values.json ? JSON.stringify(report) + "\n" : why ? formatWhy(report, why) : formatClosureInfo(report, Number(values.top ?? 20)));
      return 0;
    }
    if (command === "metadata") {
      if (positionals.length !== 2 || !values["metadata-dir"]) throw new Error("metadata requires an image@digest or layout:DIR and --metadata-dir");
      process.stdout.write(JSON.stringify(await exportMetadata(path, values["metadata-dir"], registry)) + "\n"); return 0;
    }
    if (command === "push-layout") {
      if (positionals.length !== 2 || !values.repo) throw new Error("push-layout requires a layout directory and an exact --repo");
      const result = await pushLayout(path, values.repo, values.tag, registry, values.report, tagConflict);
      process.stdout.write(`${result.reference}\n`); return 0;
    }
    if (command === "cache-info") {
      if (positionals.length !== 1) throw new Error("cache-info accepts no positional path");
      const result = await pruneLocal(values["cache-dir"] ?? process.env.BUNKO_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "v1"), false, 0, Number.MAX_SAFE_INTEGER);
      process.stdout.write(JSON.stringify({ managedBytes: result.managedBytes, scope: "validated key metadata and referenced blobs; unreferenced files are excluded" }) + "\n"); return 0;
    }
    if (command === "prune") {
      if (values["dry-run"] === false) throw new Error("prune requires --execute for deletion; --dry-run=false is unsupported");
      if (values["insecure-registry"] && !values["cache-repo"]) throw new Error("--insecure-registry requires remote prune with --cache-repo");
      if (positionals.length !== 1 || values.execute && values["dry-run"]) throw new Error("prune accepts no positional path; --execute and --dry-run cannot be combined");
      if (values["cache-repo"] && (values["cache-dir"] || values["older-than"] || values["keep-bytes"])) throw new Error("Remote prune cannot be combined with local cache/age options");
      if (values["older-than"] !== undefined && !/^\d+$/.test(values["older-than"])) throw new Error("--older-than must be non-negative integer seconds");
      if (values["keep-bytes"] !== undefined && (!/^\d+$/.test(values["keep-bytes"]) || values["older-than"] !== undefined)) throw new Error("--keep-bytes must be integer bytes and cannot be combined with --older-than");
      const result = values["cache-repo"] ? await pruneRegistry(values["cache-repo"], values.execute, registry)
        : await pruneLocal(values["cache-dir"] ?? process.env.BUNKO_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "v1"), values.execute, values["older-than"] === undefined ? undefined : Number(values["older-than"]), values["keep-bytes"] === undefined ? undefined : Number(values["keep-bytes"]));
      process.stdout.write(JSON.stringify(result) + "\n"); return 0;
    }
    if (values.execute || values["older-than"]) throw new Error("--execute/--older-than require prune");
    if (command === "pack-deps") {
      if (positionals.length !== 2 || !values.lockfile || !values["oci-layout"]) throw new Error("pack-deps requires a prepared directory, --lockfile and --oci-layout");
      const result = await packDependencies(path, values.lockfile, parsePlatform(values.platform ?? "linux/amd64"), values["oci-layout"], values.workdir, values["artifact-target"]);
      process.stdout.write(JSON.stringify(result) + "\n"); return 0;
    }
    if (values.lockfile || values.workdir) throw new Error("--lockfile/--workdir require pack-deps");
    if (command === "prepare-base") {
      if (positionals.length !== 1 || !values["oci-layout"]) throw new Error("prepare-base requires --oci-layout and a base input");
      process.stdout.write(JSON.stringify(await prepareBase({ base: values.base, baseLayout: values["base-layout"], output: values["oci-layout"], platform: values.platform, registry })) + "\n"); return 0;
    }
    if (command === "check-base") {
      if (positionals.length !== 1) throw new Error("Use --base or --base-layout for check-base");
      const result = await checkBase({ base: values.base, baseLayout: values["base-layout"], platform: values.platform, bunPath: values["bun-path"], run: values.run, runtimePath: values["runtime-path"], runtimeInject: values["runtime-inject"], runtimeCache: values["runtime-cache"], registry: registry });
      process.stdout.write(JSON.stringify(result) + "\n");
      return 0;
    }
    if (command === "verify") {
      if (positionals.length !== 2 || !values["verify-key"]) throw new Error("verify requires an image@digest and --verify-key");
      await verifyImage(path, values["verify-key"], values["private-signatures"] ?? false, values["cosign-path"], values["insecure-registry"]);
      process.stdout.write(`${path}\n`);
      return 0;
    }
    if (values.run || values["runtime-path"]) throw new Error("--run/--runtime-path require check-base");
    if (values["verify-key"] || values["private-signatures"]) throw new Error("--verify-key/--private-signatures require verify");
    if (!["build", "resolve", "apply"].includes(command!)) throw new Error(`Unknown command: ${command ?? "(missing)"}`);
    if (rest.length) throw new Error("Use one project path and repeat --target to select workspace members");
    if (values["kind-cluster"] && !values.kind) throw new Error("--kind-cluster requires --kind");
    if (command === "build" && (values.filename || values.context || values.recursive)) throw new Error("-f/--context/--recursive require resolve");
    if (["resolve", "apply"].includes(command!) && positionals.length > 1) throw new Error("Use -f for resolve inputs and --context for source paths");
    if (command !== "build" && values["deps-artifact"]) throw new Error("--deps-artifact currently requires build; resolve/apply need per-target artifact mapping");
    const jobsText = values.jobs ?? process.env.BUNKO_JOBS;
    if (jobsText !== undefined && !/^\d+$/.test(jobsText)) throw new Error("--jobs must be an integer from 1 to 32");
    const externalDeps: Record<string, string> = {};
    for (const value of values["deps-artifact"] ?? []) {
      const equal = value.indexOf("="), key = value.slice(0, equal), reference = value.slice(equal + 1);
      if (equal < 1 || !reference || !["linux/amd64", "linux/arm64"].includes(key) || externalDeps[key]) throw new Error("Use one --deps-artifact linux/ARCH=layout:DIR or linux/ARCH=REPO@sha256:DIGEST per platform");
      externalDeps[key] = reference;
    }
    const baseSBOMs: Record<string, string> = {};
    for (const value of values["base-sbom"] ?? []) {
      const equal = value.indexOf("="), key = value.slice(0, equal), reference = value.slice(equal + 1);
      if (equal < 1 || !["linux/amd64", "linux/arm64"].includes(key) || !(reference.startsWith("layout:") && reference.length > 7 || /@sha256:[a-f0-9]{64}$/.test(reference)) || baseSBOMs[key]) throw new Error("Use --base-sbom linux/ARCH=REPO@sha256:DIGEST or linux/ARCH=layout:DIR once per platform");
      baseSBOMs[key] = reference;
    }
    const keyValues = (items: string[] | undefined) => Object.fromEntries((items ?? []).map((item) => {
      const equal = item.indexOf("=");
      if (equal < 1) throw new Error("Image labels/annotations require KEY=VALUE");
      return [item.slice(0, equal), item.slice(equal + 1)];
    }));
    if (values.progress !== undefined && !["plain", "json"].includes(values.progress)) throw new Error("--progress must be plain or json");
    const buildOptions: BuildOptions = {
      offline: values.offline, runtimeArgs: values["runtime-arg"],
      baseSBOMs: Object.keys(baseSBOMs).length ? baseSBOMs : undefined, depsVerifyKey: values["deps-verify-key"], supplyChainPolicy: values["supply-chain-policy"] as "ci" | undefined,
      define: parseDefines(values.define), assetContexts: parseAssetContexts(values["asset-context"]),
      imageLabels: keyValues(values["image-label"]), imageAnnotations: keyValues(values["image-annotation"]), imageUser: values["image-user"], imageRefs: values["image-refs"],
      appCache: values.cache && values["app-cache"],
      jobs: jobsText === undefined ? undefined : Number(jobsText),
      externalDepsByTarget: values["deps-map"] ? await dependencyMap(values["deps-map"]) : undefined,
      externalDeps: Object.keys(externalDeps).length ? externalDeps : undefined,
      mode: values.mode, moduleLocations: values["module-locations"], sbom: values.sbom, provenance: values.provenance, signKey: values["sign-key"], cosignPath: values["cosign-path"],
      targets: values.target, depsStrategy: values["deps-strategy"], sharedDeps: values["shared-deps"],
      push: values.offline && !supplied("push") ? false : values.push, repo: values.repo, bare: values.bare, tags: values.tag, tagConflict,
      tarball: values.tarball, local: values.local,
      kind: values.kind ? values["kind-cluster"] ?? process.env.KIND_CLUSTER_NAME ?? "kind" : undefined,
      cacheDir: values["cache-dir"], cacheRepo: values["cache-repo"], cacheFrom: values["cache-from"], cacheWrite: values["cache-write"],
      localCache: values.cache && values["local-cache"], registryCache: values.cache && (values.offline && !supplied("registry-cache") ? false : values["registry-cache"]),
      installCache: values["install-cache"], runtimeInject: values["runtime-inject"], runtimeCache: values["runtime-cache"], registry: registry, dryRun: values["dry-run"],
      path, output: values["oci-layout"], base: values.base,
      baseLayout: values["base-layout"], platform: values.platform,
      bunPath: values["bun-path"], report: values.report,
      reproducible: values.reproducible, verifyDeterministic: values["verify-deterministic"],
      gitMetadata: values["git-metadata"], noIndex: !values.index,
      progress: values.progress === "json" ? (event) => { process.stderr.write(JSON.stringify(event) + "\n"); } : undefined,
      log: (message) => process.stderr.write(values.progress === "json" ? JSON.stringify({ schemaVersion: 1, type: "log", message }) + "\n" : message),
    };
    const telemetry = telemetryConfig(values.otel);
    if (values.offline && telemetry) throw new Error("Offline builds cannot export telemetry");
    const execute = async () => {
    if (command === "apply") {
      const result = await applyDocuments({ ...buildOptions, files: values.filename ?? [], context: values.context, recursive: values.recursive, selector: values.selector,
        kubectlPath: values["kubectl-path"], kubeContext: values["kube-context"], namespace: values.namespace, serverSide: values["server-side"],
        fieldManager: values["field-manager"], kubeDryRun: values["kube-dry-run"] as "none" | "client" | "server" | undefined });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); return result.exit;
    }
    if (values["kubectl-path"] || values["kube-context"] || values.namespace || values["server-side"] || values["field-manager"] || values["kube-dry-run"]) throw new Error("Kubernetes options require apply");
    if (command === "resolve") {
      const result = await resolveDocuments({ ...buildOptions, files: values.filename ?? [], context: values.context, recursive: values.recursive, selector: values.selector });
      process.stdout.write(result.output);
      return 0;
    }
    const results = await buildTargets(buildOptions);
    for (const result of results) if (!result.dryRun) {
      if (result.publication?.published) process.stdout.write(`${result.publication.reference}\n`);
      else if (result.localReference) process.stdout.write(`${result.localReference}\n`);
    }
    return 0;
    };
    return telemetry ? await new Telemetry(telemetry, () => buildOptions.log?.("OpenTelemetry export incomplete; build result is unchanged\n")).run(command!, execute, (code) => code !== 0) : await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(jsonProgress ? JSON.stringify({ schemaVersion: 1, type: "error", message }) + "\n" : `bunko: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
