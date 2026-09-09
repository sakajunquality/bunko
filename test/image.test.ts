import { describe, expect, test } from "bun:test";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { imageConfig, isRootUser, type ImageOptions } from "../packages/oci/image.ts";
import { media, type ImageConfig, type Layer } from "../packages/oci/types.ts";
import { validateImageConfig } from "../packages/oci/source.ts";

const base: ImageConfig = {
  os: "linux", architecture: "amd64",
  config: { Env: ["PATH=/bin", "NODE_ENV=development", "LOCALE=C"], Cmd: ["old"], User: "1000", Labels: { base: "yes" }, WorkingDir: "/old" },
  rootfs: { type: "layers", diff_ids: [sha256("base tar")] },
  history: [{ created_by: "base" }, { created_by: "ENV", empty_layer: true }],
};
const app: Layer = { kind: "app", descriptor: { mediaType: media.gzip, size: 1, digest: sha256("app gzip") }, diffId: sha256("app tar") };
const options: ImageOptions = { platform: { os: "linux", architecture: "amd64" }, epoch: 0, entrypoint: ["/usr/local/bin/bun", "/app/server.js"], args: [], workdir: "/app", env: { CUSTOM: "yes" }, labels: { app: "yes" }, ports: [3000] };

describe("image composition", () => {
  test("retains base environment and history, resets command, appends uncompressed DiffIDs", () => {
    const image = imageConfig(base, [app], options);
    expect(image.config?.Env).toEqual(["BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "CUSTOM=yes", "LOCALE=C", "NODE_ENV=production", "PATH=/bin"]);
    expect(image.config?.Cmd).toEqual([]);
    expect(image.config?.Entrypoint).toEqual(options.entrypoint);
    expect(image.config?.WorkingDir).toBe("/app");
    expect(image.config?.User).toBe("1000");
    expect(image.config?.ExposedPorts).toEqual({ "3000/tcp": {} });
    expect(image.config?.Labels?.base).toBe("yes");
    expect(image.created).toBe("1970-01-01T00:00:00Z");
    expect(image.rootfs.diff_ids).toEqual([base.rootfs.diff_ids[0]!, app.diffId]);
    expect(image.history?.[1]?.empty_layer).toBe(true);
    expect(image.history?.[2]?.created_by).toBe("bunko app");
    expect(base.config?.Cmd).toEqual(["old"]);
  });
  test("disables implicit runtime cache writes while retaining explicit base and application choices", () => {
    expect(imageConfig(base, [], { ...options, env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/tmp/app-cache" } }).config?.Env).toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/app-cache");
    const configured = { ...base, config: { Env: ["BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/base-cache"] } };
    expect(imageConfig(configured, [], options).config?.Env).toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/base-cache");
    expect(imageConfig(configured, [], { ...options, env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/tmp/app-cache" } }).config?.Env).toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/app-cache");
  });
  test("replaces an inherited root user with nonroot, inherits other users, and honours explicit settings", () => {
    for (const User of ["0", "0:0", "00", "000:001", "00:00", "root", "root:root", "root:0", "0:root", "0:1000", ""]) expect(imageConfig({ ...base, config: { User } }, [], options).config?.User).toBe("65532:65532");
    expect(imageConfig({ ...base, config: {} }, [], options).config?.User).toBe("65532:65532");
    for (const User of ["1000", "1000:1000", "nonroot", "65532:65532"]) expect(imageConfig({ ...base, config: { User } }, [], options).config?.User).toBe(User);
    expect(imageConfig({ ...base, config: { User: "0" } }, [], { ...options, user: "0:0" }).config?.User).toBe("0:0");
    expect(imageConfig({ ...base, config: { User: "0" } }, [], { ...options, user: "root" }).config?.User).toBe("root");
    expect(imageConfig(base, [], { ...options, user: "2000:2000" }).config?.User).toBe("2000:2000");
    expect(imageConfig(base, [], { ...options, user: "00:00" }).config?.User).toBe("00:00");
    expect(isRootUser(undefined)).toBe(true); expect(isRootUser("root:1000")).toBe(true); expect(isRootUser("1000:0")).toBe(false);
  });
  test("omits history when the base has none", () => {
    expect(imageConfig({ ...base, history: undefined }, [app], options).history).toBeUndefined();
  });
  test("JSON keys are canonical, but semantic array order is preserved", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 1 } })).toEqual(canonicalJSON({ a: { c: 1, d: 2 }, b: 1 }));
    expect(canonicalJSON([1, 2])).not.toEqual(canonicalJSON([2, 1]));
  });
  test("rejects inconsistent base platform, history and DiffID count", () => {
    expect(() => validateImageConfig(base, { os: "linux", architecture: "arm64" }, 1)).toThrow("platform");
    expect(() => validateImageConfig(base, options.platform, 2)).toThrow("DiffIDs");
    expect(() => validateImageConfig({ ...base, history: [] }, options.platform, 1)).toThrow("history");
  });
  test("does not inherit the base's Git revision as the application's revision", () => {
    const image = imageConfig({ ...base, config: { Labels: { "org.opencontainers.image.revision": "base-commit", "org.bunko.source.digest": "old", custom: "kept" } } }, [app], options);
    expect(image.config?.Labels?.["org.opencontainers.image.revision"]).toBeUndefined();
    expect(image.config?.Labels?.["org.bunko.source.digest"]).toBeUndefined();
    expect(image.config?.Labels?.custom).toBe("kept");
  });
  test("rejects malformed inherited port and history metadata", () => {
    expect(() => validateImageConfig({ ...base, config: { ExposedPorts: [] } }, options.platform, 1)).toThrow("ExposedPorts");
    expect(() => validateImageConfig({ ...base, history: [{ empty_layer: "false" }] }, options.platform, 1)).toThrow("empty_layer");
  });
});
