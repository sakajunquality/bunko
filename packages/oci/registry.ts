import { dockerCredentials, type CredentialProvider } from "./credentials.ts";
import { object } from "./digest.ts";
import { media } from "./types.ts";

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;
export interface RegistryOptions {
  sensitivePaths?: string[];
  tls?: Record<string, import("./tls.ts").RegistryTLS>;
  fetcher?: Fetcher;
  credentials?: CredentialProvider;
  insecure?: string[];
  retries?: number;
  /** Deadline for GET/HEAD response headers; it never limits body transfers. */
  headersTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Explicit readers avoid Bun 1.3.11's intermittent native async-iterator errors. */
export async function* webStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; return; }
      yield value;
    }
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* retain the original read failure */ } }
    // Bun 1.3.11 can throw while releasing an already completed HTTP reader.
    // Cleanup must not replace the read result; consumers still verify size/hash.
    try { reader.releaseLock(); } catch { /* completed stream is reclaimed by GC */ }
  }
}

export async function responseBytes(response: Response, limit = 8 * 1024 * 1024): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty registry response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of webStream(response.body)) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`Registry metadata exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class RegistryError extends Error {
  constructor(readonly status: number, method: string, registry: string) {
    super(`Registry ${method} failed (${status}): ${registry}`);
  }
}

/** One client per registry; tokens are scoped to repository/action sets. */
export class RegistryClient {
  readonly origin: string;
  readonly fetcher: Fetcher;
  private readonly credentials: CredentialProvider;
  private readonly insecureOrigins: Set<string>;
  private readonly tokens = new Map<string, { authorization: string; expires: number }>();
  constructor(readonly registry: string, private readonly options: RegistryOptions = {}) {
    this.insecureOrigins = new Set((options.insecure ?? []).map((host) => new URL(`http://${host}`).origin));
    const http = new URL(`http://${registry}`).origin;
    this.origin = this.insecureOrigins.has(http) ? http : new URL(`https://${registry}`).origin;
    if (options.headersTimeoutMs !== undefined && (!Number.isFinite(options.headersTimeoutMs) || options.headersTimeoutMs <= 0)) throw new Error("Registry header timeout must be positive");
    const transport = options.fetcher ?? fetch;
    this.fetcher = (url, init) => {
      const origin = new URL(url).origin;
      const tls = options.tls?.[origin];
      return transport(url, { ...init, ...(tls && origin.startsWith("https://") ? { tls: { ...tls, rejectUnauthorized: true } } : {}) } as RequestInit);
    };
    this.credentials = options.credentials ?? dockerCredentials();
  }

  private safeURL(value: string | URL, from = this.origin): URL {
    const url = new URL(value, from);
    if (url.username || url.password || url.hash) throw new Error("Registry URLs must not contain credentials or fragments");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && this.insecureOrigins.has(url.origin))) throw new Error("Registry URLs and redirects must use HTTPS; explicitly allow a test registry with --insecure-registry");
    return url;
  }

  private async authenticate(challenge: string, scopes: string[], refresh: boolean): Promise<{ authorization: string; expires: number }> {
    const credential = await this.credentials(this.registry, refresh);
    if (/^Basic\s/i.test(challenge)) {
      if (credential?.username === undefined || credential.password === undefined) throw new Error(`Registry credentials required: ${this.registry}; configure Docker login or a credential helper`);
      return { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`, expires: Date.now() + 5 * 60_000 };
    }
    if (!/^Bearer\s/i.test(challenge)) throw new Error(`Unsupported registry authentication: ${this.registry}`);
    if (credential?.registryToken) return { authorization: `Bearer ${credential.registryToken}`, expires: Date.now() + 60_000 };
    const values = Object.fromEntries([...challenge.matchAll(/([\w]+)="((?:\\.|[^"])*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!.replace(/\\(.)/g, "$1")]));
    if (!values.realm) throw new Error("Registry Bearer challenge has no realm");
    const realm = this.safeURL(values.realm);
    const params = new URLSearchParams();
    if (values.service) params.set("service", values.service);
    for (const scope of scopes) params.append("scope", scope);
    const headers = new Headers();
    let body: URLSearchParams | undefined;
    if (credential?.identityToken) {
      body = params;
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", credential.identityToken);
      body.set("client_id", "bunko");
    } else {
      for (const [key, value] of params) realm.searchParams.append(key, value);
      if (credential?.username !== undefined && credential.password !== undefined) headers.set("Authorization", `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
    }
    let response: Response;
    try { response = await this.fetcher(realm, { method: body ? "POST" : "GET", headers, body, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error(`Registry token request failed: ${this.registry}`); }
    if (!response.ok) { await response.body?.cancel(); throw new RegistryError(response.status, "authentication", this.registry); }
    let token: Record<string, unknown>;
    try { token = object(JSON.parse(Buffer.from(await responseBytes(response, 1024 * 1024)).toString()), "Token response"); }
    catch { throw new Error("Invalid registry token response"); }
    const value = token.token ?? token.access_token;
    if (typeof value !== "string" || !value) throw new Error("Registry returned no Bearer token");
    const seconds = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : 60;
    return { authorization: `Bearer ${value}`, expires: Date.now() + Math.max(1, seconds - Math.min(30, seconds / 2)) * 1000 };
  }

  async request(path: string | URL, init: RequestInit = {}, scopes: string[] = [], allowed: number[] = []): Promise<Response> {
    const initial = this.safeURL(path);
    const method = init.method ?? "GET";
    const key = [...new Set(scopes)].sort().join(" ");
    const retryable = method === "GET" || method === "HEAD";
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let url = initial;
      let response: Response | undefined;
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          const headers = new Headers(init.headers);
          headers.delete("Authorization");
          const token = this.tokens.get(key);
          if (url.origin === this.origin && token && token.expires > Date.now()) headers.set("Authorization", token.authorization);
          if (!headers.has("Accept")) headers.set("Accept", [media.index, media.manifest, media.dockerIndex, media.dockerManifest, "application/octet-stream"].join(", "));
          // A whole-request deadline also aborts Bun's response stream and
          // slow PATCH bodies. Only bound the wait for GET/HEAD headers here.
          const controller = retryable ? new AbortController() : undefined;
          const timer = controller ? setTimeout(() => controller.abort(), this.options.headersTimeoutMs ?? 120_000) : undefined;
          const signal = controller ? init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal : init.signal;
          try { response = await this.fetcher(url, { ...init, headers, redirect: "manual", signal }); }
          finally { clearTimeout(timer); }
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("Location");
          await response.body?.cancel();
          if (!location || redirects === 5 || (!retryable && ![307, 308].includes(response.status))) throw new Error("Invalid or excessive registry redirect");
          url = this.safeURL(location, url.toString());
        }
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason;
        if (error instanceof Error && /HTTPS|credentials or fragments|registry redirect/.test(error.message)) throw error;
        if (!retryable || attempt >= (this.options.retries ?? 3)) throw new Error(`Registry ${method} connection failed: ${this.registry}`);
        await this.backoff(attempt);
        continue;
      }
      if (!response) throw new Error("No registry response");
      if (response.status === 401 && url.origin === this.origin && !refreshed) {
        const challenge = response.headers.get("WWW-Authenticate") ?? "";
        await response.body?.cancel();
        const hadToken = this.tokens.has(key);
        this.tokens.set(key, await this.authenticate(challenge, scopes, hadToken));
        refreshed = true;
        attempt--;
        continue;
      }
      if (retryable && (response.status === 429 || response.status >= 500) && attempt < (this.options.retries ?? 3)) {
        const after = response.headers.get("Retry-After");
        await response.body?.cancel();
        await this.backoff(attempt, after);
        continue;
      }
      if (!response.ok && !allowed.includes(response.status)) {
        await response.body?.cancel();
        throw new RegistryError(response.status, method, this.registry);
      }
      return response;
    }
  }

  private async backoff(attempt: number, retryAfter?: string | null) {
    const requested = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : NaN;
    const delay = Number.isFinite(requested) ? Math.max(0, Math.min(30_000, requested)) : Math.min(5000, 250 * 2 ** attempt + Math.random() * 100);
    await (this.options.sleep ?? Bun.sleep)(delay);
  }
}
