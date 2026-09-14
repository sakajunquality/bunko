import { expect, test } from "bun:test";
import { RegistryClient, type RegistryOptions } from "../packages/oci/registry.ts";
import { registryAuthOrigins } from "../packages/oci/auth-origins.ts";
import { registryTLS } from "../packages/oci/tls.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function exchange(registry: string, realm: string, options: RegistryOptions = {}) {
  const sent: { origin: string; auth: string | null; body?: BodyInit | null }[] = [];
  const client = new RegistryClient(registry, { credentials: async () => ({ username: "fixture", password: "secret" }), ...options,
    fetcher: async (input, init) => {
      const url = new URL(input), auth = new Headers(init?.headers).get("Authorization");
      if (url.pathname === "/token") { sent.push({ origin: url.origin, auth, body: init?.body }); return Response.json({ token: "scoped" }); }
      return auth === "Bearer scoped" ? new Response("ok") : new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer realm="${realm}"` } });
    },
  });
  let error: unknown;
  try { await client.request("/v2/"); } catch (failure) { error = failure; }
  return { sent, error };
}

test("Basic and refresh credentials never reach an unapproved token service", async () => {
  for (const credential of [{ username: "fixture", password: "secret" }, { identityToken: "secret" }]) {
    const result = await exchange("registry.example", "https://unapproved.example/token?private=secret", { credentials: async () => credential });
    expect(result.sent).toHaveLength(0);
    expect(String(result.error)).toContain("authentication origin is not allowed");
    expect(String(result.error)).not.toContain("secret");
  }
});

test("same-origin and standard Docker Hub exchanges remain supported", async () => {
  for (const [registry, realm] of [["registry.example", "https://registry.example/token"], ["registry-1.docker.io", "https://auth.docker.io/token"]]) {
    const result = await exchange(registry!, realm!);
    expect(result.error).toBeUndefined(); expect(result.sent).toHaveLength(1);
    expect(result.sent[0]!.auth).toStartWith("Basic ");
  }
});

test("allowlists match exact registry, scheme and port and never trust suffixes", async () => {
  const authOrigins = { "registry.example": ["https://auth.example:8443"] };
  const accepted = await exchange("registry.example", "https://auth.example:8443/token", { authOrigins, credentials: async () => ({ identityToken: "secret" }) });
  expect(accepted.error).toBeUndefined(); expect(String(accepted.sent[0]!.body)).toContain("refresh_token=secret");
  for (const [registry, realm] of [["other.example", "https://auth.example:8443/token"], ["registry.example", "https://auth.example/token"], ["registry.example", "https://sub.auth.example:8443/token"]]) {
    const result = await exchange(registry!, realm!, { authOrigins }); expect(result.sent).toHaveLength(0); expect(result.error).toBeInstanceOf(Error);
  }
  const http = await exchange("registry.example", "http://auth.example/token", { authOrigins: { "registry.example": ["http://auth.example"] } });
  expect(http.sent).toHaveLength(0); expect(String(http.error)).toContain("HTTPS");
  const allowedHTTP = await exchange("registry.example", "http://auth.example/token", { authOrigins: { "registry.example": ["http://auth.example"] }, insecure: ["auth.example"] });
  expect(allowedHTTP.error).toBeUndefined(); expect(allowedHTTP.sent).toHaveLength(1);
});

test("anonymous exchanges remain anonymous and an explicit empty list removes Docker Hub's extra default", async () => {
  const anonymous = await exchange("registry.example", "https://auth.example/token", { credentials: async () => undefined });
  expect(anonymous.error).toBeUndefined(); expect(anonymous.sent[0]!.auth).toBeNull(); expect(anonymous.sent[0]!.body).toBeUndefined();
  const denied = await exchange("registry-1.docker.io", "https://auth.docker.io/token", { authOrigins: { "docker.io": [] } });
  expect(denied.sent).toHaveLength(0); expect(denied.error).toBeInstanceOf(Error);
});

test("versioned configuration loads authentication origins and rejects unsafe values", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-auth-origins-"));
  try {
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, authOrigins: { "docker.io": ["https://auth.example:443/"] } }));
    expect((await registryTLS(file)).authOrigins).toEqual({ "registry-1.docker.io": ["https://auth.example"] });
    for (const origin of ["https://*.example", "https://auth.example/token", "https://user:secret@auth.example", "https://auth.example/?secret", "https://auth.example/#secret", "ftp://auth.example"]) {
      expect(() => registryAuthOrigins({ "registry.example": [origin] })).toThrow();
    }
    expect(() => registryAuthOrigins({ "docker.io": [], "registry-1.docker.io": [] })).toThrow("Duplicate");
  } finally { await rm(root, { recursive: true, force: true }); }
});
