# bunko — 仕様書 v0.1

bunko は Bun プロジェクトを Dockerfile なし・daemon なしで OCI イメージにするビルダー。
Go における ko の思想（ツールチェーンが成果物を作り、変わったレイヤーだけ registry に push する）を
Bun 向けに再設計し、buildx の registry cache 相当をレジストリ自身で代替する。

このドキュメントは実装の唯一の仕様。実装中に矛盾や未定義を見つけたら
`## 未決事項` に追記し、決定したら該当セクションを更新する。

---

## 1. ゴールと非ゴール

### ゴール（優先順）

1. **ゼロ設定**: `bunx bunko build .` が package.json だけで動く
2. **差分 push 最小化**: 1 行の変更で push されるのはアプリバンドルのレイヤー（数百 KB〜数 MB）のみ
3. **決定的ビルド**: 同じソース・同じ lockfile・同じ bunko バージョンなら image digest が一致する
4. **daemonless**: Docker daemon / BuildKit 不要。CI でもローカルでも同じ動作
5. **workspaces 対応**: 1 つの `bun.lock` から複数イメージを出し、deps レイヤーをサービス間で共有
6. **供給網**: SBOM・provenance・署名をオプション一つで付与
7. **逃げ道を用意**: `--compile` モード、native deps の外部委譲、任意の base image

### 非ゴール

- Dockerfile の解釈、任意の `RUN` 実行
- Node.js プロジェクトのビルド（将来検討、v0 では Bun のみ）
- Windows コンテナ
- レジストリの実装・ホスティング

### 「ベスト」の証明（README 先頭に置くベンチ）

比較対象: Bun 公式ガイドの Dockerfile（multi-stage + `--compile`）、buildx + `--cache-to type=registry`。
指標: (a) 1 行変更時の push バイト数 (b) キャッシュ hit 時のビルド秒数 (c) イメージサイズ (d) digest 再現性。
`bench/` に再現スクリプトを置き、リリースごとに更新する。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| target | ビルド対象の 1 パッケージ（単一プロジェクトなら root、workspaces なら各 package） |
| platform | `linux/amd64`, `linux/arm64`（OCI platform 文字列） |
| layer | OCI レイヤー（gzip tar）。bunko は役割ごとに固定順序で積む |
| cache key | レイヤー入力から算出する sha256。registry 上の cache tag と対応 |
| bundle モード | `bun build --target=bun` の出力 JS をアプリレイヤーにする既定モード |
| compile モード | `bun build --compile` の単一バイナリをアプリレイヤーにするモード |

---

## 3. CLI

```
bunko build [<path>...]        イメージをビルドして push（既定）
bunko resolve -f <file>...     manifest 内の bunko:// 参照を digest 付き image 参照に置換
bunko apply -f <file>...       resolve して kubectl apply に流す（M4）
bunko cache ls|prune           registry 上の cache tag を一覧 / 削除
bunko version
```

### `bunko build`

```
bunko build [<path>...] [flags]

  <path>            target のディレクトリ。省略時は "."。
                    workspaces root を渡すと全 target をビルド。
                    "bunko://<path>" 形式も受け付ける（resolve と統一）

  --repo <ref>      push 先。省略時は $BUNKO_REPO
  --push            push する（既定 true）。--push=false で tarball 出力のみ
  --local           docker daemon にロード（repo は "bunko.local"）
  --kind            kind クラスタにロード（repo は "kind.local"、$KIND_CLUSTER_NAME）
  --platform <list> 例 linux/amd64,linux/arm64。既定 linux/amd64
  --tag <t>         追加 tag（複数可）。既定は latest と <git short sha>（git 管理下のとき）
  --bare            image 名を <repo> そのものにする（既定は <repo>/<target 名>）
  --mode bundle|compile
  --base <ref>      base image 上書き
  --sbom            SPDX SBOM を生成して referrer として push（既定 true）
  --sign            cosign で署名（cosign バイナリを exec）
  --oci-layout <dir>  OCI layout ディレクトリへも書き出す
  --tarball <file>  docker-loadable tarball を書き出す
  --verbose / -v
  --dry-run         何を push するかだけ表示
```

出力（stdout）: 最終 image 参照 `repo/name@sha256:...` を 1 行ずつ。
ログは stderr。これは ko と同じで、パイプで `kubectl set image` 等に渡せることを保証する。

### 環境変数

