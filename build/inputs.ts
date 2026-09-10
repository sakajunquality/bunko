// Parsing shared by the build Action steps.

/**
 * A newline-separated Action input, such as `targets` or `tags`: one value per line, surrounding
 * whitespace removed and blank lines dropped. Commas are not separators; they belong to a value.
 * Both the build step and the cache key derive their target selection from this one function, so
 * the two always agree on which targets a stored cache entry was built for.
 */
export const list = (value?: string): string[] => (value ?? "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
