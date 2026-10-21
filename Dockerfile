# Control plane. Only source is in git: the console and Go helpers build here, and the
# prebuilt slot payloads come from the release pinned in deploy/payload.json.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
RUN npm install -g pnpm@10
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS helpers
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
WORKDIR /src
COPY worker/go.mod worker/go.sum ./worker/
RUN cd worker && go mod download
COPY worker/ ./worker/
COPY api-kernel/go.mod api-kernel/go.sum ./api-kernel/
RUN cd api-kernel && go mod download
COPY api-kernel/ ./api-kernel/
RUN cd worker && go build -buildvcs=false -trimpath -o /out/kin-worker ./cmd/kin-worker \
  && go build -buildvcs=false -trimpath -o /out/kin-egress ./cmd/kin-egress \
  && CGO_ENABLED=0 go build -buildvcs=false -trimpath -o /out/kin-slot-gate ./cmd/kin-slot-gate \
  && cd ../api-kernel && go build -buildvcs=false -trimpath -o /out/kin-api-kernel ./cmd/kin-api-kernel

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS payload
WORKDIR /src
COPY deploy/payload.json deploy/payload.json
COPY scripts/fetch-payload.mjs scripts/fetch-payload.mjs
RUN node scripts/fetch-payload.mjs --dest /payload

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iptables iproute2 python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/tapmodels
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY VERSION CHANGELOG.md ./
COPY docker/kin-os ./docker/kin-os
COPY docker/kin-kvm ./docker/kin-kvm
COPY --from=web /src/web/dist ./web/dist
COPY --from=payload /payload/bin/ /opt/tapmodels/image-bin/
COPY --from=helpers /out/ /opt/tapmodels/image-bin/
COPY share/wrap-cli /opt/tapmodels/image-wrap-cli
COPY --from=payload /payload/share/wrap-cli/ /opt/tapmodels/image-wrap-cli/
COPY --from=payload /payload/share/crag/ /opt/tapmodels/image-crag/
COPY scripts/docker-entrypoint.sh /usr/local/bin/tapmodels-entrypoint
RUN chmod 755 /usr/local/bin/tapmodels-entrypoint /opt/tapmodels/image-bin/* \
  && rm -f /opt/tapmodels/src/lib/oauth/auth.js \
  && cp -a /opt/tapmodels/src/config /opt/tapmodels/image-config \
  && mkdir -p /opt/tapmodels/vms /opt/tapmodels/data /opt/tapmodels/bin /opt/tapmodels/share
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    KIN_PROJECT_ROOT=/opt/tapmodels \
    KIN_DATA_DIR=/opt/tapmodels/data \
    KIN_KERNEL_BIN=/opt/tapmodels/bin/kin-kernel \
    KIN_EGRESS_BIN=/opt/tapmodels/bin/kin-egress \
    KIN_WORKER_BIN=/opt/tapmodels/bin/kin-worker \
    KIN_CODEX_KERNEL_BIN=/opt/tapmodels/bin/kin-codex-kernel \
    KIN_OAUTH_AUTH_BIN=/opt/tapmodels/bin/kin-oauth-auth \
    KIN_COMPUTER_BIN=/opt/tapmodels/bin/kin-computer \
    KIN_API_KERNEL_BIN=/opt/tapmodels/bin/kin-api-kernel
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/tapmodels-entrypoint"]
