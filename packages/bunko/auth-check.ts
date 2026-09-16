import { RegistryClient, type RegistryOptions } from "../oci/registry.ts";
import { registryCredentials } from "../oci/credential-sources.ts";
import { registryHost } from "../oci/registry-host.ts";
import { defaultAuthOrigins, registryAuthOrigins } from "../oci/auth-origins.ts";

/** An authentication probe is not a proof of repository push permission. */
export async function authCheck(host: string, scope: string | undefined, options: RegistryOptions = {}) {
  const registry = registryHost(host, true);
  if (scope !== undefined && !/^repository:[A-Za-z0-9._/-]+:(?:pull|push)(?:,(?:pull|push))*$/.test(scope)) throw new Error("Use a repository scope with pull and/or push actions");
  const client = new RegistryClient(registry, options);
  const provider = options.credentials ?? registryCredentials();
  const credential = await provider(registry);
  const allowed = [client.origin, ...(options.authOrigins ? registryAuthOrigins(options.authOrigins)[registry] ?? defaultAuthOrigins(registry) : defaultAuthOrigins(registry))];
  let challenge = false, realm: string | undefined;
  const transport = options.fetcher ?? fetch;
  const probe = new RegistryClient(registry, { ...options, credentials: provider, fetcher: async (url, init) => {
    const response = await transport(url, init);
    if (new URL(url).origin === client.origin && response.status === 401) {
      challenge = true;
      const value = /\brealm="([^"\r\n]+)"/i.exec(response.headers.get("www-authenticate") ?? "")?.[1];
      if (value) { try { const parsed = new URL(value); if (!parsed.username && !parsed.password) realm = parsed.origin; } catch { /* Invalid challenges are rejected by RegistryClient. */ } }
    }
    return response;
  } });
  const summary = () => ({ schemaVersion: 1, registry, source: credential?.source ?? (credential ? "configured" : "anonymous"),
    credentialKind: credential?.registryToken ? "registry-token" : credential?.identityToken ? "identity-token" : credential ? "basic" : "none",
    challenge, ...(realm ? { realmOrigin: realm, realmAllowed: allowed.includes(realm) } : {}), requestedScope: scope ?? null,
    repositoryPermissions: "unverified" as const });
  try {
    const response = await probe.request("/v2/", {}, scope ? [scope] : []); await response.body?.cancel();
    return { ...summary(), status: "success", authentication: challenge ? "challenge-accepted" : "not-challenged" };
  } catch {
    return { ...summary(), status: "failed", authentication: "failed", error: "Registry authentication probe failed; check credentials, transport and allowed auth origins" };
  }
}
