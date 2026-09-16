import { expect, test } from "bun:test";
import { registryCredentials } from "../packages/oci/credential-sources.ts";
import { credentialRequest } from "../packages/oci/credential-http.ts";
import { buildArguments } from "../build/run.ts";
import { rebaseArguments } from "../rebase/run.ts";

test("Google sources are host-bound and explicit tokens bypass metadata without fallback", async () => {
  let requests = 0;
  const fetcher = async () => { requests++; throw new Error("SECRET"); };
  const provider = registryCredentials(["google"], { env: { GOOGLE_OAUTH_ACCESS_TOKEN: "SECRET" }, fetcher });
  for (const host of ["gcr.io", "us.gcr.io", "asia-northeast1-docker.pkg.dev:443"]) expect(await provider(host)).toMatchObject({ username: "oauth2accesstoken", password: "SECRET" });
  for (const host of ["gcr.io.attacker.test", "foo.pkg.dev", "gcr.io:8080", "evilpkg.dev", "ghcr.io"]) expect(await provider(host)).toBeUndefined();
  expect(requests).toBe(0);
  await expect(registryCredentials(["google", "github"], { env: { GOOGLE_OAUTH_ACCESS_TOKEN: "" }, fetcher })("gcr.io")).rejects.toThrow("Google access token");
  expect(requests).toBe(0);
});
test("metadata uses fixed address, rejects redirects, validates response flavor and refreshes expiring tokens", async () => {
  let requests = 0;
  const provider = registryCredentials(["google"], { env: {}, fetcher: async (url, init) => {
    requests++; expect(String(url)).toBe("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token");
    expect(init?.redirect).toBe("error"); expect(new Headers(init?.headers).get("Metadata-Flavor")).toBe("Google");
    expect((init as any).proxy).toBe("");
    return Response.json({ access_token: `token${requests}`, token_type: "Bearer", expires_in: requests === 1 ? 1 : 3600 }, { headers: { "Metadata-Flavor": "Google" } });
  } });
  expect((await provider("gcr.io"))?.password).toBe("token1");
  expect((await provider("gcr.io"))?.password).toBe("token2");
  expect((await provider("gcr.io"))?.password).toBe("token2"); expect(requests).toBe(2);
  await expect(registryCredentials(["google"], { env: {}, fetcher: async () => Response.json({ access_token: "SECRET" }) })("gcr.io")).rejects.toThrow("metadata response");
});
test("credential requests bound stalled bodies, redact failures and retry only transient errors", async () => {
  let calls = 0;
  await expect(credentialRequest("google", "https://example.test", {}, { timeoutMs: 10, fetcher: async () => { calls++; return new Response("SECRET", { status: 403 }); } })).rejects.toThrow("google credential request failed (HTTP 403)"); expect(calls).toBe(1);
  calls = 0;
  const result = await credentialRequest("google", "https://example.test", {}, { fetcher: async () => ++calls === 1 ? new Response("SECRET", { status: 503 }) : new Response("ok") });
  expect(result.text).toBe("ok"); expect(calls).toBe(2);
  await expect(credentialRequest("google", "https://example.test", {}, { timeoutMs: 10, fetcher: async () => new Response(new ReadableStream({ start() {} })) })).rejects.toThrow("credential request failed");
  await expect(credentialRequest("google", "https://example.test", {}, { fetcher: async () => new Response("x".repeat(1024 * 1024 + 1)) })).rejects.toThrow("credential request failed");
});
test("build and rebase Actions forward authentication sources without shell interpretation", () => {
  const value = "docker,google";
  expect(buildArguments({ "auth-sources": value }, "/tmp/action").args).toContain(value);
  expect(rebaseArguments({ image: "app", "old-base": "old", base: "new", "auth-sources": value }, "/report")).toContain(value);
});
