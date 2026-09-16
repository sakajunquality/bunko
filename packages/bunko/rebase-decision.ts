export type RebaseDecision = "compatible" | "requires-policy" | "requires-rebuild" | "error";
/** Typed compatibility outcomes must never classify authentication or transport errors by message text. */
export class RebaseDecisionError extends Error {
  constructor(readonly decision: "requires-policy" | "requires-rebuild", readonly reason: string, message: string, readonly changes?: string[]) { super(message); }
  get exitCode() { return this.decision === "requires-policy" ? 3 : 4; }
}
