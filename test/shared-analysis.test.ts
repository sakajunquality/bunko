import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("worker validators share one real AST while preserving lazy prefilters", async () => {
  // Isolate module instrumentation from the rest of the test suite.
  const script = `
    import {mock} from 'bun:test';
    import * as ts from 'typescript';
    const create = ts.createSourceFile; let count = 0;
    mock.module('typescript', () => ({...ts, createSourceFile: (...args) => { count++; return create(...args); }}));
    const {sourceAnalysis} = await import('./packages/bunko/source-analysis.ts');
    const {moduleLocations} = await import('./packages/bunko/location-diagnostics.ts');
    const {rejectMacroSyntax, rejectApplicationImports} = await import('./packages/bunko/syntax.ts');
    const code = 'import {x} from "./x"; export const result = [x, import.meta.url];';
    const analysis = sourceAnalysis(code, 'src/index.ts');
    const warnings = moduleLocations(code, 'src/index.ts', analysis);
    rejectMacroSyntax(code, 'src/index.ts', analysis);
    rejectApplicationImports(code, 'src/index.ts', analysis);
    const plain = 'console.log(1)', unused = sourceAnalysis(plain, 'plain.ts');
    moduleLocations(plain, 'plain.ts', unused); rejectMacroSyntax(plain, 'plain.ts', unused); rejectApplicationImports(plain, 'plain.ts', unused);
    console.log(JSON.stringify({count, warnings: warnings.map(w => w.expression)}));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: resolve("."), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ count: 1, warnings: ["import.meta.url"] });
});

test("deep diagnostics takes one snapshot for multiple workspace targets", async () => {
  const script = `
    import {mock} from 'bun:test';
    import {rm} from 'node:fs/promises';
    import {temporary} from './test/helpers.ts';
    import {workspaceFixture} from './test/workspace-fixture.ts';
    const files = await import('./packages/bunko/files.ts');
    const snapshot = files.snapshot; let calls = 0;
    mock.module('./packages/bunko/files.ts', () => ({...files, snapshot: async (...args) => { calls++; return snapshot(...args); }}));
    const {checkConfig} = await import('./packages/bunko/diagnostics.ts');
    const root = await temporary();
    try {
      const {source} = await workspaceFixture(root);
      const result = await checkConfig({path: source, deep: true});
      console.log(JSON.stringify({calls, targets: result.targets.length}));
    } finally { await rm(root, {recursive: true, force: true}); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: resolve("."), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ calls: 1, targets: 2 });
});
