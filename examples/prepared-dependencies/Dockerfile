# Supply a digest-pinned Bun image matching the application toolchain and libc.
ARG BASE
FROM ${BASE} AS prepare
WORKDIR /prepared
COPY package.json bun.lock ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    bun install --production --frozen-lockfile --ignore-scripts --cache-dir /tmp/bun-cache
# Keep generation explicit and reviewed; do not enable every dependency script.
COPY generate.ts ./
RUN bun run generate.ts

FROM scratch
COPY --from=prepare /prepared/node_modules /node_modules
