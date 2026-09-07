# Registry 設定と検証状況

M1 は OCI Distribution の push/pull と Docker-compatible credentials を実装する。cloud SDK は同梱せず、認証済み Docker config / credential helper を利用する。repository の作成や cloud IAM の変更は行わない。

## 対応表

| Registry | `--repo` の例（prefix） | 認証 | 現時点の検証 |
| --- | --- | --- | --- |
| GitHub Container Registry | `ghcr.io/OWNER` | Docker login、PAT / workflow token | helper・Basic → scoped Bearer の自動試験。サービスへの実 push は未検証 |
| Google Artifact Registry | `asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY` | `gcloud` / `gcr` helper、access token | helper・Bearer の自動試験。サービスへの実 push は未検証 |
| Docker Hub | `docker.io/USERNAME` | Docker login / credential store | 公開 base の実 pull、host alias・Bearer の自動試験。アカウントへの実 push は未検証 |
| Amazon ECR private | `ACCOUNT.dkr.ecr.REGION.amazonaws.com/PREFIX` | `ecr-login` helper、AWS password | helper・Basic challenge と再取得の自動試験。サービスへの実 push は未検証 |
| OCI Distribution | `localhost:5000/demo` | Basic / Bearer / anonymous | Distribution 3 で実 push/pull、cache 再利用、コンテナ実行を確認 |

prefix に `bunko.imageName` または project 名が付く。Docker Hub で repository `USERNAME/app` を正確に指定する場合などは `--repo docker.io/USERNAME/app --bare` を使う。GAR の project/repository、ECR の完全な image repository は事前に用意する。ECR Public や Harbor 固有の拡張、referrers/署名は別途検証が必要。

各 cloud Registry への公開試験には利用者が指定した repository と権限が必要なため、この PR では未実施。mock の成功を cloud の相互運用確認として扱わない。

## 認証設定の選択

config の参照順は次のとおり。

1. `BUNKO_DOCKER_CONFIG`: **file** path
2. `$DOCKER_CONFIG/config.json`: Docker と同じ directory 指定
3. `~/.docker/config.json`

registry ごとの `credHelpers` → `credsStore` → `auths` の順に選ぶ。選んだ helper が失敗した場合は stale な `auths` に切り替えない。helper は `PATH` 上の `docker-credential-NAME get` を実行し、server を stdin へ渡す。Docker Hub の `docker.io` / `registry-1.docker.io` / `https://index.docker.io/v1/` を対応付ける。[Docker credential stores](https://docs.docker.com/reference/cli/docker/login/#credential-stores)

`auths` の username/password、base64 `auth`、`identitytoken`、`registrytoken` に対応する。HTTP 401 の Basic / Bearer challenge に従って認証し、Bearer token は scope と有効期限を考慮して再利用する。別 origin の storage redirect に Registry の Authorization を転送しない。[Registry authentication](https://docs.docker.com/reference/api/registry/auth/)

## 設定例

以下の大文字名は環境に合わせて置換する。login は通常の Docker CLI で一度行うか、既存 helper を使用する。

### GHCR

PAT classic を使う場合は公開先に `write:packages` 権限が必要。GitHub Actions では repository/package へのアクセス権を持つ `GITHUB_TOKEN` と `packages: write` を設定する。[GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

```sh
# 対話ログイン: token をコマンド引数に含めない
# CI では secret を docker login --password-stdin に渡す
docker login ghcr.io --username USERNAME
bun run dev build examples/hello --repo ghcr.io/OWNER
```

### Google Artifact Registry

gcloud CLI を認証した環境で対象 host の helper を設定する。standalone `docker-credential-gcr` と ADC も利用できる。[Artifact Registry authentication](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication)

```sh
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
bun run dev build examples/hello \
  --repo asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY
```

### Docker Hub

```sh
docker login --username USERNAME
bun run dev build examples/hello --repo docker.io/USERNAME
```

### Amazon ECR

`docker-credential-ecr-login` をインストールし、Docker config に host ごとの helper を指定する。

```json
{
  "credHelpers": {
    "ACCOUNT.dkr.ecr.REGION.amazonaws.com": "ecr-login"
  }
}
```

AWS credentials は helper 側で解決する。helper を使わない場合は AWS CLI から password を stdin に渡す。ECR authorization token は 12 時間有効。[ECR private registry authentication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html)

```sh
aws ecr get-login-password --region REGION | \
  docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
bun run dev build examples/hello \
  --repo ACCOUNT.dkr.ecr.REGION.amazonaws.com/hello --bare
```

### HTTP の開発用 Registry

HTTPS が既定。loopback を含め、HTTP を使う host は明示する。

```sh
bun run dev build examples/hello --repo localhost:5000/demo \
  --insecure-registry localhost:5000
```

TLS 証明書の検証を無効化する flag ではない。

## Cache と公開失敗

cache は既定で image と同じ repository の `bunko-cache-v1-deps-<full-key>` / `bunko-cache-v1-assets-<full-key>` tag に保存する。別 repository は `--cache-repo` または `BUNKO_CACHE_REPO`。cache の custom OCI artifact が許可されない場合や書き込み権限がない場合は警告し、image の公開は成功扱いにできる。不要なら `--no-registry-cache` を指定する。

blob は HEAD → 同一 Registry の cross-repository mount → upload の順に配置する。upload は 8 MiB ごとの chunk と offset 照合を使う。全 platform の manifest/index を digest で公開した後に tag を更新する。複数 tag は transaction ではなく、途中失敗時は `--report` に公開済み digest / tags / pendingTags を残し、exit 1・stdout 空とする。既存 tag の rollback はしない。

Registry credentials は npm credentials と別扱い。private npm は project `.npmrc` の HTTPS registry / scoped registry と `${ENV_NAME}` の認証値を利用する。認証 file は install staging だけに置いて終了時に削除し、cache key、image、report に認証値を入れない。
