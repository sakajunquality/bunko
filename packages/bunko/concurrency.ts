/** Limit open file streams while preserving input order and draining on failure. */
export async function mapJobs<T, R>(values: readonly T[], jobs: number, map: (value: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 32) throw new Error("jobs must be an integer from 1 to 32");
  const results = new Array<R>(values.length);
  let next = 0, failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(jobs, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await map(values[index]!); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}

export async function mapFiles<T, R>(values: readonly T[], map: (value: T) => Promise<R>): Promise<R[]> { return mapJobs(values, 16, map); }
