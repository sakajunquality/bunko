import { readFile } from "node:fs/promises";
import { scanPrivateOutput } from "./privacy.ts";

// Keep private identifiers in a local file, never in command arguments or reports.
try {
  const directory = process.env.BUNKO_QUARANTINE;
  const termsFile = process.env.BUNKO_PRIVATE_TERMS_FILE;
  if (!directory || !termsFile) throw new Error();
  const terms: unknown = JSON.parse(await readFile(termsFile, "utf8"));
  if (!Array.isArray(terms)) throw new Error();
  await scanPrivateOutput(directory, terms);
  console.log(JSON.stringify({ schemaVersion: 1, identifierGate: "passed", publicationApproved: false }));
} catch {
  console.log(JSON.stringify({ schemaVersion: 1, identifierGate: "failed", publicationApproved: false }));
  process.exitCode = 1;
}
