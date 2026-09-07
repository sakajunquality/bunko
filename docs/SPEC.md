# bunko 実装仕様 — M2b

2026-09-07。現行実装の契約。将来の設計は [DESIGN.md](DESIGN.md)、元仕様は [archive/SPEC-v0.1.md](archive/SPEC-v0.1.md)、実測と未検証範囲は [VALIDATION.md](VALIDATION.md) を参照。

## 1. 対応範囲

standalone / workspace の Bun アプリを bundle し、base image と合成して OCI Registry に公開、完全な OCI layout / Docker archive に export、Docker / kind に load する。Bun は `>=1.3.11 <1.4`、検証基準は 1.3.11。CLI 自体の外部 npm runtime dependencies は 0。

一度に `linux/amd64` と `linux/arm64` を選べる。arm64 の省略 variant は v8 として扱い、platform は安定した順序で index に収録する。build 中に target executable やエミュレーターを起動しない。Docker archive / local / kind と `--no-index` は単一 platform に限定する。

通常の registry npm dependencies、workspace dependencies、明示的な production runtime externals を扱う。compile、bytecode、SBOM/provenance/sign、resolve/apply、外部 deps artifact、prune は後続 milestone。

## 2. CLI と結果

```sh
bunko build [path] --repo <registry/prefix> [options]
bunko build [path] --push=false --oci-layout <directory>
bunko build [path] --local
bunko version
```

| option | 動作 |
| --- | --- |
| path | 既定 `.`。`bunko://<path>` も許可。workspace では複数 target（§8） |
| `--target NAME/PATH` | root から workspace member を選択。複数指定可 |
| `--repo PREFIX` / `--bare` | 既定は PREFIX/project-name。bare は正確な repository 名として利用 |
| `--tag TAG` | 複数指定可。既定 latest と Git revision（dirty suffix あり） |
| `--push=false` | 公開を無効化。CLI は既定 push=true、公開先が必要 |
| `--oci-layout DIR` | 完全な OCI layout。既存の非空 directory は拒否 |
| `--tarball FILE` | 単一 platform の Docker archive。既存 file は拒否 |
| `--local` | Docker load と image inspect。push を無効化 |
| `--kind` / `--kind-cluster NAME` | 既存の Docker-backed kind cluster に load し全 node の image を確認 |
| `--base REF` / `--base-layout DIR` | Registry reference / local OCI layout。排他 |
| `--platform LIST` | comma 区切り。既定 linux/amd64 |
| `--bun-path FILE` | bundle/install に使う Bun executable |
| `--cache-dir DIR` / `--cache-repo REPO` | local layer cache / Registry cache の保存先 |
| `--no-cache` | 両 layer cache の永続再利用を無効化 |
| `--no-local-cache` / `--no-registry-cache` | 各 layer cache を無効化 |
| `--install-cache DIR` | Bun の package download cache。layer cache と独立 |
| `--insecure-registry HOST:PORT` | 指定 host の HTTP を明示許可。複数指定可 |
| `--dry-run` | build と Registry read で転送を見積もる。Registry write/export/load はしない |
| `--reproducible` | 明示的な base digest または local base layout を要求 |
| `--verify-deterministic` | layer cache を迂回して二つの staging の結果を比較 |
| `--git-metadata=false` | 自動 Git labels と Git-derived tag を省略 |
| `--no-index` | 単一 manifest を image root にする |
| `--report FILE` | JSON 結果。既存 file、layout 内の path は拒否 |

対応環境変数は `BUNKO_REPO`、`BUNKO_CACHE_DIR`、`BUNKO_CACHE_REPO`、`BUNKO_DOCKER_CONFIG`、`DOCKER_CONFIG`、`BUNKO_DEFAULT_BASE`、`BUNKO_DEFAULT_PLATFORMS`、`SOURCE_DATE_EPOCH`、`XDG_CACHE_HOME`、`KIND_CLUSTER_NAME`。CLI の明示値を優先する。未知・未対応 option は失敗し、無視しない。

stdout は、公開成功時に `repo@digest` 一行、local/kind 成功時に content tag 一行、export/dry-run は空。ログは stderr。exit code は成功 0、失敗 1。複数 tag の途中失敗でも stdout に成功結果を出さない。

単一 target の report は `schemaVersion:2`。複数 target は §8 の schemaVersion 3。`images[]` に platform ごとの manifest/config/base/layers、runtime inventory、native ELF 情報を収録し、`cache[]` に key と local/registry/miss/bypass を記録する。`publication` は reference、published、tags、pendingTags、transfers を持つ。transfer の uploaded は layer/config payload bytes（dry-run は推定）で、manifest/index、HTTP overhead、cache publication を含む wire total ではない。互換用の top-level manifest/config/layers/baseDigest は最初の platform を指す。

