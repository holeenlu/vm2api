# 版本与构建

提交、推送、上游同步和授权边界见 [交付规范](CHANGE_DELIVERY.md)；应用发版步骤以 [品牌与发布](BRANDING_AND_RELEASE.md) 及当前 `.github/workflows/release.yml` 为准。

git 里只有源码。`bin/`、`web/dist`、`share/crag` 与 `share/wrap-cli` 里的 ELF / glibc 都不进 git：

- `web/dist`、`kin-worker`、`kin-egress`、`kin-slot-gate` 与 `kin-api-kernel` 由源码编译；保留 tapmodels 的 HTTP/HTTPS/SOCKS 代理定制，不使用上游预编译 Go helper。
- 生产验证过的 linux amd64 产物（`kin-kernel`、`kin-codex-kernel`、`kin-oauth-auth`、`kin-computer`、`cli-node`、`cc-node`、crag kernel、glibc 2.39 shim）放在独立的 payload Release，由 [`deploy/payload.json`](../deploy/payload.json) 按 sha256 / 大小钉住。`npm run fetch:payload` 下载并校验到 `bin/` / `share/`；镜像构建同样按清单下载，校验不过即失败。

正常构建使用已锁定的上游资产，不需要自己发布 payload。校验失败先核实来源，不能重算哈希掩盖上游文件被替换。只有另行授权更换/发布自有 payload 时，才准备并核对完整文件集：

```bash
node scripts/fetch-payload.mjs --pin payload-YYYY.MM.DD     # 重算清单 sha256 / 大小并指向新 Release
node scripts/fetch-payload.mjs --stage /tmp/payload          # 按 asset 名导出
gh release create payload-YYYY.MM.DD /tmp/payload/* --repo holeenlu/vm2api --prerelease --latest=false \
  --title "slot payload YYYY.MM.DD" --notes "Pinned by deploy/payload.json"
```

自有 payload 发布后，同步核对 `deploy/payload.json` 的 `repo`、`release` 与文件级来源，再从空目录下载验证后提交；`--pin` 不会自动改写 `repo`。payload Release 必须 `--prerelease --latest=false`：一键脚本与面板按 `releases/latest` 找应用版本。现有固定上游来源不因应用交付仓库改变而自动迁移。

## 版本怎么记

| 记号 | 谁写 | 含义 |
|---|---|---|
| 仓库根 `VERSION` | 正式发布流程在发布提交中更新 | 对外 semver，和发布 tag 对齐；源码值参与下一版本计算 |
| git tag `v*` | 正式发布流程创建 | 指向发布提交；tag 推送不触发发版 |
| Actions run 的 commit SHA | GitHub | 对照源码与构建；不再单独上传 `VERSION.txt` |

`VERSION` 是应用版本来源；正式发版时，`scripts/release/plan.py` 只在发布提交内更新 VERSION，不写入 package 元数据，不将该提交强行回推 main。变更说明维护在 [CHANGELOG.md](../CHANGELOG.md) 或对应交付文档。`Dockerfile` 拷贝 VERSION 和 CHANGELOG，面板据此读取版本；一键脚本按自己的 GitHub Release tag 升级。无需在本机手动打 tag 触发工作流。

## 打一个 Release

在 `holeenlu/vm2api` 的 Actions → **Manual versioned release** → **Run workflow**，选择 `main`。默认 `publish=true` 正式发版；取消勾选才以 `publish=false` 做构建验收。版本自动使用上游 X.Y.Z 前缀及递增修订号，不接受手填版本。不要向本机仍指向上游的 `origin` 推送标签。

正式流程预留版本与草稿，完成测试、linux/amd64 构建和镜像启动验收后才上传完整资产并发布应用版本，最后更新 latest 镜像。失败保留草稿，不将其提升为 Latest。构建产物包括（完整必需清单以 `scripts/release/publish.py` 为准）：

