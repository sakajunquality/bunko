# Initial npm publication

On 2026-09-09, `@sakajunquality/bunko@0.1.0-rc.5` was published from the reviewed tarball produced by [#72](https://github.com/sakajunquality/bunko/pull/72). The development checkout remains private. The package contains exactly seven files and has no lifecycle hooks or runtime npm dependencies.

- Tarball SHA512 integrity: `sha512-Dvto9Zs5RS4Vy6a2igo300WnChthzY9q8kKhOGLVghhF5Sjp+9o/NR06z1JdW2MJAm67whqqRfv+VSABbQiz1g==`.
- Enclosed CLI SHA256: `56e4c2ef57ebdb1b2ac0f0c4c6e7ccee6383c9df8a86643ae9b520eae1427d83`, unchanged from the independently attested [rc.5 release](rc5.md).
- Anonymous registry metadata and tarball download passed. Registry SHA512 and downloaded bytes match the tested candidate; installation preserves the CLI SHA256.
- npm installation and fresh-cache `bunx @sakajunquality/bunko@0.1.0-rc.5 version` and `bunx @sakajunquality/bunko@next version` passed with Bun 1.4.2.
- Local tarball installation and execution previously passed with Bun 1.3.11 and 1.4.2. Global npm rc.4 → rc.5 → rc.4 upgrade/rollback, plus Bun add and scoped bunx execution, passed in isolated temporary directories. The rc.4 tarball used authenticated GitHub release inputs and was not published to npm.

Initial registry metadata returned 404 for several minutes after the publish command succeeded, while the version endpoint and package ownership were available. Consumer verification completed only after normal package resolution became available. The release was not republished to work around propagation.

This was an authenticated local bootstrap, so the npm tarball has no GitHub Actions npm provenance. Its enclosed `PROVENANCE.jsonl` authenticates the unchanged CLI release assets. The npm Trusted Publisher now permits direct publication from `sakajunquality/bunko`, workflow `npm.yml`, environment `npm`; the GitHub environment permits only main. The next new version must exercise that OIDC workflow and its post-publication verification. Existing rc.5 must not be republished.

These checks do not certify cross-version registry upgrades or arbitrary application workloads. No npm credentials or authentication challenge URLs are included in this evidence.
