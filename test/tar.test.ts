import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { archivePath, packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { inspectTar, temporary } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function store() { const root = await temporary(); directories.push(root); return new BlobStore(root); }

describe("deterministic OCI layers", () => {
  test("orders entries, preserves executability, and separates compressed digest from DiffID", async () => {
    const blobs = await store();
    const entries: TarEntry[] = [
      { path: "app/z.txt", type: "file", content: Buffer.from("last\n") },
      { path: "app/bin/run", type: "file", content: Buffer.from("#!/bin/sh\n"), executable: true },
      { path: "app/a.txt", type: "file", content: Buffer.from("first\n") },
    ];
    const first = (await packLayer(blobs, entries, "app", 123))!;
    const second = (await packLayer(blobs, [...entries].reverse(), "app", 123))!;
    expect(first).toEqual(second);
    const bytes = await readFile(blobs.path(first.descriptor.digest));
    expect(bytes[9]).toBe(255);
    expect(bytes.readUInt32LE(4)).toBe(0);
    expect(sha256(bytes)).toBe(first.descriptor.digest);
    expect(sha256(gunzipSync(bytes))).toBe(first.diffId);
    expect(first.diffId).not.toBe(first.descriptor.digest);
    expect(gunzipSync(bytes).subarray(-1024).every((b) => b === 0)).toBe(true);
    const files = await inspectTar(blobs.path(first.descriptor.digest));
    expect(files.map((f) => f.name)).toEqual(["app", "app/a.txt", "app/bin", "app/bin/run", "app/z.txt"]);
    expect(files.find((f) => f.name === "app/bin/run")?.mode).toBe(0o755);
    expect(files.find((f) => f.name === "app/a.txt")?.mode).toBe(0o644);
    expect(files.every((f) => f.uid === 0 && f.gid === 0 && f.mtime === 123)).toBe(true);
  });

  test("PAX handles long UTF-8 paths, long links and large timestamps", async () => {
    const blobs = await store();
    const name = `app/${"文".repeat(60)}/${"文".repeat(50)}`;
    const target = "x".repeat(150);
    const layer = (await packLayer(blobs, [
      { path: name, type: "file", content: Buffer.from("unicode\n") },
      { path: `app/${target}`, type: "file", content: Buffer.from("target") },
      { path: "app/link", type: "symlink", target },
    ], "assets", 10_000_000_000))!;
    const files = await inspectTar(blobs.path(layer.descriptor.digest));
    expect(files.find((f) => f.name === name)?.content).toBe("unicode\n");
    expect(files.find((f) => f.name === "app/link")?.linkname).toBe(target);
    expect(files.every((f) => f.mtime === 10_000_000_000)).toBe(true);
  });

  test("empty layers are omitted and SOURCE_DATE_EPOCH changes layer identity", async () => {
    const blobs = await store();
    expect(await packLayer(blobs, [], "assets", 0)).toBeUndefined();
    const entries: TarEntry[] = [{ path: "app/file", type: "file", content: Buffer.from("hello") }];
    expect((await packLayer(blobs, entries, "app", 0))?.descriptor.digest).not.toBe((await packLayer(blobs, entries, "app", 1))?.descriptor.digest);
  });

  test.each(["../escape", "/absolute", "app/../escape", "app//file", "app\\file", "app/.wh.removed", "app/\0bad"])("rejects unsafe path %j", (path) => {
    expect(() => archivePath(path)).toThrow("Unsafe archive path");
  });

  test("rejects file/directory collisions, duplicate files, case collisions and escaping links", async () => {
    const blobs = await store();
    const file: TarEntry = { path: "app", type: "file", content: Buffer.from("x") };
    for (const entries of [
      [file, { ...file, path: "app/child" }], [file, file],
      [{ ...file, path: "App" }, file],
      [{ path: "app/link", type: "symlink", target: "../../outside" }],
    ] as TarEntry[][]) await expect(packLayer(blobs, entries, "app", 0)).rejects.toThrow();
  });

  test("a shrinking source fails rather than emitting an invalid tar", async () => {
    const blobs = await store();
    const source = join(blobs.root, "file");
    await writeFile(source, "x");
    await expect(packLayer(blobs, [{ path: "app/file", type: "file", source, size: 100 }], "app", 0)).rejects.toThrow("File changed");
  });
});


test("owned layer roots preserve base ancestors without weakening collision validation", async () => {
  const blobs = await store();
  const entries: TarEntry[] = [
    { path: "tmp/seed/data.txt", type: "file", content: Buffer.from("data") },
    { path: "usr/local/share/fonts/custom/font.otf", type: "file", content: Buffer.from("font") },
  ];
  const layer = (await packLayer(blobs, entries, "assets", 0, ["tmp/seed", "usr/local/share/fonts/custom"]))!;
  expect((await inspectTar(blobs.path(layer.descriptor.digest))).map((entry) => entry.name)).toEqual([
    "tmp/seed", "tmp/seed/data.txt", "usr/local/share/fonts/custom", "usr/local/share/fonts/custom/font.otf",
  ]);
  for (const entries of [
    [{ path: "tmp", type: "file", content: Buffer.from("x") }, { path: "tmp/seed/data", type: "file", content: Buffer.from("y") }],
    [{ path: "TMP/file", type: "file", content: Buffer.from("x") }, { path: "tmp/seed/data", type: "file", content: Buffer.from("y") }],
  ] as TarEntry[][]) await expect(packLayer(blobs, entries, "assets", 0, ["tmp/seed"])).rejects.toThrow();
  expect(() => archivePath(`app/${"x".repeat(256)}`)).toThrow("Unsafe archive path");
  expect(() => archivePath(`app/${"文".repeat(86)}`)).toThrow("Unsafe archive path");
});
