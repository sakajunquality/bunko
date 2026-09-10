import type { Platform } from "../oci/types.ts";

interface SizedLayer { kind: string; descriptor: { size: number; mediaType: string } }

/** Descriptor sizes describe stored layer bytes, not expanded Docker filesystems or billing. */
export function imageSizeSummary(platform: Platform, layers: SizedLayer[]): string {
  const kinds = new Map<string, number>();
  let total = 0;
  for (const layer of layers) {
    total += layer.descriptor.size;
    kinds.set(layer.kind, (kinds.get(layer.kind) ?? 0) + layer.descriptor.size);
  }
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;
  const compression = layers.length && layers.every((layer) => /(?:\+(?:gzip|zstd)|\.tar\.gzip)$/.test(layer.descriptor.mediaType)) ? "compressed" : "mixed or uncompressed";
  return `Image size (${platform.os}/${platform.architecture}): ${mb(total)} stored layer bytes (${compression}, ${layers.length} layers)\nLayers: ${[...kinds].map(([kind, size]) => `${kind} ${mb(size)}`).join(", ") || "none"}\n`;
}
