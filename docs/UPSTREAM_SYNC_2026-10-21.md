# 2026-10-21 上游合并与验证记录

执行依据：[交付规范](CHANGE_DELIVERY.md)。本轮范围为合并、处理冲突、验证、提交并推送；不含正式发版、Docker 验收、真实节点操作、生产部署或数据库迁移。本文记录发布前的最终候选及验证；最终提交和远端状态由 Git 历史与本轮交付回复核对。

## 固定来源

| 对象 | 完整 SHA |
| --- | --- |
| 原本地 main / holeenlu/vm2api main | `ddf4ee9c01e7074b8d57ad4d47a58993f4a094c5` |
| 本轮规范提交 | `59553ef502a06bc831e272b804729ee619f32b58` |
| dofastted/vm2api main | `33e1f0a6158f0363d1816bcee9223cc134a3098f` |
| 共同祖先 | `819ee2a7c40b49fe81ebc3823e20373350a20545` |

来源与交付仓库分别 fetch 后固定；审查共同祖先到来源的完整差异，包括 113 个来源变更文件，并核对本地定制调用链。普通 merge 保留上游提交，不重写已发布历史。没有同步 sub2api 或其他参考项目。

## 新增功能与改进

| 项目 | 使用入口、默认行为与影响 |
| --- | --- |
| 集群直连 TLS 通道 | 控制台「集群」远程节点配置的「直连通道」（`/console/#/cluster`）。新增节点 IP、端口输入，端口默认 7790；未配置时仍走 SSH，直连失败回退 SSH。管理员配置后才在对应节点准备 gate；本轮未实际配置节点。 |
| 官方 Claude Code 登录 | VM 凭据操作复用槽终端登录，支持远程槽的异步就绪与凭据 SFTP 同步；沿用现有登录入口，搭配本轮锁定的 cli-node。 |
| Auto compact 窗口 | 「设置 → 协议 → Auto compact 窗口」（`/console/#/settings/protocol`），字段 `compatibility.auto_compact_window`，默认空值跟随模型；界面提供 200K、500K、1M。请求的显式窗口优先，已有值和槽配置按原同步链处理。 |
| Responses WebSocket 中断 | 已启用的 WS 连接可发送 `response.interrupt`，只终止对应在途 hop；完成后的中断不重复结算，后续轮继续复用已有传输链。 |
| ChatGPT 订阅到期信息 | VM 账号详情显示可取得的订阅到期时间；不把缺失字段编造成日期。 |
| 槽服务更新与调试 | 吸收旧容器服务更新适配、远程服务目录、内存扩容校验/回滚、种子编辑和遥测调试改进；管理脚本未在真实槽位执行。 |

直连新增 `PUT` / `DELETE /api/panel/cluster/nodes/:id/direct-link` 两个 HTTP 操作；token 与证书 pin 由服务端管理，不返回明文 token。控制面环境变量 `KIN_CLUSTER_GATE_BIN` 默认指向项目 `bin/kin-slot-gate`，通常无需自定义。

## Bug 修复

- 备份的快照、压缩与哈希工作移入 worker，避免同步阻塞主线程；本地恢复入口补齐 `await`，保留在途/待对账请求的恢复门禁，并验证恢复后资金、调度与路由存储重绑定。
- 保留上游角色/启用状态变化撤销会话、非管理员不得强刷共享模型目录的安全修复。
- 吸收有效 access token 与残留刷新错误的判断修正、过期 Fable 周窗口恢复、跨账号历史 thinking 签名处理，以及会话 beta 固定。
- 官方完整提示词按新 CLI 分段，补齐独立 reporting 段和正确 CLI 身份；更新旧四段测试预期，保留正文、环境和缓存边界的检查。

上述自动修复无需额外配置，部署相应源码、前端和 payload 后生效；本轮没有部署，不能把源码合入视为运行实例已经更新。

## 冲突与清理

