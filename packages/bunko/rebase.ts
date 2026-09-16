import { RebaseDecisionError } from "./rebase-decision.ts";
import { smokeRebase, smokeArguments } from "./rebase-smoke.ts";
import { mkdtemp } from "../runtime/invocation.ts";
import { lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { assertDigest, canonicalJSON, object, sha256 } from "../oci/digest.ts";
import { assertOutputAvailable, canonicalOutput, exportLayout } from "../oci/layout.ts";
import { inspectRebase, rebaseImage } from "../oci/rebase.ts";
import { RegistrySource } from "../oci/source.ts";
import { accumulate, PublicationError, Publisher, repositoryName, type Publication, type TagConflict } from "../oci/publish.ts";
import { artifact, publishArtifacts, type Artifact } from "../oci/artifacts.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { media, type Descriptor, type Digest, type ImageConfig } from "../oci/types.ts";
import { assertReportNotInput, assertReportWritable, writeFailureReport, writeReport } from "./build.ts";
import { platform as parsePlatform } from "./config.ts";
import { assertCosign } from "./cosign.ts";
import { sbomType, provenanceType, signImages } from "./attest.ts";
import { builderIdentity } from "./identity.ts";
import { baseInventory, exportMetadata } from "./metadata.ts";
import { rebaseInput } from "./rebase-input.ts";
import { checkRebaseSafety } from "./rebase-safety.ts";
import { rebaseProvenance, rebaseSpdx } from "./rebase-attest.ts";

export interface RebaseOptions {
  image: string; oldBase: string; base: string;
  platform?: string; output?: string; repo?: string; push?: boolean; tags?: string[];
  dryRun?: boolean; report?: string; policy?: string; registry?: RegistryOptions;
  tagConflict?: TagConflict; sbom?: boolean; baseSBOMs?: Record<string, string>; provenance?: boolean;
  signKey?: string; cosignPath?: string; smokeCommand?: string[];
}
export interface RebasePolicy {
  schemaVersion: 1 | 2;
  reviewed?: boolean;
  transitions: { platform: string; oldBase: Digest; newBase: Digest; libc: "glibc" | "musl" }[];
}

export async function readRebasePolicy(path: string): Promise<{ value: RebasePolicy; digest: Digest }> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error("Rebase policy must be a regular file of at most 64 KiB");
  const bytes = await readFile(path);
  if (bytes.length > 64 * 1024) throw new Error("Rebase policy exceeds 64 KiB");
  const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "Rebase policy");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 || value.schemaVersion === 2 && value.reviewed !== true || Object.keys(value).some((key) => !["schemaVersion", "transitions", ...(value.schemaVersion === 2 ? ["reviewed"] : [])].includes(key)) || !Array.isArray(value.transitions) || !value.transitions.length || value.transitions.length > 64) throw new Error("Invalid rebase compatibility policy");
  const seen = new Set<string>();
  for (const raw of value.transitions) {
    const item = object(raw, "Rebase transition");
    if (Object.keys(item).sort().join(",") !== "libc,newBase,oldBase,platform" || !["linux/amd64", "linux/arm64"].includes(String(item.platform)) || !["glibc", "musl"].includes(String(item.libc))) throw new Error("Invalid rebase compatibility transition");
    assertDigest(item.oldBase); assertDigest(item.newBase);
    const key = `${item.platform}:${item.oldBase}:${item.newBase}`;
    if (seen.has(key)) throw new Error("Duplicate rebase compatibility transition");
    seen.add(key);
  }
  return { value: value as unknown as RebasePolicy, digest: sha256(bytes) };
}