| 文件 | 角色 |
|---|---|
| `kin-kernel` | Claude Code 槽内核（payload，推理必带） |
| `kin-egress` | 远程 SOCKS5 透明网关 |
| `kin-slot-gate` | 扩展节点直连通道入口（控制面每请求一条 TLS 连接直达节点槽位） |
| `kin-worker` | **只** `telemetry`，不是 hop |
| `kin-codex-kernel` | Codex 槽（payload） |
| `kin-oauth-auth` | OAuth / Setup Token 换票服务二进制；源码不随部署上传 |
| `kin-kernel-crag` / `cli-node` / `cc-node` | crag kernel 与槽内 wrap CLI（payload） |

`publish=false` 的产物仅用于构建验收，不创建版本 tag 或 Release、不推送应用镜像；`publish=true` 才进行正式发布。两种模式都从人工 workflow_dispatch 开始，不由普通 push/PR 或 tag 推送触发。

正式控制面镜像仅由 amd64 `Dockerfile` 构建，在镜像里编 `web/dist` 和 Go helper 并校验 payload；当前 Release workflow 的 artifact 保留 14 天。`deploy/Dockerfile.arm64-control` 仅是保留的手动部署路径，不属于正式发布产物。

槽位 OS 镜像由 `.github/workflows/guest-images.yml` 独立发布：main 上 `docker/kin-os/`、`docker/kin-kvm/` 或该 workflow 有变化时触发，也可手动运行。此类 push 会实际发布 guest/KVM 镜像，需按交付规范核对授权；不能将“应用发版只手动”扩展为“所有镜像都只手动”。四种系统并行构建，各用独立缓存；普通应用发版不再重复构建槽位镜像。

KVM runner 镜像在同一 workflow 的 `kvm` job 构建，推送到运行仓库所有者命名空间（`ghcr.io/<repository_owner>/kin-kvm-<family>:<tag>`）；现有运行配置中的 guest 镜像来源需单独核对，不会自动迁移。构建使用单 Dockerfile `docker/kin-kvm/` + `ARG CLOUD_IMAGE_URL`（官方 cloud image URL 见 `src/lib/vm/os-catalog.mjs` 的 `kvm.cloud_image`）。本机构建：

```bash
node docker/kin-kvm/build.mjs ubuntu          # 与 kin-os 同语义：--force / --pull / --pull-only / 过滤器
```

装到机器上（Compose 部署可跳过，镜像入口会把镜像内的同名文件写进挂载的 `bin/`）：

```bash
install -m 755 kin-kernel kin-egress kin-worker kin-codex-kernel kin-oauth-auth /opt/tapmodels/bin/
```

然后按 [DEPLOY.md](DEPLOY.md) 指环境变量。槽进程不是 root：权限必须是 `755`，不要 `700`。

