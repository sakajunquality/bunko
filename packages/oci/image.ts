import type { BlobStore } from "./blob-store.ts";
import { canonicalJSON } from "./digest.ts";
import { media, type BaseImage, type Descriptor, type ImageConfig, type Layer, type Platform, type RuntimeConfig } from "./types.ts";

export interface ImageOptions {
  platform: Platform;
  epoch: number;
  entrypoint: string[];
  args: string[];
  workdir: string;
  user?: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  ports?: number[];
}

export function imageConfig(base: ImageConfig, layers: Layer[], options: ImageOptions): ImageConfig {
  const inherited = base.config ?? {};
  const env = new Map<string, string>();
  for (const item of inherited.Env ?? []) {
    const equals = item.indexOf("=");
    if (equals < 1) throw new Error(`Invalid base environment entry: ${item}`);
    env.set(item.slice(0, equals), item.slice(equals + 1));
  }
  env.set("NODE_ENV", "production");
  for (const [key, value] of Object.entries(options.env)) env.set(key, value);
  const created = new Date(options.epoch * 1000).toISOString().replace(".000Z", "Z");
  const baseLabels = Object.fromEntries(Object.entries(inherited.Labels ?? {}).filter(([key]) => !key.startsWith("org.bunko.") && key !== "org.opencontainers.image.revision"));
  const config: RuntimeConfig = {
    User: options.user ?? (inherited.User || "65532:65532"),
    Env: [...env].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([k, v]) => `${k}=${v}`),
    Entrypoint: options.entrypoint,
    Cmd: options.args,
    WorkingDir: options.workdir,
    ExposedPorts: options.ports ? Object.fromEntries(options.ports.map((p) => [`${p}/tcp`, {}])) : inherited.ExposedPorts ?? undefined,
    Labels: { ...baseLabels, ...options.labels, "org.opencontainers.image.created": created },
    Volumes: inherited.Volumes ?? undefined,
    StopSignal: inherited.StopSignal ?? undefined,
  };
  return {
    ...options.platform,
    created,
    ...(base.author ? { author: base.author } : {}),
    config,
    rootfs: { type: "layers", diff_ids: [...base.rootfs.diff_ids, ...layers.map((layer) => layer.diffId)] },
    ...(base.history ? { history: [...base.history, ...layers.map((layer) => ({ created, created_by: `bunko ${layer.kind}` }))] } : {}),
  };
}

export async function assembleImage(store: BlobStore, base: BaseImage, layers: Layer[], options: ImageOptions, noIndex = false): Promise<{ root: Descriptor; manifest: Descriptor; config: Descriptor }> {
  const config = await store.put(canonicalJSON(imageConfig(base.config, layers, options)), media.config);
  const manifest = await store.put(canonicalJSON({
    schemaVersion: 2, mediaType: media.manifest, config,
    layers: [...base.manifest.layers, ...layers.map((layer) => layer.descriptor)],
  }), media.manifest);
  const root = noIndex ? manifest : await store.put(canonicalJSON({
    schemaVersion: 2, mediaType: media.index,
    manifests: [{ ...manifest, platform: options.platform }],
  }), media.index);
  return { root, manifest, config };
}
