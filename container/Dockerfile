FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates gpgv git \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/bunko /work /out /home/bunko/.cache \
 && chown -R 65532:65532 /work /out /home/bunko
ARG BUNKO_VERSION
LABEL org.opencontainers.image.source="https://github.com/sakajunquality/bunko" \
      org.opencontainers.image.title="bunko" \
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
