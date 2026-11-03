#!/bin/sh
set -eu

ROOT=$1
PROJECT=$2
CONTAINER=$3
PREVIOUS_ID=$4
TAG=$5
ARCH=$6
shift 6
cd "$ROOT"

STATUS_FILE="$ROOT/.tapmodels-upgrade-status"
FINISHED=0

write_status() {
  phase=$1
  progress=$2
  message=$3
  tmp="$STATUS_FILE.tmp.$$"
  {
    printf 'target=%s\n' "$TAG"
    printf 'phase=%s\n' "$phase"
    printf 'progress=%s\n' "$progress"
    printf 'message=%s\n' "$message"
    printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_FILE" 2>/dev/null || rm -f "$tmp"
}

on_exit() {
  if [ "$FINISHED" -eq 0 ]; then
    write_status failed 0 '升级任务失败，请查看更新日志'
  fi
}

trap on_exit EXIT

COMPOSE_FILE_LIST=''
for file do
  if [ -n "$COMPOSE_FILE_LIST" ]; then COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:"; fi
  COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST$file"
done

compose() {
  COMPOSE_FILE="$COMPOSE_FILE_LIST" env -u DOCKER_DEFAULT_PLATFORM docker compose \
    --project-directory "$ROOT" --project-name "$PROJECT" "$@"
}

# Use the HTTP server's kernel client, so this also catches auth/protocol regressions.
# Busy kernels may have no idle slots; process health still has to survive the update.
probe() {
  docker exec "$CONTAINER" node --input-type=module -e '
    const [mode, target, baseline = "[]"] = process.argv.slice(1)
    const port = process.env.PORT || "8787"
    const base = `http://127.0.0.1:${port}`
    const fs = await import("node:fs")
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync((process.env.KIN_DATA_DIR || "/opt/tapmodels/data") + "/runtime-secrets.json", "utf8")) } catch {}
    const key = process.env.TAPMODELS_API_KEY || process.env.KIN_API_KEY || saved.TAPMODELS_API_KEY || ""
    async function json(path) {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
      const body = await res.json()
      return body.data || body
    }
    function kernelHealthy(detail) {
      const kernel = detail.kernel
      const health = kernel?.codex_health || kernel?.rust_health || kernel?.go_health
      return health?.status === 200 && health.process_up !== false && health.healthy !== false
    }
    async function mapLimit(items, limit, fn) {
      const out = new Array(items.length)
      let cursor = 0
      async function worker() {
        while (cursor < items.length) {
          const index = cursor++
          out[index] = await fn(items[index], index)
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
      return out
    }
    async function checkSlot(id) {
      try {
        return kernelHealthy(await json(`/api/panel/vms/${encodeURIComponent(id)}`))
          ? { id, ok: true }
          : { id, ok: false, error: "kernel unhealthy" }
      } catch (error) {
        return { id, ok: false, error: error.message }
      }
    }
    try {
      if (mode === "snapshot") {
        const list = await json("/api/panel/vms")
        const vms = Array.isArray(list) ? list : list.items
        if (!Array.isArray(vms)) throw new Error("Invalid slot list")
        const checks = await mapLimit(
          vms.filter(vm => vm.status === "running").map(vm => vm.id),
          8,
          checkSlot,
        )
        const healthy = checks.filter(item => item.ok).map(item => item.id)
        const failed = checks.filter(item => !item.ok)
        if (failed.length) console.error(`Pre-upgrade slot checks failed: ${failed.map(item => `${item.id} (${item.error})`).join(", ")}`)
        console.log(JSON.stringify(healthy))
      } else {
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
        if (!health.ok) throw new Error(`Backend health: HTTP ${health.status}`)
        const version = await json("/api/panel/version?status=1")
        if (version.current_tag !== target) throw new Error(`Backend still at ${version.current_tag}`)
        const checks = await mapLimit(JSON.parse(baseline), 8, checkSlot)
        const failed = checks.filter(item => !item.ok)
        if (failed.length) {
          throw new Error(
            failed
              .map(item => `Previously healthy slot ${item.id} failed kernel verification: ${item.error}`)
              .join("; "),
          )
        }
      }
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  ' "$@"
}

# Let the update request return before replacing its own HTTP server.
write_status starting 0 '正在准备升级任务'
sleep 2
write_status snapshot 10 '正在并行记录升级前的槽位健康状态'
BASELINE=$(probe snapshot "$TAG")
echo "Recording healthy slot kernels before upgrade: $BASELINE"
write_status snapshot 20 '升级前槽位健康快照已完成'
if [ -d .git ]; then
  if [ "$ARCH" = arm64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.arm64.yml:"*) ;;
      *) echo 'ARM64 source install lacks docker-compose.arm64.yml' >&2; exit 1 ;;
    esac
  fi
  export GIT_TERMINAL_PROMPT=0
  command -v git >/dev/null || apk add --no-cache git >/dev/null
  git config --global --add safe.directory "$ROOT"
  # Fetch only the fork tag, without reusing an upstream tag of the same name.
  git fetch --no-tags https://github.com/holeenlu/vm2api.git "refs/tags/$TAG"
  RELEASE_COMMIT=$(git rev-parse 'FETCH_HEAD^{commit}')
  # Routing and interception rules are tracked defaults but live operator config.
  CONFIG_BACKUP=$(mktemp -d)
  if [ -d src/config ]; then cp -a src/config "$CONFIG_BACKUP/config"; fi
  restore_config() {
    if [ -d "$CONFIG_BACKUP/config" ]; then
      mkdir -p src/config
      cp -a "$CONFIG_BACKUP/config/." src/config/
    fi
    rm -rf "$CONFIG_BACKUP"
  }
  if ! git checkout -f --detach "$RELEASE_COMMIT"; then
    restore_config
    exit 1
  fi
  restore_config
  chmod 755 bin/kin-* 2>/dev/null || true
  grep -q '^!CHANGELOG.md$' .dockerignore 2>/dev/null || printf '\n!CHANGELOG.md\n' >> .dockerignore
  if [ "$ARCH" = amd64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.build.yml:"*) ;;
      *) COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:$ROOT/docker-compose.build.yml" ;;
    esac
  fi
  write_status building 35 '正在构建控制面镜像'
  compose build tapmodels
else
  IMAGE_TAG=$TAG
  [ "$ARCH" != arm64 ] || IMAGE_TAG=$TAG-arm64
  touch .env
  if grep -q '^TAPMODELS_IMAGE=' .env; then
    sed -i.bak 's|^TAPMODELS_IMAGE=.*|TAPMODELS_IMAGE=ghcr.io/holeenlu/tapmodels-gateway|' .env
    rm -f .env.bak
  else
    printf '\nTAPMODELS_IMAGE=ghcr.io/holeenlu/tapmodels-gateway\n' >> .env
  fi
  if grep -q '^TAPMODELS_IMAGE_TAG=' .env; then
    sed -i.bak "s|^TAPMODELS_IMAGE_TAG=.*|TAPMODELS_IMAGE_TAG=$IMAGE_TAG|" .env
    rm -f .env.bak
  else
    printf '\nTAPMODELS_IMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
  fi
  write_status pulling 35 '正在拉取控制面镜像'
  compose pull tapmodels
fi

write_status restarting 55 '正在替换控制面容器'
compose up -d --no-deps --force-recreate tapmodels
CURRENT_ID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
if [ "$CURRENT_ID" = "$PREVIOUS_ID" ]; then
  echo 'Compose did not replace the running control plane' >&2
  exit 1
fi

# Check the backend and previously healthy slots, rather than trusting VERSION.
write_status verifying 65 '正在等待控制面恢复并验证版本'
attempt=0
while [ "$attempt" -lt 45 ]; do
  if probe verify "$TAG" "$BASELINE"; then
    [ -d .git ] || printf '%s\n' "${TAG#v}" > VERSION
    # Slot payloads through the new server (it alone holds the cluster links):
    # compare kernel/CLI first; changed payloads are synced with restart=true.
    # Then publish saved native telemetry policies, including remote nodes.
    # Unchanged payloads do not trigger a blanket worker/egress restart.
    # Older control-plane images may not carry the helper yet; retry on the
    # next image update instead of invalidating an otherwise verified upgrade.
    write_status refreshing 82 '正在检查并刷新需要变更的槽位资源'
    if ! docker exec "$CONTAINER" test -f /opt/tapmodels/scripts/fleet-services.mjs >/dev/null 2>&1; then
      echo "Slot refresh helper is not present in the control plane; retry after the next image update" >&2
    elif ! docker exec "$CONTAINER" node /opt/tapmodels/scripts/fleet-services.mjs; then
      echo "Slot payload/service refresh failed; inspect the per-slot report" >&2
      exit 1
    fi
    write_status completed 100 '升级完成，控制面和必要槽位已验证'
    FINISHED=1
    echo "Control plane restarted and verified at $TAG"
    echo "Previously healthy slot kernels verified: $BASELINE"
    exit 0
  fi
  attempt=$((attempt + 1))
  verification_progress=$((65 + attempt / 3))
  [ "$verification_progress" -le 80 ] || verification_progress=80
  write_status verifying "$verification_progress" "正在等待控制面和槽位恢复（第 ${attempt}/45 次）"
  sleep 2
done
echo "Control plane or previously healthy slot kernels did not become healthy at $TAG" >&2
exit 1
