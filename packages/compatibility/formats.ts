/** Reader requirements describe format revisions, not trust in a particular writer.
 * Security-bearing payloads remain strictly validated after version selection. */
export const persistedFormats = {
  "rebase-capsule": { versions: [1], readers: { 1: "0.8.0" }, features: { nodeRuntime: "0.9.0" } },
  "sbom-evidence": { versions: [1, 2], readers: { 1: "0.9.0", 2: "0.11.0" } },
  "build-report": { versions: [2, 3] },
  "resolve-report": { versions: [4] },
  "apply-report": { versions: [5] },
  "rebase-report": { versions: [1] },
  "base-status-report": { versions: [1] },
  "push-layout-report": { versions: [1] },
} as const;
export type PersistedFormat = keyof typeof persistedFormats;

export class UnsupportedFormatError extends Error {
  readonly code = "BUNKO_UNSUPPORTED_FORMAT";
  readonly newer: boolean;
  readonly supportedVersions: readonly number[];
  constructor(readonly format: PersistedFormat, readonly version: number) {
    const supported = persistedFormats[format].versions;
    const newer = version > Math.max(...supported);
    super(`Unsupported ${format} version ${version}${newer ? " (newer than this Bunko reader)" : ""}; supported versions: ${supported.join(", ")}. Use a compatible Bunko reader; do not remove fields to bypass validation.`);
    this.name = "UnsupportedFormatError";
    this.newer = newer; this.supportedVersions = supported;
  }
}

export function assertFormatVersion(format: PersistedFormat, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Invalid ${format} version`);
  if (!(persistedFormats[format].versions as readonly number[]).includes(value as number)) throw new UnsupportedFormatError(format, value as number);
}
