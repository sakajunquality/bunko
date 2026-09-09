import { createHash } from "node:crypto";
import type { Descriptor, Digest } from "./types.ts";

export function sha256(bytes: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function assertDigest(value: unknown): asserts value is Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Unsupported or invalid digest: ${String(value)}`);
  }
}

export function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function descriptor(value: unknown): Descriptor {
  const d = object(value, "Descriptor");
  assertDigest(d.digest);
  if (typeof d.mediaType !== "string" || !Number.isSafeInteger(d.size) || (d.size as number) < 0) {
    throw new Error("Descriptor requires a mediaType and a non-negative integer size");
  }
  if (d.annotations !== undefined) {
    const annotations = object(d.annotations, "Descriptor annotations");
    if (Object.values(annotations).some((value) => typeof value !== "string")) throw new Error("Descriptor annotation values must be strings");
  }
  return d as unknown as Descriptor;
}

/** Only newly generated JSON is canonicalized; received manifests retain their bytes. */
export function canonicalJSON(value: unknown): Uint8Array {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([key, v]) => [key, sort(v)]));
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite JSON number");
    return item;
  }
  return Buffer.from(JSON.stringify(sort(value)));
}
