import { validateImageConfig } from "./source.ts";
import { assembleImage, imageConfig, type ImageOptions } from "./image.ts";
import { canonicalJSON, assertDigest } from "./digest.ts";
import { rebaseMetadata, rebaseMetadataLabel, type RebaseBuildContext } from "./rebase-metadata.ts";
import type { BlobStore } from "./blob-store.ts";
import { media, type BaseImage, type Descriptor, type ImageConfig, type Layer, type RuntimeConfig } from "./types.ts";

const baseAnnotation = "org.opencontainers.image.base.digest";
const baseNameAnnotation = "org.opencontainers.image.base.name";
const baseLabel = "org.bunko.base.digest";
const baseIndexLabel = "org.bunko.base.index.digest";

function fail(message: string): never { throw new Error(`Invalid rebase metadata: ${message}`); }
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[], name: string) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) fail(`unknown ${name} field ${key}`);
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}
function stringMap(value: unknown, name: string): Record<string, string> {
  const out = record(value, name);
  for (const [key, item] of Object.entries(out)) { if (!key || typeof item !== "string") fail(`${name} must contain string values`); }
  return out as Record<string, string>;
}
function same(a: unknown, b: unknown): boolean { return Buffer.from(canonicalJSON(a)).equals(Buffer.from(canonicalJSON(b))); }
function digest(value: unknown, name: string) { try { assertDigest(value); } catch { fail(`${name} must be a sha256 digest`); } return value; }

function parseContext(value: unknown): RebaseBuildContext {
  const c = record(value, "context"); exactKeys(c, ["mode", "libc", "buildToolchain", "runtime"], "context");
  if (!["bundle", "source", "compile"].includes(c.mode as string) || !["glibc", "musl"].includes(c.libc as string)) fail("unsupported context policy");
  const tool = record(c.buildToolchain, "buildToolchain"); exactKeys(tool, ["version", "revision"], "buildToolchain");
  const runtime = record(c.runtime, "runtime"); exactKeys(runtime, ["origin", "kind"], "runtime");
  if (runtime.kind !== undefined && runtime.kind !== "node") fail("unsupported runtime kind");
  if (runtime.kind === "node" && (runtime.origin !== "base" || c.mode === "compile")) fail("Node runtime requires base origin and bundle/source mode");
  if (!["base", "injected", "compiled"].includes(runtime.origin as string)) fail("unsupported runtime policy");
  return { ...(runtime.kind === "node" ? { runtimeKind: "node" as const } : {}), mode: c.mode as RebaseBuildContext["mode"], libc: c.libc as RebaseBuildContext["libc"], bunVersion: string(tool.version, "toolchain.version"), bunRevision: string(tool.revision, "toolchain.revision"), runtimeOrigin: runtime.origin as RebaseBuildContext["runtimeOrigin"] };
}

function parsePorts(value: unknown, explicit: boolean): number[] | undefined {
  if (!explicit) return undefined;
  const ports = record(value, "ExposedPorts"); const out: number[] = [];
  for (const key of Object.keys(ports)) {
    const match = /^(\d+)\/tcp$/.exec(key); const port = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !same(ports[key], {})) fail("ports must be valid tcp ports");
    out.push(port);
  }
  return out.sort((a, b) => a - b);
}

