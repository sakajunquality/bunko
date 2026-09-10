/** Stable supported host toolchains; verified compile runtimes have separate exact pins. */
export function supportedBunVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^1\.(3|4)\.(0|[1-9]\d*)$/.exec(value);
  return Boolean(match && (match[1] === "4" || Number(match[2]) >= 13));
}
