import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { exportLayout } from "../packages/oci/layout.ts";
import { packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { media, type Platform, type RuntimeConfig } from "../packages/oci/types.ts";
import { libcLoader } from "../packages/bunko/libc.ts";

export function rebaseRuntime(platform: Platform, libc: "glibc" | "musl" = "glibc") {
  const bytes = Buffer.alloc(1024);
  bytes.write("\x7fELF"); bytes[4] = 2; bytes[5] = 1;
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(platform.architecture === "amd64" ? 62 : 183, 18);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(3, 56);
  const segment = (index: number, type: number, offset: number, size: number) => {
    const p = 64 + index * 56; bytes.writeUInt32LE(type, p); bytes.writeBigUInt64LE(BigInt(offset), p + 8);
    bytes.writeBigUInt64LE(BigInt(offset), p + 16); bytes.writeBigUInt64LE(BigInt(size), p + 32);
  };
  segment(0, 1, 0, 1024);
  const interpreter = `${libcLoader(libc, platform)}\0`; bytes.write(interpreter, 300); segment(1, 3, 300, interpreter.length); segment(2, 2, 400, 64);
  const strings = "\0libc.so.6\0"; bytes.write(strings, 600);
  for (const [i, [tag, value]] of [[5, 600], [10, strings.length], [1, 1], [0, 0]].entries()) { bytes.writeBigUInt64LE(BigInt(tag!), 400 + i * 16); bytes.writeBigUInt64LE(BigInt(value!), 408 + i * 16); }
  bytes.write(`\0${Bun.revision.padEnd(40, "0")}\0`, 800);
  return bytes;
}

export async function rebaseBase(directory: string, platform: Platform = { os: "linux", architecture: "amd64" }, config: RuntimeConfig = {}, extra: TarEntry[] = []) {
  const store = new BlobStore(`${directory}-store`);
  const layer = (await packLayer(store, [
    { path: "usr/local/bin/bun", type: "file", content: rebaseRuntime(platform), executable: true },
    { path: libcLoader("glibc", platform).slice(1), type: "file", content: Buffer.from("loader"), executable: true },
    { path: "lib/libc.so.6", type: "file", content: Buffer.from("libc") },
    { path: "etc/os-release", type: "file", content: Buffer.from('ID="debian"\nVERSION_ID="13"\n') },
    ...extra,
  ], "assets", 0, []))!;
  const c = await store.put(canonicalJSON({ ...platform, config: { User: "65532:65532", Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "FLAG=old"], ...config }, rootfs: { type: "layers", diff_ids: [layer.diffId] }, history: [{ created_by: "base fixture" }] }), media.config);
  const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config: c, layers: [layer.descriptor] }), media.manifest);
  await exportLayout(store, directory, { ...manifest, platform }, [c, layer.descriptor], "base");
  return { directory, manifest, store };
}
