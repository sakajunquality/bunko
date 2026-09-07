# 詳細設計の検証記録

2026-09-07。[DESIGN.md](DESIGN.md) の根拠。§1–7 は設計時の事前調査、§8 は M0a、§9 は M0b/M1 の検証記録。

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

## 9. M0b / M1 実装の検証

同じ PR で private Registry authentication、push、production dependencies、deps/assets cache、multi-platform、Docker archive/local/kind を追加した。以下は M0a の記録後に確認した結果であり、§7–8 の当時の未実装一覧を更新する。

### 自動試験

Bun 1.3.11 で型チェックと **86 tests / 264 assertions** が成功。通常試験は Docker・ネットワークを使わない。自作 npm fixture の cache は通常 install 用で、実 package の download/integrity 検証を代替しない。

- Docker config/helper の優先順位、Docker Hub aliases、GHCR/Hub/GAR の scoped Bearer、ECR の Basic と資格情報再取得、OAuth identity token。
- cross-repository mount 201/202/非対応、429、redirect の認証分離、PATCH 切断後の offset 照合、曖昧な manifest PUT、部分 tag 更新、read-only dry-run。
- build と production の分離、dev deps 除外、scripts 無効、npm credentials の隔離、optional peer の lock 照合、patch 内容による key 更新、symlink 逸脱、ELF architecture。
- source 変更で remote deps/assets hit、layer GET なし・upload 0、local blob / remote metadata 破損、cache write 拒否時の image 成功、決定性比較の cache bypass。
- multi-platform index、Python tarfile による Docker archive と非圧縮 layer DiffID の独立検査。

patch の適用自体は別の実 npm package probe で検証した。`is-number@7.0.0` を `num` alias、optional peer、override、`bun patch` で生成した patch とともに準備し、製品の隔離 Linux production install で patch 後の bytes が残ることを確認した。sandbox 内では停止したが、許可された実行環境では成功したため、ネットワーク不要の通常試験では lock 整合性と patch による key 変更を扱う。

### 実 Registry と Linux runtime

`bun run test:m1-smoke` で専用の Distribution 3 container を起動し、`examples/dependencies` を amd64/arm64 に構築して公開した。local layer cache は無効、初回は `--verify-deterministic`。source の応答文字列を変更して再公開し、Registry cache hit と deps/assets の upload 0 を確認した。

| 項目 | 実測値 |
| --- | --- |
| host / runtime | macOS arm64、Bun 1.3.11 / revision af24e281、Docker Engine 29.3.1 |
| base index | `oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9`（Bun 1.3.11 slim） |
| bundled JS | `is-number@7.0.0` |
| native external | `@node-rs/xxhash@1.7.7`、Linux 向け prebuilt addon、scripts 無効 |
| 初回 image index | `sha256:7913aacab58d9c1b3df0eef5dcfd483166fb442481a0796af9021c7ab1536abf` |
| source 変更後 index | `sha256:bd589ee76439323cd2f680617a263a346e429ebb689eef8cd5b10dafc297305f` |
| 両 platform の HTTP | 200、`number:true`、`hash:510391394`、変更後の message |
| runtime 制約 | user `65532:65532`、read-only rootfs、tmpfs /tmp、cap-drop ALL |
| shutdown | amd64 / arm64 とも SIGTERM で exit 0 |

Docker Desktop の daemon から host の loopback 公開 port へ直接 `docker pull` する方法は、この環境では接続できなかった。試験は host 側の Registry client で manifest/layer を再取得・digest 検証し、Docker archive にして Docker にロード・実行している。Registry の実 push/pull と独立した Docker runtime は確認済みだが、Docker CLI からの直接 pull が成功したという記録ではない。専用 Registry/container/tag は終了時に削除した。

### source 変更時の転送量

同じ二つの platform を含む公開について、重複 blob を一度だけ数えた payload bytes:

| 種別 | 初回公開 | source 変更後 |
| --- | ---: | ---: |
| base layers | 138,615,264 | 0 |
| deps layers | 1,142,711 | 0 |
| assets layer | 176 | 0 |
| app layer | 830 | 833 |
| image configs | 9,441 | 9,441 |
| 合計 | 139,768,422 | 10,274 |

