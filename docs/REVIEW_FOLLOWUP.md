# Review follow-up: scalar semantics, workspace discovery, and scan cost

2026-09-08. This follow-up addresses three observations after the workspace and resolution correctness and live Registry changes.

## YAML block scalars

URI validation applies to the decoded YAML value and never trims it. A non-template scalar starting with `bunko://` fails with `Invalid bunko reference` if its value includes whitespace. A final newline retained by `|`, `|+`, `>`, or `>+` therefore causes a pre-build failure. A single-line `|-` or `>-` removes that newline and resolves normally, while embedded whitespace or a trailing space still fails.

This is intentional strict URI validation. The [current specification](SPEC.md#10-resolve) now states the rule explicitly rather than implying every block style is accepted. Regression tests cover clipped/kept/stripped literal and folded scalars, retained header comments, CRLF, and invalid whitespace. Existing tests also verify invalid references cause no Registry requests.

## Workspace pattern normalization

Bun 1.3.11 accepts `./packages/*` in Glob.scan but does not match it against `packages/app` with Glob.match. Ancestor discovery therefore missed a workspace that root discovery accepted.

Both discovery paths now normalize leading `./` segments and trailing slashes before using the glob. Tests compare root/member/package discovery and perform a build from a member directory, using the root lock and production workspace layout. Unrelated or malformed ancestors remain ignored; `--target .` still explicitly selects the workspace root.

## Dependency syntax scan cost

The cost observation is confirmed. The TypeScript parser still scans all JS/TS dependency files before each bundle; minifying the CLI does not reduce that parsing work.

The reproducible benchmark is:

```sh
bun run bench:syntax
# Optional dependency directory and repetition count:
bun run bench:syntax node_modules 3
```

On macOS arm64 with Bun 1.3.11, the repository's installed development dependencies contained 504 JS/TS files totaling 23,353,012 bytes. Three serial passes measured:

| Work | Read + parse time per pass |
| --- | --- |
| typescript/lib/typescript.js | 884 ms, 574 ms, 507 ms |
| Complete dependency tree | 2,061 ms, 1,371 ms, 1,598 ms |

[Raw measurements](validation/2026-09-08-syntax-scan.json) include discovery time. The timings include file reads and the actual macro guard, but exclude dependency installation, bundling, compression, Registry I/O, and CLI startup. They mix the initial and subsequent passes and are not cold-cache benchmarks. The full guard repeats for each bundle, including platform and determinism builds. A tree large enough to require tens of seconds was not measured here.

The distributed CLI is now minified: the candidate measured approximately 3.90 MB, compared with 9.24 MB for the same source without minification, including complete license notices. The prepared release and ordinary `bun run build` use the same minification setting. Tests exercise installed version/resolve commands, actual bundled builds, license retention, and rejection of an executable macro before its side effect.

Whole-tree parsing remains a performance limitation. A future change should compare a smaller parser or reuse validated content across builds, while retaining coverage for import/export attributes, escaped specifiers, template expressions, regexes, comments, and JSX. No files are skipped by this follow-up's guard.
