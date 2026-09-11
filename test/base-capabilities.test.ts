import { expect, test } from "bun:test";
import { baseCapabilities } from "../packages/bunko/base-capabilities.ts";
import type { BaseFilesystem } from "../packages/bunko/runtime-layer.ts";
import { checkBase } from "../packages/bunko/check-base.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";

test("static capabilities report CA, fonts, shells and unresolved native requirements without claiming ABI compatibility", () => {
  const tree: BaseFilesystem = new Map();
  const file = (path: string, mode = 0o644) => tree.set(path, { type: "file", size: 24, mode });
  file("etc/ssl/certs/ca-certificates.crt"); file("usr/share/fonts/test.ttf"); file("etc/fonts/fonts.conf");
  file("usr/bin/sh", 0o755); tree.set("bin", { type: "symlink", link: "usr/bin", mode: 0o777, size: 0 });
  file("usr/lib/libc.so.6"); tree.set("usr/lib/libgcc_s.so.1", { type: "symlink", link: "missing.so", mode: 0o777, size: 0 });
  const result = baseCapabilities(tree, { User: "1000:1000", Env: ["SSL_CERT_FILE=/missing.pem"] }, "/app", [{ path: "app/node_modules/canvas/addon.node", architecture: "amd64", needed: ["libc.so.6", "libgcc_s.so.1"] }]);
  expect(result.ca.systemStorePresent).toBe(true); expect(result.ca.configuredFile).toBe("/missing.pem");
  expect(result.fonts.count).toBe(1); expect(result.fonts.fontconfig).toEqual(["/etc/fonts/fonts.conf"]);
  expect(result.shells).toContain("/bin/sh"); expect(result.workdir.empty).toBe(true);
  expect(result.missingFromBase).toMatchObject([{ name: "libgcc_s.so.1", requiredBy: "app/node_modules/canvas/addon.node" }]);
  expect(result.runtimeCompatibilityVerified).toBe(false);
  tree.delete("etc/ssl/certs/ca-certificates.crt");
  expect(baseCapabilities(tree, {}).ca.systemStorePresent).toBe(false);
});

