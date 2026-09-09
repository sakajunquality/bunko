import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryTLS } from "../packages/oci/tls.ts";
import { selectRegistryMirrors } from "../packages/oci/mirrors.ts";

test("versioned registry config accepts scoped mirrors and rejects unknown or malformed fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-registry-config-")), path = join(root, "registry.json");
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, tls: {}, mirrors: { "docker.io": ["mirror.example/cache"] } }));
    const config = await registryTLS(path); expect(config.hosts).toEqual({}); expect(config.mirrors).toEqual({ "registry-1.docker.io": ["mirror.example/cache"] });
    for (const value of [{ schemaVersion: 2 }, { schemaVersion: 1, unknown: true }, { schemaVersion: 1, mirrors: { "docker.io": "mirror.example" } }, { schemaVersion: 1, mirrors: { "bad/path": [] } }, { schemaVersion: 1, mirrors: { "docker.io": ["mirror.example/../cache"] } }]) {
      await writeFile(path, JSON.stringify(value)); await expect(registryTLS(path)).rejects.toThrow();
    }
    await writeFile(path, "{}"); expect((await registryTLS(path)).mirrors).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit mirror flags replace environment and config, including explicit empty environment", () => {
  const config = { "origin.example": ["config.example/cache"] };
  expect(selectRegistryMirrors(undefined, undefined, config)).toBe(config);
  expect(selectRegistryMirrors(undefined, " origin.example=env.example/cache\r\n\n", config)).toEqual({ "origin.example": ["env.example/cache"] });
  expect(selectRegistryMirrors(undefined, "", config)).toEqual({});
  expect(selectRegistryMirrors(["origin.example=flag.example"], "invalid", config)).toEqual({ "origin.example": ["flag.example"] });
});
