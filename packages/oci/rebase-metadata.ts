import { canonicalJSON } from "./digest.ts";
import type { ImageOptions } from "./image.ts";
import type { BaseImage, Layer } from "./types.ts";

/** OCI config label containing the build-time facts needed for a future rebase. */
export const rebaseMetadataLabel = "org.bunko.rebase.metadata";

export interface RebaseBuildContext {
  mode: "bundle" | "source" | "compile";
  libc: "glibc" | "musl";
  bunVersion: string;
  bunRevision: string;
  runtimeOrigin: "base" | "injected" | "compiled";
}

const maxMetadataBytes = 64 * 1024;

function sortedKeys(values: Record<string, unknown>, excludeReserved = false): string[] {
  return Object.keys(values)
    .filter((key) => !excludeReserved || key !== rebaseMetadataLabel)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * Produce canonical, value-free ownership metadata for safe future config reconstruction.
 * This function records build inputs and policies; it does not make compatibility claims.
 */
export function rebaseMetadata(base: BaseImage, layers: Layer[], options: ImageOptions, context: RebaseBuildContext): string {
  const metadata = {
    version: 1,
    base: {
      manifestDigest: base.descriptor.digest,
      configDigest: base.manifest.config.digest,
      ...(base.indexDigest ? { indexDigest: base.indexDigest } : {}),
      layerCount: base.manifest.layers.length,
    },
    generatedLayers: layers.map(({ kind }) => ({ role: kind })),
    platform: options.platform,
    context: {
      mode: context.mode,
      libc: context.libc,
      buildToolchain: { version: context.bunVersion, revision: context.bunRevision },
      runtime: { origin: context.runtimeOrigin },
    },
    ownership: {
      env: {
        inherited: "base",
        explicitKeys: sortedKeys(options.env),
        defaults: {
          NODE_ENV: { value: "production", policy: "always" },
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: { value: "0", policy: "if-missing" },
        },
        applicationOrder: ["inherited", "defaults", "explicit"],
      },
      labels: {
        explicitKeys: sortedKeys(options.labels, true),
        inherited: "base",
        inheritBaseOciLabels: options.inheritBaseOciLabels !== false,
        inheritedFilter: {
          excludedPrefixes: ["org.bunko.", ...(options.inheritBaseOciLabels === false ? ["org.opencontainers.image."] : [])],
          excludedKeys: ["org.opencontainers.image.revision", rebaseMetadataLabel],
        },
        baseIdentity: {
          manifest: "org.bunko.base.digest",
          index: "org.bunko.base.index.digest",
          policy: "replace-from-selected-base",
        },
        created: { key: "org.opencontainers.image.created", policy: "builder-owned-overwrite" },
      },
      user: options.user === undefined
        ? { policy: "inherit-nonroot-or-default", explicit: false }
        : { policy: "explicit", explicit: true },
      ports: options.ports === undefined
        ? { policy: "inherit", explicit: false }
        : { policy: "explicit", explicit: true },
      entrypoint: { policy: "explicit-always-owned" },
      cmd: { policy: "explicit-always-owned" },
      workdir: { policy: "explicit-always-owned" },
      volumes: { policy: "inherit" },
      stopSignal: { policy: "inherit" },
      platform: { policy: "explicit-always-owned" },
    },
    topLevel: {
      author: "inherit-if-present",
      history: "inherit-and-append-if-present",
      created: "epoch-owned",
    },
  };
  const bytes = canonicalJSON(metadata);
  if (bytes.byteLength > maxMetadataBytes) {
    throw new Error(`Rebase metadata exceeds the 64 KiB UTF-8 limit (${bytes.byteLength} bytes)`);
  }
  return Buffer.from(bytes).toString("utf8");
}