控制面镜像：`docker compose -f docker-compose.yml -f docker-compose.build.yml build` 在镜像内编控制台与 Go helper 并下载 payload，构建机需要能访问 GitHub Release（见 [DEPLOY.md](DEPLOY.md#安装)）。槽位 `kin-os/*` 首次启动编 ubuntu，或 `node docker/kin-os/build.mjs`；KVM 槽编 `kin-kvm-*`，或 `node docker/kin-kvm/build.mjs`。

## 本机构建

依赖：Node 22、Go 1.25、pnpm 10、python3（官方 CLI PTY 脚本）。OAuth 换票由控制面 spawn `bin/kin-oauth-auth` 完成；`auth.js` 只保留在本地构建目录，不上传到控制面。kernel / wrap CLI 用 payload ELF，不要在本机 cargo / 重编 Claude Code。

```bash
npm ci
pnpm -C web install --frozen-lockfile

npm run fetch:payload     # bin/kin-{kernel,codex-kernel,oauth-auth,computer}、share/wrap-cli、share/crag
npm run build:egress      # bin/kin-egress
npm run build:gate        # bin/kin-slot-gate
npm run build:worker      # bin/kin-worker
npm run build:web         # web/dist
```

格式：和 CI 同一套，全文 LF。说明见 [FORMAT.md](FORMAT.md)。

```bash
npm run format
npm run format:check
```

Go helper 从当前源码编译；不列入上游 payload 清单，也不要求重新发布上游二进制：

```bash
CGO_ENABLED=0 go build -trimpath -o bin/kin-egress ./worker/cmd/kin-egress
CGO_ENABLED=0 go build -trimpath -o bin/kin-slot-gate ./worker/cmd/kin-slot-gate
CGO_ENABLED=0 go build -trimpath -o bin/kin-worker ./worker/cmd/kin-worker
pnpm -C web build
```

`kin-worker` 不带参数会退出（hop 已删）。只要：

```bash
kin-worker telemetry --config /path/to/worker.json
```

## 验证

```bash
npm test                  # unit + worker Go；不包含 api-kernel、web 或 E2E
npm run test:web          # 要先 pnpm -C web install
(cd api-kernel && go test -race ./...)  # 修改此模块时单独执行
node --check src/server.mjs
```

CI（`.github/workflows/test.yml`）在 main push / PR 上运行，也可手动触发：Node 格式、源码及脚本语法与 unit（先拉 payload、编 `kin-egress`）；`worker/` 和 `api-kernel/` 的 gofmt、所选包及调用方 race test（含默认 vet）和必要的 CGO 关闭命令编译；payload 清单校验与 linux amd64 ELF 检查；web 格式、测试、类型检查和构建。Node 22、Go 1.25、pnpm 10 与部署要求一致，依赖缓存分别以对应 lockfile / `go.sum` 为键。

普通 push/PR 先由 `scripts/upstream-sync/ci_plan.py` 比较真实前后文件树，按范围选择上述任务；缺失基点、未知路径、工作流或工具变化回退全量。手动与上游预检候选仍跑全量。`result` 汇总所选任务，失败或意外跳过不能被当作成功。详细范围见 [交付规范](CHANGE_DELIVERY.md#同步效率与中断恢复)。

## 升级一台已部署的机

当前版本从 `holeenlu/vm2api` 已发布的 tag 选择，操作前核对 [部署说明](DEPLOY.md#一键安装--更新) 和部署授权。源码目录执行 `git pull` 前确认其跟踪目标确为本项目交付仓库；不能从仍指向上游的 origin 拉取并直接部署。[旧 v1.2.22 迁移记录](DEPLOY.md#已部署机升级到-1222) 仅用于维护对应历史安装，不是当前 fork 的发版步骤。

**Compose（其它版本通用）**

```bash
cd /opt/tapmodels
git pull
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

槽位容器不会被升级脚本无条件 `docker rm`。从 1.2.22 开始，一键更新默认把 `share/wrap-cli` 同步到本机槽并重启槽内 dataplane；集群槽在同一次同步里重建内容哈希镜像并换容器。仅在明确需要延后时使用 `--no-sync-wrap`。

**本机 Node + systemd**

1. `git pull` 或检出目标 tag。
2. `npm ci`；`pnpm -C web install --frozen-lockfile && npm run build:web`；`npm run build:egress && npm run build:worker`。
3. `npm run fetch:payload` 换 `bin/` 和 `share/` ELF，再调用 `POST /api/panel/wrap-cli/sync` 并传 `{"restart":true}`。同步优先 `bin/kin-kernel`。
4. `node --check src/server.mjs`。
5. `systemctl restart tapmodels` **一次**。确认 `/health`。

静态 HTML / `web/dist` 单独更新不必重启。同一轮不要 restart 两次，不要 `stop` 后不拉起。


---

交流见仓库 [README](../README.md)。

本地验证以 [最小充分验证](CHANGE_DELIVERY.md#5-最小充分验证) 为准：web build 已包含 tsc，不先重复 typecheck；普通前端逻辑默认相关测试与类型检查，只有打包风险才加本地构建。纯后端 CI 只选 unit/contracts，unit 测试文件单独变化只选 unit；跨前后端变化取任务并集。

CI 内部进一步按范围执行：unit 测试文件与已审查 Images 解析边界可定向，未枚举后端边界回退 Node 全量；Go 按模块与 go list 依赖闭包选择包，解析失败/依赖/资源变化回退模块全量。工作流与部署发布工具回归不再附带每次普通后端检查。细节及回退条件见交付规范第 5 节。
