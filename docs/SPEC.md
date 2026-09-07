# bunko 実装仕様 — M0a

2026-09-07。現行実装の契約。将来の設計は [DESIGN.md](DESIGN.md)、最初の仕様書は [archive/SPEC-v0.1.md](archive/SPEC-v0.1.md) に保存する。

## 1. 対応範囲

Bun の dependency-free な単一アプリを bundle し、base image と合成した **完全な OCI image layout** を生成する。Bun は `>=1.3.11 <1.4`、実機検証の基準は 1.3.11。外部 npm runtime dependencies は 0。

対応 platform は一度に `linux/amd64` または `linux/arm64`。arm64 の省略 variant は v8 として扱う。ビルド時にエミュレーターを起動しない。

registry push、npm dependencies の install、runtime external、workspaces、compile、bytecode、SBOM/provenance/sign、resolve/apply、registry cache、Docker archive の製品用 export は後続 milestone。

## 2. CLI

```sh
bunko build [path] --push=false --oci-layout <directory> [options]
bunko version
```

| option | 動作 |
| --- | --- |
| path | 既定 `.`。`bunko://<path>` も許可 |
| `--push=false` | M0a では必須。push を要求した場合は未対応エラー |
| `--oci-layout DIR` | 完全な OCI layout。既存の非空 directory は拒否 |
| `--base REF` | 公開 registry の base。tag または SHA-256 digest |
| `--base-layout DIR` | ネットワークを使わず local OCI layout を base にする |
| `--platform VALUE` | 単一 platform。既定 `linux/amd64` |
| `--bun-path FILE` | bundle に使う Bun executable |
| `--reproducible` | 明示的な base digest または local base layout を要求 |
| `--verify-deterministic` | 二つの staging directory で bundle/pack/assembly を比較 |
| `--git-metadata=false` | app の自動 Git revision/dirty label を省略 |
| `--no-index` | 単一 manifest を image の root とする |
| `--report FILE` | JSON の結果。既存 file と layout 内の path は拒否 |

`--base` と `--base-layout` は排他。未実装・未知の option は失敗し、無視しない。build は stdout を空に保ち、ログ・結果 digest は stderr に出す。exit code は成功 0、失敗 1。version/help の stdout は例外。

report は target/platform、root/manifest/config descriptor、source/base digest、toolchain、追加 layer の compressed digest/DiffID、決定性検証の実施有無を持つ。CLI 自身は base を起動検査しないため `baseRuntimeVerified:false` を記録する。

## 3. 入力と設定

entrypoint は `bunko.entrypoint > bin > module > main > src/index.ts > index.ts`。複数 bin は明示指定が必要。宣言した entrypoint が壊れていても下位候補へ fallback しない。

dependencies/devDependencies/optionalDependencies/peerDependencies のいずれかが非空なら未対応エラー。依存宣言が空なら lock なしを許可し、install は実行しない。workspaces を持つ root と project bunfig.toml は拒否する。

対応する package.json.bunko の例（全項目任意）:

```json
{
  "entrypoint": "src/server.ts",
  "mode": "bundle",
  "imageName": "hello",
  "base": "oven/bun:1.3.11-distroless",
  "platforms": ["linux/amd64"],
  "assets": ["public"],
  "env": {"NODE_ENV": "production"},
  "ports": [3000],
  "user": "65532:65532",
  "workdir": "/app",
  "args": [],
  "labels": {},
  "runtime": {"bunPath": "/usr/local/bin/bun", "libc": "glibc"},
  "build": {"minify": true, "sourcemap": "none", "define": {}}
}
```

`external:[]`、`build.bytecode:false`、`build.target:"bun"`、`enabled:true` も許可する。未知 key と未対応値はエラー。sourcemap は `none` / `external`。source symlink、import attributes/macros は初期版では拒否する。import attributes の検出は保守的なので、ソース中の文字列・コメントに同じ構文がある場合も拒否することがある。

base/platform は `CLI > BUNKO_DEFAULT_BASE / BUNKO_DEFAULT_PLATFORMS > package.json > 既定`。既定 base は選択した Bun の完全バージョンの `oven/bun:<version>-distroless`。catalog による自動 digest pin はまだ実装しない。

## 4. Snapshot と bundle

元の作業ツリーを変更せず、一時 directory に snapshot を作る。file content hash、正規化した mode、相対 path、directory 一覧を hash し、絶対 checkout path と元の mtime は identity に入れない。到達ソースだけへの縮小はまだ行わない。