CLI は base を起動検査しないため `baseRuntimeVerified:false` を記録する。決定性比較の成否は `verifiedDeterministic`、実行時の速度は image identity に含めない。

## 3. 入力・設定・依存

entrypoint は `bunko.entrypoint > bin > module > main > src/index.ts > index.ts`。複数 bin は明示指定が必要。宣言した entrypoint が壊れていても fallback しない。

対応する `package.json.bunko` の例（全項目任意）:

```json
{
  "entrypoint": "src/server.ts",
  "mode": "bundle",
  "imageName": "hello",
  "base": "oven/bun:1.3.11-slim",
  "platforms": ["linux/amd64", "linux/arm64"],
  "external": ["@node-rs/xxhash"],
  "deps": {"strategy": "production"},
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

`build.bytecode:false`、`build.target:"bun"`、`enabled:true` も許可する。未知 key と未対応値はエラー。sourcemap は none / external。project bunfig.toml、source symlink、import attributes/macros、computed application require/import は拒否する。構文検出は保守的なため文字列やコメントを誤検出する場合がある。

base/platform は `CLI > BUNKO_DEFAULT_BASE / BUNKO_DEFAULT_PLATFORMS > package.json > 既定`。既定 base は `oven/bun:<selected Bun version>-distroless`。catalog による自動 digest pin は未実装。native dependency を検出した場合は共有ライブラリを含む明示 base が必要で、暗黙の distroless を使わない。

dependencies/devDependencies/optionalDependencies/peerDependencies のいずれかが非空なら text `bun.lock` が必要。v1 の text lock に限定し、root の依存宣言、optional peer metadata、overrides/resolutions、patchedDependencies を照合する。integrity のない entry、未知 schema、file/link/git/tarball spec などを拒否する。workspace protocol は §8 の制約内で許可する。patch 内容は key に含める。

build dependencies は source snapshot を複製した staging に host 用 frozen install する。external がある場合は別 staging に `--production --os=linux --cpu=x64|arm64` で install する。`--ignore-scripts --linker=isolated --backend=copyfile` を指定し、install 前後で manifest/lock の bytes が変わっていないことも検査する。source の node_modules をコピーせず、元の checkout は変更しない。

production strategy の runtime deps は production tree 全体を保持する。external closure の最小化は M2b。package 内の data files、peer context、内部 symlink を維持し、収録する runtime の外へ出る symlink、dangling link、preinstall/install/postinstall を宣言する runtime package は拒否する。external は production/optional/peer dependency の package root に限定し、typo/unresolved import を自動 external 化しない。

native `.node` は ELF64 little-endian、target architecture を検査し、DT_NEEDED を report に記録する。Bun の optional selection が glibc/musl 両方を含む場合は tree を維持する。任意 base の共有ライブラリ・ABI 検証や native source compile は行わない。examples/dependencies の glibc prebuilt addon は amd64/arm64 で実行確認した。

private npm は project `.npmrc` の HTTPS registry / scoped registry と認証設定を読み、`${ENV_NAME}` を展開する。認証値は install staging 内だけに mode 0600 で配置して終了時に削除し、snapshot、cache key、image、report、install エラーの生ログに出さない。解決に影響する非認証の registry 設定は key に入れる。

## 4. Snapshot・bundle・layer

通常 file/directory の内容 hash、正規化 mode、相対 path、directory 一覧から source digest を作る。mtime と checkout 絶対 path は identity に入れない。到達ソースだけへの縮小はしない。

`.git`、node_modules、`.bunko-build`、`.bunko-output`、`.bunko-cache`、`.docker`、`.aws`、`.config`、`.env*`、`.npmrc`、`.yarnrc.yml`、`.DS_Store` と指定 output/report/cache path を除外する。

Bun CLI は argv 配列、空の明示 config、小さな子プロセス環境、`--no-env-file --env=disable --reject-unresolved` で起動する。bundle は ESM、target=bun、packages=bundle、既定 minify=true。出力名を保持し、metafile から server entrypoint を識別する。HTML/browser output と external sourcemap は生成 tree から収録し、source map は安定した `bunko:///` path に正規化する。

assets は project 相対 file/directory/glob。未一致、case/file/親子 path 衝突、runtime node_modules との重複はエラー。layer 順は `base → deps → assets → app`、空 layer は省略し、追加内容は workdir に置く。

tar は UTF-8 byte order、明示 parent directory、uid/gid=0、uname/gname 空、mtime=SOURCE_DATE_EPOCH、通常 file=0644、実行 file/directory=0755、symlink=0777。長い path/linkpath/時刻は PAX。gzip は level=6、mtime=0、filename なし、OS byte=255。compressed digest と非圧縮 tar の DiffID を streaming で別々に算出する。