| 変数 | 意味 |
|---|---|
| `BUNKO_REPO` | 既定の push 先。`--repo` より弱い |
| `BUNKO_DEFAULT_BASE` | 既定 base image |
| `BUNKO_DEFAULT_PLATFORMS` | 既定 platform |
| `SOURCE_DATE_EPOCH` | レイヤー内 mtime と image created。未設定時は `0` |
| `BUNKO_CACHE_REPO` | cache tag を置く repo。既定 `<repo>/bunko-cache` |
| `BUNKO_DOCKER_CONFIG` | docker config.json の場所。既定 `~/.docker/config.json` |

---

## 4. 設定（package.json `"bunko"` キー）

設定ファイルは増やさない。`package.json` の `"bunko"` キーのみ。全項目任意。

```jsonc
{
  "name": "api",
  "module": "src/server.ts",
  "bunko": {
    "entrypoint": "src/server.ts",     // 既定: bin > module > main の順で自動検出
    "mode": "bundle",                  // "bundle" | "compile"
    "base": "oven/bun:1-distroless",   // 既定値は §6.1
    "platforms": ["linux/amd64", "linux/arm64"],
    "assets": ["public", "migrations"], // コピーするディレクトリ/ファイル（glob 可）
    "external": ["sharp", "@prisma/client"], // bundle せず deps レイヤーに入れる package
    "env": { "NODE_ENV": "production" },
    "ports": [3000],
    "user": "65532:65532",             // 既定: base の User。未設定なら nonroot
    "workdir": "/app",
    "labels": { "org.opencontainers.image.source": "https://github.com/..." },
    "args": [],                        // entrypoint の後ろに付ける引数
    "build": {                         // bun build に渡すオプションのサブセット
      "minify": true,
      "sourcemap": "external",         // "none" | "inline" | "external"
      "bytecode": false,
      "define": { "process.env.FOO": "\"bar\"" },
      "target": "bun"
    }
  }
}
```

**entrypoint 自動検出**: `bin`（文字列 or 単一エントリ） > `module` > `main` > `src/index.ts` > `index.ts`。
見つからなければエラー（推測しない）。

**external 自動検出**（`external` に追加でマージ）:
- `node_modules/<pkg>` 配下に `.node` ファイルを含む package
- `trustedDependencies` に列挙された package
- `@prisma/client`, `prisma`（engine を同梱する必要があるため）
- `bun build` が "Could not resolve" で失敗した package（1 回だけ自動リトライで external に回し、警告を出す）

---

## 5. ビルドパイプライン

```
resolve targets
  └ workspaces なら bun.lock から package 一覧を読む
for each target:
  1. base image の manifest / config を取得（platform ごと）
  2. deps レイヤー   : key = H(bun.lock の関連部分, externals, platform)  → cache lookup
  3. assets レイヤー : key = H(assets ファイル群)                          → cache lookup
  4. app レイヤー    : bun build を実行 → 決定的 tar → digest
  5. config を組み立て（entrypoint/env/user/labels/created）
  6. platform ごとの manifest → 複数なら image index
  7. blob 存在確認（HEAD）→ 無いものだけ push（cache hit は cross-repo mount）
  8. SBOM / 署名
  9. stdout に digest 参照を出力
```

各ステップは純粋関数として実装し、`--dry-run` で 7 以降を止められること。

---

## 6. レイヤー仕様

順序は固定。下から上へ変化頻度が上がる。

| # | レイヤー | 内容 | 展開先 | cache |
|---|---|---|---|---|
| 0 | base | base image のレイヤーそのまま | — | registry に既存 |
| 1 | deps | external とその推移的依存の `node_modules` | `/app/node_modules` | registry cache |
| 2 | assets | `assets` で指定したファイル | `/app/<元の相対パス>` | registry cache |
| 3 | app | bundle: `index.js` (+ sourcemap) / compile: バイナリ | `/app/` | 都度計算、HEAD で存在確認 |

空のレイヤー（deps が無い等）は **省略** する（空 tar を積まない）。

### 6.1 base image

既定: `oven/bun:1-distroless`（存在と中身を実装前に確認、§11）。
bunko は base の **digest を pin** して config に `org.bunko.base.digest` label を書く。
`bunko build` は毎回 tag を解決するので base 更新は自動追従。固定したければ `base` に digest を書く。

bundle モードの base 要件: `bun` バイナリが `/usr/local/bin/bun` にあること。
compile モードの base 要件: glibc + libstdc++（`gcr.io/distroless/cc-debian12` 既定）。
musl ターゲット（`bun-linux-x64-musl`）は M3 で対応検討。

### 6.2 deps レイヤー

