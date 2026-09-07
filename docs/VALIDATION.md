# 詳細設計の検証記録

2026-09-07。[DESIGN.md](DESIGN.md) の根拠。§1–7 は設計時の事前調査、§8 はその後に実装した M0a の検証記録。

## 1. 環境と範囲

| 項目 | 実測値 |
| --- | --- |
| Bun | `1.3.11` |
| Bun revision | `af24e281ebacd6ac77c0f14b4206599cf4ae1c9f` |
| OS / CPU | `darwin / arm64` |
| リポジトリの開始状態 | README.md のみ、`ef64a49 Initial commit`、作業ツリー clean |
| 元仕様の SHA-256 | `259bd699d4c93736eabbef7560a5bf172f61dc91ce0f147e747314a9c155599e` |

事前調査では一時ディレクトリに自作の小さな fixture を作り、Bun CLI を実行した。外部 npm package は取得していない。Linux container 起動、registry push/mount、OCI tar の生成は事前調査では実行していない。実装後の結果は §8 に追記した。

公式ドキュメントは参照時点の最新内容であり、手元の 1.3.11 と同じ機能集合とは限らない。特に bytecode や compile target の仕様は、実装時に使用する Bun version へ対応を固定する。

## 2. 確認できたこと

| 調査項目 | 結果 | 設計への反映 |
| --- | --- | --- |
| `Bun.JSONC.parse` | object/API が存在し、コメントと trailing comma のある JSONC を parse | JSONC parser の自作は不要 |
| `--os` / `--cpu` | `bun install --help` に存在 | flag の有無は解決。Linux optional deps の取得・起動は別検証 |
| 通常 bundle の反復 | 同一 fixture を別プロセスで二度 build し一致 | golden fixture の出発点にできる |
| 通常 bundle の別 checkout | 深さの異なる二つの checkout で一致 | この fixture の host path は通常 ESM に埋まらなかった |
| external sourcemap | cwd/outdir の path 表記で差が出たが、realpath と相対 outdir にそろえると一致 | path の正規化と異なる staging 間の検証が必要 |
| bytecode | 同一 checkout 内では一致、別 checkout では JS と `.jsc` が不一致 | 初期対応から外す |
| HTML import | 標準 naming で server JS、HTML、client JS を出力 | output tree 全体を保持 |
| HTML + 固定 entry naming | `--entry-naming=index.js` で output path 衝突 | 全 entry の固定名化をしない |
| workspace lock | version/config/workspaces/packages の最小形を確認 | versioned adapter と workspace manifest 照合が必要 |
| workspace の frozen install | workspace-only の manifest 変更を拒否しないケースを確認 | frozen flag だけに整合性の検証を任せない |

## 3. Bundle / sourcemap / bytecode の fixture

二つの directory に、同じ内容の次のファイルを作った。

```text
checkout-a/
  package.json
  .env
  src/server.ts
  src/lib.ts
different-depth/checkout-b/
  （同じファイル内容）
```

```json
{"name":"probe","module":"src/server.ts","type":"module"}
```

```ts
// src/lib.ts
export const message = "hello bunko";
```

```ts
// src/server.ts
import { message } from "./lib.ts";
console.log(message, import.meta.url, import.meta.dir, process.env.BUNKO_PROBE_VALUE);
```

`.env` は `BUNKO_PROBE_VALUE=dotenv-probe`。cwd を realpath に正規化してから、次の command を両 checkout で二度ずつ実行した。

```sh
bun build ./src/server.ts --target=bun --root=. \
  --entry-naming=index.js --outdir=canonical-plain \
  --minify --env=disable

bun build ./src/server.ts --target=bun --root=. \
  --entry-naming=index.js --outdir=canonical-map \
  --minify --env=disable --sourcemap=external

bun build ./src/server.ts --target=bun --root=. \
  --entry-naming=index.js --outdir=canonical-bytecode \
  --minify --env=disable --bytecode
```

この fixture の entry は一つなので固定 naming で比較した。HTML を含めた bunko の設計ではこの指定を採用しない。

| 生成物 | 結果 |
| --- | --- |
| 通常 `index.js` | 106 bytes、4 回とも `b2bbd37e5f8a265245651d7df58234c34850efd6c57124395962d8a5ef25f920` |
| sourcemap 有効時 `index.js` | 152 bytes、4 回とも `be95e3e2241048c87748440944b21c42d4c5114ef7e79d5cf60d8d4638e586f8` |
| 正規化した `index.js.map` | 435 bytes、4 回とも `ea373b070a04f57912998dd8da4fac9167d760b6bfb25a1a0d70a474a9e2915b` |
| bytecode の `index.js` | checkout-a 364 bytes、checkout-b 396 bytes。各 checkout 内では反復一致 |
| `index.js.jsc` | checkout-a 2.56 KB、checkout-b 2.62 KB。各 checkout 内では反復一致 |

