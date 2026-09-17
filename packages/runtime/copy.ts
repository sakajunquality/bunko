import { cp } from "node:fs/promises";
import { throwIfCancelled } from "./invocation.ts";

/** Native copy stays bounded to one file; observe cancellation before every tree entry. */
export async function copyTree(source: string, destination: string): Promise<void> {
  throwIfCancelled();
  await cp(source, destination, { recursive: true, filter() { throwIfCancelled(); return true; } });
  throwIfCancelled();
}
