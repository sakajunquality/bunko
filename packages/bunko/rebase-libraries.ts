import { posix } from "node:path";
import { baseNode, type BaseFilesystem, type BaseNode } from "./runtime-layer.ts";
import type { ImageOptions } from "../oci/image.ts";
import type { Libc } from "./libc.ts";

/** Check a shared object's bounded ELF header, without requiring an executable interpreter. */
export function libraryELF(header: Buffer | undefined, architecture: "amd64" | "arm64", path: string): void {
  if (!header || header.length < 64 || header.subarray(0, 4).toString("latin1") !== "\x7fELF" ||
    header[4] !== 2 || header[5] !== 1 || header[6] !== 1 || ![0, 3].includes(header[7]!) ||
    header.readUInt16LE(16) !== 3 || header.readUInt16LE(18) !== (architecture === "amd64" ? 62 : 183) ||
    header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64) {
    throw new Error(`Rebase shared library is not a target-compatible ELF64 object: ${path}`);
  }
}

/** Read search tags from the ELF64 image already validated by runtimeELF. */
function searchTags(bytes: Buffer) {
  const offset = Number(bytes.readBigUInt64LE(32)), count = bytes.readUInt16LE(56);
  const segments = Array.from({ length: count }, (_, i) => {
    const at = offset + i * 56;
    return { type: bytes.readUInt32LE(at), offset: Number(bytes.readBigUInt64LE(at + 8)), address: Number(bytes.readBigUInt64LE(at + 16)), size: Number(bytes.readBigUInt64LE(at + 32)) };
  });
  const dynamic = segments.find((segment) => segment.type === 2)!;
  const tags = new Map<number, number>();
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.size; at += 16) {
    const key = Number(bytes.readBigUInt64LE(at)); if (!key) break;
    if ([5, 10, 15, 29, 0x6ffffffb].includes(key)) {
      if (tags.has(key)) throw new Error("Ambiguous runtime ELF search metadata");
      tags.set(key, Number(bytes.readBigUInt64LE(at + 8)));
    }
  }
  const address = tags.get(5)!, length = tags.get(10)!;
  const segment = segments.find((item) => item.type === 1 && address >= item.address && address + length <= item.address + item.size)!;
  const start = segment.offset + address - segment.address;
  const text = (tag: number) => {
    const offset = tags.get(tag); if (offset === undefined) return;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= length) throw new Error("Invalid runtime ELF search string");
    const end = bytes.indexOf(0, start + offset);
    if (end < start + offset || end >= start + length) throw new Error("Invalid runtime ELF search string");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start + offset, end));
  };
  if ((tags.get(0x6ffffffb) ?? 0) & 0x800) throw new Error("Rebase does not support DF_1_NODEFLIB runtimes");
  return { rpath: text(15), runpath: text(29) };
}

/** GNU cache 1.1 wire layout; only baseline entries for the target ABI are eligible. */
function cacheEntries(bytes: Buffer, architecture: "amd64" | "arm64") {
  if (bytes.length < 48 || bytes.subarray(0, 20).toString("ascii") !== "glibc-ld.so.cache1.1" || ![0, 2].includes(bytes[28]! & 3)) throw new Error("Unsupported glibc loader cache; rebuild with a supported base");
  const count = bytes.readUInt32LE(20), start = 48 + count * 24, end = start + bytes.readUInt32LE(24);
  if (count > 50_000 || end > bytes.length) throw new Error("Invalid glibc loader cache bounds");
  const string = (at: number) => {
    const zero = bytes.indexOf(0, at);
    if (at < start || at >= end || zero < at || zero >= end) throw new Error("Invalid glibc loader cache string");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, zero));
  };
  const result = new Map<string, string[]>();
  for (let i = 0; i < count; i++) {
    const at = 48 + i * 24;
    if (bytes.readUInt32LE(at) !== (architecture === "amd64" ? 0x303 : 0xa03) || bytes.readBigUInt64LE(at + 16) !== 0n) continue;
    const name = string(bytes.readUInt32LE(at + 4)), path = string(bytes.readUInt32LE(at + 8));
    if (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid glibc loader cache path");
    const entries = result.get(name);
    if (entries) entries.push(path); else result.set(name, [path]);
  }
  return result;
}

