import type { Credential } from "./credentials.ts";
import { credentialJSON, credentialRequest, secret, type CredentialTransport } from "./credential-http.ts";

export function googleRegistry(host: string): boolean {
  return host === "gcr.io" || /^[a-z0-9-]+\.gcr\.io$/.test(host) || /^[a-z0-9-]+-docker\.pkg\.dev$/.test(host);
}
export async function googleCredentials(host: string, env: Record<string, string | undefined>, transport: CredentialTransport = {}): Promise<Credential | undefined> {
  if (!googleRegistry(host)) return;
  if (env.GOOGLE_OAUTH_ACCESS_TOKEN !== undefined) return { username: "oauth2accesstoken", password: secret(env.GOOGLE_OAUTH_ACCESS_TOKEN, "Google access token") };
  const response = await credentialRequest("google", "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } }, transport, true);
  if (response.headers.get("Metadata-Flavor") !== "Google") throw new Error("Invalid google metadata response");
  const token = credentialJSON(response.text);
  if (token.token_type !== "Bearer" || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 86400) throw new Error("Invalid google token lifetime or type");
  return { username: "oauth2accesstoken", password: secret(token.access_token), expires: Date.now() + token.expires_in * 1000 };
}
