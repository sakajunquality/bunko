/** Invocation constants are explicit values, never ambient environment lookups. */
export function parseDefines(items: string[] | undefined): Record<string, string> {
  const values = new Map<string, string>();
  for (const item of items ?? []) {
    const equals = item.indexOf("="), key = item.slice(0, equals);
    if (equals < 1 || equals === item.length - 1 || !/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/.test(key) || item.includes("\0")) throw new Error("--define requires KEY=VALUE with an identifier or dotted key and an explicit value");
    if (values.has(key)) throw new Error("Duplicate --define key");
    values.set(key, item.slice(equals + 1));
  }
  return Object.fromEntries(values);
}