通常 bundle では `import.meta.url`、`import.meta.dir`、`process.env.BUNKO_PROBE_VALUE` が式として残った。bytecode の CJS wrapper では `import.meta.url` / `dir` が **元の source の絶対 path の文字列**に変わった。したがって今回の違いは時刻や乱数を推測したものではなく、生成 JS 内で原因を確認している。

external sourcemap の最初の試行では、macOS の `/var/...` と `/private/var/...` の path 表記を混ぜた絶対 outdir を使い、`sources` に長い相対 path が入って checkout ごとに差が出た。cwd/outdir を正規化した試行では `../src/lib.ts` と `../src/server.ts` になり、一致した。

この結果だけでは、任意の依存、別 Bun version、別 OS/CPU、compile、plugins/macros に対する再現性は証明できない。`.env` に関しても、この fixture で該当値が bundle に inline されなかったことだけを確認した。

## 4. HTML import の fixture

```ts
// server.ts
import page from "./index.html";
Bun.serve({ routes: { "/": page } });
```

```html
<!doctype html><html><body><h1>probe</h1><script type="module" src="./client.ts"></script></body></html>
```

```ts
// client.ts
console.log("browser probe");
```

```sh
bun build ./server.ts --target=bun --outdir=out-default
```

成功し、`server.js`、`index.html`、`index-428bmrtn.js` を出力した。server JS 内の HTML manifest が `./index.html` と `./index-428bmrtn.js` を参照していた。`--entry-naming=[name].[ext]` でも出力に成功した。

```sh
bun build ./server.ts --target=bun --entry-naming=index.js --outdir=out
```

こちらは exit 1、`Multiple files share the same output path`。HTML 由来の output にも naming 設定が作用することを確認した。

