import { readFile } from "node:fs/promises";
import { sha256 } from "../oci/digest.ts";
import { rejectMacroSyntax } from "./syntax.ts";

/** Invocation-local validation memoization. File bytes are always reread and
 * hashed; paths remain part of the key because parser behavior can depend on them. */
export class SyntaxCache {
  private readonly valid = new Map<string, true>();
  readonly stats = { parsed: 0, reused: 0, bytes: 0 };
  constructor(private readonly limit = 50_000) {}
  async check(file: string, name: string): Promise<void> {
    const bytes = await readFile(file), key = `${name}\0${sha256(bytes)}`;
    this.stats.bytes += bytes.length;
    if (this.valid.has(key)) {
      this.valid.delete(key); this.valid.set(key, true); this.stats.reused++; return;
    }
    rejectMacroSyntax(bytes.toString("utf8"), name);
    this.stats.parsed++;
    if (this.limit <= 0) return;
    if (this.valid.size >= this.limit) this.valid.delete(this.valid.keys().next().value!);
    this.valid.set(key, true);
  }
}
