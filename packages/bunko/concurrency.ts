/** Limit open file streams while preserving input order and draining on failure. */
export async function mapFiles<T, R>(values: readonly T[], map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0, failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(16, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await map(values[index]!); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
