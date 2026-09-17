import { expect, test } from "bun:test";
import { assertActionVersion, minimumActionCLI } from "../scripts/action-compatibility.ts";
import { fallbackVersion } from "../scripts/setup.ts";
import { imageResults } from "../build/run.ts";

test("Actions reject older/unrecognized CLIs and the local setup fallback satisfies the minimum", () => {
  for (const version of ["0.8.0", "0.9.0", "malformed", "1.0.0"]) expect(() => assertActionVersion(version)).toThrow("requires bunko");
  expect(() => assertActionVersion(minimumActionCLI)).not.toThrow();
  expect(() => assertActionVersion(fallbackVersion.slice(1))).not.toThrow();
  expect(() => imageResults({ schemaVersion: 999, status: "success" })).toThrow("Unsupported build report schema");
});
