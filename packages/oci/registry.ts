import { registryHost } from "./registry-host.ts";
import { dockerCredentials, type CredentialProvider } from "./credentials.ts";
import { object } from "./digest.ts";
import { media } from "./types.ts";

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;
export interface RegistryOptions {
  /** Origin-to-mirror hosts; only RegistrySource uses these for digest reads. */
  mirrors?: Record<string, string[]>;
  onMirrorFallback?: (event: { registry: string; mirror: string; reason: string }) => void;
  sensitivePaths?: string[];
  tls?: Record<string, import("./tls.ts").RegistryTLS>;
  fetcher?: Fetcher;
  credentials?: CredentialProvider;
  insecure?: string[];
  retries?: number;
  /** Deadline for GET/HEAD response headers; it never limits body transfers. */
  headersTimeoutMs?: number;
  /** Maximum idle time between blob body chunks; active transfers have no total deadline. */
  bodyIdleTimeoutMs?: number;
  maxRetryDelayMs?: number;
  /** Parallel per-blob publication work within one manifest, 1–32; see publishConcurrency. */
  publishConcurrency?: number;
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

export class RegistryConnectionError extends Error {}
/** Transport policy failures must survive connection-error wrapping and retries. */
export class RegistryNetworkDisabledError extends Error {}

const errorCodes = new Set(["BLOB_UNKNOWN", "BLOB_UPLOAD_INVALID", "BLOB_UPLOAD_UNKNOWN", "DIGEST_INVALID", "MANIFEST_BLOB_UNKNOWN", "MANIFEST_INVALID", "MANIFEST_UNKNOWN", "NAME_INVALID", "NAME_UNKNOWN", "SIZE_INVALID", "UNAUTHORIZED", "DENIED", "UNSUPPORTED", "TOOMANYREQUESTS", "TAG_INVALID", "MANIFEST_UNVERIFIED"]);

/** Retain standardized diagnostics without echoing untrusted messages or details. */
async function registryErrorCodes(response: Response): Promise<{ codes: string[]; immutableTag: boolean }> {
  if (!response.body) return { codes: [], immutableTag: false };
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) return Buffer.concat(chunks);
          size += value.byteLength;
          if (size > 64 * 1024) throw new Error("Registry error body exceeds limit");
          chunks.push(value);
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Registry error body deadline")), 1000); }),
    ]);
    const value = JSON.parse(bytes.toString());
    const errors = Array.isArray(value?.errors) ? value.errors : [];
    const codes = [...new Set<string>(errors.map((item: any) => item?.code).filter((code: unknown): code is string => typeof code === "string" && errorCodes.has(code)))].slice(0, 8);
    // Classify only explicit immutable-tag refusals; never retain upstream text.
    const immutableTag = [400, 403, 405, 409, 412].includes(response.status) && errors.some((item: any) => ["TAG_INVALID", "DENIED", "UNSUPPORTED"].includes(item?.code) && typeof item.message === "string" && /\bimmutab(?:le|ility)\b|\blocked tag\b|\btag (?:is )?locked\b/i.test(item.message));
    return { codes, immutableTag };
  } catch { return { codes: [], immutableTag: false }; }
  finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Pending cancellation releases the stream. */ }
  }
}

export class RegistryError extends Error {
  /** The refusal's own Retry-After survives the throw: an upload recovery must wait as long as
   * a rate-limited registry asked for, not for its own exponential guess. */
  constructor(readonly status: number, method: string, registry: string, readonly codes: string[] = [], readonly immutableTag = false, readonly retryAfter?: string) {
    super(`Registry ${method} failed (${status}): ${registry}${codes.length ? ` [${codes.join(", ")}]` : ""}`);
  }
  static async response(response: Response, method: string, registry: string): Promise<RegistryError> {
    const after = response.headers.get("Retry-After");
    const diagnostics = await registryErrorCodes(response);
    return new RegistryError(response.status, method, registry, diagnostics.codes, diagnostics.immutableTag, after ?? undefined);
  }
}

/** One client per registry; tokens are scoped to repository/action sets. */
export class RegistryClient {
  readonly origin: string;
  readonly fetcher: Fetcher;
  private readonly credentials: CredentialProvider;
  private readonly insecureOrigins: Set<string>;
  private readonly challenges = new Map<string, string>();
  private readonly tokens = new Map<string, { authorization: string; expires: number }>();
  private readonly pendingTokens = new Map<string, Promise<{ authorization: string; expires: number }>>();
  private cooldownUntil = 0;
  private cooldownTime = 0;
  private cooling?: Promise<unknown>;
  constructor(readonly registry: string, private readonly options: RegistryOptions = {}) {
    registryHost(registry);
    this.insecureOrigins = new Set((options.insecure ?? []).map((host) => new URL(`http://${registryHost(host)}`).origin));
    const http = new URL(`http://${registry}`).origin;
    this.origin = this.insecureOrigins.has(http) ? http : new URL(`https://${registry}`).origin;
    if (options.headersTimeoutMs !== undefined && (!Number.isFinite(options.headersTimeoutMs) || options.headersTimeoutMs <= 0)) throw new Error("Registry header timeout must be positive");
    if (options.maxRetryDelayMs !== undefined && (!Number.isFinite(options.maxRetryDelayMs) || options.maxRetryDelayMs < 0 || options.maxRetryDelayMs > 30_000)) throw new Error("Registry retry delay limit must be between 0 and 30000 ms");
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
    const values: Record<string, string> = Object.create(null);
    for (const match of challenge.replace(/^Bearer\s+/i, "").matchAll(/(?:^|,)\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)) {
      const key = match[1]!.toLowerCase();
      if (Object.hasOwn(values, key)) throw new Error("Ambiguous registry authentication challenge");
      values[key] = match[2] === undefined ? match[3]! : match[2].replace(/\\(.)/g, "$1");
    }
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
    catch (error) { if (error instanceof RegistryNetworkDisabledError) throw error; throw new Error(`Registry token request failed: ${this.registry}`); }
    if (!response.ok) throw await RegistryError.response(response, "authentication", this.registry);
    let token: Record<string, unknown>;
    try { token = object(JSON.parse(Buffer.from(await responseBytes(response, 1024 * 1024)).toString()), "Token response"); }
    catch { throw new Error("Invalid registry token response"); }
    const value = token.token ?? token.access_token;
    if (typeof value !== "string" || !value) throw new Error("Registry returned no Bearer token");
    const seconds = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : 60;
    return { authorization: `Bearer ${value}`, expires: Date.now() + Math.max(1, seconds - Math.min(30, seconds / 2)) * 1000 };
  }

