# Source parser

bunko uses the pinned `@babel/parser` 7.29.8 behind `packages/bunko/parser.ts`. The parser is included in the distributed CLI; no Babel installation or native parser library is required on the build host. TypeScript 7.0.2 is a development-only native typechecker; its platform package is needed for repository development, not for running the distributed bunko CLI. The parser is independent of this compiler: [TypeScript 7 does not provide the former JavaScript compiler API](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

The adapter supplies syntax trees, child traversal, parent links, literal module specifiers and reference classification. Macro/data-import guards, lexical scope analysis, Node runtime guards, module-location diagnostics and conservative workspace input discovery share this boundary. Parsing does not resolve modules, execute source, transform code or load project Babel plugins/configuration. Bun still performs the actual build and module resolution.

## Compatibility

JavaScript files use Babel's JavaScript grammar; TypeScript grammar is enabled only for TypeScript extensions. This prevents JavaScript expressions such as `a < Bun > (c)` from being hidden as a type assertion. The configured grammar covers JavaScript, TypeScript, JSX/TSX, CommonJS, decorators and existing import attributes, including legacy `assert`. Deferred import evaluation (`import defer ...` and `import.defer(...)`) is intentionally rejected with an explicit unsupported-syntax error because Bunko does not model its loading semantics or dependency discovery. Decorators are accepted when written before an exported declaration (`@dec export class A {}`); Babel still rejects the alternate `export @dec class A {}` placement, which Bunko reports as unsupported or invalid executable syntax. Uncertain workspace input discovery falls back to the complete snapshot. Its fingerprint policy changes to `member-inputs-v2`, so previous narrowed-input cache entries are not reused under different parsing semantics.

Regression coverage includes commented and escaped imports, macro specifiers, empty attribute blocks, dynamic data loaders, shadowed names, unreachable Bun feature-detection branches, JSX component references, CommonJS sloppy-mode constructs and diagnostic locations. Module-location diagnostics retain the existing Bun class-heritage policy. Declaration-only files remain outside executable dependency scanning.

## Maintenance

Babel 7 is a bounded compatibility choice. [Babel 8 removes the legacy import-assertion parser option](https://babeljs.io/docs/v8-migration), while bunko currently accepts that syntax for supported data loaders. [Babel 7 receives security support until June 2027](https://babeljs.io/blog/2026/06/16/8.0.0/). Before that deadline, migrate to a supported parser preserving this contract or explicitly announce a syntax compatibility change. Dependabot continues patch updates; major 8 updates require this review. Do not silently remove legacy grammar or introduce a text-rewriting workaround.

For parser updates, run `bun run check`, `bun run build`, the bundled CLI/license assertions, and the supported Bun/platform CI matrix, including runtime injection and compile fixtures. Compare syntax performance against an identical input corpus and record bundle size; do not compare different installed dependency trees.

## Measurement on 2026-09-17

On macOS arm64, Bun 1.4.2, the minified CLI changed from 8,109,946 bytes (TypeScript 6 analyzer) to 1,906,559 bytes (Babel parser plus public AST visitor definitions and notices), approximately 76% smaller. This is the JavaScript artifact, not a compressed download or compiled executable.

A fixed corpus of 311 `.js`/`.jsx`/`.mjs`/`.cjs` files (17,392,806 bytes), copied from the same installed dependency tree and excluding declaration files, was scanned three times serially with `bun test/syntax-benchmark.ts CORPUS 3`. It includes `typescript/lib/typescript.js`. Old and new runs used the same Bun binary and corpus, without concurrent test processes.

| Read-and-guard measurement | TypeScript 6 baseline | Babel adapter |
| --- | --- | --- |
| Whole corpus, three passes (ms) | 1220 / 1077 / 1015 | 1940 / 1738 / 1684 |
| `typescript.js`, three passes (ms) | 750 / 490 / 456 | 1126 / 786 / 815 |

The migration reduces distribution size and removes the runtime compiler-API dependency, but the whole-corpus scan workload measured approximately 1.59–1.66 times the TypeScript 6 baseline, while the `typescript.js` subset measured approximately 1.50–1.79 times the baseline. These numbers are not an end-to-end build speedup claim. Parent links are collected with lexical scopes when needed, instead of eagerly walking every syntax tree twice; child traversal uses Babel's public visitor keys. The parser bundle is part of the published CLI and should be measured with the same minifier and dependency tree as the benchmark. Keep measuring this tradeoff when updating the parser.
