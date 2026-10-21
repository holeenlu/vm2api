# 品牌、语言和发布

## 品牌和 Logo

站长进入 **设置 → 品牌**（`/console/#/settings/branding`）修改品牌名称、副标题、Logo 和网站图标。可填写图片 URL 或上传 PNG/JPEG/WebP（每张最多 256 KB）；上传图片内嵌保存到 SQLite，不依赖临时浏览器缓存，也无需重新构建。移除图片恢复默认图标，恢复默认按钮在保存后生效。

品牌应用到侧栏、登录页、欢迎页顶部、浏览器标题和 favicon。配置是公开信息，不包含系统密钥。外部 URL 由访问者的浏览器加载，请使用能从访问者网络访问的稳定地址。新名称和图片未指定时保持 tapmodels 默认值。

## 语言与账号菜单

原 Theme Settings 面板由语言菜单替代，保留单独的明暗主题切换。支持 English (`en_US`)、简体中文 (`zh_CN`)、繁體中文 (`zh_TW`)、日本語 (`ja_JP`)。选择保存在当前浏览器 `tapmodels.locale`，刷新保留，并设置标准 HTML `lang`。

本次接入导航、标题、账号菜单、登录、个人资料和品牌设置等管理台公共区域。现有业务页面中未接入词典的说明、表格和错误信息仍显示原文，不声称业务页面已经全部翻译。品牌名称和用户录入数据不翻译。该语言菜单不更改 VM 槽位的 `LANG`、`LC_ALL` 或 `TZ`；槽位语言与出口时区仍由 VM 配置管理。

账号菜单仅保留右上角入口；左下角重复菜单及其专属组件已移除。普通用户只有个人资料、本人 API 密钥与退出登录；站长按权限增加设置、关于/更新、用户管理，运维不显示站长专属功能。个人资料与密码有独立后端授权，不能通过修改请求提交角色、余额、其他用户 ID 或分组权限。改密校验当前密码并撤销其他会话。联系邮箱不参与登录或密码找回。

## 发布仓库和架构

产品名称为 **tapmodels**；代码、Release 和安装脚本仍位于现有 **holeenlu/vm2api** 仓库，镜像使用独立的 tapmodels 名称：

- GitHub Releases：<https://github.com/holeenlu/vm2api/releases>
- 控制面镜像：`ghcr.io/holeenlu/tapmodels-gateway:vX.Y.Z.N` 与 `latest`
- 一键安装/升级脚本：`https://raw.githubusercontent.com/holeenlu/vm2api/main/deploy/install.sh`
- 架构仅 **linux/amd64**；不构建或发布 ARM64 控制面镜像。

源码更新直接从该仓库抓取目标 tag 的提交；tapmodels 后续版本始终使用 ghcr.io/holeenlu/tapmodels-gateway，不从 GitHub 仓库名称推导镜像名称。

`deploy/payload.json` 中的闭源内核/CLI 仍按现有上游固定版本与 SHA256 获取；发布流程会把这些已校验的 Linux amd64 文件一并上传到自己的 Release。已有槽位 OS 镜像来源不在本次控制面发布改动范围内。现存 ARM64 手动部署代码和准备脚本的单元测试保留，但不生成 ARM64 发版产物，不能将本流程描述为 ARM64 镜像支持。

2026-10-20 干净构建发现上游替换了共享 payload 标签的 `cli-node`。该文件单独固定到上游 `v1.3.201`，保留原 `049200f5…` SHA256 与 27173896 字节，未更新内核/CLI 行为或放宽校验。清单的文件级 `release` 用于这种已核实的来源固定；重新 `--pin` 到新的完整 payload 发布时会移除文件级覆盖。

## GitHub Actions

本项目普通 main push/PR 跑 CI，**不会自动发布应用版本**。应用发版由人工启动 `Manual versioned release`，其后的版本选择、构建、检查、上传和发布自动完成。不要据此推断与 sub2api 的全部 Actions 触发策略相同。

