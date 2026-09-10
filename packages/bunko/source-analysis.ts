import { createSourceFile, ScriptTarget, type SourceFile } from "typescript";

/** One lazy AST per loaded file. Callers retain it only for that file's validation. */
export function sourceAnalysis(code: string, name: string): () => SourceFile {
  let source: SourceFile | undefined;
  return () => source ??= createSourceFile(name, code, ScriptTarget.Latest, true);
}