function validateConfig(config: ImageConfig) {
  const top = config as unknown as Record<string, unknown>;
  exactKeys(top, ["architecture", "os", "variant", "created", "author", "config", "rootfs", "history"], "config");
  if (typeof config.architecture !== "string" || config.os !== "linux") fail("invalid platform");
  const runtime = record(config.config ?? {}, "runtime config");
  exactKeys(runtime, ["User", "Env", "Entrypoint", "Cmd", "WorkingDir", "ExposedPorts", "Labels", "Volumes", "StopSignal"], "runtime config");
  if (runtime.User !== undefined) string(runtime.User, "User");
  for (const field of ["Entrypoint", "Cmd"] as const) if (!Array.isArray(runtime[field]) || runtime[field].some((v: unknown) => typeof v !== "string")) fail(`${field} must be a string array`);
  if (typeof runtime.WorkingDir !== "string") fail("WorkingDir must be a string");
  if (runtime.Env !== undefined && (!Array.isArray(runtime.Env) || runtime.Env.some((v: unknown) => typeof v !== "string"))) fail("invalid Env");
  if (runtime.Labels !== undefined) stringMap(runtime.Labels, "Labels");
  for (const field of ["ExposedPorts", "Volumes"] as const) if (runtime[field] !== undefined) {
    const values = record(runtime[field], field);
    for (const value of Object.values(values)) if (record(value, field) && Object.keys(value as Record<string, unknown>).length) fail(`${field} values must be empty objects`);
  }
  if (runtime.StopSignal !== undefined) string(runtime.StopSignal, "StopSignal");
  const rootfs = record(config.rootfs, "rootfs"); exactKeys(rootfs, ["type", "diff_ids"], "rootfs");
  if (rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids)) fail("invalid rootfs");
  for (const d of rootfs.diff_ids) digest(d, "diff_id");
  if (config.history !== undefined) {
    if (!Array.isArray(config.history)) fail("history must be an array");
    for (const item of config.history) {
      const history = record(item, "history"); exactKeys(history, ["created", "author", "created_by", "empty_layer", "comment"], "history");
      for (const field of ["created", "author", "created_by", "comment"] as const) if (history[field] !== undefined) string(history[field], `history.${field}`);
      if (history.empty_layer !== undefined && typeof history.empty_layer !== "boolean") fail("history.empty_layer must be boolean");
    }
  }
}

