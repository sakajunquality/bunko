import { expect, test } from "bun:test";
import { loadProject } from "../packages/bunko/config.ts";
import { runtimeAsset, runtimeELF, type InjectedRuntime } from "../packages/bunko/runtime-download.ts";
import { runtimeEntries, type BaseFilesystem } from "../packages/bunko/runtime-layer.ts";
import { assertBaseLibc, assertNativeLibc, libcLoader } from "../packages/bunko/libc.ts";
import { assertSharedClosure } from "../packages/bunko/closure.ts";
import { baseCapabilities } from "../packages/bunko/base-capabilities.ts";
import { cacheKey } from "../packages/bunko/cache.ts";

const toolchain = { path: "bun", version: "1.4.2", revision: "744846f84" };
for (const architecture of ["amd64", "arm64"] as const) test(`musl ${architecture} selects a pinned artifact and requires its loader and libraries`, () => {
  const platform = { os: "linux", architecture } as const;
  const interpreter = libcLoader("musl", platform);
  expect(runtimeAsset(toolchain, platform, "musl")).toBe(architecture === "amd64" ? "bun-linux-x64-musl-baseline" : "bun-linux-aarch64-musl");
  const tree: BaseFilesystem = new Map();
  expect(() => assertBaseLibc(tree, "musl", platform)).toThrow("musl runtime base requires executable loader");
  tree.set(interpreter.slice(1), {type:"file", mode:0o644, size:1});
  expect(() => assertBaseLibc(tree, "musl", platform)).toThrow();
  tree.set(interpreter.slice(1), {type:"file", mode:0o755, size:1});
  assertBaseLibc(tree, "musl", platform);
  expect(() => assertBaseLibc(tree, "glibc", platform)).toThrow("Base uses musl");
  const metadata = {libc:"musl", path:"/usr/local/bin/bun", interpreter, needed:["libstdc++.so.6", interpreter.split('/').at(-1)!.replace('ld-', 'libc.')]} as InjectedRuntime;
  expect(() => runtimeEntries(metadata, Buffer.from('fixture'), tree)).toThrow("missing libstdc++.so.6");
  tree.set("usr/lib/libstdc++.so.6", {type:"file",mode:0o755,size:1});
  expect(runtimeEntries(metadata, Buffer.from('fixture'), tree)).toHaveLength(1);
  const capabilities = baseCapabilities(tree, {}, '/', [{path:'addon.node', architecture, needed:[metadata.needed[1]!]}]);
  expect(capabilities.missingFromBase).toEqual([]);
  expect(cacheKey({runtime: {...metadata, libc:"glibc"}})).not.toBe(cacheKey({runtime:metadata}));
});

test("libc selection defaults to glibc and shared dependencies reject mixed libc", async () => {
  const project = await loadProject({path:'examples/hello'});
  expect(project.runtimeLibc).toBe('glibc');
  const musl = await loadProject({path:'examples/hello',runtimeLibc:'musl'});
  expect(musl.runtimeLibc).toBe('musl');
  await expect(loadProject({path:'examples/hello',runtimeLibc:'unknown'})).rejects.toThrow('runtime.libc');
  expect(() => assertSharedClosure([{...project,depsStrategy:'closure'},{...musl,depsStrategy:'closure'}],true,true)).toThrow('runtime libc');
});

test("runtime ELF rejects a wrong libc before trusting the executable", () => {
  const bytes = Buffer.alloc(256); bytes.write('\x7fELF'); bytes[4]=2; bytes[5]=1; bytes.writeUInt16LE(3,16); bytes.writeUInt16LE(62,18);
  bytes.writeBigUInt64LE(64n,32); bytes.writeUInt16LE(56,54); bytes.writeUInt16LE(1,56); bytes.writeUInt32LE(3,64);
  bytes.writeBigUInt64LE(128n,72); bytes.writeBigUInt64LE(32n,96); bytes.write('/lib64/ld-linux-x86-64.so.2\0',128);
  expect(() => runtimeELF(bytes,{os:'linux',architecture:'amd64'},'musl')).toThrow('expected musl executable');
});

test("musl rejects an unpaired glibc addon but retains an inactive optional pair", () => {
  const binaries=[{path:"package/addon.node",needed:["libc.so.6"]}];
  expect(() => assertNativeLibc("musl",binaries,new Set())).toThrow("requires glibc");
  expect(() => assertNativeLibc("musl",binaries,new Set([binaries[0]!.path]))).not.toThrow();
  expect(() => assertNativeLibc("glibc",binaries,new Set())).not.toThrow();
});