1. `bun.lock`（JSONC）を parse し、externals から推移的依存の閉包を取る
2. 一時ディレクトリに `package.json`（externals のみ、lockfile 上のバージョン固定）と `bun.lock` をコピーし
   `bun install --production --frozen-lockfile` を実行。
   frozen が通らない場合は full install → 閉包外を削除、にフォールバック
3. platform 固有 optional deps は `bun install --os linux --cpu <arch>` で取得（要検証 §11。
   未対応なら該当 platform を native 環境で実行するか BuildKit 委譲 §9）
4. `node_modules` を決定的 tar 化

cache key: `sha256(lockfile 中の閉包エントリを正規化した JSON + platform + bun major version)`

### 6.3 app レイヤー（bundle モード）

```
bun build <entrypoint> --target=bun --outdir=<tmp> [--minify] [--sourcemap=...] [--define ...] \
  --external <each external> --packages=bundle
```

- 出力ファイル名は entrypoint に依らず `index.js` に固定（rename）
- HTML import（Bun.serve の静的アセット）は bun build が `<tmp>` に出すので、そのまま app レイヤーに含める
- **決定性チェック**: `--verify-deterministic`（隠しフラグ）で 2 回 build して digest 比較する。
  CI の bunko 自身のテストで必ず実行

### 6.4 app レイヤー（compile モード）

```
bun build <entrypoint> --compile --target=bun-linux-<arch> --outfile=<tmp>/app [--minify] ...
```

- platform ごとに別レイヤー
- `--bytecode` 有効時は決定性を再確認（未確認、§11）
- サイズが大きいことを警告で明示する（"consider mode: bundle"）

### 6.5 決定的 tar

- パスは UTF-8 バイト列で昇順ソート
- ディレクトリエントリも明示的に含める（親→子の順）
- mtime = `SOURCE_DATE_EPOCH`（既定 0）、atime/ctime 無し
- uid/gid = 0、uname/gname = 空
- mode: ディレクトリ 0755、実行ビットありファイル 0755、それ以外 0644
- xattr、PAX ヘッダ（サイズ超過時以外）、シンボリックリンクの解決なし（そのままリンクとして格納）
- gzip: mtime 0、name 無し、OS byte 255、圧縮レベル固定（6）
- `/app` の所有者は user と一致させず root のまま（読み取り専用前提）。書き込みが必要なら `/tmp`

DiffID（非圧縮 sha256）と圧縮 digest の両方を計算し、config の `rootfs.diff_ids` に入れる。

### 6.6 config

```json
{
  "architecture": "<arch>", "os": "linux",
  "created": "<SOURCE_DATE_EPOCH を RFC3339>",
  "config": {
    "Entrypoint": ["bun", "run", "/app/index.js"],   // compile: ["/app/app"]
    "Cmd": <args>,
    "Env": ["PATH=<base の PATH>", "NODE_ENV=production", ...],
    "WorkingDir": "/app",
    "User": "<user>",
    "ExposedPorts": {"3000/tcp": {}},
    "Labels": {
      "org.opencontainers.image.created": "...",
      "org.opencontainers.image.revision": "<git sha>",
      "org.bunko.version": "...",
      "org.bunko.base.digest": "sha256:...",
      "org.bunko.mode": "bundle"
    }
  },
  "rootfs": {"type": "layers", "diff_ids": [...]},
  "history": [ base の history..., {"created_by": "bunko deps"}, ... ]
}
```

base の Env/User/WorkingDir は継承し、bunko の設定で上書きする。

---

## 7. Registry cache

buildx の `type=registry` cache に相当する仕組みを、**レジストリの content-addressable 性だけ**で実現する。

### 7.1 cache tag

- repo: `$BUNKO_CACHE_REPO`（既定 `<repo>/bunko-cache`）
- tag: `k-<cache key の先頭 32 hex>`
- 中身: 単一レイヤーの最小 manifest（config は空 JSON blob）。annotation に
  `org.bunko.cache.key`, `org.bunko.cache.kind` (deps|assets), `org.bunko.cache.created`

### 7.2 lookup / hit 時の処理

1. `HEAD /v2/<cache repo>/manifests/k-<key>` → 200 なら GET してレイヤー digest を得る
2. 対象 repo に対して `POST /v2/<repo>/blobs/uploads/?mount=<digest>&from=<cache repo>`
   → 201 なら転送ゼロで完了
3. mount が 202（未対応）なら、cache repo から blob を GET して対象 repo に PUT（フォールバック）

hit 時は `bun install` を実行しない。ローカルの node_modules も見ない。

