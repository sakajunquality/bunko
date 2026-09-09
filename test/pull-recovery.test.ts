import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { RegistrySource } from "../packages/oci/source.ts";
import { media } from "../packages/oci/types.ts";
import { temporary } from "./helpers.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const bytes = Buffer.from("verified registry blob"), d = { digest: sha256(bytes), size: bytes.length, mediaType: media.gzip };
async function store() { const root = await temporary(); roots.push(root); return new BlobStore(root); }
const options = { credentials: async () => undefined, retries: 0, sleep: async () => {}, bodyIdleTimeoutMs: 20 };
function interrupted(prefix: Uint8Array, cancel?: () => void) {
  let sent = false;
  return new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(prefix); } }, cancel });
}

test.each([true, false])("idle blob recovery handles Range support=%s and verifies the final hash", async (rangeSupported) => {
  let calls = 0, cancelled = false;
  const source = new RegistrySource("registry.example/team/app", { ...options, fetcher: async (_url, init) => {
    calls++; const headers = new Headers(init?.headers);
    expect(headers.get("Accept-Encoding")).toBe("identity");
    if (calls === 1) return new Response(interrupted(bytes.subarray(0, 5), () => { cancelled = true; }));
    expect(headers.get("Range")).toBe("bytes=5-");
    return rangeSupported ? new Response(bytes.subarray(5), { status: 206, headers: { "Content-Range": `bytes 5-${bytes.length - 1}/${bytes.length}`, "Content-Length": String(bytes.length - 5) } }) : new Response(bytes);
  } });
  const target = await store(); await target.putStream(await source.blob(d), d.mediaType, d);
  expect(await target.read(d)).toEqual(bytes); expect(calls).toBe(2); expect(cancelled).toBe(true);
});

test("truncated EOF resumes and rejects mixed bytes through complete digest validation", async () => {
  let calls = 0;
  const source = new RegistrySource("registry.example/team/app", { ...options, fetcher: async () => ++calls === 1 ? new Response(bytes.subarray(0, 5)) : new Response(Buffer.alloc(bytes.length - 5, 1), { status: 206, headers: { "Content-Range": `bytes 5-${bytes.length - 1}/${bytes.length}` } }) });
  const target = await store();
  await expect(target.putStream(await source.blob(d), d.mediaType, d)).rejects.toThrow("digest/size mismatch");
  expect(await Bun.file(target.path(d.digest)).exists()).toBe(false);
});

test.each(["bytes 0-20/21", "bytes 5-19/21", "bytes 5-20/999", "invalid"])("resume rejects incorrect Content-Range %s without repeated transfer", async (range) => {
  let calls = 0;
  const source = new RegistrySource("registry.example/team/app", { ...options, fetcher: async () => ++calls === 1 ? new Response(bytes.subarray(0, 5)) : new Response(bytes.subarray(5), { status: 206, headers: { "Content-Range": range } }) });
  const target = await store();
  await expect(target.putStream(await source.blob(d), d.mediaType, d)).rejects.toThrow("Content-Range mismatch"); expect(calls).toBe(2);
});

test("permanently idle streams have bounded retries and cancellation cannot hang cleanup", async () => {
  let calls = 0;
  const source = new RegistrySource("registry.example/team/app", { ...options, fetcher: async () => { calls++; return new Response(interrupted(new Uint8Array(), () => new Promise(() => {}))); } });
  const target = await store();
  await expect(target.putStream(await source.blob(d), d.mediaType, d)).rejects.toThrow("connection failed"); expect(calls).toBe(4);
  expect(await Bun.file(target.path(d.digest)).exists()).toBe(false);
});

test("active slow transfers are not limited by total elapsed body time", async () => {
  let index = 0;
  const source = new RegistrySource("registry.example/team/app", { ...options, bodyIdleTimeoutMs: 100, fetcher: async () => new Response(new ReadableStream({ async pull(controller) {
    await Bun.sleep(15); if (index < bytes.length) controller.enqueue(bytes.subarray(index, ++index)); else controller.close();
  } })) });
  const target = await store(); await target.putStream(await source.blob(d), d.mediaType, d);
  expect(await target.read(d)).toEqual(bytes);
});

test("blob headers and oversized payloads fail closed before retry", async () => {
  for (const response of [new Response(bytes, { headers: { "Content-Length": "1" } }), new Response(bytes, { headers: { "Docker-Content-Digest": sha256(Buffer.from("other")) } }), new Response(Buffer.concat([bytes, bytes]))]) {
    let calls = 0; const source = new RegistrySource("registry.example/team/app", { ...options, fetcher: async () => { calls++; return response; } });
    const target = await store(); await expect(target.putStream(await source.blob(d), d.mediaType, d)).rejects.toThrow(); expect(calls).toBe(1);
  }
});


test("consumer return interrupts an idle read without opening a recovery request", async () => {
  let calls = 0, cancelled = false;
  const source = new RegistrySource("registry.example/team/app", { ...options, bodyIdleTimeoutMs: 10_000, fetcher: async () => { calls++; return new Response(interrupted(new Uint8Array(), () => { cancelled = true; })); } });
  const iterator = (await source.blob(d))[Symbol.asyncIterator]();
  const pending = iterator.next().then(() => "unexpected", () => "cancelled");
  await Bun.sleep(10);
  await iterator.return!(undefined);
  expect(await pending).toBe("cancelled"); expect(calls).toBe(1); expect(cancelled).toBe(true);
}, 1000);


test("header cancellation does not retry or fall back to another mirror", async () => {
  let calls = 0, fallbacks = 0;
  const source = new RegistrySource("registry.example/team/app", { ...options, retries: 3, mirrors: { "registry.example": ["mirror.example", "second.example"] }, onMirrorFallback: () => { fallbacks++; }, fetcher: async (_url, init) => {
    calls++; return new Promise<Response>((_, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); });
  } });
  const iterator = (await source.blob(d))[Symbol.asyncIterator]();
  const pending = iterator.next().catch(() => "cancelled"); await Bun.sleep(10); await iterator.return!(undefined);
  expect(await pending).toBe("cancelled"); expect(calls).toBe(1); expect(fallbacks).toBe(0);
}, 1000);

test("consumer cancellation interrupts body recovery backoff", async () => {
  let calls = 0, sleeping = false;
  const source = new RegistrySource("registry.example/team/app", { ...options, sleep: async () => { sleeping = true; await new Promise(() => {}); }, fetcher: async () => { calls++; return new Response(new Uint8Array()); } });
  const iterator = (await source.blob(d))[Symbol.asyncIterator]();
  const pending = iterator.next().catch(() => "cancelled");
  for (let i = 0; !sleeping && i < 100; i++) await Bun.sleep(1);
  expect(sleeping).toBe(true); await iterator.return!(undefined);
  expect(await pending).toBe("cancelled"); expect(calls).toBe(1);
}, 1000);