deps の圧縮サイズは amd64 584,233 bytes / arm64 558,478 bytes。assets とこの fixture の app は両 platform で共有する。表は layer/config payload のみで、manifest/index、cache metadata、HTTP overhead、再送を含む wire total ではない。

記録上の所要時間は初回 10,036 ms / source 変更後 2,010 ms。ただし **初回は決定性検証のため二重 build、後者は単一 build、npm download cache は事前に温まっている**。公平な速度比較や buildx に対する優位性の根拠には使わない。digest とサイズはこの時点の fixture / 実装に対する記録で、将来の固定期待値ではない。

### Docker / kind

製品の `--local` で単一 platform の Docker archive を生成し、Docker load と inspect に成功した。archive の形式・DiffID は通常試験でも Python で検査する。

kind 0.33.0 の公式 macOS arm64 binary の checksum を照合し、一時 cluster `bunko-m1-6f0ca10` を作成した。製品の `--kind --kind-cluster ... --platform linux/arm64` により image-archive のロードと node 上の `crictl inspecti` に成功。cluster は削除済み。この kind 試験は image の格納確認で、Pod の native HTTP 動作確認ではない。

### 実機で修正した互換性

- Bun 1.3.11 の install 引数は `--config=PATH` / `--registry=URL` / `--cache-dir=PATH` を使う。空白区切りの config が追加 package と解釈されるケースを回避した。
- HTTP response の native async iterator が reader 解放時に例外になるケースを確認した。明示 reader による streaming と、取得後の digest/size 検査を使う。
- file-backed Blob slice を PATCH body にした場合の送信不整合を確認した。8 MiB の範囲だけを Buffer に読み、長さを確認して送る。
- distroless ではこの native addon が必要とする `libgcc_s.so.1` がなく起動に失敗した。example は slim base に変更し、native deps には明示 base を要求する。glibc/musl 両 variant がインストールされる場合も、実行確認は glibc のみ。

### 残る相互運用・性能検証

cloud アカウントへの GHCR / GAR / Docker Hub / ECR の実 push、private npm のサービス実認証、mount のサービス固有挙動は未検証。認証設定と対応表は [REGISTRIES.md](REGISTRIES.md)。HTML のコンテナ配信、汎用 native ABI、musl、別 Bun version、繰り返し benchmark / buildx 比較も未実施。

CI は Linux/macOS の型チェック・unit/integration・CLI bundle と、Linux の実 Distribution smoke を実行する。Linux の smoke は両 platform を build し、amd64 を runtime 検証する。手元の amd64/arm64 runtime 検証と区別する。

## 10. M2a workspace 実装の検証

M1 の後続として、共通 lock の検証、workspace target の自動/明示選択、複数 image の構築・公開、production runtime 配置の保持を追加した。

### 自動試験

Bun 1.3.11 で型チェックと **97 tests** を実行。既存 M1 の 86 tests を維持し、次を追加した。

- root 自動選択、package 名/path の --target、member directory からの共通 lock 利用。
- shared package と異なる fixture-msg 1.0.0/2.0.0、同じ fixture-adapter が要求する peer の解決を保持。両 service の image layer を Python tarfile で展開し、Bun で実行して各 version の結果を確認。
- external workspace の TypeScript と相対 file、root tsconfig extends、別 checkout depth の sourcemap/digest 再現性。
- source のみ変更で deps/assets hit、runtime shared source の変更で deps miss。
- stale child manifest / membership / workspace lock reference、image 名の衝突、runtime の外へ出る symlink、assets と内部配置の衝突。
- 後続 target が build 失敗した場合の export/publish 防止、複数 target の dry-run、部分 tag 更新の report / pendingTargets。
- CLI の複数 target export と stdout、単一 target 限定の tarball、layout 内の report 拒否。

fixture は自作 package を隔離 download cache に配置し、通常試験のネットワーク依存を避ける。semver の再解決器を bunko 内に作らず、Bun が実際に install した store と symlink を検査する。

### 実 Registry / CLI / runtime

`bun run test:m2a-smoke` を macOS arm64 / Bun 1.3.11 / Docker 29.3.1 で実行した。専用 Distribution 3 に CLI から二つの multi-platform image を公開し、stdout が target 順の二つの digest 行だけになることを確認。初回は二つの staging で決定性を検証した。

