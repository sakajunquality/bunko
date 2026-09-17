import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProject } from "../packages/bunko/config.ts";
import { localPlatform } from "../packages/bunko/platforms.ts";
import { project, temporary } from "./helpers.ts";

let root: string | undefined;
const original = process.env.BUNKO_DEFAULT_PLATFORMS;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.BUNKO_DEFAULT_PLATFORMS;
  else process.env.BUNKO_DEFAULT_PLATFORMS = original;
});

test("local architecture selection supports both hosts and rejects an unknown implicit target", () => {
  expect(localPlatform("arm64")).toBe("linux/arm64");
  expect(localPlatform("x64")).toBe("linux/amd64");
  expect(() => localPlatform("riscv64")).toThrow("set --platform");
});

test("local defaults follow the host while explicit platforms and other output defaults retain precedence", async () => {
  delete process.env.BUNKO_DEFAULT_PLATFORMS;
  root = await temporary(); const path = await project(join(root, "app"));
  const selected = async (options = {}) => (await loadProject({ path, ...options })).platform.architecture;
  expect(await selected({ local: true })).toBe(process.arch === "arm64" ? "arm64" : "amd64");
  expect(await selected()).toBe("amd64");
  expect(await selected({ kind: true })).toBe("amd64");
  expect(await selected({ tarball: "image.tar" })).toBe("amd64");
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "hello", module: "src/server.ts", bunko: { platforms: ["linux/arm64"] } }));
  expect(await selected({ local: true })).toBe("arm64");
  process.env.BUNKO_DEFAULT_PLATFORMS = "linux/amd64";
  expect(await selected({ local: true })).toBe("amd64");
  expect(await selected({ local: true, platform: "linux/arm64" })).toBe("arm64");
});
