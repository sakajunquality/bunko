import { descriptor } from "./digest.ts";
import { RegistryConnectionError } from "./registry.ts";
import type { Descriptor } from "./types.ts";

/** Resume verified-address blob reads; the BlobStore validates the complete hash. */
export function pullStream(d: Descriptor, read: (headers: Headers, signal: AbortSignal) => Promise<Response>, idleMs: number, backoff: (attempt: number) => Promise<void>): AsyncGenerator<Uint8Array> {
  descriptor(d);
  const controller = new AbortController();
  const iterator = download(d, read, idleMs, backoff, controller.signal);
  const finish = iterator.return.bind(iterator), fail = iterator.throw.bind(iterator);
  iterator.return = (value) => { controller.abort(); return finish(value); };
  iterator.throw = (error) => { controller.abort(); return fail(error); };
  return iterator;
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

async function* download(d: Descriptor, read: (headers: Headers, signal: AbortSignal) => Promise<Response>, idleMs: number, backoff: (attempt: number) => Promise<void>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let offset = 0;
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers({ "Accept-Encoding": "identity" });
    if (offset) headers.set("Range", `bytes=${offset}-`);
    signal.throwIfAborted();
    const response = await abortable(read(headers, signal), signal);
    let skip = 0;
    try {
      const declared = response.headers.get("Docker-Content-Digest");
      if (declared && declared !== d.digest) throw new Error("Registry blob digest header mismatch");
      let expected = d.size;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
        if (!range || Number(range[1]) !== offset || Number(range[2]) !== d.size - 1 || Number(range[3]) !== d.size) throw new Error("Registry blob Content-Range mismatch");
        expected -= offset;
      } else if (response.status === 200) skip = offset;
      else throw new Error("Unexpected registry blob response status");
      const length = response.headers.get("Content-Length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) throw new Error("Registry blob Content-Length mismatch");
      if (!response.body) throw new Error("Registry blob response has no body");
    } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    const reader = response.body!.getReader();
    let complete = false;
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await abortable(Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("idle")), idleMs); })]), signal);
        } catch { signal.throwIfAborted(); throw new RegistryConnectionError("Registry blob connection failed while reading body"); }
        finally { clearTimeout(timer); }
        if (chunk.done) {
          if (offset !== d.size || skip) throw new RegistryConnectionError("Registry blob connection failed before the complete body");
          complete = true; return;
        }
        let bytes = chunk.value;
        if (skip) { const ignored = Math.min(skip, bytes.length); skip -= ignored; bytes = bytes.subarray(ignored); }
        if (offset + bytes.length > d.size) throw new Error("Registry blob exceeds descriptor size");
        offset += bytes.length;
        if (bytes.length) yield bytes;
      }
    } catch (error) {
      if (!(error instanceof RegistryConnectionError)) throw error;
      // All expected bytes may have arrived before the connection closed. The
      // caller still verifies their complete digest before accepting the blob.
      if (offset === d.size && !skip) return;
      if (attempt >= 3) throw error;
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* Pending cancellation releases the lock. */ }
    }
    await abortable(backoff(attempt), signal);
  }
}
