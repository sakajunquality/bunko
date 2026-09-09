import { expect, test } from "bun:test";
import { registryClient } from "../packages/oci/registry.ts";
import { RegistrySource } from "../packages/oci/source.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { media } from "../packages/oci/types.ts";

test("registry readers and publishers reuse clients only for identical option objects", async () => {
  let tokens = 0;
  const scopes: string[] = [];
  const options = { credentials: async () => undefined, fetcher: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.host === "auth.example") { tokens++; scopes.push(url.searchParams.get("scope")!); return Response.json({ token: "scoped", expires_in: 3600 }); }
    if (!new Headers(init?.headers).has("Authorization")) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } });
    return Response.json({ schemaVersion: 2, mediaType: media.index, manifests: [] });
  } };
  for (const tag of ["first", "second", "third"]) await new RegistrySource(`registry.example/team/app:${tag}`, options).root();
  expect(tokens).toBe(1); expect(scopes).toEqual(["repository:team/app:pull"]);
  expect(new Publisher("registry.example/team/app", options).client).toBe(new RegistrySource("registry.example/team/app", options).client);
  await new RegistrySource("registry.example/team/other", options).root(); expect(tokens).toBe(2);
  await new RegistrySource("registry.example/team/app", { ...options }).root(); expect(tokens).toBe(3);
  expect(registryClient("registry.example", options, true)).not.toBe(registryClient("registry.example", options));
});