### 7.3 miss 時

レイヤーを作って対象 repo に push した後、同じ digest を cache repo に mount して cache tag を PUT。
cache tag の PUT 失敗はビルド失敗にしない（警告のみ）。

### 7.4 prune

`bunko cache prune --older-than 30d`: annotation の created を見て tag を DELETE。
DELETE 未対応レジストリでは一覧だけ出して案内。

### 7.5 ローカル cache

`~/.cache/bunko/` に blob（digest 名）と cache key → digest の index を置く。
registry より先にローカルを見る。`--no-local-cache` で無効。
`bun install` 自体は Bun のグローバルキャッシュ（`~/.bun/install/cache`）が効くので bunko は関与しない。

---

## 8. Multi-platform

- app レイヤー（bundle モード）と assets レイヤーは **platform 非依存**。1 回作って全 platform の manifest で共有
- deps レイヤーは platform ごとに key が変わるが、閉包に platform 固有 package が無ければ同一 digest になる
  （key に platform を含めるが、内容が同じなら blob は同じ）
- base は image index から platform ごとの manifest を選ぶ
- 出力は OCI image index（`application/vnd.oci.image.index.v1+json`）。
  platform が 1 つでも index で出す（`--no-index` で manifest 単体）
- QEMU 不要。native ビルドが必要な deps は §9

---

## 9. 逃げ道

### 9.1 BuildKit 委譲（native deps）

node-gyp 等でビルド時にコンパイルが要る package は bunko では作れない。
`bunko build --deps-from <image ref>` で、外部で作った `node_modules` を持つイメージの
最上位レイヤーを deps レイヤーとして採用する。cache key は同じ規則で計算し、cache tag にも登録する。
`examples/native-deps/` に buildx で deps だけ作る Dockerfile と Action の例を置く。

### 9.2 compile モード

前述。`bunko` のセルフビルド（配布用バイナリ）はこのモードを使う。

### 9.3 任意 base

`base` に何を指定しても良い。bundle モードでは `bun` の存在だけ起動前に検査（config の PATH を見て
`/usr/local/bin/bun` があるレイヤーを探す。見つからなければ警告）。

---

## 10. Workspaces

- root の `package.json` に `workspaces` があれば workspaces モード
- `bunko build .` は `bunko` キーを持つ package 全部（無ければ `bin` か `module` を持つもの）をビルド
- `bunko build ./apps/api ./apps/worker` で個別指定
- deps レイヤーの閉包は target ごとに計算する。閉包が同じなら digest が同じになり自動で共有される。
  意図的に「全 target 共通の deps レイヤー」にしたい場合は root の `bunko.sharedDeps: true`（M2）
- `bun build` は target ディレクトリを cwd として実行。workspace 内 package は bundle に巻き込む

---

## 11. 未決事項（実装前に検証）

- [ ] `oven/bun:1-distroless` の存在、`bun` のパス、User/Env の既定値
- [ ] `bun build --target=bun` の出力が決定的か（複数回実行して比較。ハッシュ付きファイル名、`import.meta` 展開、時刻埋め込みの有無）
- [ ] `--bytecode` 出力の決定性
- [ ] `bun install --os/--cpu` の有無と挙動（platform 固有 optional deps の取得手段）
- [ ] `bun.lock` の JSONC スキーマ（workspaces、catalog、patchedDependencies の表現）
- [ ] HTML import 時の出力ファイル構成（`bun build` が出す静的アセットの配置）
- [ ] musl ターゲットの実用性（distroless static が使えるか）
- [ ] ECR / GAR / GHCR / Docker Hub / Harbor で blob mount が動くか（未対応なら §7.2 フォールバック）

---

## 12. 実装

### 12.1 言語・配布

- TypeScript on Bun。**ランタイム依存ゼロ**（devDependencies は可）
- 配布: npm（`bunx bunko`）と GitHub Releases の単一バイナリ（compile モードでセルフビルド）
- 対応 Bun: 実装開始時点の最新 minor 以上。`engines.bun` に明記

### 12.2 リポジトリ構成

