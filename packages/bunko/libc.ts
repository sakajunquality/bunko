import type { Platform } from "../oci/types.ts";
import { baseNode, type BaseFilesystem } from "./runtime-layer.ts";

export type Libc = "glibc" | "musl";
export function runtimeLibc(value: unknown): Libc {
  if (value === undefined) return "glibc";
  if (value !== "glibc" && value !== "musl") throw new Error("runtime.libc must be glibc or musl");
  return value;
}
export function libcLoader(libc: Libc, platform: Platform): string {
  return libc === "musl" ? `/lib/ld-musl-${platform.architecture === "amd64" ? "x86_64" : "aarch64"}.so.1`
    : platform.architecture === "amd64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
}
/** Reject incompatible declared libc without executing any image content on the host. */
export function assertBaseLibc(tree: BaseFilesystem, libc: Libc, platform: Platform): void {
  const executable = (path: string) => { const node = baseNode(tree, path); return node?.type === "file" && node.size > 0 && Boolean(node.mode & 0o111); };
  const selected = libcLoader(libc, platform);
  if (libc === "musl" && !executable(selected)) throw new Error(`musl runtime base requires executable loader ${selected}; choose an Alpine/musl base`);
  if (libc === "glibc" && !executable(selected) && executable(libcLoader("musl", platform))) throw new Error("Base uses musl; set runtime.libc to musl and use compatible runtime and native dependencies");
}

/** Opposite-libc optional variants may coexist only when a matching variant is available. */
export function assertNativeLibc(libc: Libc, native: {path: string; needed: string[]}[], inactive: ReadonlySet<string>): void {
  if (libc !== "musl") return;
  const incompatible = native.find((binary) => !inactive.has(binary.path) && binary.needed.includes("libc.so.6"));
  if (incompatible) throw new Error(`Native dependency ${incompatible.path} requires glibc; supply a musl build or select runtime.libc glibc`);
}