/** Changes to loader controls, users, mounts or signals require a full rebuild. */
function safeRuntimeConfig(original: ImageConfig, replacement: ImageConfig): void {
  const env = (config: ImageConfig) => Object.fromEntries((config.config?.Env ?? []).map((entry) => { const i = entry.indexOf("="); return [entry.slice(0, i), entry.slice(i + 1)]; }).filter(([key]) => /^(?:PATH$|GLIBC_TUNABLES$|LD_|DYLD_|BUN_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|SSL_CERT_(?:FILE|DIR)$)/.test(key!)));
  if (Buffer.compare(Buffer.from(canonicalJSON(env(original))), Buffer.from(canonicalJSON(env(replacement))))) throw new RebaseDecisionError("requires-rebuild", "runtime-environment", "Rebase changes runtime loader or trust environment; rebuild instead");
  for (const key of ["User", "Volumes", "StopSignal"] as const) if (Buffer.compare(canonicalJSON(original.config?.[key] ?? null), canonicalJSON(replacement.config?.[key] ?? null)) !== 0) throw new RebaseDecisionError("requires-rebuild", "runtime-config", `Rebase changes runtime ${key}; rebuild instead`);
}

/** Plan every selected platform before exports, registry writes or signing. */
export async function rebase(options: RebaseOptions) {
  if (!options.image || !options.oldBase || !options.base) throw new Error("rebase requires an image, --old-base and a replacement --base or --base-layout");
  if (options.tagConflict !== undefined && !["fail", "skip"].includes(options.tagConflict)) throw new Error("Tag conflict policy must be fail or skip");
  if (options.smokeCommand) smokeArguments(options.smokeCommand);
  const push = options.push ?? Boolean(options.repo);
  if (push && !options.repo) throw new Error("Rebase publication requires an exact --repo");
  if (!push && !options.output && !options.dryRun) throw new Error("Rebase requires --oci-layout, --repo or --dry-run");
  if (options.signKey && !push) throw new Error("Rebase signing requires registry publication");
  if (options.cosignPath && !options.signKey) throw new Error("--cosign-path requires --sign-key for rebase");
  if (options.tags?.length && !push) throw new Error("Rebase tags require registry publication");
  if (Object.keys(options.baseSBOMs ?? {}).length && !options.sbom) throw new Error("Rebase --base-sbom requires --sbom");
  const registry = options.registry ?? {};
  const output = options.output ? await canonicalOutput(options.output) : undefined;
  const report = options.report ? await canonicalOutput(options.report) : undefined;
  const inputs = [options.image, options.oldBase, options.base, ...Object.values(options.baseSBOMs ?? {})].filter((input) => input.startsWith("layout:")).map((input) => input.slice(7));
  if (options.policy) inputs.push(options.policy);
  if (options.signKey && !options.signKey.includes("://")) inputs.push(options.signKey);
  inputs.push(...registry.sensitivePaths ?? []);
  await assertReportNotInput(report, inputs);
  if (output) {
    await assertOutputAvailable(output);
    await assertReportNotInput(output, inputs);
    await assertReportNotInput(report, [output]);
  }
  if (report) await assertReportWritable(report);
  const publisher = push ? new Publisher(options.repo!, registry) : undefined;
  const tags = options.tags ?? [];
  if (tags.some((tag) => !/^[\w][\w.-]{0,127}$/.test(tag))) throw new Error("Invalid rebase output tag");
  const directory = await mkdtemp(join(tmpdir(), "bunko-rebase-")), store = new BlobStore(directory);
  const written = new Set<string>(); let publication: Publication | undefined;
  let signed = false;
  let smoke: "not-requested" | "pending" | "passed" | "failed" = options.smokeCommand ? "pending" : "not-requested";
  try {
    const policy = options.policy ? await readRebasePolicy(options.policy) : undefined;
    const input = await rebaseInput(options.image, registry, store);
    const oldInput = await rebaseInput(options.oldBase, registry, store);
    const newInput = await rebaseInput(options.base, registry, store);
    const available = await input.platforms();
    const selected = options.platform === undefined ? available : options.platform.split(",").map((value) => parsePlatform(value.trim()));
    if (!selected.length || new Set(selected.map((p) => p.architecture)).size !== selected.length) throw new Error("Rebase platforms must be nonempty and unique");
    for (const p of selected) if (!available.some((item) => item.architecture === p.architecture)) throw new Error(`Source image lacks ${p.os}/${p.architecture}`);
    for (const key of Object.keys(options.baseSBOMs ?? {})) if (!selected.some((p) => `${p.os}/${p.architecture}` === key)) throw new Error("Base SBOM supplied for an unselected platform");
    const inventory = options.sbom ? await exportMetadata(options.image, join(directory, "original-metadata"), registry) : undefined;
    const inventoryDigests: Digest[] = [];
    const results = [], attachments: Artifact[] = [], descriptors: Descriptor[] = [];
    for (const platform of selected) {
      const image = await input.image(platform), oldBase = await oldInput.image(platform), newBase = await newInput.image(platform);
      if (!image.config.config?.Labels?.["org.bunko.rebase.metadata"]) throw new RebaseDecisionError("requires-rebuild", "metadata-missing", "Image has no rebase ownership metadata capsule; rebuild instead");
      const { options: owned, context, layers } = inspectRebase(image, oldBase);
      const transformed = await rebaseImage(store, image, oldBase, newBase);
      const config = JSON.parse(Buffer.from(await store.read(transformed.config)).toString()) as ImageConfig;
      safeRuntimeConfig(image.config, config);
      const compatibility = await checkRebaseSafety(store, image, oldBase, newBase, owned, context, directory, policy?.value);
      // The core cannot infer registry names from content-addressed BaseImage values.
      const manifest = object(JSON.parse(Buffer.from(await store.read(transformed.manifest)).toString()), "Rebased manifest");
      const annotations = { ...object(manifest.annotations ?? {}, "Rebased annotations"), ...(newInput.origin instanceof RegistrySource ? { "org.opencontainers.image.base.name": `${repositoryName(newInput.origin.ref)}@${newBase.descriptor.digest}` } : {}) };
      const outputManifest = await store.put(canonicalJSON({ ...manifest, annotations }), media.manifest);
      if (inventory) {
        const matches = inventory.records.filter((record) => record.subject.digest === image.descriptor.digest && record.payload.mediaType === sbomType);
        if (matches.length !== 1) throw new Error("Rebase --sbom requires exactly one supported original SPDX inventory per platform");
        const record = matches[0]!;
        const document = JSON.parse(await readFile(join(inventory.directory, record.file), "utf8"));
        const baseRef = options.baseSBOMs?.[`${platform.os}/${platform.architecture}`];
        const baseDocument = baseRef ? await baseInventory(baseRef, [newBase.descriptor.digest], registry) : undefined;
        inventoryDigests.push(record.payload.digest, ...(baseDocument ? [baseDocument.payload.digest] : []));
        attachments.push(await artifact(store, outputManifest, sbomType, rebaseSpdx(document, image.descriptor, outputManifest, platform, owned.epoch, baseDocument ? { namespace: String(baseDocument.document.documentNamespace), digest: baseDocument.payload.digest, described: baseDocument.described } : undefined, { kind: context.runtimeKind ?? "bun", version: image.config.config?.Labels?.["org.bunko.node.version"] })));
      }
      descriptors.push(outputManifest, transformed.config, ...newBase.manifest.layers, ...layers.map((layer) => layer.descriptor));
      results.push({ platform, original: image.descriptor, manifest: outputManifest, config: transformed.config, oldBase: oldBase.descriptor.digest, newBase: newBase.descriptor.digest, preservedLayers: layers.map((layer) => layer.descriptor.digest), policy: compatibility.policy, compatibility });
    }
    const oldRoot = await input.json(input.subject);
    const annotations: Record<string, unknown> = { ...object(oldRoot.annotations ?? {}, "Source annotations"), "org.opencontainers.image.base.digest": newInput.root.digest };
    delete annotations["org.opencontainers.image.base.name"];
    if (newInput.origin instanceof RegistrySource) annotations["org.opencontainers.image.base.name"] = `${repositoryName(newInput.origin.ref)}@${newInput.root.digest}`;
    const root = [media.manifest, media.dockerManifest].includes(input.subject.mediaType as typeof media.manifest) && results.length === 1
      ? results[0]!.manifest : await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, annotations, manifests: results.map((result) => ({ ...result.manifest, platform: result.platform })) }), media.index);
    if (options.provenance) {
      const builder = await builderIdentity(); assertDigest(builder.digest);
      attachments.push(await artifact(store, root, provenanceType, rebaseProvenance({ source: input.subject, root, platforms: results, builder: { ...builder, digest: builder.digest }, policyDigest: policy?.digest, inventoryDigests })));
    }
    descriptors.push(...attachments.flatMap((item) => [item.manifest, ...item.blobs]));
    if (options.signKey && !options.dryRun) await assertCosign(options.cosignPath);
    if (publisher) {
      publication = await publisher.publish(store, root, options.smokeCommand ? [] : tags, new Map(results.flatMap((result) => result.preservedLayers.map((digest) => [digest, "preserved"] as const))), options.dryRun, options.tagConflict);
      if (options.smokeCommand) publication.pendingTags = [...tags];
      if (!options.dryRun) {
        await publishArtifacts(publisher, store, attachments, (part, elapsed) => accumulate(publication!, part, elapsed));
        if (options.signKey && !options.smokeCommand) {
          await signImages([root, ...results.map((result) => result.manifest), ...attachments.map((item) => item.manifest)].map((d) => `${repositoryName(publisher.ref)}@${d.digest}`), options.signKey, options.cosignPath, registry.insecure);
          signed = true;
        }
      }
    }
    if (options.smokeCommand && !options.dryRun) {
      if (publication) publication.pendingTags = [...tags];
      try { await smokeRebase(store, results, options.smokeCommand, directory); smoke = "passed"; }
      catch (error) { smoke = "failed"; throw error; }
      if (publisher && options.signKey) {
        await signImages([root, ...results.map((result) => result.manifest), ...attachments.map((item) => item.manifest)].map((d) => `${repositoryName(publisher.ref)}@${d.digest}`), options.signKey, options.cosignPath, registry.insecure);
        signed = true;
      }
      if (publisher && tags.length) {
        try {
          const promoted = await publisher.publish(store, root, tags, undefined, false, options.tagConflict);
          accumulate(promoted, publication!); publication = promoted;
        } catch (error) {
          if (error instanceof PublicationError) { accumulate(error.result, publication!); publication = error.result; }
          throw error;
        }
      }
    }
    if (output && !options.dryRun) await exportLayout(store, output, root, descriptors, `${options.repo ?? "bunko.local/rebased"}@${root.digest}`);
    const result = { schemaVersion: 1, command: "rebase", status: "success", decision: "compatible" as const, smoke, dryRun: Boolean(options.dryRun), source: input.subject, root, platforms: results, policyDigest: policy?.digest, layout: options.dryRun ? undefined : output, publication, attestations: attachments.map(({ subject, manifest }) => ({ subject, manifest })), signed };
    if (report) await writeReport(report, result, written);
    return result;
  } catch (error) {
    if (!publication && error instanceof PublicationError) publication = error.result;
    if (report && !written.has(report)) await writeFailureReport(report, { schemaVersion: 1, command: "rebase", status: "failed", decision: error instanceof RebaseDecisionError ? error.decision : "error", reason: error instanceof RebaseDecisionError ? error.reason : undefined, changes: error instanceof RebaseDecisionError ? error.changes : undefined, requires: error instanceof RebaseDecisionError ? error.decision === "requires-policy" ? "compatibility-policy" : "rebuild" : undefined, smoke, publication, signed, error: error instanceof Error ? error.message : "Rebase failed" }, error);
    if (publication?.published) throw new PublicationError(`Rebase incomplete after image publication at ${publication.reference}: ${error instanceof Error ? error.message : "output failure"}`, publication, error);
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
