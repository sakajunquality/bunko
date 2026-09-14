import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export function catalog(): string[] {
  // The negative control intentionally uses the original source module's location.
  const root = process.env.CATALOG_LOCATION === "module"
    ? resolve(import.meta.dir, "../../bunkodata")
    : process.env.BUNKO_DATA_PATH!;
  try {
    return readdirSync(resolve(root, "catalog")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
  } catch {
    // A successful response with an empty fallback is the regression under test.
    return [];
  }
}