export function inspectRebase(image: BaseImage, oldBase: BaseImage): { options: ImageOptions; context: RebaseBuildContext; layers: Layer[] } {
  const requested = { os: image.config.os, architecture: image.config.architecture, ...(image.config.variant ? { variant: image.config.variant } : {}) } as ImageOptions["platform"];
  validateImageConfig(image.config, requested, image.manifest.layers.length);
  validateImageConfig(oldBase.config, requested, oldBase.manifest.layers.length);
  const labels = image.config.config?.Labels ?? {};
  const capsule = labels[rebaseMetadataLabel]; if (typeof capsule !== "string") fail("capsule is missing");
  if (Buffer.byteLength(capsule, "utf8") > 64 * 1024) fail("capsule exceeds 64 KiB UTF-8 limit");
  let meta: any; try { meta = JSON.parse(capsule); } catch { fail("capsule is not JSON"); }
  const root = record(meta, "capsule"); exactKeys(root, ["version", "base", "generatedLayers", "platform", "context", "ownership", "topLevel"], "capsule");
  if (root.version !== 1) fail("unsupported capsule version");
  const bi = record(root.base, "base"); exactKeys(bi, ["manifestDigest", "configDigest", "indexDigest", "layerCount"], "base");
  if (!same({ manifestDigest: oldBase.descriptor.digest, configDigest: oldBase.manifest.config.digest, ...(oldBase.indexDigest ? { indexDigest: oldBase.indexDigest } : {}), layerCount: oldBase.manifest.layers.length }, bi)) fail("old base identity mismatch");
  if (image.manifest.layers.length < oldBase.manifest.layers.length) fail("layer prefix is missing");
  for (let i = 0; i < oldBase.manifest.layers.length; i++) if (!same(image.manifest.layers[i], oldBase.manifest.layers[i])) fail("layer prefix mismatch");
  validateConfig(image.config);
  if (!same(image.config.rootfs.diff_ids.slice(0, oldBase.config.rootfs.diff_ids.length), oldBase.config.rootfs.diff_ids)) fail("diff_id prefix mismatch");
  const generated = image.manifest.layers.slice(oldBase.manifest.layers.length);
  const roles = root.generatedLayers; if (!Array.isArray(roles) || roles.length !== generated.length) fail("generated layer count mismatch");
  const layers: Layer[] = generated.map((descriptor: Descriptor, i: number) => {
    const item = record(roles[i], "generated layer"); exactKeys(item, ["role"], "generated layer");
    if (!["app", "assets", "deps", "runtime"].includes(item.role as string)) fail("unknown generated layer role");
    const diffId = image.config.rootfs.diff_ids[oldBase.config.rootfs.diff_ids.length + i]; if (!diffId) fail("generated diff_id missing");
    return { kind: item.role as Layer["kind"], descriptor, diffId };
  });
  const platform = record(root.platform, "platform"); exactKeys(platform, ["os", "architecture", "variant"], "platform");
  if (platform.os !== image.config.os || platform.architecture !== image.config.architecture || (platform.architecture === "arm64" ? (platform.variant ?? "v8") : platform.variant) !== (image.config.variant ?? (image.config.architecture === "arm64" ? "v8" : undefined))) fail("platform mismatch");
  const context = parseContext(root.context);
  const ownership = record(root.ownership, "ownership"); exactKeys(ownership, ["env", "labels", "user", "ports", "entrypoint", "cmd", "workdir", "volumes", "stopSignal", "platform"], "ownership");
  const envOwn = record(ownership.env, "env ownership"); const labelOwn = record(ownership.labels, "label ownership");
  if (!same(envOwn.defaults, { NODE_ENV: { value: "production", policy: "always" }, ...(context.runtimeKind === "node" ? {} : { BUN_RUNTIME_TRANSPILER_CACHE_PATH: { value: "0", policy: "if-missing" } }) }) || !same(envOwn.applicationOrder, ["inherited", "defaults", "explicit"])) fail("unknown environment policy");
  if (!Array.isArray(envOwn.explicitKeys) || envOwn.explicitKeys.some((k: unknown) => typeof k !== "string" || !k)) fail("invalid explicit environment keys");
  const env = Object.fromEntries((envOwn.explicitKeys as string[]).map((k) => [k, ""])) as Record<string, string>;
  const effectiveEnv = image.config.config?.Env ?? []; const seenEnv = new Set<string>();
  for (const item of effectiveEnv) { const p = item.indexOf("="); if (p < 1) fail("invalid effective environment"); const key = item.slice(0, p); if (Object.hasOwn(env, key)) { env[key] = item.slice(p + 1); seenEnv.add(key); } }
  if ((envOwn.explicitKeys as string[]).some((key) => !seenEnv.has(key))) fail("explicit environment key missing");
  exactKeys(labelOwn, ["explicitKeys", "inherited", "inheritBaseOciLabels", "inheritedFilter", "baseIdentity", "created"], "label ownership");
  if (labelOwn.inherited !== "base" || !same(labelOwn.baseIdentity, { manifest: baseLabel, index: baseIndexLabel, policy: "replace-from-selected-base" }) || !same(labelOwn.created, { key: "org.opencontainers.image.created", policy: "builder-owned-overwrite" })) fail("unknown label policy");
  if (!Array.isArray(labelOwn.explicitKeys) || labelOwn.explicitKeys.some((k: unknown) => typeof k !== "string" || !k)) fail("invalid explicit label keys");
  const labelsOut = Object.fromEntries((labelOwn.explicitKeys as string[]).map((k) => [k, ""])) as Record<string, string>; for (const key of Object.keys(labelsOut)) { if (labels[key] === undefined) fail("explicit label missing"); labelsOut[key] = labels[key]!; }
  const runtime = image.config.config!;
  const explicitUser = record(ownership.user, "user ownership").explicit === true; const explicitPorts = record(ownership.ports, "ports ownership").explicit === true;
  const epochText = string(image.config.created, "created"); const epochDate = Date.parse(epochText); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(epochText) || !Number.isSafeInteger(epochDate / 1000)) fail("created must be strict epoch seconds");
  const options: ImageOptions = { runtimeKind: context.runtimeKind, platform: platform as unknown as ImageOptions["platform"], epoch: epochDate / 1000, entrypoint: [...runtime.Entrypoint!], args: [...runtime.Cmd!], workdir: runtime.WorkingDir!, env, labels: labelsOut, inheritBaseOciLabels: labelOwn.inheritBaseOciLabels === true, user: explicitUser ? runtime.User : undefined, ports: parsePorts(runtime.ExposedPorts, explicitPorts) };
  if (context.runtimeKind === "node" && labels["org.bunko.runtime.kind"] !== "node" || context.runtimeKind !== "node" && labels["org.bunko.runtime.kind"] !== undefined) fail("runtime kind label mismatch");
  if (context.runtimeKind === "node" && !["22", "24"].includes(labels["org.bunko.node.version"] ?? "")) fail("invalid declared Node major");
  const order = ["runtime", "deps", "assets", "app"]; let previous = -1;
  for (const layer of layers) { const index = order.indexOf(layer.kind); if (index <= previous) fail("generated layer roles are out of order or duplicated"); previous = index; }
  if (context.mode === "compile" && context.runtimeOrigin !== "compiled") fail("compile mode requires compiled runtime");
  if (context.mode !== "compile" && context.runtimeOrigin === "compiled") fail("compiled runtime requires compile mode");
  if (context.runtimeOrigin === "injected" && !layers.some((layer) => layer.kind === "runtime")) fail("injected runtime requires runtime layer");
  if (context.runtimeOrigin !== "injected" && layers.some((layer) => layer.kind === "runtime")) fail("runtime layer requires injected runtime");
  if (!/^\d+\.\d+\.\d+$/.test(context.bunVersion) || !/^[a-f0-9]{7,40}$/.test(context.bunRevision)) fail("invalid build toolchain version or revision");
  for (const [key, expected] of [["org.bunko.mode", context.mode], ["org.bunko.runtime.libc", context.libc], ["org.bunko.bun.version", context.bunVersion], ["org.bunko.bun.revision", context.bunRevision]] as const) if (labels[key] !== expected) fail(`missing or mismatched ${key}`);
  if (rebaseMetadata(oldBase, layers, options, context) !== capsule) fail("capsule is non-canonical or tampered");
  const reconstructed = imageConfig(oldBase.config, layers, options);
  reconstructed.config!.Labels![rebaseMetadataLabel] = capsule;
  if (!same(reconstructed, image.config)) fail("config reconstruction mismatch");
  return { options, context, layers };
}

