import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withCacheLock } from "../packages/bunko/cache-lock.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(join(tmpdir(), "bunko-mutex-test-")); roots.push(value); return value; }
const modulePath = resolve(import.meta.dir, "../packages/bunko/cache-lock.ts");

test("SIGKILL releases the mutex and recovers only its matching new-format directory", async () => {
  const directory = await root(), script = join(directory, "owner.ts");
  await writeFile(script, `import {withCacheLock} from ${JSON.stringify(modulePath)}; await withCacheLock(process.argv[2],async()=>{console.log("ready");await Bun.sleep(30000)});`);
  const child = Bun.spawn([process.execPath, script, directory], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); reader.releaseLock();
    const owner = JSON.parse(await readFile(join(directory, ".bunko-lock/owner.json"), "utf8"));
    expect(owner.schemaVersion).toBe(2);
    child.kill("SIGKILL"); await child.exited;
    expect(await withCacheLock(directory, async () => "recovered", undefined, 1000)).toBe("recovered");
    expect(await Bun.file(join(directory, ".bunko-lock/owner.json")).exists()).toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("independent contenders serialize without stealing a live mutex", async () => {
  const directory = await root(), script = join(directory, "writer.ts"), log = join(directory, "events");
  await writeFile(script, `import {withCacheLock} from ${JSON.stringify(modulePath)};import{appendFile}from"node:fs/promises";await withCacheLock(process.argv[2],async()=>{await appendFile(process.argv[3],"enter "+process.pid+"\\n");await Bun.sleep(50);await appendFile(process.argv[3],"exit "+process.pid+"\\n")},undefined,5000);`);
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, script, directory, log], { stdout: "ignore", stderr: "pipe" }));
  try {
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0]);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(8);
    for (let i = 0; i < lines.length; i += 2) expect(lines[i + 1]).toBe(lines[i]!.replace("enter", "exit"));
  } finally { for (const child of children) child.kill("SIGKILL"); await Promise.all(children.map((child) => child.exited)); }
});

test("mutex symlinks never authorize recovery", async () => {
  const directory = await root(), target = join(directory, "unrelated"), mutex = join(directory, ".bunko-lock.sqlite");
  await writeFile(target, "keep"); await symlink(target, mutex);
  await expect(withCacheLock(directory, async () => { throw new Error("must not execute"); }, undefined, 100)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("keep");
});


test("a replaced mutex inode does not authorize deletion of an old owner directory", async () => {
  const directory = await root(), lock = join(directory, ".bunko-lock"), mutex = join(directory, ".bunko-lock.sqlite");
  let owner = "";
  await withCacheLock(directory, async () => { owner = await readFile(join(lock, "owner.json"), "utf8"); });
  await mkdir(lock); await writeFile(join(lock, "owner.json"), owner);
  await rename(mutex, `${mutex}.old`);
  await expect(withCacheLock(directory, async () => { throw new Error("must not execute"); }, undefined, 50)).rejects.toThrow("locked");
  expect(await readFile(join(lock, "owner.json"), "utf8")).toBe(owner);
});