/** Resolve direct Bun dependencies through supported loader paths, never by basename across the image. */
export function checkRuntimeLibraries(tree: BaseFilesystem, bodies: WeakMap<BaseNode, Buffer>, headers: WeakMap<BaseNode, Buffer>, bytes: Buffer, options: ImageOptions, libc: Libc, needed: string[], env: Record<string, string>, distribution?: string): void {
  const tags = searchTags(bytes), origin = posix.dirname(options.entrypoint[0]!);
  const paths = (value: string | undefined, separators: RegExp, expand = true) => {
    if (!value) return [];
    return value.split(separators).filter((part) => libc !== "musl" || part.length > 0).map((part) => {
      const path = expand ? part.replace(/\$\{ORIGIN\}|\$ORIGIN\b/g, origin) : part;
      if (!path.startsWith("/") || /[$\x00-\x1f\x7f]/.test(path)) throw new Error("Rebase loader paths must be absolute and use only supported ORIGIN tokens");
      return posix.normalize(path);
    });
  };
  const libraryPath = paths(env.LD_LIBRARY_PATH, libc === "musl" ? /[:\n]/ : /[:;]/, libc !== "musl");
  const fileBody = (path: string) => {
    const node = baseNode(tree, path);
    if (!node) return;
    const body = bodies.get(node);
    if (node.type !== "file" || !body) throw new Error(`Cannot inspect rebase loader configuration ${path}`);
    return body;
  };
  let directories: string[], cache = new Map<string, string[]>(), defaults: string[] = [];
  if (libc === "musl") {
    const config = fileBody(`/etc/ld-musl-${options.platform.architecture === "amd64" ? "x86_64" : "aarch64"}.path`);
    const system = config === undefined ? "/lib:/usr/local/lib:/usr/lib" : new TextDecoder("utf-8", { fatal: true }).decode(config);
    directories = [...libraryPath, ...paths(tags.runpath ?? tags.rpath, /[:\n]/), ...paths(system, /[:\n]/, false)];
  } else {
    directories = [...paths(tags.runpath === undefined ? tags.rpath : undefined, /:/), ...libraryPath, ...paths(tags.runpath, /:/)];
    const data = fileBody("/etc/ld.so.cache");
    if (data) cache = cacheEntries(data, options.platform.architecture);
    // These profiles describe the standard distribution loaders; custom loaders need explicit paths/cache entries.
    if (["debian", "ubuntu"].includes(distribution ?? "")) {
      const triple = options.platform.architecture === "amd64" ? "x86_64-linux-gnu" : "aarch64-linux-gnu";
      defaults = [`/lib/${triple}`, `/usr/lib/${triple}`, "/lib", "/usr/lib"];
    } else if (["fedora", "rhel", "centos", "rocky", "almalinux", "amzn"].includes(distribution ?? "")) defaults = ["/lib64", "/usr/lib64"];
  }
  for (const name of needed) {
    if (!name || /[$\x00-\x1f\x7f]/.test(name)) throw new Error("Unsupported rebase DT_NEEDED name");
    if (libc === "musl" && ["libc.so", `libc.musl-${options.platform.architecture === "amd64" ? "x86_64" : "aarch64"}.so.1`].includes(name)) continue;
    if (name.includes("/") && !name.startsWith("/")) throw new Error("Rebase does not support relative DT_NEEDED paths");
    const candidates = name.startsWith("/") ? [name] : [...directories.map((path) => posix.join(path, name)), ...(cache.get(name) ?? []), ...defaults.map((path) => posix.join(path, name))];
    let found = false;
    for (const path of candidates) {
      const node = baseNode(tree, path);
      if (!node) continue;
      if (node.type !== "file" || !node.size) throw new Error(`Invalid rebase shared library candidate ${path}`);
      libraryELF(headers.get(node), options.platform.architecture, path);
      found = true; break;
    }
    if (!found) throw new Error(`Rebase runtime requires missing shared library ${name} in loader search paths`);
  }
}
