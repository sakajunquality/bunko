import { assertFormatVersion, UnsupportedFormatError } from "../compatibility/formats.ts";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "../runtime/invocation.ts";
import { BlobStore } from "../oci/blob-store.ts";
import { assertDigest, canonicalJSON, object } from "../oci/digest.ts";
import { RegistrySource } from "../oci/source.ts";
import { repositoryName } from "../oci/publish.ts";
import { RegistryError, type RegistryOptions } from "../oci/registry.ts";
import { rebaseInput } from "./rebase-input.ts";
import { rebase } from "./rebase.ts";
import { RebaseDecisionError } from "./rebase-decision.ts";
import { rebaseBaseDiff } from "./rebase-safety.ts";
import { platform } from "./config.ts";
import { libcLoader } from "./libc.ts";

function inspectionFailure(error: unknown) { return { reason: error instanceof RegistryError && [401, 403].includes(error.status) ? "registry-authentication" : "inspection-failed", ...(error instanceof RegistryError ? { registryStatus: error.status } : {}) }; }

export interface RebaseTarget { image: string; oldBase?: string; base?: string; platforms?: string; policy?: string; tags?: string[]; smoke?: string[] }
async function readJSON(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error("Rebase operation input must be a regular JSON file of at most 64 KiB");
  const data = await readFile(path);
  if (data.length > 64 * 1024) throw new Error("Rebase operation input exceeds 64 KiB");
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)), "Rebase operation input");
}
export async function rebaseTargets(path: string): Promise<RebaseTarget[]> {
  const value = await readJSON(path);
  if (value.schemaVersion !== 1 || Object.keys(value).some((key) => !["schemaVersion", "targets"].includes(key)) || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 128) throw new Error("Expected rebase targets schemaVersion 1 with 1..128 targets");
  for (const raw of value.targets) {
    const target = object(raw, "Rebase target");
    if (typeof target.image !== "string" || !target.image || Object.keys(target).some((key) => !["image", "oldBase", "base", "platforms", "policy", "tags", "smoke"].includes(key))) throw new Error("Invalid rebase target");
    for (const key of ["oldBase", "base", "platforms", "policy"]) if (target[key] !== undefined && (typeof target[key] !== "string" || !target[key])) throw new Error("Invalid rebase target field");
    for (const key of ["tags", "smoke"]) if (target[key] !== undefined && (!Array.isArray(target[key]) || target[key].length > 64 || !target[key].every((item) => typeof item === "string"))) throw new Error("Invalid rebase target array");
  }
  return value.targets as RebaseTarget[];
}
async function pinned(reference: string, registry: RegistryOptions): Promise<string> {
  if (reference.startsWith("layout:")) return reference;
  const source = new RegistrySource(reference, registry), root = await source.root();
  return `${repositoryName(source.ref)}@${root.descriptor.digest}`;
}
/** Read-only discovery. A digest annotation never supplies an original mutable tag. */
export async function baseStatus(targets: RebaseTarget[], registry: RegistryOptions = {}) {
  if (!targets.length || targets.length > 128) throw new Error("base-status requires 1..128 targets");
  const directory = await mkdtemp(join(tmpdir(), "bunko-base-status-"));
  const results: Record<string, unknown>[] = [];
  try {
    for (const target of targets) {
      try {
        const reference = await pinned(target.image, registry), store = new BlobStore(join(directory, String(results.length)));
        const loaded = new Map<string, ReturnType<typeof rebaseInput>>();
        const load = (ref: string) => {
          let pending = loaded.get(ref);
          if (!pending) { pending = rebaseInput(ref, registry, store); loaded.set(ref, pending); }
          return pending;
        };
        const input = await load(reference), root = await input.json(input.subject);
        const selected = target.platforms ? target.platforms.split(",").map((item) => platform(item.trim())) : await input.platforms();
        if (!selected.length || new Set(selected.map((p) => p.architecture)).size !== selected.length) throw new Error("Invalid base-status platforms");
        const replacement = target.base ? await pinned(target.base, registry) : undefined;
        const fresh = replacement ? await load(replacement) : undefined;
        for (const p of selected) {
          const common = { image: reference, source: input.subject.digest, platform: `${p.os}/${p.architecture}` };
          try {
          const image = await input.image(p);
          if (!image.config.config?.Labels?.["org.bunko.rebase.metadata"]) { results.push({ ...common, status: "not-rebaseable", reason: "metadata-missing" }); continue; }
          const capsuleText = image.config.config.Labels["org.bunko.rebase.metadata"]!;
          if (Buffer.byteLength(capsuleText) > 64 * 1024) throw new Error("Oversized rebase metadata");
          const capsule = object(JSON.parse(capsuleText), "Rebase metadata");
          assertFormatVersion("rebase-capsule", capsule.version);
          const metadata = await input.json(image.descriptor);
          const annotations = object(metadata.annotations ?? {}, "Image annotations") as Record<string, string>;
          const current = annotations["org.opencontainers.image.base.digest"];
          let oldBase = target.oldBase;
          if (!oldBase) {
            const name = (root.annotations as Record<string, string> | undefined)?.["org.opencontainers.image.base.name"] ?? annotations["org.opencontainers.image.base.name"];
            if (name) {
              const identity = object(capsule.base, "Rebase base");
              const digest = identity.indexDigest ?? identity.manifestDigest; assertDigest(digest);
              const recorded = new RegistrySource(name, registry).ref;
              const configured = target.base && !target.base.startsWith("layout:") ? new RegistrySource(target.base, registry).ref : undefined;
              if (configured?.registry === recorded.registry && configured.repository === recorded.repository) oldBase = `${repositoryName(recorded)}@${digest}`;
            }
          }
          if (!fresh) { results.push({ ...common, status: "unknown", reason: "base-tag-required", currentBase: current }); continue; }
          const candidate = await fresh.image(p);
          if (candidate.descriptor.digest === current) { results.push({ ...common, status: "current", currentBase: current, candidateBase: current }); continue; }
          if (!oldBase) { results.push({ ...common, status: "unknown", reason: "explicit-old-base-required", currentBase: current }); continue; }
          try {
            const result = await rebase({ image: reference, oldBase, base: replacement!, platform: `${p.os}/${p.architecture}`, policy: target.policy, dryRun: true, registry }, { store, load });
            results.push({ ...common, status: "outdated", decision: result.decision, currentBase: current, candidateBase: candidate.descriptor.digest, oldBase, base: replacement });
          } catch (error) {
            if (!(error instanceof RebaseDecisionError)) throw error;
            results.push({ ...common, status: error.decision === "requires-policy" ? "outdated" : "not-rebaseable", decision: error.decision, reason: error.reason, currentBase: current, candidateBase: candidate.descriptor.digest, oldBase, base: replacement });
          }
          } catch (error) {
            results.push(error instanceof UnsupportedFormatError
              ? { ...common, status: "not-rebaseable", reason: "unsupported-format", format: error.format, formatVersion: error.version, supportedVersions: error.supportedVersions }
              : { ...common, status: "unknown", ...inspectionFailure(error) });
          }
        }
      } catch (error) { results.push({ image: target.image, status: "unknown", ...inspectionFailure(error) }); }
    }
    return { schemaVersion: 1, command: "base-status", results };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Writes an unapproved v2 template exclusively; it does not certify ABI compatibility. */
export async function rebasePolicyTemplate(options: { oldBase: string; base: string; platform?: string; libc?: "glibc" | "musl"; out: string; registry?: RegistryOptions }) {
  const directory = await mkdtemp(join(tmpdir(), "bunko-rebase-policy-"));
  try {
    const store = new BlobStore(directory), registry = options.registry ?? {};
    const old = await rebaseInput(options.oldBase, registry, store), fresh = await rebaseInput(options.base, registry, store);
    const platforms = (options.platform ?? "linux/amd64").split(",").map((p) => platform(p.trim()));
    if (new Set(platforms.map((p) => p.architecture)).size !== platforms.length) throw new Error("Duplicate rebase policy platforms");
    const transitions = [], review = [];
    for (const p of platforms) {
      const a = await old.image(p), b = await fresh.image(p), libc = options.libc ?? "glibc";
      const difference = await rebaseBaseDiff(store, a, b, directory);
      transitions.push({ platform: `${p.os}/${p.architecture}`, oldBase: a.descriptor.digest, newBase: b.descriptor.digest, libc });
      review.push({ platform: `${p.os}/${p.architecture}`, loader: libcLoader(libc, p), ...difference });
    }
    const value = { schemaVersion: 2, reviewed: false, transitions };
    await writeFile(options.out, canonicalJSON(value), { flag: "wx", mode: 0o600 });
    return { schemaVersion: 1, policy: value, review };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
