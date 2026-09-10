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
  const result = baseCapabilities(tree, {}, "/", [{ path: "app/addon.node", architecture: "amd64", needed: ["cycle.so", "relative/lib.so"] }]);
  expect(result.requirements.map((item) => item.status)).toEqual(["unknown", "unknown"]);
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
  const result = baseCapabilities(tree, { Env: ["MALFORMED", "SSL_CERT_DIR=/cert-alias"] }, "/cert-alias");
  expect(result.ca.directories).toContain("/cert-alias");
  expect(result.workdir).toEqual({ path: "/cert-alias", type: "directory", empty: false });
});