guest/KVM 镜像另由 `guest-images.yml` 管理：普通快进推送在真实 before/after 文件树涉及 `docker/kin-os/**`、`docker/kin-kvm/**` 或该 workflow 时自动发布，需覆盖相应发布授权。forced/非快进推送、缺少可验证旧提交时跳过发布，整理定制提交不会意外推送镜像；需要更新镜像时单独授权手动运行。具体见 [交付规范](CHANGE_DELIVERY.md#7-github-actions发版与部署边界)。

1. 在本仓库 `main` 运行该 workflow，`publish=false` 为默认值，只构建验收，无 tag、Release、镜像推送或 Latest 变更。
2. 正式发版使用 `publish=true`。每次运行先读取 `dofastted/vm2api` 的最新正式 Release，冻结其三段版本 X.Y.Z，发布版本采用 X.Y.Z.N。`version` 留空时，同一前缀首次为 N=1，之后取本仓库同前缀已占用序号的最大值加 1；上游前缀变化后重新从 1 开始。例如上游 v1.3.204 对应 v1.3.204.1、v1.3.204.2；上游变为 v1.3.205 后首次为 v1.3.205.1。也可输入完整 vX.Y.Z.N 或 X.Y.Z.N，必须匹配本次上游前缀，且序号大于已占用值。草稿和已推送但尚未建 Release 的 tag 均占号，旧三段 tag、payload tag 和其他前缀不参与当前序号计算。无法查询上游正式版本时直接报错，不使用本地旧 VERSION 猜测。
3. 发布流程先为 VERSION 创建发布提交与 tag、预留草稿；不把版本提交强行回推 main。失败时保留草稿，不替换 Latest。下一次启动跳过已预留版本；重跑失败 job 使用本次已上传计划。
4. Node 权限/用户/更新测试、全部前端测试及构建、Go 测试通过后，构建 linux/amd64 原生辅助程序、下载校验固定 payload，并构建控制面镜像。 VERSION、Release/tag、镜像标签和应用界面均使用四段版本。VERSION 仍是应用版本的唯一来源，不再往 package/lock 写入重复或不合法的版本号。仅构建验收也在各隔离构建检出中写入规划版本，但不创建 tag、草稿或占用序号。
5. 镜像须通过独立容器启动验收：架构、VERSION、健康接口、公开品牌接口、前端可达、个人资料鉴权、辅助 ELF 架构。通过后才推送版本镜像。
6. 完整产物上传草稿，包含辅助程序、payload、`checksums.txt`、`release-manifest.json`，再公开 Release 并更新 latest 镜像。Release 正文包含该提交的完整 [定制 Release Note](CUSTOMIZATION_RELEASE_NOTES.md)，缺少说明则停止发布。内核更新继续使用兼容的资产文件名。

版本前缀查询只用于命名，不会自动合并原作者代码；实际源码由 `release-manifest.json` 中的 source_commit 与 commit 记录。安装与在线更新支持四段版本，并保留对既存三段部署版本的读取；查询最新正式 Release 失败时，不再用可能属于失败草稿的 Git tag 作为默认安装版本。

只需内置 `GITHUB_TOKEN`：prepare/publish 请求 contents write，镜像发布请求 packages write；仓库默认权限仍是 read。操作仅允许 `holeenlu/vm2api` 的 `main`，有串行发布锁。首次正式发版前，自己的仓库没有可用 Release，在线更新不会回退上游版本。

## 清理与验收

删除 Theme Settings 组件及其独占的十个主题/布局/方向预览 SVG 组件，删除侧栏 GitHub/文档按钮，合并两份账号菜单，移除 CI 的 ARM64 构建 job 和发版的多架构流程。布局、方向、字体 Provider 仍被现有布局与持久化偏好读取，保留，不作无关重置。

本次代码检查、镜像、浏览器与 Actions 的实际结果记在 `CONSOLE_IDENTITY_DELIVERY.md`。现有数据和迁移保持，新建 `044_user_profile.sql` 增加显示名称字段；本地验收先备份 SQLite 和槽位目录。

## tapmodels 全新部署契约（2026-10-21）

本次品牌用于全新部署，不在已有 vm2api 部署上升级或替换。没有旧品牌环境变量别名、目录探测、浏览器偏好迁移、凭据转换、旧包格式导入或旧容器接管逻辑，也不移动旧数据。

- 默认镜像 ghcr.io/holeenlu/tapmodels-gateway，保留 vX.Y.Z.N 和 latest 标签规则。
- Compose 服务、默认容器、systemd 单元均为 tapmodels；新装目录及容器内目录为 /opt/tapmodels。
- 部署配置使用 TAPMODELS_*；KIN_* 是现有内核/运行时配置，继续按各参数定义使用，不是 vm2api 的改名兼容层。
- 槽位镜像前缀 tapmodels/kin-slot-，受管容器标签 tapmodels.cluster，macOS 节点目录 ~/.tapmodels 和 launchd 前缀 com.tapmodels.slot。
- 浏览器存储、导出日志、单槽包类型、控制台默认品牌和公开健康标识使用 tapmodels。已由站长配置的自定义品牌仍由品牌设置管理。
- 安装、镜像构建、升级助手、发布校验及文档统一采用上述值。必须先正式发布新镜像，才能使用拉取镜像的安装方式；代码推送不表示镜像已经发布。

保留的 vm2api 文本仅用于真实 GitHub 仓库/上游 payload 来源、许可证和原作者署名/联系方式、历史记录及本机现有 Git/技能标识。源码仓库和外部服务未重命名，不生成不存在的 tapmodels GitHub 地址。旧品牌宣传插图已移除，首页替换为可维护的 tapmodels SVG。

用户于 2026-10-21 确认：本项目使用 ghcr.io/holeenlu/tapmodels-gateway，与 sub2api 的 ghcr.io/holeenlu/tapmodels 渠道隔离。产品名、Compose 服务名和默认容器名仍为 tapmodels。
