/** Validate registry authorities, including bracketed IPv6 literals. */
export function registryHost(value: string, normalize = false): string {
  if (typeof value !== "string" || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\])(?::[0-9]+)?$/.test(value)) throw new Error("Registry endpoints must be hosts with optional ports");
  let host: string;
  try { host = new URL(`https://${value}`).host.toLowerCase(); }
  catch { throw new Error("Invalid registry endpoint"); }
  const selected = normalize ? host : value.toLowerCase();
  return ["docker.io", "index.docker.io"].includes(selected) ? "registry-1.docker.io" : selected;
}
