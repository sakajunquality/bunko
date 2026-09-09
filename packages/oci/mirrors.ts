import { registryHost } from "./registry-host.ts";
export { registryHost } from "./registry-host.ts";

export function mirrorEndpoint(value: string): { registry: string; prefix: string; name: string } {
  if (typeof value !== "string") throw new Error("Registry mirror must be a host with an optional repository prefix");
  const [host, ...components] = value.split("/");
  const registry = registryHost(host!);
  if (components.some((part) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))) throw new Error("Invalid registry mirror repository prefix");
  const prefix = components.join("/");
  return { registry, prefix, name: registry + (prefix ? `/${prefix}` : "") };
}

export function registryMirrors(items: string[] | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null);
  for (const item of items ?? []) {
    const parts = item.split("=");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("--registry-mirror requires ORIGIN=MIRROR");
    const origin = registryHost(parts[0], true), mirror = mirrorEndpoint(parts[1]);
    if (origin === registryHost(mirror.registry, true) && !mirror.prefix) throw new Error("Registry mirror must differ from its origin");
    const mirrors = result[origin] ??= [];
    if (mirrors.some((value) => { const prior = mirrorEndpoint(value); return registryHost(prior.registry, true) === registryHost(mirror.registry, true) && prior.prefix === mirror.prefix; })) throw new Error("Duplicate registry mirror");
    if (mirrors.length >= 8) throw new Error("At most eight mirrors are allowed per registry");
    mirrors.push(mirror.name);
  }
  return result;
}


export function selectRegistryMirrors(flags: string[] | undefined, environment: string | undefined, configured: Record<string, string[]> = {}): Record<string, string[]> {
  if (flags !== undefined) return registryMirrors(flags);
  if (environment !== undefined) return registryMirrors(environment.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return configured;
}
