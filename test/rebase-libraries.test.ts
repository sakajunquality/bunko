import { expect, test } from "bun:test";
import { checkRuntimeLibraries } from "../packages/bunko/rebase-libraries.ts";
import type { BaseNode } from "../packages/bunko/runtime-layer.ts";
import { rebaseRuntime } from "./rebase-fixture.ts";

const platform = { os: "linux", architecture: "amd64" } as const;
const options = { platform, epoch: 0, entrypoint: ["/opt/bun/bin/bun"], args: [], workdir: "/app", env: {}, labels: {} };
function fixture() {
  const tree = new Map<string, BaseNode>(), bodies = new WeakMap<BaseNode, Buffer>();
  function file(path: string, body = Buffer.from("library")) { const node = { type: "file", mode: 0o644, size: body.length }; tree.set(path, node); bodies.set(node, body); }
  const check = (bytes = rebaseRuntime(platform), env = {}, libc: "glibc" | "musl" = "glibc", needed = ["libc.so.6"], architecture: "amd64" | "arm64" = "amd64") => checkRuntimeLibraries(tree, bodies, bytes, { ...options, platform: { os: "linux", architecture } }, libc, needed, env, "debian");
  return { tree, bodies, file, check };
}
function withPaths(rpath?: string, runpath?: string) {
  const bytes = rebaseRuntime(platform), tags: [number, number][] = [[5, 600], [10, 0], [1, 1]];
  let strings = "\0libc.so.6\0";
  for (const [key, value] of [[15, rpath], [29, runpath]] as const) if (value !== undefined) { tags.push([key, Buffer.byteLength(strings)]); strings += value + "\0"; }
  tags[1]![1] = Buffer.byteLength(strings); tags.push([0, 0]);
  bytes.write(strings, 600); bytes.writeBigUInt64LE(BigInt(tags.length * 16), 64 + 2 * 56 + 32);
  for (const [i, [tag, value]] of tags.entries()) { bytes.writeBigUInt64LE(BigInt(tag), 400 + i * 16); bytes.writeBigUInt64LE(BigInt(value), 408 + i * 16); }
  return bytes;
}
function cache(flags = 0x303, hwcap = 0n) {
  const name = "libc.so.6\0", path = "/opt/system/libc.so.6\0", bytes = Buffer.alloc(72 + name.length + path.length);
  bytes.write("glibc-ld.so.cache1.1"); bytes.writeUInt32LE(1, 20); bytes.writeUInt32LE(name.length + path.length, 24); bytes[28] = 2;
  bytes.writeUInt32LE(flags, 48); bytes.writeUInt32LE(72, 52); bytes.writeUInt32LE(72 + name.length, 56); bytes.writeBigUInt64LE(hwcap, 64);
  bytes.write(name + path, 72); return bytes;
}

test("only loader-visible paths satisfy dependencies, including merged-/usr symlinks", () => {
  const f = fixture(); f.file("app/cache/libc.so.6");
  expect(() => f.check()).toThrow("missing shared library");
  f.file("usr/lib/x86_64-linux-gnu/libc.so.6"); f.tree.set("lib", { type: "symlink", link: "usr/lib", mode: 0o777, size: 0 });
  expect(() => f.check()).not.toThrow();
});
test("glibc RPATH precedes environment paths; RUNPATH suppresses RPATH and follows environment", () => {
  const f = fixture(); f.file("opt/selected/libc.so.6"); f.file("opt/broken/libc.so.6", Buffer.alloc(0));
  expect(() => f.check(withPaths("/opt/selected"), { LD_LIBRARY_PATH: "/opt/broken" })).not.toThrow();
  expect(() => f.check(withPaths("/opt/selected", "/opt/selected"), { LD_LIBRARY_PATH: "/opt/broken" })).toThrow("Invalid rebase shared library candidate");
  expect(() => f.check(withPaths("/opt/selected", "/opt/absent"))).toThrow("missing shared library");
  expect(() => f.check(withPaths("/opt/broken", "/opt/absent"), { LD_LIBRARY_PATH: "/opt/selected" })).not.toThrow();
});
test("ORIGIN expansion is supported only where the loader expands it; ambiguous paths fail", () => {
  const f = fixture(); f.file("opt/bun/lib/libc.so.6");
  expect(() => f.check(withPaths(undefined, "$ORIGIN/../lib"))).not.toThrow();
  expect(() => f.check(undefined, { LD_LIBRARY_PATH: "${ORIGIN}/../lib" })).not.toThrow();
  for (const path of ["relative", "/lib:", "$LIB", "/lib/$PLATFORM"]) expect(() => f.check(undefined, { LD_LIBRARY_PATH: path })).toThrow("loader paths");
  expect(() => f.check(undefined, { LD_LIBRARY_PATH: "$ORIGIN/../lib" }, "musl")).toThrow("loader paths");
});
test("musl path configuration replaces defaults and accepts colon/newline separators", () => {
  const f = fixture(); f.file("lib/libextra.so");
  expect(() => f.check(undefined, {}, "musl", ["libextra.so", "libc.musl-x86_64.so.1"])).not.toThrow();
  f.file("etc/ld-musl-x86_64.path", Buffer.from("/opt/custom:\n\n"));
  expect(() => f.check(undefined, {}, "musl", ["libextra.so"])).toThrow("missing shared library");
  f.file("opt/custom/libextra.so");
  expect(() => f.check(undefined, {}, "musl", ["libextra.so"])).not.toThrow();
  expect(() => f.check(undefined, { LD_LIBRARY_PATH: "/absent;relative" }, "musl", ["libextra.so"])).not.toThrow();
});
test("GNU cache entries use target ABI and baseline hardware capabilities with bounded strings", () => {
  for (const architecture of ["amd64", "arm64"] as const) {
    const f = fixture(); f.file("opt/system/libc.so.6");
    f.file("etc/ld.so.cache", cache(architecture === "amd64" ? 0x303 : 0xa03));
    expect(() => f.check(undefined, {}, "glibc", undefined, architecture)).not.toThrow();
    f.file("etc/ld.so.cache", cache(architecture === "amd64" ? 0xa03 : 0x303));
    expect(() => f.check(undefined, {}, "glibc", undefined, architecture)).toThrow("missing shared library");
    f.file("etc/ld.so.cache", cache(architecture === "amd64" ? 0x303 : 0xa03, 1n));
    expect(() => f.check(undefined, {}, "glibc", undefined, architecture)).toThrow("missing shared library");
  }
  for (const mutate of [(b: Buffer) => { b[28] = 3; }, (b: Buffer) => b.writeUInt32LE(100_000, 20), (b: Buffer) => b.writeUInt32LE(1, 52), (b: Buffer) => { b[0] = 0; }]) {
    const f = fixture(), data = cache(); mutate(data); f.file("etc/ld.so.cache", data);
    expect(() => f.check()).toThrow("loader cache");
  }
});
