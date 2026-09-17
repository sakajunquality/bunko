import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporary } from "./helpers.ts";
import { withCacheLock } from "../packages/bunko/cache-lock.ts";
import { pruneLocal } from "../packages/bunko/prune.ts";

test("dead local locks fail promptly without deleting potentially raced ownership", async () => {
  const root = await temporary(), lock = join(root, ".bunko-lock");
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await child.exited;
  try {
    await mkdir(lock); await writeFile(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, hostname: hostname(), pid: child.pid }));
    const start = Date.now(); await expect(withCacheLock(root, async () => 1, undefined, 30000)).rejects.toThrow("dead local owner");
    expect(Date.now() - start).toBeLessThan(2000); expect(await Bun.file(join(lock, "owner.json")).exists()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("crash residue is counted without deleting blobs that may belong to active writers", async () => {
  const root = await temporary();
  try {
    await mkdir(join(root, "blobs/sha256"), { recursive: true });
    await writeFile(join(root, "blobs/sha256", "a".repeat(64)), "orphan"); await writeFile(join(root, "blobs/.tmp-fixture"), "temp");
    const result = await pruneLocal(root, true, 0);
    expect(result.unreferencedBytes).toBe(6); expect(result.temporaryBytes).toBe(4); expect(result.deleted).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
