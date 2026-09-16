import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { invocationSignal, throwIfCancelled, pause } from "../runtime/invocation.ts";
import type { Fetcher } from "./registry.ts";

/** Bun's fetch inherits cached proxy settings even with an empty proxy option.
 * Native HTTP requests keep metadata and local credential services off that path. */
async function directFetch(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined,
    }, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      resolve(new Response(Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }));
    });
    request.on("error", reject);
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
}

export interface CredentialTransport { fetcher?: Fetcher; timeoutMs?: number }
/** No redirects, bounded bodies, total deadlines, and fixed diagnostics for secret-bearing services. */
export async function credentialRequest(source: string, url: string, init: RequestInit, options: CredentialTransport = {}, direct = false) {
  // Local credential services must never send identity material to an ambient proxy.
  direct ||= ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid credential request deadline");
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: number | undefined;
    try {
      const operation = async () => {
        const response = await (options.fetcher ?? (direct ? directFetch : fetch))(url, { ...init, redirect: "error", signal: invocationSignal(controller.signal), verbose: false, ...(direct ? { proxy: "" } : {}) } as RequestInit);
        status = response.status;
        if (!response.ok) { await response.body?.cancel(); throw new Error("response"); }
        if (!response.body) throw new Error("body");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let length = 0;
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.length; if (length > 1024 * 1024) throw new Error("size"); chunks.push(value);
        }
        return { text: Buffer.concat(chunks).toString(), headers: response.headers };
      };
      return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeout); })]);
    } catch {
      throwIfCancelled();
      if (attempt === 0 && (status === undefined || status === 429 || status >= 500)) { await pause(100); continue; }
      throw new Error(`${source} credential request failed${status === undefined ? "" : ` (HTTP ${status})`}`);
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { try { void reader.cancel().catch(() => {}); reader.releaseLock(); } catch { /* Preserve the sanitized failure. */ } }
    }
  }
}
export function credentialJSON(text: string): Record<string, unknown> {
  try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new Error("Invalid credential service response"); }
}
export function secret(value: unknown, label = "credential"): string {
  if (typeof value !== "string" || !value || value.length > 256 * 1024 || /[\x00-\x20\x7f]/.test(value)) throw new Error(`Invalid ${label} response`);
  return value;
}