export async function rebaseImage(store: BlobStore, image: BaseImage, oldBase: BaseImage, newBase: BaseImage): Promise<{ root: Descriptor; manifest: Descriptor; config: Descriptor }> {
  const inspected = inspectRebase(image, oldBase); const p = inspected.options.platform;
  validateImageConfig(newBase.config, p, newBase.manifest.layers.length);
  const newVariant = newBase.config.architecture === "arm64" ? (newBase.config.variant ?? "v8") : newBase.config.variant;
  const requestedVariant = p.architecture === "arm64" ? (p.variant ?? "v8") : p.variant;
  if (newBase.config.os !== p.os || newBase.config.architecture !== p.architecture || newVariant !== requestedVariant) fail("new base platform mismatch");
  const annotations = { ...((image.manifest as unknown as { annotations?: Record<string, string> }).annotations ?? {}) };
  delete annotations[baseAnnotation]; delete annotations[baseNameAnnotation]; annotations[baseAnnotation] = newBase.descriptor.digest;
  const labels: Record<string, string> = { ...inspected.options.labels, [baseLabel]: newBase.descriptor.digest, "org.bunko.rebase.source.digest": image.descriptor.digest };
  if (newBase.indexDigest) labels[baseIndexLabel] = newBase.indexDigest; else delete labels[baseIndexLabel];
  return assembleImage(store, newBase, inspected.layers, { ...inspected.options, labels, annotations, rebase: inspected.context }, true);
}