  /** Parallel publication work meets the same 401 in every worker. Share one exchange per
   * scope and challenge so a burst costs one token request, not one per blob. */
  private async token(key: string, challenge: string, scopes: string[], refresh: boolean): Promise<{ authorization: string; expires: number }> {
    const id = `${refresh ? "refresh" : "initial"}\0${key}\0${challenge}`;
    let pending = this.pendingTokens.get(id);
    if (!pending) {
      pending = this.authenticate(challenge, scopes, refresh);
      this.pendingTokens.set(id, pending);
      // Every caller awaits the shared promise; this only keeps a rejection from being
      // reported as unhandled before the first caller resumes.
      void pending.catch(() => {});
    }
    try { return await pending; } finally { if (this.pendingTokens.get(id) === pending) this.pendingTokens.delete(id); }
  }

  async request(path: string | URL, init: RequestInit = {}, scopes: string[] = [], allowed: number[] = []): Promise<Response> {
    const initial = this.safeURL(path);
    const method = init.method ?? "GET";
    const key = [...new Set(scopes)].sort().join(" ");
    const retryable = method === "GET" || method === "HEAD";
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      const previous = this.tokens.get(key), challenge = this.challenges.get(key);
      if (initial.origin === this.origin && previous && previous.expires <= Date.now() && challenge) {
        this.tokens.set(key, await this.token(key, challenge, scopes, true));
      }
      let url = initial;
      let response: Response | undefined;
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          await this.cool(0);
          init.signal?.throwIfAborted();
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
        if (error instanceof RegistryNetworkDisabledError) throw error;
        if (error instanceof Error && /HTTPS|credentials or fragments|registry redirect/.test(error.message)) throw error;
        if (!retryable || attempt >= (this.options.retries ?? 3)) throw new RegistryConnectionError(`Registry ${method} connection failed: ${this.registry}`);
        await this.backoff(attempt);
        continue;
      }
      if (!response) throw new Error("No registry response");
      if (response.status === 401 && url.origin === this.origin && !refreshed) {
        const challenge = response.headers.get("WWW-Authenticate") ?? "";
        await response.body?.cancel();
        const hadToken = this.tokens.has(key);
        this.tokens.set(key, await this.token(key, challenge, scopes, hadToken));
        this.challenges.set(key, challenge);
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
        throw await RegistryError.response(response, method, this.registry);
      }
      return response;
    }
  }

  /** A rate limit applies to the whole account, not to one request, so a Retry-After pause is
   * shared by this client's workers. Ordinary retry backoff stays per request. */
  async backoff(attempt: number, retryAfter?: string | null) {
    const requested = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : NaN;
    const throttled = Number.isFinite(requested);
    const delay = throttled ? Math.max(0, Math.min(30_000, requested)) : Math.min(5000, 250 * 2 ** attempt + Math.random() * 100);
    const bounded = Math.min(delay, this.options.maxRetryDelayMs ?? 30_000);
    if (!throttled) { await (this.options.sleep ?? Bun.sleep)(bounded); return; }
    await this.cool(bounded);
  }

  /** Each refusal extends a monotonic deadline. Advancing the logical clock by a
   * completed sleep also supports injected sleeps that resolve without real time passing. */
  private async cool(delayMs: number): Promise<void> {
    const now = () => Math.max(performance.now(), this.cooldownTime);
    if (delayMs > 0) this.cooldownUntil = Math.max(this.cooldownUntil, now() + delayMs);
    while (this.cooldownUntil > now()) {
      if (!this.cooling) {
        const deadline = this.cooldownUntil;
        this.cooling = Promise.resolve((this.options.sleep ?? Bun.sleep)(deadline - now()))
          .finally(() => { this.cooling = undefined; this.cooldownTime = Math.max(this.cooldownTime, deadline); });
      }
      await this.cooling;
    }
  }

}


const clients = new WeakMap<RegistryOptions, Map<string, RegistryClient>>();

/** Reuse scoped tokens only within the same immutable transport/credential options. */
export function registryClient(registry: string, options: RegistryOptions = {}, mirror = false): RegistryClient {
  let pool = clients.get(options);
  if (!pool) { pool = new Map(); clients.set(options, pool); }
  const key = `${mirror ? "mirror" : "origin"}:${registry}`;
  let client = pool.get(key);
  if (!client) {
    client = new RegistryClient(registry, mirror ? { ...options, retries: Math.min(options.retries ?? 1, 1), headersTimeoutMs: Math.min(options.headersTimeoutMs ?? 5000, 5000), maxRetryDelayMs: Math.min(options.maxRetryDelayMs ?? 250, 250) } : options);
    pool.set(key, client);
  }
  return client;
}
