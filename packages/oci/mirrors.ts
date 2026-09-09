import { registryHost } from "./registry-host.ts";
export { registryHost } from "./registry-host.ts";

export function registryMirrors(items: string[] | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null);
  for (const item of items ?? []) {
    const parts = item.split("=");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("--registry-mirror requires ORIGIN=MIRROR");
    const origin = registryHost(parts[0], true), mirror = registryHost(parts[1]);
    if (origin === registryHost(mirror, true)) throw new Error("Registry mirror must differ from its origin");
    const mirrors = result[origin] ??= [];
    if (mirrors.some((host) => registryHost(host, true) === registryHost(mirror, true))) throw new Error("Duplicate registry mirror");
    if (mirrors.length >= 8) throw new Error("At most eight mirrors are allowed per registry");
    mirrors.push(mirror);
  }
  return result;
}
