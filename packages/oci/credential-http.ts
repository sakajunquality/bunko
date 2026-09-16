import { invocationSignal, throwIfCancelled, pause, spawn } from "../runtime/invocation.ts";
import type { Fetcher } from "./registry.ts";

/** Older Bun releases also route node:http through cached proxy settings. A small
 * isolated worker starts with no proxy environment and never reloads project .env files. */
const directWorker = String.raw`
try {
  const input = JSON.parse(await Bun.stdin.text());
  const response = await fetch(input.url, { ...input.init, redirect: "error", verbose: false, signal: AbortSignal.timeout(input.timeout) });
  const chunks = []; let length = 0;
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    while (true) { const {value,done}=await reader.read(); if(done)break; length+=value.length; if(length>1048576)throw new Error(); chunks.push(value); }
  } else await response.body?.cancel();
  process.stdout.write(JSON.stringify({status:response.status,headers:[...response.headers],body:Buffer.concat(chunks).toString("base64")}));
} catch { process.exitCode=1; }
`;
async function directFetch(url: string, init: RequestInit): Promise<Response> {
  const env: Record<string, string> = {};
  for (const key of ["SYSTEMROOT", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const executable = Bun.which("bun");
  if (!executable) throw new Error("Direct credential transport requires Bun on PATH");
  const child = spawn([executable, "--no-env-file", "-e", directWorker], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const cancel = () => { child.kill("SIGKILL"); };
  init.signal?.addEventListener("abort", cancel, { once: true });
  const reader = child.stdout.getReader();
  try {
    init.signal?.throwIfAborted();
    child.stdin.write(JSON.stringify({url,timeout:5000,init:{method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body}}));
    await child.stdin.end();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const {value,done}=await reader.read(); if(done)break; length+=value.length; if(length>2*1024*1024)throw new Error(); chunks.push(value); }
    if (await child.exited !== 0 || child.signalCode) throw new Error("Direct credential transport failed");
    const value = JSON.parse(Buffer.concat(chunks).toString());
    return new Response(value.status === 204 ? null : Buffer.from(value.body, "base64"), {status:value.status,headers:value.headers});
  } finally {
    init.signal?.removeEventListener("abort", cancel); cancel();
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
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
