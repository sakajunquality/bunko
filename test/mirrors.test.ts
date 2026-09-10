import { expect, test } from "bun:test";
import { registryMirrors } from "../packages/oci/mirrors.ts";
import { RegistrySource } from "../packages/oci/source.ts";
import { RegistryClient } from "../packages/oci/registry.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { media } from "../packages/oci/types.ts";
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config: {}, layers: [] }));
const digest = sha256(bytes);

test("mirror inputs normalize hosts, preserve order and reject unsafe paths or credentials", () => {
  expect(registryMirrors(["docker.io=mirror.example:443", "index.docker.io=second.example"])).toEqual({ "registry-1.docker.io": ["mirror.example:443", "second.example"] });
  for (const input of ["origin.example", "origin.example=https://mirror.example", "origin.example=user@mirror.example", "origin.example=mirror.example/../path", "origin.example=origin.example:443", "origin.example=mirror.example=extra"]) expect(() => registryMirrors([input])).toThrow();
  expect(() => registryMirrors(["origin.example=mirror.example", "origin.example:443=mirror.example:443"])).toThrow("Duplicate");
});

test("tags remain authoritative at the origin and digest reads use separately authenticated mirrors", async () => {
  const calls: { host: string; path: string; authorization: string | null }[] = [], credentialHosts: string[] = [];
  const source = new RegistrySource("origin.example/team/app:stable", {
    mirrors: { "origin.example": ["mirror.example"] },
    credentials: async (host) => { credentialHosts.push(host); return { username: host, password: "test" }; },
    fetcher: async (value, init) => {
      const url = new URL(value), authorization = new Headers(init?.headers).get("authorization");
      calls.push({ host: url.host, path: url.pathname, authorization });
      if (!authorization) return new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="fixture"' } });
      expect(authorization).toBe(`Basic ${Buffer.from(`${url.host}:test`).toString("base64")}`);
      return new Response(bytes, { headers: { "docker-content-digest": digest, "content-type": media.manifest } });
    },
  });
  expect((await source.root()).descriptor.digest).toBe(digest);
  expect(calls.every((call) => call.host === "origin.example")).toBe(true);
  const stream = await source.blob({ digest, mediaType: media.manifest, size: bytes.length });
  for await (const chunk of stream) expect(Buffer.from(chunk)).toEqual(bytes);
  expect(credentialHosts).toEqual(["origin.example", "mirror.example"]);
  expect(calls.at(-1)!.host).toBe("mirror.example");
});

test("mirror misses and server failures fall back; authentication and corrupt manifests fail closed", async () => {
  for (const status of [404, 500, 401, 403]) {
    const hosts: string[] = [];
    const source = new RegistrySource(`origin.example/team/app@${digest}`, { retries: 0, mirrors: { "origin.example": ["mirror.example"] }, credentials: async () => undefined,
      fetcher: async (value) => { const host = new URL(value).host; hosts.push(host); return host === "mirror.example" ? new Response(null, { status }) : new Response(bytes); } });
    if ([404, 500].includes(status)) { expect((await source.root()).descriptor.digest).toBe(digest); expect(hosts).toEqual(["mirror.example", "origin.example"]); }
    else { await expect(source.root()).rejects.toThrow(); expect(hosts).toEqual(["mirror.example"]); }
  }
  const corrupt = new RegistrySource(`origin.example/team/app@${digest}`, { mirrors: { "origin.example": ["mirror.example"] }, fetcher: async (url) => { expect(new URL(url).host).toBe("mirror.example"); return new Response("corrupt"); } });
  await expect(corrupt.root()).rejects.toThrow("digest mismatch");
});

test("publisher transports never redirect writes to configured mirrors", async () => {
  const methods: string[] = [];
  const client = new RegistryClient("origin.example", { mirrors: { "origin.example": ["mirror.example"] }, fetcher: async (value, init) => { expect(new URL(value).host).toBe("origin.example"); methods.push(init!.method!); return new Response(null, { status: 202 }); } });
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) await client.request("/v2/team/app/blobs/uploads/test", { method }, ["repository:team/app:pull,push"]);
  expect(methods).toEqual(["POST", "PATCH", "PUT", "DELETE"]);
});


