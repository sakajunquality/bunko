import { awsCredentials } from "./aws-credentials.ts";
import { googleCredentials } from "./google-credentials.ts";
import type { CredentialTransport } from "./credential-http.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { dockerCredentials, type Credential, type CredentialProvider, type HelperRunner } from "./credentials.ts";
import { registryHost } from "./registry-host.ts";

export type AuthSource = "docker" | "github" | "google" | "aws";
export interface CredentialSourcesOptions extends CredentialTransport {
  env?: Record<string, string | undefined>;
  helper?: HelperRunner;
}
export function authSources(values?: string[], environment = process.env.BUNKO_AUTH_SOURCES): AuthSource[] {
  const names = (values ?? (environment === undefined ? ["docker"] : [environment])).flatMap((value) => value.split(",").map((name) => name.trim()));
  if (!names.length || names.some((name) => !["docker", "github", "google", "aws"].includes(name))) throw new Error("Auth sources must be a nonempty list of docker, github, google or aws");
  return [...new Set(names)] as AuthSource[];
}
export function dockerConfigPath(env: Record<string, string | undefined> = process.env): string {
  return env.BUNKO_DOCKER_CONFIG ?? join(env.DOCKER_CONFIG ?? join(homedir(), ".docker"), "config.json");
}
/** Sources are enabled explicitly; a configured identity is authoritative even when unavailable. */
export function registryCredentials(values?: string[], options: CredentialSourcesOptions = {}): CredentialProvider {
  const env = options.env ?? process.env;
  const sources = authSources(values, env.BUNKO_AUTH_SOURCES);
  const explicit = values !== undefined || env.BUNKO_AUTH_SOURCES !== undefined;
  const file = dockerConfigPath(env);
  if (!explicit) return Object.assign(dockerCredentials(file, options.helper), { bridge: false });
  const pending = new Map<string, Promise<Credential | undefined>>();
  const cache = new Map<string, Credential | undefined>();
  async function lookup(registry: string): Promise<Credential | undefined> {
    for (const source of sources) {
      let credential: Credential | undefined;
      if (source === "docker") {
        let configured = false;
        credential = await dockerCredentials(file, options.helper, () => { configured = true; }, true)(registry);
        if (configured && !credential) return; // Preserve anonymous access, but never try a different identity.
      } else if (source === "github" && registry === "ghcr.io") {
        const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
        if (token !== undefined) {
          if (!token || /[\s\x00-\x1f]/.test(token)) throw new Error("Invalid github credential input");
          const username = env.GITHUB_ACTOR || "x-access-token";
          if (/[:\s\x00-\x1f]/.test(username)) throw new Error("Invalid github actor");
          credential = { username, password: token };
        }
      }
      if (source === "aws") credential = await awsCredentials(registry, env, options);
      if (source === "google") credential = await googleCredentials(registry, env, options);
      if (credential) return { ...credential, source };
    }
  }
  const provider: CredentialProvider = (input, refresh) => {
    const registry = registryHost(input, true);
    const active = pending.get(registry); if (active) return active;
    const cached = cache.get(registry);
    if (!refresh && cache.has(registry) && (!cached?.expires || cached.expires > Date.now() + 30_000)) return Promise.resolve(cached);
    const work = lookup(registry).then((value) => { cache.set(registry, value); return value; }).finally(() => pending.delete(registry));
    pending.set(registry, work); return work;
  };
  provider.bridge = sources.some((source) => source !== "docker");
  provider.sensitivePaths = [...(sources.includes("docker") ? [file] : []), ...(sources.includes("aws") ? [env.AWS_WEB_IDENTITY_TOKEN_FILE, env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE].filter((path): path is string => Boolean(path)) : [])];
  return provider;
}
