# v0.8.3

This patch updates bunko's bundled TypeScript parser from 5.9.3 to 6.0.3. TypeScript 6 retains the JavaScript compiler APIs used for syntax analysis, macro detection, input discovery and module-location diagnostics. TypeScript 7 remains excluded pending the API migration tracked in [#185](https://github.com/sakajunquality/bunko/issues/185).

A new [prebuilt application example](https://github.com/sakajunquality/bunko/tree/v0.8.3/examples/prebuilt) demonstrates building with npm or pnpm and packaging the generated JavaScript and static assets with bunko. The resulting image runs with Bun; bunko does not consume npm/pnpm lockfiles or run their build scripts.

Supported Bun versions and runtime/rebase compatibility boundaries are unchanged. The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0; select `version: v0.8.3` explicitly. See the [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.8.3.md).
