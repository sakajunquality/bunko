# bunko

Bun プロジェクトを Dockerfile・Docker daemon なしで OCI イメージにするビルダー。Go の [ko](https://ko.build/) に着想を得ています。

現在は **M2 preview**。単一アプリ・Bun workspace の bundle、npm dependencies、明示的な runtime external、Registry push、deps/assets cache、multi-platform、Docker/kind load、YAML/JSON の resolve に対応しています。GHCR・Google Artifact Registry・Docker Hub・ECR は Docker の認証設定を利用します。各サービスへの実 push の検証状況は [Registry 対応表](docs/REGISTRIES.md) を参照してください。

## 試す

Bun `>=1.3.11 <1.4` が必要です。検証基準は Bun 1.3.11。配布用の `dist/bunko.js` は YAML parser も bundle し、外部 npm runtime dependencies を要求しません。開発時は下記の install を実行してください。

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

## Workspace / monorepo

root の共通 `bun.lock` と `workspaces` を使い、複数 service を一度に build/push できます。

```sh
# 各 service の image を公開: ghcr.io/OWNER/api と ghcr.io/OWNER/worker
bun run dev build examples/workspace --repo ghcr.io/OWNER

# package 名または root 相対 path で選択（--target は複数指定可）
bun run dev build examples/workspace --target @example/api --repo ghcr.io/OWNER

# member の directory を直接指定しても、root の lock を利用
bun run dev build examples/workspace/services/api --repo ghcr.io/OWNER

# 複数 target を一つの OCI layout に保存
bun run dev build examples/workspace --push=false \
  --oci-layout .bunko-output/workspace --platform linux/amd64,linux/arm64
```

root からの自動選択では `bunko.enabled:false` を除き、`bunko` 設定のある member を優先します。なければ `bin` / `module` のある member を選びます。設定は各 service の `package.json.bunko` に置き、root の bunko 設定は子へ継承しません。

全 target の構築成功後に公開を始め、stdout に target 順の digest を一行ずつ返します。公開途中の失敗は `--report` に記録します。`--bare` / `--tarball` は単一 target 限定です。

共通 package は既定で bundle します。明示 external にした workspace も収録でき、同名異版と peer dependencies は Bun の install 配置を保持します。M2a の production strategy は **workspace 全体の production tree** を収録するため、他 service の依存も入ります。`--deps-strategy closure`（または各 service の `bunko.deps.strategy: "closure"`）で、external から到達する実際の package instance だけに絞れます。

```sh
bun run dev build examples/workspace --repo ghcr.io/OWNER --deps-strategy closure
# 選択した service の依存の和集合を同じ deps layer に収録
bun run dev build examples/workspace --repo ghcr.io/OWNER --shared-deps
```

`--shared-deps` または root の `bunko.sharedDeps:true` は closure を既定にし、workdir/base/platform が一致する target 間で deps layer を共有します。各 service の external link は app layer に分離するため、同名異版も維持します。closure は毎回 Linux production install で graph を確認しますが、対象 package の bytes・mode・link が同じなら、無関係な lock/source の変更後も layer cache を再利用できます。

対応する workspace 宣言は相対・正の glob を並べた配列です。nested workspace、catalog、file/link dependencies は未対応。npm 認証・override・patch の設定は root にまとめます。

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

## YAML / JSON の resolve

manifest の文字列値 `bunko://<project-directory>` を、公開した `repo@sha256:...` に置換します。Kubernetes の適用は行いません。

```sh
bun run dev resolve -f examples/manifests/services.yaml \
  --context examples/workspace --repo ghcr.io/OWNER --shared-deps

# stdin も同じ相対 path の基準で処理
cat examples/manifests/services.yaml | bun run dev resolve -f - \
  --context examples/workspace --repo ghcr.io/OWNER
```

`-f` は複数指定でき、directory は YAML/YML/JSON を辞書順に読みます。入れ子も読む場合は `--recursive`。参照 path は cwd（または `--context`）を基準にし、manifest file の場所には依存しません。workspace root が複数 target を選ぶ場合は service directory を指定してください。

コメント・anchor/alias・mapping key・説明文中の部分文字列を保持し、同じ target は一度だけ build します。全 target を構築し、完成する文書を検査してから公開を開始します。全成功時だけ解決済み文書を stdout に出し、ログは stderr へ送ります。単一 JSON は JSON、複数 JSON は配列、YAML を含む入力は YAML document stream にします。公開途中の失敗は `--report` に記録できます。

resolve は Registry 公開専用です。`--push=false`、export/local/kind、`--dry-run`、`--target` は使用できません。

## 再現性と対応範囲

`--reproducible` は digest 固定 base または `--base-layout` を要求します。`--verify-deterministic` は layer cache を迂回し、別々の staging で二度構築して比較します。Git 情報を出力から外す場合は `--git-metadata=false`。

未対応: nested workspaces、catalog、file/link/git dependencies、compile/bytecode、source symlink、project bunfig.toml、import attributes/macros、computed application imports、install scripts が必要な runtime packages、SBOM/provenance/sign、apply、cache prune。構文検出は保守的で、文字列やコメントを誤検出する場合があります。未知・未対応の指定はエラーにします。

## 開発・検証

```sh
bun run check
bun run build
bun dist/bunko.js --help

# Docker とネットワークが必要: 実 Registry への公開・再利用・pull・実行
bun run test:m1-smoke
bun run test:m2a-smoke
bun run test:m2b-smoke
bun run test:m2c-smoke
bun run test:bundled-smoke
```

通常テストはネットワーク/Docker 不要で、Python 3 の tarfile による独立検査も含みます。CI は Linux/macOS の型チェック・テスト・CLI bundle と、Linux 上の実 Registry integration を実行します。smoke は専用 Registry/container/tag を作り、終了時に削除します。既定で amd64/arm64 を実行し、`BUNKO_SMOKE_PLATFORMS=linux/amd64` で実行対象だけを絞れます。

- [現行実装仕様](docs/SPEC.md)
- [Registry 設定と検証状況](docs/REGISTRIES.md)
- [詳細設計とロードマップ](docs/DESIGN.md)
- [検証記録と転送量](docs/VALIDATION.md)
- [最初の仕様書 v0.1](docs/archive/SPEC-v0.1.md)