`.git`、node_modules、`.bunko-build`、`.bunko-output`、`.env*`、`.npmrc`、`.yarnrc.yml`、`.DS_Store` と指定 output/report path は除外する。source は通常 file と directory のみ。

Bun CLI は shell を介さず argv 配列で起動する。空の明示 config、小さな子プロセス環境、NODE_ENV=production、`--no-env-file`、`--env=disable`、`--reject-unresolved` を使う。runtime env を build.define へ自動転用しない。

bundle は ESM、target=bun、packages=bundle、既定 minify=true。出力名を維持し、metafile から server entrypoint を識別する。HTML と browser 出力も app layer に含める。source map は生成 tree から収集し、metafile の input と照合して source を `bunko:///` の安定した path にする。

assets は target root 相対の file/directory/glob。未一致、app との file 衝突、case 衝突、親 file と子 path の衝突はエラー。空の assets layer は省略する。

## 5. レイヤーと OCI 構成

layer 順は `base layers → assets（あれば）→ app`。Bun 自体は base に残る。追加 file は workdir（既定 `/app`）に配置する。

tar は UTF-8 byte order、明示 parent directory、uid/gid=0、uname/gname 空、mtime=SOURCE_DATE_EPOCH、通常 file=0644、実行 file/directory=0755。OCI library は相対 symlink（0777）と長い path/linkpath/時刻の PAX を扱えるが、CLI source の symlink 対応は後続。

gzip は level=6、mtime=0、filename なし、OS byte=255。tar と gzip の hash は streaming で別々に算出し、tar 全体をメモリに保持しない。空 layer は作らない。

SOURCE_DATE_EPOCH は未設定なら 0、非負整数秒、上限 9999 年末。image.created と追加 history もこの値を使う。

base の layer bytes と DiffID は維持する。base の Env/User/一般 label を継承し、app の設定で上書きする。base の bunko 予約 label と Git revision は持ち越さない。

- Entrypoint: `[runtime.bunPath, workdir + emitted server path]`
- Cmd: args、既定 `[]`。base の command は消去
- WorkingDir: 設定値または `/app`
- User: 明示設定 → base の non-empty User → `65532:65532`
- Env: base → NODE_ENV=production → app env、key 順で出力
- history: base に存在する場合だけ継承・追記。empty_layer と DiffID 数を検証

base の User が `0` なら継承する。hello example は nonroot を明示する。read-only root filesystem の設定は container runtime の責任。

通常は single-platform OCI index を root にする。layout の index.json は export 用で、root の bytes は blobs/sha256/ に保持する。root から到達する全 config/manifest/layer を収録する。別の一時 directory に完成させてから output へ rename する。

## 6. Base source

public registry の anonymous Bearer token flow、platform 選択、blob streaming download に対応する。manifest/config/layer の descriptor digest と size を検証し、別 origin の blob storage redirect に token を渡さない。HTTPS のみ。

入力は OCI と Docker schema 2 の manifest/index、gzip または非圧縮 layer。Docker gzip media type は OCI に正規化し、bytes は変更しない。schema 1、zstd、foreign/nondistributable layer、private credentials、retry/resumable download は後続。

local base でも同じ検証経路を使う。platform 候補が 0 または複数、未知 schema、過剰な index nesting、破損 blob はエラー。任意 base の Bun binary の存在・runtime/libc 互換性は利用者側の契約であり、未検査のものを検査済みとは報告しない。

## 7. 再現性と検証

同じ snapshot、有効設定、Git metadata、Bun toolchain、bunko build、圧縮実装、base digest、platform、SOURCE_DATE_EPOCH なら同じ image bytes を作る。通常の base tag の更新は同一入力に含めない。

`--verify-deterministic` は同じ snapshot を二つの directory に複製し、独立した bundle/pack/assembly を比較する。同じ cache blob を二回返す検証ではない。比較が成功するまで output を確定しない。

unit/integration は `bun run check`。Python 3 の tarfile による独立した tar/PAX 検査も含む。Docker は通常テストに不要。実行確認は `bun run test:smoke <hello-layout>` で行い、専用 tag/container を作成・cleanup する。

次は M0b の registry 認証・push。その後の依存準備・cache・multi-platform は [詳細設計](DESIGN.md) に従う。
