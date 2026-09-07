# bunko

Bun プロジェクトを Dockerfile・Docker daemon なしで OCI イメージにするビルダー。Go の [ko](https://ko.build/) に着想を得ています。

現在は **M0a preview**。依存パッケージのない単一アプリを bundle し、base image と合成した OCI layout を生成できます。registry push と npm dependencies の処理は次の段階です。

## 試す

Bun `>=1.3.11 <1.4` が必要です。検証基準は Bun 1.3.11。CLI 自体に外部 npm runtime dependencies はありません。

```sh
bun run dev build examples/hello \
  --push=false \
  --oci-layout .bunko-output/hello \
  --verify-deterministic
```

公開 Bun base image をダウンロードし、`base + app` の OCI image index を出力します。Docker daemon は使いません。出力 directory は未作成または空にしてください。ログと image digest は stderr に出し、stdout は空に保ちます。

base も固定して再現する場合:

```sh
bun run dev build examples/hello \
  --push=false \
  --oci-layout .bunko-output/pinned-hello \
  --base oven/bun@sha256:6a78966e057efd546873b64d6c173b18a21a10c3da81562863beeaf044c1e2ec \
  --reproducible \
  --verify-deterministic \
  --git-metadata=false \
  --report .bunko-output/hello-report.json
```

この digest は検証時の Bun 1.3.11 distroless index です。Bun toolchain、ソース、設定も同じにする必要があります。`--base-layout <directory>` なら、ローカルの完全な OCI layout を base にしてネットワークなしでビルドできます。

## 対応しているもの

- 単一の JavaScript / TypeScript entrypoint。Bun と Node の組み込み module は利用可能
- `package.json.bunko` の assets、env、ports、user、workdir、args、labels、minify、external sourcemap、define
- 通常の JS bundle、HTML import の生成ファイルの収録
- 決定的 tar/gzip、DiffID と compressed digest、OCI manifest/index/layout
- 公開 registry の anonymous Bearer 認証、OCI/Docker schema 2 base、digest/size 検証
- 一度に linux/amd64 または linux/arm64。既定は linux/amd64
- 二つの staging directory による digest 比較、JSON report

まだ対応していないもの: registry push、npm dependencies、runtime external/native deps、workspaces、compile/bytecode、source symlink、project bunfig.toml、import attributes/macros、SBOM/provenance/sign、resolve/apply、registry cache。未対応の指定はエラーにします。import attributes の構文検出は保守的です。

## 開発・検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
bun dist/bunko.js --help
```

テストには Python 3 も使い、標準 tarfile 実装で tar/PAX を検査します。通常のテストに Docker やネットワークは不要です。CI は Linux/macOS で型チェック・テスト・CLI bundle を実行します。

hello の実行確認は、Docker の containerd image store が有効な環境で:

```sh
bun run test:smoke .bunko-output/hello
```

専用の一時 tag/container を作り、HTTP 200、nonroot、read-only root filesystem、SIGTERM での正常終了を確認し、作成した tag/container を削除します。この smoke test 用の OCI archive は、製品の `--tarball` 対応を意味しません。

## 設計

- [現行実装仕様](docs/SPEC.md)
- [詳細設計とロードマップ](docs/DESIGN.md)
- [検証記録](docs/VALIDATION.md)
- [最初の仕様書 v0.1](docs/archive/SPEC-v0.1.md)
