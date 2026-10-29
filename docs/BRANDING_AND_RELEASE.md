# 品牌、语言和发布

## 品牌和 Logo

站长进入 **设置 → 品牌**（`/console/#/settings/branding`）修改品牌名称、副标题、Logo 和网站图标。可填写图片 URL 或上传 PNG/JPEG/WebP（每张最多 256 KB）；上传图片内嵌保存到 SQLite，不依赖临时浏览器缓存，也无需重新构建。移除图片恢复默认图标，恢复默认按钮在保存后生效。

品牌应用到侧栏、登录页、欢迎页顶部、浏览器标题和 favicon。配置是公开信息，不包含系统密钥。外部 URL 由访问者的浏览器加载，请使用能从访问者网络访问的稳定地址。新名称和图片未指定时保持 tapmodels 默认值。

## 语言与账号菜单

原 Theme Settings 面板由语言菜单替代，保留单独的明暗主题切换。支持 English (`en-US`)、简体中文 (`zh-CN`)、台灣繁體中文 (`zh-TW`)、日本語 (`ja-JP`)。选择保存在当前浏览器 `tapmodels.locale`，刷新保留，并设置标准 HTML `lang`。

控制台使用 i18next + react-i18next，按业务模块维护四语 JSON 资源，覆盖页面、表格、弹窗、通知、校验和无障碍标签；日期与数字格式跟随界面语言。切换语言即时更新，不重新挂载整页或清空未保存输入。首次访问匹配浏览器语言，未支持的语言使用简体中文；既有 tapmodels.locale 中的下划线 ID 读取后写回标准 BCP 47 ID，不丢失本产品已保存偏好。

品牌名称、管理员填写的副标题、用户录入内容、模型 ID、协议代码和后端原始日志保留原文；内置默认副标题随界面语言显示。未知后端错误保留诊断原文，已知状态按稳定状态码显示翻译，不以译文参与业务判断。该语言菜单不更改 VM 槽位的 LANG、LC_ALL 或 TZ；槽位语言与出口时区仍由 VM 配置管理。开发约束和验证入口见 [国际化维护说明](I18N.md)。

账号菜单仅保留右上角入口；左下角重复菜单及其专属组件已移除。普通用户只有个人资料、本人 API 密钥与退出登录；站长按权限增加设置、关于/更新、用户管理，运维不显示站长专属功能。个人资料与密码有独立后端授权，不能通过修改请求提交角色、余额、其他用户 ID 或分组权限。改密校验当前密码并撤销其他会话。联系邮箱不参与登录或密码找回。

## 上游新版整套自动发布（2026-10-28）

同步合并上游后推送 main，只有实际 before/after 的上游 VERSION 递增才自动发布；同版本本地修改、仅镜像目录变化、归并历史或版本回退均不自动发布。forced 推送也按此规则判断。读取不到旧提交、来源或版本不一致时阻止发布。自动规划核验已同步的冻结父提交属于官方 main 历史；后续上游再前进也不会把未集成的新版本标在本次产物上。

自动版保留上游原始三段版本及前导零，例如 `1.4.025` 对应应用 tag `v1.4.025`，直接指向本次交付源码，不增加 `.N`、不另造版本提交。重复正式版本跳过；失败草稿可用原源码重试，不覆盖其他源码占用的 tag。

整套包含应用 Release、linux/amd64 控制面镜像、现有 helper/payload 附件及校验和、4 个 Docker guest OS 与 4 个 KVM runner。guest-images 由同一发布工作流调用并检出冻结源码，不再因独立 push 路径发布；它们全部成功后才公开应用 Release 和更新应用 latest。guest/KVM 沿用 OS 标签供现有目录使用。发布不会安装或替换运行中的服务、迁移数据库或部署生产。

补发尚未发布的当前上游版本时，显式人工运行并勾选 `upstream_version=true`，使用原始 X.Y.Z，默认不勾选则走下面的 X.Y.Z.N 人工修订版流程。已正式发布的原版号跳过，普通同版本推送不会调用补发。

## 发布仓库和架构

产品名称为 **tapmodels**；代码、Release 和安装脚本仍位于现有 **holeenlu/vm2api** 仓库，镜像使用独立的 tapmodels 名称：

- GitHub Releases：<https://github.com/holeenlu/vm2api/releases>
- 控制面镜像：`ghcr.io/holeenlu/tapmodels-gateway:vX.Y.Z`（自动上游版）或 `vX.Y.Z.N`（显式人工修订版） 与 `latest`
- 一键安装/升级脚本：`https://raw.githubusercontent.com/holeenlu/vm2api/main/deploy/install.sh`
- 架构仅 **linux/amd64**；不构建或发布 ARM64 控制面镜像。

源码更新直接从该仓库抓取目标 tag 的提交；tapmodels 后续版本始终使用 ghcr.io/holeenlu/tapmodels-gateway，不从 GitHub 仓库名称推导镜像名称。

`deploy/payload.json` 中的闭源内核/CLI 仍按现有上游固定版本与 SHA256 获取；发布流程会把这些已校验的 Linux amd64 文件一并上传到自己的 Release。已有槽位 OS 镜像来源不在本次控制面发布改动范围内。现存 ARM64 手动部署代码和准备脚本的单元测试保留，但不生成 ARM64 发版产物，不能将本流程描述为 ARM64 镜像支持。