```
bunko/
├── packages/
│   ├── oci/            # 再利用可能な OCI ライブラリ（bunko 非依存）
│   │   ├── registry.ts   # distribution API client: auth, HEAD/GET/PUT blob, mount, manifest, referrers
│   │   ├── auth.ts       # docker config.json, credHelpers, credsStore, bearer token flow
│   │   ├── tar.ts        # 決定的 tar / gzip、DiffID 計算
│   │   ├── digest.ts
│   │   ├── types.ts      # manifest / index / config の型
│   │   └── layout.ts     # OCI layout, docker tarball 書き出し
│   └── bunko/
│       ├── cli.ts
│       ├── config.ts     # package.json "bunko" 読み取り + 自動検出
│       ├── lockfile.ts   # bun.lock parse、閉包計算
│       ├── layers/{deps,assets,app}.ts
│       ├── cache.ts      # registry cache + local cache
│       ├── build.ts      # パイプライン
│       ├── resolve.ts
│       └── sbom.ts
├── bench/
├── examples/{hello,fullstack,workspaces,native-deps,compile}/
├── test/
│   ├── unit/
│   └── e2e/              # ローカル registry（registry:2 を docker で起動 or 自前の in-memory 実装）
└── docs/
    ├── SPEC.md           # このファイル
    └── LAYERS.md         # レイヤー/キャッシュ形式の外部向け仕様（upstream 提案用）
```

### 12.3 テスト方針

- `packages/oci` は in-memory registry 実装（`test/fake-registry.ts`）に対してユニットテスト。
  mount 対応/非対応の両方をシミュレート
- 決定性テスト: examples を 2 回ビルドして全 digest 一致をアサート
- e2e: `registry:2` コンテナに対して build → pull → `docker run` で疎通（CI では optional）
- ベンチ: `bench/run.sh` が §1 の 4 指標を出力

### 12.4 エラーハンドリング方針

- 推測しない。entrypoint 不明、base に `bun` 無し、lockfile 無し（`bun.lock` 必須）はエラー
- registry の非対応（mount / referrers / DELETE）はフォールバックか警告。ビルド自体は止めない
- `bun` サブプロセスの stderr はそのまま流す

---

## 13. 供給網

- **SBOM**: `bun.lock` から SPDX 2.3 JSON を生成。base image の SBOM が referrer にあれば参照を含める。
  OCI 1.1 referrers API で push、未対応なら `sha256-<digest>.sbom` tag にフォールバック
- **provenance**: SLSA v1 の最小 statement（builder = bunko@version、materials = git sha, lockfile digest, base digest）
- **署名**: `--sign` で `cosign sign` を exec（bunko は署名を実装しない）
- **base digest pin**: 前述の label。`bunko build --check-base` で base の更新有無を表示（M3）

---

## 14. `bunko resolve`

- YAML/JSON 中の文字列 `bunko://<path>` を検出し、`<path>` を target としてビルド、
  `repo/name@sha256:...` に置換して stdout へ
- 複数 target は並列ビルド（deps cache の競合は digest 同一なので問題なし）
- `-f -` で stdin、`-f dir/` でディレクトリ内の `*.yaml`
- kustomize/helm との併用は `bunko resolve -f <(helm template ...)` で足りるので専用対応しない

---

## 15. マイルストーン

| M | 内容 | 完了条件 |
|---|---|---|
| M0 | `packages/oci`（auth, blob, manifest, tar）+ bundle モード + push | `bunx bunko build .` で hello が Cloud Run / k8s で動く。決定性テスト緑 |
| M1 | registry cache（deps/assets）、ローカル cache、multi-platform index、`--local`/`--kind` | ベンチ表を README に掲載。1 行変更で push が app レイヤーのみ |
| M2 | workspaces、`sharedDeps`、`resolve` | examples/workspaces で 3 サービスが deps を共有 |
| M3 | SBOM/provenance、`--sign`、`--check-base`、compile モード、musl 検討 | GitHub Action 公開 |
| M4 | `apply`、`cache prune`、`--deps-from`、フルスタック（HTML import）example | docs/LAYERS.md を upstream 提案として公開 |

M0 の前に §11 の検証を全部やること。結果は §11 のチェックボックスと本文に反映する。

---

## 16. 設計上の判断メモ

- `--compile` を既定にしない: bun ランタイム（60〜90MB）が毎回新規レイヤーになりキャッシュ不能。bundle モードなら差分は JS だけ
- キャッシュを registry に置く: CI ごとのキャッシュ設定を不要にし、cross-repo mount で pull も push も省く。buildx の registry cache は再利用時に pull が要る
- TS で書く: 利用者が Bun 開発者なので `bunx` で動くことが最重要。OCI クライアントを副産物として切り出せる
- 設定を package.json に閉じる: 設定ファイルを増やすと「Dockerfile 不要」の訴求が薄れる
- 推測しない: entrypoint も external も、自動検出できなければ止めて聞く。ko と同じ
