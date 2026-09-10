import { throwIfCancelled } from "../runtime/invocation.ts";
/** The lowest-index rejection, kept separately from its reason: a job may reject with a falsy
 * value (a credential provider throwing `undefined`), and a caller must still see the failure. */
export interface BoundedFailure { index: number; reason: unknown }

/** Bounded fan-out for registry round trips. Input order is preserved, no job starts after a
 * failure, and every started job settles before returning, so a failed batch never leaves an
 * upload in flight unreported. The reported failure is the lowest-index one, which is the
 * failure the sequential loop this replaced would have raised. */
export async function boundedMap<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<{ results: (R | undefined)[]; failure?: BoundedFailure }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("Concurrency must be an integer from 1 to 32");
  const results = new Array<R | undefined>(values.length);
  // `failed` is tracked apart from the rejection value so a falsy reason still stops the batch.
  let next = 0, failed = false, failedIndex = 0, reason: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { throwIfCancelled(); results[index] = await map(values[index]!); }
      catch (error) { if (!failed || index < failedIndex) { failed = true; failedIndex = index; reason = error; } }
    }
  }));
  return failed ? { results, failure: { index: failedIndex, reason } } : { results };
}
