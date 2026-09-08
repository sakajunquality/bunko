/** Mirrors share repository names with their origin and only serve digest-addressed reads. */
export function registryHost(value: string, normalize = false): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(value)) throw new Error("Registry mirror endpoints must be hosts with optional ports");
  let host: string;
  try { host = new URL(`https://${value}`).host.toLowerCase(); }
  catch { throw new Error("Invalid registry mirror endpoint"); }
  const selected = normalize ? host : value.toLowerCase();
  return ["docker.io", "index.docker.io"].includes(selected) ? "registry-1.docker.io" : selected;
}

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
