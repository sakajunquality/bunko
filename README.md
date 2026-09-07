# bunko

Bun プロジェクトを Dockerfile・Docker daemon なしで OCI イメージにするビルダー。Go の [ko](https://ko.build/) に着想を得ています。

現在は **M1 preview**。単一アプリの bundle、npm dependencies、明示的な runtime external、Registry push、deps/assets cache、multi-platform、Docker/kind load に対応しています。GHCR・Google Artifact Registry・Docker Hub・ECR は Docker の認証設定を利用します。各サービスへの実 push の検証状況は [Registry 対応表](docs/REGISTRIES.md) を参照してください。

## 試す

Bun `>=1.3.11 <1.4` が必要です。検証基準は Bun 1.3.11。CLI 自体に外部 npm runtime dependencies はありません。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev build examples/hello \
  --push=false --oci-layout .bunko-output/hello \
  --verify-deterministic
```

公開 Bun base を取得し、完全な OCI layout を生成します。出力 directory は未作成または空にしてください。既定 platform は `linux/amd64`。ログは stderr、export の stdout は空です。

認証済み Registry に公開する場合（`OWNER` は自分の namespace に置換）:

```sh
bun run dev build examples/hello --repo ghcr.io/OWNER
```

成功時は `ghcr.io/OWNER/hello@sha256:...` を stdout に一行出します。`--bare` は `--repo` をそのまま repository 名に使います。既定 tag は `latest` と Git revision、明示指定は `--tag v1 --tag latest`。認証の準備は [REGISTRIES.md](docs/REGISTRIES.md) にまとめています。

## npm dependencies と native addon

通常の JS dependencies は bundle します。runtime に残す package は `package.json.bunko.external` に明示してください。依存がある場合は整合した text `bun.lock` が必要です。元の checkout の `node_modules` は使わず、一時 directory に frozen install します。install scripts は実行しません。

```sh
bun run dev build examples/dependencies \
  --push=false --oci-layout .bunko-output/dependencies \
  --platform linux/amd64,linux/arm64 \
  --verify-deterministic --report .bunko-output/dependencies.json
```

この example は `is-number` を bundle し、`@node-rs/xxhash` を external にしています。両 platform の Linux native addon を実行確認済みです。native 用には必要な共有ライブラリを含む base の明示が必要で、example は `oven/bun:1.3.11-slim` を指定しています。任意の native package / base の ABI 互換性は保証しません。

layer は `base → deps（必要時）→ assets（あれば）→ app`。M1 の deps は production install 全体を保存し、devDependencies は含めません。source だけを変更した再公開では deps/assets の転送を省略できます。cache hit 時も bundle 用の build dependencies は準備します。

## キャッシュ・ローカル実行

local layer cache は `${XDG_CACHE_HOME:-~/.cache}/bunko/v1`、Registry cache は公開先と同じ repository の予約 tag に保存します。`--cache-dir` / `--cache-repo` で変更でき、`--no-cache` で両方を無効化できます。Bun の package download cache は別管理です。Registry cache の読み書き失敗は診断を出して継続し、image 自体の公開失敗はエラーになります。

```sh
# Docker archive を保存（単一 platform）
bun run dev build examples/hello --push=false --tarball .bunko-output/hello.tar

# Docker にロード。Apple Silicon の例
bun run dev build examples/dependencies --local --platform linux/arm64

# 起動済みの Docker-backed kind cluster にロード
bun run dev build examples/hello --kind --kind-cluster kind --platform linux/arm64
```

`--local` / `--kind` は push を無効化し、ロードした content tag を stdout に返します。通常の build/push/export に Docker は不要です。`--dry-run --repo ...` は build と Registry の read で転送を見積もり、push/export/load を行いません。

## 再現性と対応範囲

`--reproducible` は digest 固定 base または `--base-layout` を要求します。`--verify-deterministic` は layer cache を迂回し、別々の staging で二度構築して比較します。Git 情報を出力から外す場合は `--git-metadata=false`。

未対応: workspaces、file/link/git dependencies、compile/bytecode、source symlink、project bunfig.toml、import attributes/macros、computed application imports、install scripts が必要な runtime packages、SBOM/provenance/sign、resolve/apply、cache prune。構文検出は保守的で、文字列やコメントを誤検出する場合があります。未知・未対応の指定はエラーにします。

## 開発・検証

```sh
bun run check
bun run build
bun dist/bunko.js --help

# Docker とネットワークが必要: 実 Registry への公開・再利用・pull・実行
bun run test:m1-smoke
```

通常テストはネットワーク/Docker 不要で、Python 3 の tarfile による独立検査も含みます。CI は Linux/macOS の型チェック・テスト・CLI bundle と、Linux 上の実 Registry integration を実行します。smoke は専用 Registry/container/tag を作り、終了時に削除します。既定で amd64/arm64 を実行し、`BUNKO_SMOKE_PLATFORMS=linux/amd64` で実行対象だけを絞れます。

- [現行実装仕様](docs/SPEC.md)
- [Registry 設定と検証状況](docs/REGISTRIES.md)
- [詳細設計とロードマップ](docs/DESIGN.md)
- [検証記録と転送量](docs/VALIDATION.md)
- [最初の仕様書 v0.1](docs/archive/SPEC-v0.1.md)
