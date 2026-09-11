import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveAssetFile } from "../packages/bunko/asset-move.ts";

test("asset moves preserve bytes and executable mode on one filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-move-"));
  try {
    const source = join(root, "source"), destination = join(root, "destination");
    await writeFile(source, "verified bytes", { mode: 0o700 });
    await moveAssetFile(source, destination);
    expect(await readFile(destination, "utf8")).toBe("verified bytes");
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual(["destination"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("failed cross-device asset commits retain the source and remove partial copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-move-")), cache = await mkdtemp("/dev/shm/bunko-move-");
  try {
    expect((await stat(root)).dev).not.toBe((await stat(cache)).dev);
    const source = join(root, "source"), destination = join(cache, "destination");
    await writeFile(source, "verified bytes");
    await mkdir(destination); await writeFile(join(destination, "existing"), "preserved");
    await expect(moveAssetFile(source, destination)).rejects.toThrow();
    expect(await readFile(source, "utf8")).toBe("verified bytes");
    expect(await readFile(join(destination, "existing"), "utf8")).toBe("preserved");
    expect(await readdir(cache)).toEqual(["destination"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); }
});
