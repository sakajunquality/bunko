import { expect, test } from "bun:test";
import { rebaseMetadata, rebaseMetadataLabel, type RebaseBuildContext } from "../packages/oci/rebase-metadata.ts";
import type { BaseImage, Layer } from "../packages/oci/types.ts";
import type { ImageOptions } from "../packages/oci/image.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as `sha256:${string}`;
const context: RebaseBuildContext = { mode: "bundle", libc: "glibc", bunVersion: "1.4.0", bunRevision: "revision", runtimeOrigin: "injected" };
const base: BaseImage = {
  descriptor: { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest("a"), size: 10 },
  manifest: {
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digest("b"), size: 20 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: digest("c"), size: 30 },
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: digest("d"), size: 40 },
    ],
  },
  config: { architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } },
  indexDigest: digest("e"),
};
const layers: Layer[] = [
  { kind: "runtime", descriptor: { mediaType: "layer", digest: digest("f"), size: 1 }, diffId: digest("1") },
  { kind: "app", descriptor: { mediaType: "layer", digest: digest("2"), size: 1 }, diffId: digest("2") },
];
const options = (overrides: Partial<ImageOptions> = {}): ImageOptions => ({
  platform: { os: "linux", architecture: "amd64" }, epoch: 0, entrypoint: ["bun"], args: ["app.js"], workdir: "/app",
  env: { SAME: "base", SECRET_ENV: "do-not-copy" }, labels: { same: "base", [rebaseMetadataLabel]: "recursive" },
  ...overrides,
});

test("records identity, generated layer roles, context, and ownership without runtime values", () => {
  const value = JSON.parse(rebaseMetadata(base, layers, options(), context));
  expect(value.base).toEqual({ manifestDigest: base.descriptor.digest, configDigest: base.manifest.config.digest, indexDigest: base.indexDigest, layerCount: 2 });
  expect(value.generatedLayers).toEqual([{ role: "runtime" }, { role: "app" }]);
  expect(value.context.buildToolchain).toEqual({ version: "1.4.0", revision: "revision" });
  expect(value.context.runtime).toEqual({ origin: "injected" });
  expect(value.ownership.env.explicitKeys).toEqual(["SAME", "SECRET_ENV"]);
  expect(value.ownership.labels.explicitKeys).toEqual(["same"]);
  expect(JSON.stringify(value)).not.toContain("do-not-copy");
});

test("distinguishes explicit equal values, empty ports, and explicit empty user", () => {
  const value = JSON.parse(rebaseMetadata(base, layers, options({ user: "", ports: [] }), context));
  expect(value.ownership.user).toEqual({ policy: "explicit", explicit: true });
  expect(value.ownership.ports).toEqual({ policy: "explicit", explicit: true });
  expect(value.ownership.env.explicitKeys).toContain("SAME");
  expect(value.ownership.env.defaults).toEqual({ NODE_ENV: { value: "production", policy: "always" }, BUN_RUNTIME_TRANSPILER_CACHE_PATH: { value: "0", policy: "if-missing" } });
  const inherited = JSON.parse(rebaseMetadata(base, layers, options({ user: undefined, ports: undefined }), context));
  expect(inherited.ownership.user).toEqual({ policy: "inherit-nonroot-or-default", explicit: false });
  expect(inherited.ownership.ports).toEqual({ policy: "inherit", explicit: false });
});

test("uses stable UTF-8 key ordering and excludes the reserved label", () => {
  const a = JSON.parse(rebaseMetadata(base, layers, options({ env: { z: "1", "é": "2", a: "3" }, labels: { z: "1", a: "2", [rebaseMetadataLabel]: "x" } }), context));
  const b = JSON.parse(rebaseMetadata(base, layers, options({ env: { a: "3", "é": "2", z: "1" }, labels: { [rebaseMetadataLabel]: "different", a: "2", z: "1" } }), context));
  expect(rebaseMetadata(base, layers, options({ env: { z: "1", "é": "2", a: "3" } }), context)).toBe(rebaseMetadata(base, layers, options({ env: { a: "3", "é": "2", z: "1" } }), context));
  expect(a.ownership.labels.explicitKeys).not.toContain(rebaseMetadataLabel);
  expect(a.ownership.labels.inherited).toBe("base");
  expect(a.ownership.labels.inheritBaseOciLabels).toBe(true);
  expect(a.ownership.labels.baseIdentity).toEqual({ manifest: "org.bunko.base.digest", index: "org.bunko.base.index.digest", policy: "replace-from-selected-base" });
  expect(a).toEqual(b);
});

test("retains a reserved-looking environment key because only labels are reserved", () => {
  const value = JSON.parse(rebaseMetadata(base, layers, options({ env: { [rebaseMetadataLabel]: "value" } }), context));
  expect(value.ownership.env.explicitKeys).toEqual([rebaseMetadataLabel]);
});

test("accepts exactly 64 KiB and rejects the next UTF-8 byte", () => {
  const baseline = rebaseMetadata(base, layers, options({ env: { padding: "x" } }), context);
  const padding = 65_536 - Buffer.byteLength(baseline);
  const atLimit = rebaseMetadata(base, layers, options({ env: { [`padding${"x".repeat(padding)}`]: "x" } }), context);
  expect(Buffer.byteLength(atLimit)).toBe(65_536);
  expect(() => rebaseMetadata(base, layers, options({ env: { [`padding${"x".repeat(padding + 1)}`]: "x" } }), context)).toThrow("64 KiB UTF-8 limit");
  expect(() => rebaseMetadata(base, layers, options({ env: { ["é".repeat(40_000)]: "x" } }), context)).toThrow("64 KiB UTF-8 limit");
});
