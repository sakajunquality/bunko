FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
USER root
COPY container/debian.sources /etc/apt/sources.list.d/debian.sources
RUN . /etc/os-release && test "$VERSION_CODENAME" = trixie \
 && apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates gpgv git \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/bunko /work /out /home/bunko/.cache \
 && chown -R 65532:65532 /work /out /home/bunko
ARG BUNKO_VERSION
ARG BUNKO_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/sakajunquality/bunko" \
      org.opencontainers.image.title="bunko" \
      org.opencontainers.image.documentation="https://github.com/sakajunquality/bunko/blob/main/docs/CI.md" \
      org.opencontainers.image.description="Build OCI images from Bun applications without Dockerfiles" \
      org.opencontainers.image.revision="${BUNKO_REVISION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${BUNKO_VERSION}"
COPY dist/release/bunko.js dist/release/SHA256SUMS dist/release/LICENSE dist/release/THIRD_PARTY_NOTICES.md /opt/bunko/
RUN cd /opt/bunko && sha256sum --check SHA256SUMS \
 && test "$(bun bunko.js version)" = "$BUNKO_VERSION" \
 && printf '#!/bin/sh\nexec /usr/local/bin/bun /opt/bunko/bunko.js "$@"\n' > /usr/local/bin/bunko \
 && chmod 0555 /usr/local/bin/bunko \
 && chmod -R a-w /opt/bunko
ENV HOME=/home/bunko XDG_CACHE_HOME=/home/bunko/.cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /work
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/bunko"]
CMD ["--help"]
