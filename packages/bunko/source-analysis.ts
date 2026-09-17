import { parseSource, type SourceFile } from "./parser.ts";

/** One lazy AST per loaded file. Callers retain it only for that file's validation. */
export function sourceAnalysis(code: string, name: string): () => SourceFile {
  let source: SourceFile | undefined;
  return () => source ??= parseSource(code, name);
}