2026-10-20 干净构建发现上游替换了共享 payload 标签的 `cli-node`。该文件单独固定到上游 `v1.3.201`，保留原 `049200f5…` SHA256 与 27173896 字节，未更新内核/CLI 行为或放宽校验。清单的文件级 `release` 用于这种已核实的来源固定；重新 `--pin` 到新的完整 payload 发布时会移除文件级覆盖。

## GitHub Actions

本项目 main push/PR 保留 CI。**Versioned system release** 在 main push 时按上游版本递增规则自动发布整套系统，同版本修改不发布；显式人工运行可发布修订版或仅构建验收。

guest/KVM 由该系统发布调用 `guest-images.yml`，全部 8 个镜像以冻结源码构建，任一失败阻止应用 Release 公开；另保留显式人工运行入口。具体见 [交付规范](CHANGE_DELIVERY.md#7-github-actions发版与部署边界)。

1. 在本仓库 main 手动运行该 workflow，默认勾选发布（publish=true），点击 Run workflow 后自动编号、构建并发布。取消勾选（publish=false）才是仅构建验收，不创建 tag、Release，不推镜像、不改 Latest。同版本普通代码 push 不会触发应用发版。
2. 显式人工修订版使用 publish=true，无需填写版本号，工作流已移除 version 输入。每次运行冻结当前定制源码的唯一上游父提交 SHA，核验它属于 dofastted/vm2api 的 main 历史，且本地版本前缀一致，再读取该已集成提交的 VERSION 得到三段版本 X.Y.Z（不依赖可能滞后的 Releases/latest），自动生成 X.Y.Z.N：同一前缀首次 N=0，之后取本仓库同前缀已占用序号的最大值加 1；上游前缀变化后从 0 重新开始。例如 v1.3.208 首次发布 v1.3.208.0，再次发布 v1.3.208.1；集成上游 v1.3.209 后首次发布 v1.3.209.0。草稿和已推送但尚未建 Release 的 tag 均占号，避免失败重试覆盖已存在产物；已有较大序号时继续递增，不回填 .0。旧三段 tag、payload tag 和其他前缀不参与当前计数。上游三段数字保留原始前导零，例如 `1.4.025` 生成 `v1.4.025.0`；定制修订号 N 使用无前导零的非负整数。上游 main 继续前进不阻止当前定制版发布；无法核验父提交来源或读取该提交 VERSION 时直接报错，不猜测版本。
3. 人工修订版先为 VERSION 创建发布提交与 tag、预留草稿；不把版本提交强行回推 main。失败时保留草稿，不替换 Latest。下一次启动跳过已预留版本；重跑失败 job 使用本次已上传计划。
4. Node 权限/用户/更新测试及全部前端测试、构建，与 Go 测试、linux/amd64 原生辅助程序构建、固定 payload 下载校验并行执行。两组全部成功后才构建镜像；镜像以同一次运行的命名构建上下文复用前端、辅助程序和 payload，不再重复安装前端依赖或编译。原生产物以 tar 保留目录和可执行权限，发布前再次校验 payload 哈希并还原既有资产名。VERSION、Release/tag、镜像标签和应用界面均使用四段版本。VERSION 仍是应用版本的唯一来源，不再往 package/lock 写入重复或不合法的版本号。仅构建验收也在各隔离构建检出中写入规划版本，但不创建 tag、草稿或占用序号。
5. 镜像须通过独立容器启动验收：架构、VERSION、健康接口、公开品牌接口、前端可达、个人资料鉴权、辅助 ELF 架构。通过后才推送版本镜像。
6. 完整产物上传草稿，包含辅助程序、payload、`checksums.txt`、`release-manifest.json`，再公开 Release 并更新 latest 镜像。Release 正文包含该提交的完整 [定制 Release Note](CUSTOMIZATION_RELEASE_NOTES.md)，缺少说明则停止发布。内核更新继续使用兼容的资产文件名。

发布源码没有唯一官方上游父提交，或源码 VERSION 与该基线不一致时，prepare 在写 VERSION、创建 tag/草稿前停止。人工发版不附带同步，不会给旧源码套用尚未集成的新上游版本号。release-manifest.json 同时记录 upstream_commit 和 upstream_version；不会自动合并原作者代码；实际源码由 `release-manifest.json` 中的 source_commit 与 commit 记录。安装与在线更新支持四段版本，并保留对既存三段部署版本的读取；查询最新正式 Release 失败时，不再用可能属于失败草稿的 Git tag 作为默认安装版本。

只需内置 `GITHUB_TOKEN`：prepare/publish 请求 contents write，镜像发布请求 packages write；仓库默认权限仍是 read。操作仅允许 `holeenlu/vm2api` 的 `main`，有串行发布锁。首次正式发版前，自己的仓库没有可用 Release，在线更新不会回退上游版本。

发布验证启用 npm/pnpm 依赖缓存；Go 缓存按系统、架构、工具链和两个模块的 go.sum 定位，依赖变化时可恢复同工具链旧缓存，再由 Go 验证并补齐。新缓存键首次运行需要预热。Docker 使用 mode=min 仅导出最终镜像需要的缓存层，减少中间构建缓存传输；常规本机源码 Docker 构建仍使用原有构建阶段。跨次发布继续串行，以保护版本预留和 Latest 晋升；这里只并行同一次发布的独立任务。实际提速以修改后的 GitHub 运行记录为准。

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