SOURCE_DATE_EPOCH は未設定なら 0、非負整数秒、上限 9999 年末。image.created と追加 history にも使う。同じ input snapshot、依存内容、設定、Git metadata、Bun/toolchain、pack implementation、base digest、platform、epoch が再現性の条件。

## 5. OCI 構成・Registry・export

base tag は invocation 内で一度解決する。OCI と Docker schema 2 の manifest/index、gzip/raw layer を扱い、digest/size を検証する。schema 1、zstd、foreign layer は未対応。base layer は必要になるまで取得を遅らせ、同じ Registry では mount や存在確認を利用する。

base の layer bytes と DiffID を維持する。Env/User/一般 label を継承し、app 設定で上書きする。base の bunko/Git revision label は持ち越さない。

- Entrypoint: `[runtime.bunPath, workdir + emitted server path]`
- Cmd: args、既定 `[]`
- WorkingDir: 設定値または `/app`
- User: 明示設定 → base の non-empty User → `65532:65532`
- Env: base → NODE_ENV=production → app env、key 順
- history: base に存在する場合だけ継承・追記。empty_layer / DiffID 数を検証

base の root User はそのまま継承する。examples は nonroot を明示。read-only rootfs は runtime 側で指定する。

Registry 認証と vendor 別手順は [REGISTRIES.md](REGISTRIES.md)。全 platform の構築成功後、blob/config → platform manifests → root index → tags の順に公開する。GET/HEAD は bounded retry。PATCH は 8 MiB chunk、曖昧な応答は upload offset / destination HEAD で照合する。manifest PUT は再取得で digest を確認する。途中失敗時は公開済み部分を report に残し、tag を rollback しない。

layout は到達可能な全 blob を収録し、一時 directory で完成させて rename する。Docker archive は manifest.json/config/検証済みの非圧縮 layer.tar を持つ。tarball/report は既存 file を上書きしない。local は Docker load + inspect、kind は kind load image-archive + 全 node の crictl inspecti を行う。

## 6. Cache

local は `${XDG_CACHE_HOME:-~/.cache}/bunko/v1` の CAS blob と atomic key record。Registry は公開先 repository の `bunko-cache-v1-{deps|assets}-<full-key>` tag、または明示した cache repository。custom OCI artifact は config に schema/key/kind/pack format/destination/platform/descriptor/DiffID/inventory/native 情報を持つ。

deps key は dependency manifest fields、lock 全体、patch 内容、非認証 registry 設定、Bun version/revision、target platform、base digest、libc、strategy/linker、external、destination、epoch、pack format を含む。app source、認証値、host 絶対 path、image tag は含めない。assets key は内容/mode/path、destination、epoch、pack format から作り、platform を共有する。

lookup は local → Registry metadata → miss。local blob は compressed digest と DiffID を検証する。remote hit の layer body は必要になったときに取得して両 digest を検証する。公開先に blob が存在する場合は remote cache の layer GET 自体を省略できる。metadata 破損や cache 読み取り失敗は診断して miss、取得した layer 本体の破損は安全に再利用できないためエラー。

新規 record は独立構築/決定性比較が成功した後に保存し、Registry cache は image publication 成功後に公開する。cache 書き込み失敗で image の成功を取り消さない。app layer の build cache、cross-process lock、cache prune は未実装。処理は主に直列で、将来設計の `--jobs` は未提供。

`--verify-deterministic` は二回とも永続 layer cache を迂回し、layer/config/platform manifest と inventory を比較する。Bun の package download cache の再利用は許可する。dry-run は local cache や package download を利用しうるが、Registry の書き込みと成果物の export/load を行わない。report の出力は許可する。

## 7. 検証

`bun run check` は型チェックとネットワーク不要の unit/integration。Python tarfile で tar/PAX と Docker archive を独立検査する。`bun run test:m1-smoke` は実 Distribution Registry、public npm/base、Docker を使い、両 platform の構築、決定性、source 変更時の deps/assets 再利用、Registry からの pull と Docker 実行、local load を確認する。

サービス別の実 push、汎用 native ABI、musl runtime、HTML の実配信、他 Bun version、性能比較の繰り返し測定は未検証。[検証記録](VALIDATION.md) に実測値と制約を残す。


## 8. Workspace と複数 target（M2a）

workspace root の `package.json.workspaces` は相対・正の glob pattern 配列を受け付ける。package 名は member 間で一意にし、宣言と実 directory から membership を決定して root の bun.lock と相互検証する。root を含む全 member の name/version/依存宣言/optional peers を照合する。snapshot 作成中の manifest や membership 変更も拒否する。

