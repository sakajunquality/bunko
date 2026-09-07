import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export const assetNames = ["bunko.js", "THIRD_PARTY_NOTICES.md"] as const;
export const maxAssetBytes = 64 * 1024 * 1024;
export const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function releaseTag(value: string): string {
  if (!/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) throw new Error("Use an explicit release version, for example v0.1.0-alpha.1");
  return value.startsWith("v") ? value : `v${value}`;
}

export function verifyAssets(manifest: string, assets: Map<string, Uint8Array>): void {
  const hashes = new Map<string, string>();
  for (const line of manifest.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (bunko\.js|THIRD_PARTY_NOTICES\.md)$/.exec(line);
    if (!match || hashes.has(match[2]!)) throw new Error("Invalid or duplicate release checksum entry");
    hashes.set(match[2]!, match[1]!);
  }
  for (const name of assetNames) {
    const bytes = assets.get(name);
    if (!bytes || bytes.length > maxAssetBytes || hashes.get(name) !== checksum(bytes)) throw new Error(`Release checksum mismatch: ${name}`);
  }
}

export async function localAsset(directory: string, name: string): Promise<Uint8Array> {
  const path = join(directory, name), info = await lstat(path);
  if (!info.isFile() || info.size > maxAssetBytes) throw new Error(`Invalid release file: ${name}`);
  return readFile(path);
}