test("explicit mirror port 443 retains HTTP opt-in and credential identity", async () => {
  const source = new RegistrySource(`origin.example/app@${digest}`, { mirrors: registryMirrors(["origin.example=mirror.example:443"]), insecure: ["mirror.example:443"],
    credentials: async (host) => { expect(host).toBe("mirror.example:443"); return { username: "mirror", password: "test" }; },
    fetcher: async (value, init) => { expect(new URL(value).origin).toBe("http://mirror.example:443"); return new Headers(init?.headers).has("authorization") ? new Response(bytes) : new Response(null, {status:401,headers:{"www-authenticate":'Basic realm="fixture"'}}); } });
  expect((await source.root()).descriptor.digest).toBe(digest);
});

test("failed mirrors have a short retry budget and a circuit shared by readers", async () => {
  let mirror = 0, origin = 0, warnings = 0;
  const waits: number[] = [];
  const options = { mirrors: { "origin.example": ["mirror.example"] }, credentials: async () => undefined, sleep: async (ms: number) => { waits.push(ms); }, onMirrorFallback: () => { warnings++; },
    fetcher: async (value: string | URL) => { if (new URL(value).host === "mirror.example") { mirror++; return new Response(null, { status: 503, headers: { "Retry-After": "99999" } }); } origin++; return new Response(bytes); } };
  for (let i = 0; i < 3; i++) expect((await new RegistrySource(`origin.example/team/app@${digest}`, options).root()).descriptor.digest).toBe(digest);
  expect(mirror).toBe(2); expect(origin).toBe(3); expect(warnings).toBe(1); expect(waits).toHaveLength(1); expect(waits[0]).toBeCloseTo(250, 0);
  await new RegistrySource(`origin.example/team/app@${digest}`, { ...options }).root();
  expect(mirror).toBe(4);
});

test("a mirror cache miss does not disable other digest lookups", async () => {
  let calls = 0, warnings = 0;
  const options = { mirrors: { "origin.example": ["mirror.example"] }, onMirrorFallback: () => { warnings++; }, fetcher: async (value: string | URL) => {
    if (new URL(value).host === "mirror.example" && ++calls < 3) return new Response(null, { status: 404 }); return new Response(bytes);
  } };
  for (let i = 0; i < 3; i++) await new RegistrySource(`origin.example/team/app@${digest}`, options).root();
  expect(calls).toBe(3); expect(warnings).toBe(1);
});


test("repository-prefixed mirrors use mapped paths and scopes with host-only credentials", async () => {
  const scopes: string[] = [], paths: string[] = [], hosts: string[] = [];
  const source = new RegistrySource(`docker.io/library/app@${digest}`, { mirrors: registryMirrors(["docker.io=us-docker.pkg.dev/example-project/cache"]),
    credentials: async (host) => { hosts.push(host); return { username: "test", password: "test" }; }, fetcher: async (value, init) => {
      const url = new URL(value);
      if (url.host === "auth.example") { scopes.push(url.searchParams.get("scope")!); return Response.json({ token: "mirror-token" }); }
      paths.push(url.pathname); expect(url.host).toBe("us-docker.pkg.dev");
      return new Headers(init?.headers).has("Authorization") ? new Response(bytes) : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } });
    } });
  expect((await source.root()).descriptor.digest).toBe(digest);
  expect(scopes).toEqual(["repository:example-project/cache/library/app:pull"]);
  expect(hosts).toEqual(["us-docker.pkg.dev"]);
  expect(paths.every((path) => path === `/v2/example-project/cache/library/app/manifests/${digest}`)).toBe(true);
  expect(() => registryMirrors(["docker.io=mirror.example/cache", "docker.io=mirror.example:443/cache"])).toThrow("Duplicate");
  expect(registryMirrors(["origin.example=origin.example/cache"])).toEqual({ "origin.example": ["origin.example/cache"] });
});