- **商业权限**：本地客户通过商业分组授权，不自管 VM/账号池。保留分组校验、Key 属主、三层 RPM、资金及模型目录契约；不恢复上游旧 `vm_pool_id`、VM 范围 Key 表单或租户 VM 管理链。已删除的 `key-payload.ts` / `key-payload.test.ts` 保持删除；移除自动合并带入的失效守卫调用和辅助函数。
- **现行测试**：旧租户测试改验客户不得导入/控制 VM、管理员可操作、会话撤销及运维不能强刷目录。新增 WS 测试使用真实的隔离用户、分组、资源授权和账务库，验证取消不误记 usage、已完成请求仅计量一次；没有给生产路径加测试旁路。
- **迁移**：本地已存在 `039_relay_operations.sql`。来源的新直连迁移映射为 `045_cluster_node_direct_links.sql`，更新测试引用；本地 001–044 内容保持不变。验证新库、旧 044 升级、原 039 校验记录、余额保留和重复执行；不声称支持任意上游数据库直接换库。
- **payload**：移除旧 cli-node 的 `v1.3.201` 文件级固定，采用本轮来源的 27174524 字节及 SHA256 `55efe49e5dbf6cf96fc26535ec5130bbe5af87d51d043b813f289056d744e61d`；从固定来源下载后严格核验，未使用重新 pin 来绕过错误。
- **发布**：吸收 kin-slot-gate 构建/附件，补入必需资产和镜像 helper 校验。保留本地人工发版、fork 仓库门禁和 linux/amd64；冲突中的旧 tag Release action、多架构及上游镜像发布说明不回流。

## 本轮验证

本机：macOS arm64、Node 22.20.0、Go 1.27.0；复用锁定依赖安装，未修改业务依赖或 lockfile。

| 检查 | 实际结果 |
| --- | --- |
| Node unit，全量隔离运行 | 279 个文件；272 文件通过，7 文件失败。汇总 3291 项：3251 pass、13 fail、27 skip。没有将本机全量标为全绿。 |
| 合并前基线对照 | 在 `59553ef5` 独立检出，以相同工具链、对应锁定 payload 和同一批失败文件重新执行；7 文件的失败用例名称一致，详见下表。 |
| 前端 | 57 文件、466 项全部通过；TypeScript/Vite 构建、改动文件 ESLint、全前端格式检查通过。 |
| HTTP 集成 | 备份、运营、细化、Codex 目录、资料、用户与面板共 40 项：初次 38 通过，2 项因 Linux kin-computer 无法在 macOS 执行失败；使用已有身份 fixture 后，面板 API 文件 19/19 通过。其他 HTTP 测试使用隔离 mock 网关。 |
| WS / 提示词专项 | 组合 98 项通过；包含真实 handleProtocol、隔离账务和后续中断行为。 |
| Go | worker 与 api-kernel 的 `go test -race ./...`、`go vet ./...`、命令编译通过；另交叉编译 4 个 linux/amd64 helper 并检查 ELF 架构。 |
| 发布与资产 | 发布脚本单测 9/9；12 个 payload 的大小/SHA256 通过；YAML 触发器/仓库门禁、shell 语法、本地历史迁移字节与版本唯一性通过。 |
| 清理与工作区 | 冲突标记、旧导入/调用和迁移引用核查；暂存 diff 空白检查通过；原主工作区 AGENTS 空格修改保留，不纳入提交。 |

同轮可复现的基线失败文件：

| 文件 | 失败范围 |
| --- | --- |
| `test/unit/egress.test.mjs` | DNS/监听与 helper 就绪，3 项 |
| `test/unit/guest-identity-reader.test.mjs` | Linux 硬件内存探测 |
| `test/unit/host-path.test.mjs` | 容器自检路径 |
| `test/unit/oauth-binary.test.mjs` | Linux OAuth binary 交换用例（含子用例） |
| `test/unit/session-oauth-seam.test.mjs` | OAuth binary/组织请求，2 项 |
| `test/unit/slot-recovery.test.mjs` | 真实 Codex socket 探测 |
| `test/unit/slot-shell-rc.test.mjs` | 客体硬件特征输出 |

这些结果仅说明本机候选与本轮基线的已知失败相同，不代替 Linux CI、真实客体、Docker 或上游实测。未执行真实供应商推理、收费调用、浏览器交互或运行数据迁移。

## 变更量与发布边界

相对本轮原 main，包含规范提交、上游普通 merge 和本地适配：业务代码及构建配置新增 3827 行、删除 344 行、净增 3483 行；测试新增 3113 行、删除 160 行、净增 2953 行。文档单列统计；不计本地依赖软链接、私有日志或原 AGENTS 空格差异。

按外部使用面计：新增 HTTP 操作 2 个、WS 消息类型 1 个；新增可配置项 4 个（直连 IP、端口、auto compact 窗口、gate 二进制路径）。新增独立执行入口 4 个：备份 worker、Claude 登录 PTY、旧集群槽迁移脚本、kin-slot-gate 命令。内部生成的 token、证书与状态字段不算用户配置。

代码推送唯一目标为 `holeenlu/vm2api` 的 main。`guest-images.yml` 与其自动发布触发路径未改，本轮 push 仅按现有配置触发质量 CI，不调用人工 Release workflow。完整日志和最终本地/远端 SHA 记录在 `.local/upstream-sync/20261021-005947/`，私有证据不提交。
