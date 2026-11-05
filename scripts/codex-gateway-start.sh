#!/bin/sh
# 外部管理时启动 Codex Gateway Worker（kin-codex-gateway）。
#
#   scripts/codex-gateway-start.sh
#
# 默认由控制面托管同机的一个 Worker，不需要本脚本；多 Worker、跨主机或单独调试时在控制面设置
# KIN_CODEX_GATEWAY_SUPERVISE=0，再用本脚本或 systemd 启动。仓库根目录的 .env 提供默认值，
# 已 export 的同名环境变量优先。详见 docs/CODEX_GATEWAY_WORKER_SETUP.md。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${KIN_PROJECT_ROOT:-$(dirname -- "$SCRIPT_DIR")}

die() {
  echo "codex-gateway: $1" >&2
  exit 1
}

# .env 只填当前为空的键，不覆盖显式传入的环境变量。
load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in '' | \#*) continue ;; esac
    case $line in *=*) ;; *) continue ;; esac
    key=${line%%=*}
    case $key in *[!A-Za-z0-9_]* | '') continue ;; esac
    eval "current=\${$key-}"
    [ -n "$current" ] && continue
    value=${line#*=}
    case $value in
      \"*\") value=$(printf '%s' "$value" | sed -e 's/^"//' -e 's/"$//') ;;
      \'*\') value=$(printf '%s' "$value" | sed -e "s/^'//" -e "s/'$//") ;;
    esac
    export "$key=$value"
  done <"$1"
}

load_env "$ROOT/.env"

PORT=${PORT:-8787}
KIN_CODEX_GATEWAY_LISTEN=${KIN_CODEX_GATEWAY_LISTEN:-127.0.0.1:8790}
KIN_CODEX_GATEWAY_INSTANCE_ID=${KIN_CODEX_GATEWAY_INSTANCE_ID:-gw-$(hostname | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | cut -c1-24)}
KIN_CODEX_GATEWAY_ADVERTISE_URL=${KIN_CODEX_GATEWAY_ADVERTISE_URL:-http://$KIN_CODEX_GATEWAY_LISTEN}
KIN_CODEX_GATEWAY_DATA_DIR=${KIN_CODEX_GATEWAY_DATA_DIR:-$ROOT/data/codex-gateway}
KIN_CODEX_GATEWAY_CONTROL_PLANE_URL=${KIN_CODEX_GATEWAY_CONTROL_PLANE_URL:-http://127.0.0.1:$PORT/internal/v1/gateway/workers/register}
KIN_CODEX_GATEWAY_RECEIPT_URL=${KIN_CODEX_GATEWAY_RECEIPT_URL:-http://127.0.0.1:$PORT/internal/v1/gateway/receipts}
KIN_CODEX_GATEWAY_REQUIRE_MTLS=${KIN_CODEX_GATEWAY_REQUIRE_MTLS:-0}
if [ -z "${KIN_CODEX_GATEWAY_VERSION:-}" ] && [ -f "$ROOT/VERSION" ]; then
  KIN_CODEX_GATEWAY_VERSION=$(tr -d ' \t\r\n' <"$ROOT/VERSION")
fi
export PORT KIN_CODEX_GATEWAY_LISTEN KIN_CODEX_GATEWAY_INSTANCE_ID KIN_CODEX_GATEWAY_ADVERTISE_URL \
  KIN_CODEX_GATEWAY_DATA_DIR KIN_CODEX_GATEWAY_CONTROL_PLANE_URL KIN_CODEX_GATEWAY_RECEIPT_URL \
  KIN_CODEX_GATEWAY_REQUIRE_MTLS
[ -n "${KIN_CODEX_GATEWAY_VERSION:-}" ] && export KIN_CODEX_GATEWAY_VERSION

mtls_on=0
case ${KIN_CODEX_GATEWAY_REQUIRE_MTLS:-0} in 1 | true | yes | on) mtls_on=1 ;; esac

# 与 Go 侧 Config.Validate 对齐，提前给出可操作的报错。
if [ -z "${KIN_CODEX_GATEWAY_INTERNAL_TOKEN:-}" ] && [ "$mtls_on" -eq 0 ]; then
  die "KIN_CODEX_GATEWAY_INTERNAL_TOKEN 为空。生成：openssl rand -hex 32，并写入控制面与本 Worker 的同一个 .env"
fi
if [ -n "${KIN_CODEX_GATEWAY_CONTROL_PLANE_URL:-}" ] && [ -z "${KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY:-}" ]; then
  die "配置了 CONTROL_PLANE_URL 就必须配 KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY（openssl rand -hex 32）。可互相投影账号的 Worker 必须共用同一个值，且不要复用 INTERNAL_TOKEN"
fi
if [ "$mtls_on" -eq 1 ] && { [ -z "${KIN_CODEX_GATEWAY_TLS_CERT_FILE:-}" ] || [ -z "${KIN_CODEX_GATEWAY_TLS_KEY_FILE:-}" ] || [ -z "${KIN_CODEX_GATEWAY_TLS_CA_FILE:-}" ]; }; then
  die "REQUIRE_MTLS=1 需要同时配置 TLS_CERT_FILE / TLS_KEY_FILE / TLS_CA_FILE"
fi
if [ "$mtls_on" -eq 0 ]; then
  for url in "$KIN_CODEX_GATEWAY_CONTROL_PLANE_URL" "$KIN_CODEX_GATEWAY_RECEIPT_URL"; do
    [ -n "$url" ] || continue
    case $url in
      http://127.0.0.1[:/]* | http://localhost[:/]* | 'http://[::1]'[:/]* | https://*) ;;
      *) die "明文回连非环回地址被禁止：$url。跨主机请开启 REQUIRE_MTLS 并改用 https://" ;;
    esac
  done
fi

BIN=${KIN_CODEX_GATEWAY_BIN:-$ROOT/bin/kin-codex-gateway}
if [ ! -x "$BIN" ]; then
  die "找不到可执行文件 $BIN。本机构建：npm run build:codex-gateway；容器部署请确认控制面已启动过一次（入口会把镜像内二进制复制到 bin/）"
fi

mkdir -p "$KIN_CODEX_GATEWAY_DATA_DIR"
chmod 700 "$KIN_CODEX_GATEWAY_DATA_DIR" 2>/dev/null || true

echo "codex-gateway: instance=$KIN_CODEX_GATEWAY_INSTANCE_ID listen=$KIN_CODEX_GATEWAY_LISTEN advertise=$KIN_CODEX_GATEWAY_ADVERTISE_URL mtls=$mtls_on data=$KIN_CODEX_GATEWAY_DATA_DIR" >&2
exec "$BIN" "$@"