member の package directory を明示すると、親の宣言を探索して共通 lock を使う。root からは enabled:false を除く bunko 設定のある子を優先し、それがなければ bin/module を持つ子を選ぶ。候補ゼロはエラー。root 自身の選択は `--target .`、個別 member は package 名または root 相対 path の `--target`（複数可）で指定する。同一 target の重複は除去し、path 順に処理する。root の bunko 設定は子へ継承しない。

構築前に全 target の設定、image 名の衝突、出力制約、lock の整合性を検査する。`--bare` と `--tarball` は単一 target 限定。全 target/platform の構築と決定性比較が成功してから export/push/load する。base の tag 解決結果は同じ invocation 内で共有する。

共通 root を一度 snapshot し、元の workspace 相対構造を維持した別 staging に build / Linux production install する。member の bundling はその directory を cwd にし、metafile と sourcemap の source は workspace snapshot 全体を境界とする。root の相対 tsconfig extends と他 member の source import を許可する。

通常の workspace dependencies は bundle する。runtime external がある場合は root と全 member の production node_modules、それらから参照され得る workspace package の全 files を `workdir/.bunko-workspace/` に収録する。Bun が作った相対 topology と peer context を維持し、選択した service の external roots を `workdir/node_modules/<package>` からその実体へ link する。workdir と app/assets の配置は変えない。存在しない外部 package、収録範囲外への link、install scripts を必要とする runtime package は拒否する。

production strategy は workspace 全体の tree を対象にするため、選んだ service が不要な依存や、bundle 済みの共通 package も含み得る。workspace package が version を宣言しない場合、inventory の version は空文字で未指定を表す。縮小・sharedDeps は §9 を参照。

cache key は全 member の依存関連 manifest、全 lock、target path、workspace layout version と、runtime に入り得る workspace package の source 内容を含む。service source だけの変更では deps を再利用でき、runtime shared package の変更では miss になる。source digest は root snapshot 全体であり、他 service の source 変更でも image config / root digest が変わる場合がある。

複数 target の OCI layout は一つの index.json から名前 annotation を付けた各 target root を参照し、到達可能な blob を重複なく収録する。単一 target の export 形式は変えない。

複数 target の report は `{schemaVersion:3,status,targets:[BuildResult...]}`。各 result は targetPath を含む。失敗時は error と pendingTargets を追加し、公開済み root / tags と未更新 tags を targets 内に残す。Registry 公開・local load に横断 transaction はない。stdout は全 target の要求が成功した場合だけ固定順で一行ずつ出す。

API は `buildTargets(options): Promise<BuildResult[]>` を追加する。既存 `build(options)` は一つの target を返し、複数選択は副作用の前に拒否する。

M2a では nested workspace、workspace の object/catalog 形式、否定 glob、file/link package、member ごとの npmrc/overrides/resolutions/patchedDependencies は非対応。後者は root へまとめる。project bunfig と install scripts の制約は M1 と同じ。

## 9. Dependency closure / sharedDeps（M2b）

`bunko.deps.strategy` / `--deps-strategy` は production（既定）または closure。closure は元の manifest/lock を変更せず Bun の Linux production install を行い、明示 external を起点に dependencies / optionalDependencies / peerDependencies を実際の node_modules resolution でたどる。省略された optional / optional peer は許可し、required edge の欠落は拒否する。独自の semver 解決は行わない。

instance ごとの package files（workspace source、JSON/data、license、実行属性も含む）を workdir/.bunko-deps 下へ収録し、各 instance に解決済み edge の node_modules link を配置する。version/peer context を別 instance として保持する。到達しない node_modules と dev dependencies は除く。依存の bin link も投影し、同一 scope の bin 名衝突は拒否する。package は runtime imports を dependencies/optionalDependencies/peerDependencies に宣言する必要がある。未宣言の hoisted dependency への偶然のアクセスには対応しない。

root の `bunko.sharedDeps:true` または `--shared-deps` は選択 target の closure の和集合を一度準備する。全 target は closure strategy、同じ workdir/base/platforms を使う必要がある。明示 strategy がなければ closure が選ばれる。target の external aliases は app layer に置き、共有 deps layer の digest は platform ごとに一致する。単独 target での build はその target だけの和集合になる。

closure key は投影後の全 file の SHA256、mode、path、symlink edges、layout version、toolchain、platform、base digest、workdir、epoch、pack format を含む。全 lock は key に入れず、元 lock の整合検査と frozen install は毎回実施する。Linux install と graph 確認は cache hit 時も必要で、layer 圧縮・転送を再利用する。production の cache hit 時に Linux install を省略する契約は維持する。異なる取得元や patch でも投影 bytes が同一なら再利用可能。

symlink の install tree / closure 外への脱出、特殊 file、install scripts 必須 package、native ELF/platform の検査は投影時に行う。assets/app は .bunko-deps と node_modules を上書きできない。determinism 検証では graph も別々の install から構築する。