HTML ファイルを app レイヤーに含める根拠にはなるが、コンテナ内での配信成功は未検証。公式にも ahead-of-time HTML bundling が説明されている。[Bun fullstack](https://bun.com/docs/bundler/fullstack#ahead-of-time-bundling-recommended)

## 5. Workspace lock と frozen install

root は `workspaces:["packages/*"]` と `dependencies:{"@probe/a":"workspace:*"}`。`packages/a` は `@probe/b` に workspace dependency を持ち、`packages/b` は依存を持たない。

```sh
bun install --lockfile-only --ignore-scripts
```

生成された lock は次の形だった。通常 npm package、catalog、patch、peer context の形式まで確認したものではない。

```jsonc
{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "dependencies": { "@probe/a": "workspace:*" }
    },
    "packages/a": {
      "name": "@probe/a",
      "version": "1.0.0",
      "dependencies": { "@probe/b": "workspace:*" }
    },
    "packages/b": { "name": "@probe/b", "version": "1.0.0" }
  },
  "packages": {
    "@probe/a": ["@probe/a@workspace:packages/a"],
    "@probe/b": ["@probe/b@workspace:packages/b"]
  }
}
```

root package.json の dependencies を `@probe/b` に変更し、lock は `@probe/a` のままで次を実行した。

```sh
bun install --production --frozen-lockfile --ignore-scripts
```

exit 0 で成功し、lock と package.json の root dependency の差は残った。元の tree と、node_modules をコピーしない新規 directory の両方で確認した。

これは workspace-only の小さな fixture の結果であり、一般的な npm dependency 更新で frozen install が変更を許すという主張ではない。また、縮小した package.json と任意の元 lock を組み合わせてよいという証明でもない。bunko は original manifests を維持し、自身でも lock の対応部分と照合する設計にした。

## 6. 公式資料から確認した事項

| 項目 | 確認範囲 |
| --- | --- |
| ko | Go build cache、既存 registry blob の再利用、KOCACHE の役割。[Build Cache](https://ko.build/features/build-cache/) |
| distroless Bun | main branch の Dockerfile は `/usr/local/bin/bun` を配置。published tag の実 config は未取得。[Dockerfile](https://github.com/oven-sh/bun/blob/main/dockerhub/distroless/Dockerfile) |
| install platform | `--os` / `--cpu` による package 選択。[Bun install](https://bun.com/docs/pm/cli/install#platform-specific-dependencies) |
| isolated install | store・symlink・peer context を考慮する必要。[Bun isolated installs](https://bun.com/docs/pm/isolated-installs) |
| cache config | custom media type の config を持つ OCI artifact が可能。[OCI manifest](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md#guidelines-for-artifact-usage) |
| Distribution | cross-repo mount、upload session、referrers fallback、削除方式を区別する必要。[OCI Distribution v1.1.1](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md) |
| provenance | v1 predicate の構造は buildDefinition/runDetails。[SLSA provenance](https://slsa.dev/spec/v1.1/provenance) |

## 7. 実装前・release 前に残る検証

以下は事前調査時点の一覧。M0a の実装後に完了した範囲は §8 を参照。

- [ ] 使用する Bun の完全 version に対応する distroless tag/index/platform manifest/config を取得し、digest と User/Env/libc を記録する。
- [ ] bundle を Linux amd64/arm64 の base 上で起動する。custom base と read-only rootfs も別 fixture にする。
- [ ] target OS/CPU の optional deps を scripts 無効で取得し、代表 native package の runtime を確認する。
- [ ] lock の通常 npm、同名異版、alias、peer、catalog、override、patch、file/link/workspace の fixture を作る。
- [ ] HTML/CSS/file-loader/sourcemap が image 内の配置で動くことを確認する。
- [ ] compile の各 target と base の dynamic linking 条件を確認する。musl は別評価にする。
- [ ] tar/PAX/gzip の golden bytes、別 host での compressed digest、OCI schema を検証する。
- [ ] real registry で mount 201 / 202、auth helper、referrers、local export を検証する。
- [ ] ECR / GAR / GHCR / Docker Hub / Harbor は個別に対応表を作る。未検証を成功扱いしない。
- [ ] 比較対象の buildx 設定を固定し、push bytes と pull bytes を別計測する。

元仕様 §11 の「M0 の前にすべて」は、上記を必要機能ごとのゲートへ変更する提案。今回未検証の項目が残っていること自体は、詳細設計書の未記載ではなく、今後の実装検証として明示している。

## 8. M0a 実装の検証

同日、TypeScript/Bun で CLI、snapshot、bundle、決定的 tar/gzip、public registry reader、OCI composition/layout を実装した。元仕様は [archive/SPEC-v0.1.md](archive/SPEC-v0.1.md) に移し、[SPEC.md](SPEC.md) を実装済みの契約に更新した。

### 自動テスト

`bun run check` で型チェックと unit/integration を実行。tar は Python 3 の tarfile でも読み、path 順・mode・uid/gid・mtime・PAX・長い UTF-8 path・linkpath を確認した。source path の異なる checkout、external sourcemap、HTML、assets の再利用、壊れた base blob、Bearer token と redirect、設定継承、stdout、未対応入力のエラーを検証した。

`bun run build` で配布用 CLI bundle を生成し、`bun dist/bunko.js version` が `0.0.1` を返した。外部 npm runtime dependencies はない。CI 設定は Linux/macOS に追加したが、リモート CI 自体はこのセッションでは起動していない。

### 公開 base と hello

Docker Hub の tag を実際に解決して manifest/config/layer を取得した。後続の hello は次の index digest へ固定した。

| 項目 | 実測値 |
| --- | --- |
| base index | `oven/bun@sha256:6a78966e057efd546873b64d6c173b18a21a10c3da81562863beeaf044c1e2ec` |
| linux/amd64 base manifest | `sha256:13860e114310e8e7f9cbb7ca76d3a6cb0a505740c241521b56b8b329652b78a5` |
| base の User | `0`。hello の user は `65532:65532` で明示上書き |
| Bun path | hello の Entrypoint `/usr/local/bin/bun` で起動確認 |
| hello app layer | gzip 293 bytes（この小さな example のみの値） |
| 確認した hello index | `sha256:631ab3b2bf37977da809d378e5d0540b8698f65103c57446ded48d63ed36952a` |
| ビルドの反復 | `--reproducible --verify-deterministic --git-metadata=false` で layer/config/manifest/index 一致 |

上の hello digest は検証時の snapshot に対する記録であり、将来ソース・設定・Bun・bunko が変わった場合の期待値ではない。

### Docker の実行試験

Docker Engine 29.3.1 の containerd image store に、生成 layout の OCI archive を試験用の完全修飾 tag でロードした。macOS arm64 host 上の Docker で linux/amd64 container を実行した。

`bun run test:smoke <hello-layout>` により、次を確認した。

- HTTP 200、body は `Hello from bunko!` と改行。
- image config の user `65532:65532` で実行。
- `--read-only --tmpfs /tmp:rw,noexec,nosuid --cap-drop=ALL` で動作。
- SIGTERM で exit 0。試験用 container/tag は終了時に cleanup。

この試験は `--local` / `--tarball` 製品機能の実装を意味しない。Docker の OCI import では完全修飾名と `io.containerd.image.name` annotation を使い、通常 build の image root bytes は変更していない。

### 実装中に追加で分かった Bun 1.3.11 の挙動

- `--no-macros` を指定しても fixture の macro が実行された。現行版は source の import attributes/macros を保守的に拒否する。
- CLI metafile の outputs に external sourcemap が列挙されなかったため、生成 tree から別途収集する。
- nested output の sourcemap source が `.map` の directory ではなく outdir 基準になるケースがあり、metafile inputs と照合して安定した path へ直す。

registry push/mount、private credentials、native/npm dependencies、linux/arm64 の実 container、他 registry の相互運用は M0a の未検証・未実装範囲として残る。