test("check-base cross-checks a build report against the selected platform", async () => {
  const root = await temporary();
  try {
    const base = await baseLayout(join(root, "base")), report = join(root, "report.json");
    await writeFile(report, JSON.stringify({ schemaVersion: 2, images: [{ platform: { os: "linux", architecture: "amd64" }, native: [{ path: "app/addon.node", architecture: "amd64", needed: ["libgcc_s.so.1"] }] }] }));
    const result = await checkBase({ baseLayout: base, requirementsReport: report });
    expect(result.platforms[0]!.capabilities.missingFromBase[0]!.name).toBe("libgcc_s.so.1");
    expect(result.platforms[0]!.runtimeVerified).toBe(false);
    await writeFile(report, JSON.stringify({ schemaVersion: 2, images: [{ platform: { os: "linux", architecture: "arm64" }, native: [] }] }));
    await expect(checkBase({ baseLayout: base, requirementsReport: report })).rejects.toThrow("no linux/amd64 image");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cyclic library links are unknown and do not break advisory inspection", () => {
  const tree: BaseFilesystem = new Map([["lib/cycle.so", { type: "symlink", link: "cycle.so", mode: 0o777, size: 0 }]]);
  const result = baseCapabilities(tree, {}, "/", [{ path: "app/addon.node", architecture: "amd64", needed: ["cycle.so", "relative/lib.so", "/lib/cycle.so", "/lib/missing.so"] }]);
  expect(result.requirements.map((item) => item.status)).toEqual(["unknown", "unknown", "unknown", "missing-from-base"]);
  expect(result.unresolvedPaths).toContain("/lib/cycle.so");
  expect(result.workdir.type).toBe("directory");
  expect(result.unresolvedPaths).not.toContain("/");
});

test("requirements reports validate shapes and accept multi-target inventory", async () => {
  const root = await temporary();
  try {
    const base = await baseLayout(join(root, "base")), report = join(root, "report.json");
    for (const value of [null, 4, { schemaVersion: 3, targets: [null] }]) {
      await writeFile(report, JSON.stringify(value));
      await expect(checkBase({ baseLayout: base, requirementsReport: report })).rejects.toThrow("Requirements report");
    }
    for (const schemaVersion of [3, 4]) {
      await writeFile(report, JSON.stringify({ schemaVersion, targets: [{ images: [{ platform: { os: "linux", architecture: "amd64" }, native: [{ path: "app/test.node", architecture: "amd64", needed: ["libmissing.so"] }] }] }] }));
      const result = await checkBase({ baseLayout: base, requirementsReport: report });
      expect(result.platforms[0]!.capabilities.missingFromBase[0]!.requiredBy).toBe("app/test.node");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured CA directories and workdirs resolve image-local directory links", () => {
  const tree: BaseFilesystem = new Map([
    ["cert-store", { type: "directory", mode: 0o755, size: 0 }],
    ["cert-store/root.pem", { type: "file", mode: 0o644, size: 20 }],
    ["cert-alias", { type: "symlink", link: "cert-store", mode: 0o777, size: 0 }],
  ]);
  const result = baseCapabilities(tree, { Env: ["MALFORMED", "SSL_CERT_DIR=/cert-alias/:/cert-alias"] }, "/cert-alias");
  expect(result.ca.directories).toEqual(["/cert-alias"]);
  expect(result.workdir).toEqual({ path: "/cert-alias", type: "directory", empty: false });
});

test("capability inventories disclose truncation and do not count loader configuration as libraries", () => {
  const tree: BaseFilesystem = new Map();
  for (let i = 0; i < 1001; i++) tree.set(`lib/libfixture${i}.so`, { type: "file", mode: 0o644, size: 1 });
  for (let i = 0; i < 101; i++) tree.set(`usr/share/fonts/font${i}.ttf`, { type: "file", mode: 0o644, size: 1 });
  tree.set("etc/ld.so.conf", { type: "file", mode: 0o644, size: 20 });
  tree.set("certs", { type: "directory", mode: 0o755, size: 0 });
  tree.set("certs/nested/root.pem", { type: "file", mode: 0o644, size: 20 });
  const result = baseCapabilities(tree, { Env: ["SSL_CERT_DIR=/certs"] });
  expect(result.ca.directories).toEqual([]);
  expect(result.fonts).toMatchObject({ count: 101, truncated: true });
  expect(result.fonts.files).toHaveLength(100);
  expect(result.sharedLibraryCount).toBe(1001);
  expect(result.sharedLibrariesTruncated).toBe(true);
  expect(result.sharedLibraries).toHaveLength(1000);
});

test.each(["amd64", "arm64"])("paired libc addons retain real base findings on %s", (architecture) => {
  const cpu = architecture === "amd64" ? "x64" : "arm64";
  const tree: BaseFilesystem = new Map();
  const file = (path: string, mode = 0o755) => tree.set(path, { type: "file", size: 24, mode });
  const glibcLoader = architecture === "amd64" ? "ld-linux-x86-64.so.2" : "ld-linux-aarch64.so.1";
  const muslLoader = architecture === "amd64" ? "ld-musl-x86_64.so.1" : "ld-musl-aarch64.so.1";
  const binary = (libc: "gnu" | "musl", version = "1.0.0") => ({
    path: `app/node_modules/.bun/@vendor+addon-linux-${cpu}-${libc}@${version}/node_modules/@vendor/addon-linux-${cpu}-${libc}/addon.linux-${cpu}-${libc}.node`,
    architecture, needed: [libc === "gnu" ? "libc.so.6" : "libc.so", "libgcc_s.so.1"],
  });
  const gnu = binary("gnu"), musl = binary("musl");
  file(`lib/${glibcLoader}`); file("lib/libc.so.6");
  let result = baseCapabilities(tree, {}, "/", [musl, gnu]);
  expect(result.missingFromBase).toMatchObject([{ name: "libgcc_s.so.1", requiredBy: gnu.path }]);
  expect(result.inactiveNativeVariants).toEqual([{ path: musl.path, libc: "musl", baseLibc: "glibc", alternative: gnu.path }]);
  expect(result.requirements.filter((item) => item.requiredBy === musl.path).every((item) => item.status === "inactive-libc-variant")).toBe(true);
  file("lib/libgcc_s.so.1");
  expect(baseCapabilities(tree, {}, "/", [musl, gnu]).missingFromBase).toEqual([]);
  // A single incompatible addon, a different package version, or ambiguous ELF evidence stays visible.
  expect(baseCapabilities(tree, {}, "/", [musl]).missingFromBase.map((item) => item.name)).toEqual(["libc.so"]);
  expect(baseCapabilities(tree, {}, "/", [musl, binary("gnu", "2.0.0")]).inactiveNativeVariants).toEqual([]);
  expect(baseCapabilities(tree, {}, "/", [musl, { ...gnu, needed: ["libc.so.6", "libc.so"] }]).inactiveNativeVariants).toEqual([]);
  expect(baseCapabilities(tree, {}, "/", [musl, { ...gnu, architecture: "other" }]).inactiveNativeVariants).toEqual([]);
  expect(baseCapabilities(tree, {}, "/", [musl, { ...gnu, path: gnu.path.replace("@vendor", "@unrelated") }]).inactiveNativeVariants).toEqual([]);
  // Unknown, non-executable and mixed loader bases do not imply a selected libc.
  file(`lib/${glibcLoader}`, 0o644);
  expect(baseCapabilities(tree, {}, "/", [musl, gnu]).inactiveNativeVariants).toEqual([]);
  file(`lib/${glibcLoader}`); file(`lib/${muslLoader}`);
  expect(baseCapabilities(tree, {}, "/", [musl, gnu]).inactiveNativeVariants).toEqual([]);
  tree.delete(`lib/${glibcLoader}`); file("lib/libc.so");
  result = baseCapabilities(tree, {}, "/", [musl, gnu]);
  expect(result.inactiveNativeVariants[0]).toMatchObject({ path: gnu.path, baseLibc: "musl", alternative: musl.path });
  tree.delete(`lib/${muslLoader}`);
  expect(baseCapabilities(tree, {}, "/", [musl, gnu]).inactiveNativeVariants).toEqual([]);
});

test("libc-looking names without matching ELF and Linux variant evidence are not suppressed", () => {
  const tree: BaseFilesystem = new Map([["lib/ld-linux-aarch64.so.1", { type: "file", mode: 0o755, size: 24 }]]);
  for (const suffix of [".node", "-linux-arm64-musl.so", "-musl.node"]) {
    const musl = { path: "app/addon" + suffix, architecture: "arm64", needed: ["libc.so"] };
    const gnu = { ...musl, path: musl.path.replace("musl", "gnu"), needed: ["libc.so.6"] };
    expect(baseCapabilities(tree, {}, "/", [musl, gnu]).inactiveNativeVariants).toEqual([]);
  }
});
