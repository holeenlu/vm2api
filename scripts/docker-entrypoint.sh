#!/bin/sh
set -eu

ROOT="${KIN_PROJECT_ROOT:-/opt/tapmodels}"
IMAGE_BIN="/opt/tapmodels/image-bin"
mkdir -p "$ROOT/vms" "$ROOT/data" "$ROOT/bin"

# 镜像安装没有仓库 checkout：把镜像内默认配置补进被 bind-mount 覆盖的 src/config。
mkdir -p "$ROOT/src/config"
if [ -d /opt/tapmodels/image-config ]; then
  for f in /opt/tapmodels/image-config/*; do
    [ -f "$f" ] || continue
    dest="$ROOT/src/config/$(basename "$f")"
    [ -f "$dest" ] || cp "$f" "$dest"
  done
fi

# No seeded vm-01. A fresh fleet is empty. Seeding an active placeholder made
# the only slot undeletable: DELETE refuses the active VM, and the next start
# would recreate the files.

ensure_bin() {
  name="$1"
  dest="$ROOT/bin/$name"
  src="$IMAGE_BIN/$name"
  if [ ! -f "$src" ]; then
    if [ -f "$dest" ]; then
      chmod 755 "$dest" || true
    fi
    return 0
  fi
  tmp="$dest.new"
  cp "$src" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
}
ensure_bin kin-kernel
ensure_bin kin-egress
ensure_bin kin-slot-gate
ensure_bin kin-worker
ensure_bin kin-api-kernel
ensure_bin kin-codex-kernel
ensure_bin kin-oauth-auth
ensure_bin kin-computer
KERNEL="${KIN_KERNEL_BIN:-$ROOT/bin/kin-kernel}"
if [ ! -x "$KERNEL" ]; then
  echo "tapmodels: $KERNEL missing or not executable after image-bin copy. Rebuild with docker compose build, or put linux amd64 Release files in $ROOT/bin." >&2
  exit 1
fi
API_KERNEL="${KIN_API_KERNEL_BIN:-$ROOT/bin/kin-api-kernel}"
if [ ! -x "$API_KERNEL" ]; then
  echo "tapmodels: $API_KERNEL missing or not executable after image-bin copy. Rebuild the control-plane image so kin-api-kernel is staged in image-bin." >&2
  exit 1
fi
mkdir -p "$ROOT/share/wrap-cli"
WRAP_CHANGED=0
if [ -d /opt/tapmodels/image-wrap-cli ]; then
  # 首装先整目录落地（glibc239 / SAMPLE.json），再由下面的循环按内容覆盖可执行文件。
  if [ ! -f "$ROOT/share/wrap-cli/cli-node" ]; then
    cp -a /opt/tapmodels/image-wrap-cli/. "$ROOT/share/wrap-cli/"
    WRAP_CHANGED=1
  fi
  # cli-node 也随镜像覆盖：只在缺失时复制会让升级用户一直留着旧 ELF（#120 baseline 换不进去）。
  for name in kin-kernel.bin kin-kernel cli-node cc-node; do
    src="/opt/tapmodels/image-wrap-cli/$name"
    dest="$ROOT/share/wrap-cli/$name"
    if [ -f "$src" ]; then
      if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
        WRAP_CHANGED=1
      fi
      cp "$src" "$dest.new"
      chmod 755 "$dest.new"
      mv -f "$dest.new" "$dest"
    fi
  done
fi
# The crag kernel no longer comes from a repo checkout; refresh it from the image like the wrap ELFs.
if [ -f /opt/tapmodels/image-crag/kin-kernel ]; then
  mkdir -p "$ROOT/share/crag"
  dest="$ROOT/share/crag/kin-kernel"
  if [ ! -f "$dest" ] || ! cmp -s /opt/tapmodels/image-crag/kin-kernel "$dest"; then
    cp /opt/tapmodels/image-crag/kin-kernel "$dest.new"
    chmod 755 "$dest.new"
    mv -f "$dest.new" "$dest"
    WRAP_CHANGED=1
  fi
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "tapmodels: /var/run/docker.sock not mounted; slot create/start will fail." >&2
elif [ -f /opt/tapmodels/docker/kin-os/build.mjs ]; then
  # 只拉预构建客体镜像；拉不到不阻塞启动，建槽时再兜底构建。
  node /opt/tapmodels/docker/kin-os/build.mjs --pull-only ubuntu || true
fi

# start-server persists per-installation secrets (including a random initial
# administrator password) in data/runtime-secrets.json, mode 0600.
# Explicit environment/.env credentials take precedence; never log passwords.
if [ "$WRAP_CHANGED" = 1 ] && [ "${KIN_AUTO_SYNC_WRAP:-0}" = 1 ]; then
  node /opt/tapmodels/scripts/sync-wrap-cli.mjs &
fi

cd /opt/tapmodels
exec node scripts/start-server.mjs