| target | 共通 package | npm dependency | Linux runtime |
| --- | --- | --- | --- |
| api | @example/shared を bundle | is-number 7.0.0、@node-rs/xxhash 1.7.7 external | amd64 / arm64 とも HTTP 200、version 7.0.0、hash 510391394 |
| worker | @example/shared を external、JSON file を含む | is-number 6.0.0 external | amd64 / arm64 とも HTTP 200、version 6.0.0 |

base は M1 と同じ Bun slim index `oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9`。4 通りとも nonroot `65532:65532`、read-only rootfs、tmpfs /tmp、cap-drop ALL、SIGTERM exit 0 を確認した。

api の応答文字列だけを変更して再公開すると、両 target/platform の deps は Registry cache hit・upload 0 になった。worker の app layer も upload 0。共通 source digest を使うため worker の config は更新された。新しい layer/config payload は api 9,552 bytes / worker 9,167 bytes で、HTTP overhead・manifest/index・cache metadata を含まない。この fixture には assets layer はなく、assets の再利用は自動試験で検証する。

Registry から host 側 client で全 bytes を再取得・検証し、Docker archive を load/run する方式は M1 smoke と同じ。Docker CLI の直接 pull を検証した記録ではない。一時 Registry/container/tag は cleanup 済み。

CI は従来の M1 smoke に M2a smoke を追加する。両 platform を build し、Linux runner では amd64 の二つの service を実行する。手元では上記 4 通りを実行した。

### M2b に残す最適化

M2a の runtime は workspace 全体の production tree なので、worker に api 用の native package も含まれる。closure による package 削減、sharedDeps、必要な target graph だけの cache key、source digest の対象縮小は未実装。現時点の挙動と制約は SPEC.md §8 に記載した。


## 11. M2b: closure / sharedDeps（2026-09-07）

Bun 1.3.11 / macOS arm64 / Docker Desktop で `bun run test:m2b-smoke` が成功。実 Distribution Registry に 2 target × amd64/arm64 を publish し、source 編集後の Registry cache hit と deps/assets の追加 upload 0 を確認。worker の closure から API 専用 native addon が除外された。sharedDeps の再構築では platform ごとに両 target の deps digest が一致した。

削減後と共有後の計 8 image/platform を RegistrySource で検証付き pull → Docker archive → Docker load/run し、API の native xxhash、is-number 7/6 の使い分け、共通 workspace JSON、nonroot/read-only、SIGTERM exit 0 を確認。初回 closure は独立 install を使う決定性比較にも成功。CI に同じ smoke を追加し、実行 platform は amd64 に限定する。

通常テストには同名異版・peer context、bundled workspace の除外、optional 欠落、required 欠落、symlink 脱出、bin link、package data、checkout 深さの独立性、無関係な dev lock 変更の cache hit、reachable workspace source 変更の miss を追加。closure は cache hit 時も Linux install を行い、install 回避や速度向上の測定結果は主張しない。クラウド Registry 個別の実 push 状況は M1 と同じ。


## 12. M2c: resolve（2026-09-07）

`bun run test:m2c-smoke` が macOS arm64 / Bun 1.3.11 / Docker Desktop で成功。2 document と anchor/alias を持つ YAML を実 CLI resolve に渡し、2 service × amd64/arm64 の公開 reference と出力 scalar の一致を確認した。重複 alias は追加 target を作らず、コメントを保持した。source 編集後の Registry cache、closure/sharedDeps の 8 runtime checks、native addon、異なる依存 version、nonroot/read-only、SIGTERM exit 0 も成功した。

通常テストは YAML multi-doc、コメント、block scalar、CRLF、複雑な mapping key、anchor/alias、template/部分文字列の除外、JSON 数値の bytes 維持、複数 JSON 配列、directory 順序/再帰、stdin、canonical target 重複排除、workspace sharedDeps、構文/名前衝突/途中 build 失敗で Registry 書き込みなし、target identity 変更の拒否、部分公開の report と stdout 空を確認する。YAML 1.1 と 1.2 の別入力を連結する際の directive 継承も検査する。

`bun run build && bun run test:bundled-smoke` は dist/bunko.js だけを外部 node_modules のない一時 directory にコピーし、stdin resolve と YAML license の同梱を確認する。CI に bundled smoke と実 Registry M2c smoke を追加した。kubectl apply や各クラウド Registry 個別の実 push はこの検証に含まない。
