# tapmodels 定制版 Release Note

## 2026-11-05 usage_json 不再保存上游 attribution（尝试记录、Gateway 回执与对账任务；Worker 回执源头剥离）

- **需求：** 排查生产 `kin.db` 两天从约 0.6 GB 涨到 4.6 GB（每日备份因此跑 38 分钟、打满磁盘）。用备份副本只读统计：`request_attempts` 2.08 GB，其中 `usage_json` 2.0 GB，平均每行 12.5 KB，11-04 当天平均 21 KB；`gateway_worker_receipts` 1.54 GB，其中 `usage_json` 1.44 GB，平均每行 32 KB。两者都是上游 usage 里的 `attribution.items`，即按会话中每条消息累积的 token 归因表，随会话变长、无上限。`request_attempts` 保留 7 天，稳态约 8–9 GB；回执表没有保留清理，每天约增 1.25 GB。用户确认“两张表都去掉”。
- **Bug 修复 / 优化改进：**
  - **控制面：** `usageForStorage()`（`src/lib/core/usage-persist.mjs`）原先只用于 `billing_charges`，现扩展到另外三处写入：`request_attempts`（`RequestAttemptsRepo.record()` / `complete()`）、`gateway_worker_receipts`（`ingestReceipt` 的新增与更新），以及 `gateway_worker_reconciliation_jobs`（入队与挂接回执）。计数字段全部保留，调用方对象不改动。计费与额度只读计数字段，结果不变。
  - **Worker（源头）：** 构建回执时由 `receiptUsage()` 去掉 `attribution`，并沿用原有的“上游无档位时补实际发送档位”。回执、Worker 事件日志（`events/seg-*.log`），以及重构后事件收件箱 `executor_event_inbox.payload_json`（`KIN_EXECUTOR_EVENTS` 为 shadow / primary 时写入，保留 7 天）从源头不再携带该字段。`payload_hash` 由 Worker 对剥离后的回执计算，验签不受影响。控制面侧剥离继续保留，用于防护旧版 Worker 与升级窗口内的回执。
- **上游取舍（例外保留）：** `request_attempts` 写入原本按 11-03 同步决定与上游一致、原样保存 attribution。现以生产实测（两天约 4 GB、每日备份打满磁盘、网站不可用）为依据，保留最小差异：只在序列化 `usage` 时套一层 `usageForStorage()`，其余逻辑仍与上游一致。移除条件：上游不再原样保存 attribution，或上游自行引入等效裁剪。回执表、对账任务与 Worker 为本地定制，不涉及上游。
- **破坏性变更：** 新写入的上述三张表 `usage_json` 与 Worker 回执不再含 `attribution`。全仓库（`src`、`web/src`、`worker`、`test`）无任何读取方。
- **升级指南：** 部署控制面镜像（含 Worker）后自动生效，无需配置，无数据库迁移。**历史数据未处理：** `request_attempts` 的旧行 7 天内自然淘汰；`gateway_worker_receipts` 与对账任务的旧行（约 1.5 GB）仍在，需另行授权清理，并在低峰执行 `VACUUM` 才能缩小文件（对 4.6 GB 库是重 IO 操作）。
- **代码统计（相对远端 `7691945c`，含新增文件）：** 业务代码 +49 −17（含注释），测试 +103 −0，文档 +16 −2（不含本行）。
- **验证：**
  - **Node：** `test/unit/usage-attribution-trim.test.mjs` 新增 2 项，用真实 SQLite 覆盖 `request_attempts`（`record` 与 `begin` + `complete`）、回执、对账任务（入队与挂接）落库后不含 attribution、计数完整且小于 1000 字节。在未修复的检出上这 2 项失败，修复后 5/5 通过。引用相关模块的 34 个单测文件共 355 项通过。`biome format` 通过。
  - **Worker：** 新增 `TestReceiptUsageDropsAttributionAndAddsTier`；`gofmt`、`go vet ./...`、`go test -race ./...`、`CGO_ENABLED=0 go build ./...` 均通过。

## 2026-11-05 Gateway Worker 的 BPS 协议状态改为按条目增量落盘，不再每 2 秒整写约 60 MB

- **需求：** 用户反馈生产站点访问很慢，`top` 里各进程 CPU 都很低。排查发现磁盘写满（`sda` %util 100%，写延迟约 140 ms），网关主进程阻塞在 `jbd2_log_wait_commit`。主因是生产主机上的每日 SQLite 热备份（见下方“运维”），次因是 Worker：`kin-codex-gateway` 持续写盘约 18 MB/s，运行 66 分钟累计写入 76.7 GB，来源是约 60 MB 的 `bps_state.json`，只要有变动就每 2 秒整体重写一次。用户要求两处都修。
- **优化改进（Worker `codexgateway`）：**
  - **按条目分文件：** BPS 工具回放、会话目录、续接快照与图片检查点改存数据目录 `bps_state/<sha256(scope, name)>.json`，每个条目一个文件。落盘仍延迟 2 秒合并，但只重写有变动的条目（先写临时文件再原子替换），过期或淘汰的条目直接删除对应文件。原先每次把全部条目整写一遍。
  - **只读续期不重写内容：** 读取续期只更新文件修改时间。重启后过期时间取“记录值”与“修改时间 + 2 小时”中较晚者，续期效果与原先一致。
  - **加密、上限与版本比较不变：** 配置凭据包密钥时，每个条目文件单独加密（与账号库相同）；单条与合计上限（32 MiB，超出先淘汰最早过期）、2 小时空闲过期、目录写入按版本比较，均与原先相同。无法解密、损坏或文件名与键不符的条目文件按“协议状态可丢”删除，中断落盘留下的临时文件在启动时清理。
  - **落盘失败重试：** 写入失败的条目保留待写标记并重新安排落盘；并发落盘串行执行，避免旧内容覆盖新内容。
- **兼容保留：** Worker 启动时把旧格式单文件 `bps_state.json` 中未过期的条目迁入 `bps_state/`，然后删除旧文件；无法读取或解密的旧文件直接丢弃。依据：生产数据目录目前仍有该文件（约 60 MB）。移除条件：所有实例都运行过本版本一次后，删除 `importLegacy` 及其在 `server.go` 中的调用。配置 `KIN_REDIS_URL` 时，存储仍走 Redis，数据目录只作退回路径，行为不变。
- **运维（生产主机，不在仓库内）：** `/usr/local/sbin/tapmodels-sqlite-backup`（`tapmodels-sqlite-backup.timer`，每日 03:17 UTC 起随机延后最多 10 分钟）已在主机上替换，旧版保存为同目录 `tapmodels-sqlite-backup.bak-20261105`。
  - **旧版问题：** 用 Python `src.backup(dst, pages=256, sleep=0.05)` 分步复制，但两步之间不持有读事务。网关一写入，SQLite 就让备份从头再来，而 `sleep` 只在 BUSY/LOCKED 时生效，等于没有限速。4.6 GB 的 `kin.db` 备份跑了 38 分钟，写盘上百 GB（10 秒写 638 MB）。本机用 86 MB 库带并发写入复现：旧方式 40 秒内无法完成。
  - **新版做法：** 在固定读快照内分步复制（`BEGIN` 后先读一次；WAL 下不阻塞写入）。每步 256 页后暂停 0.1 秒，写入上限约 10 MiB/s。目标库关闭日志与同步，先写入 `.partial` 临时文件，`integrity_check` 通过后再改名。整个 Python 部分以 `nice -n 19 ionice -c3` 运行。本机复现库 9 秒完成，`integrity_check` 为 ok。
- **Bug 修复：** 见上。无用户可见的功能变化。
- **破坏性变更：** Worker 数据目录的持久化文件由 `bps_state.json` 改为 `bps_state/` 目录。旧文件在首次启动时自动迁入；回退到旧版本时 `bps_state/` 不会被读取（协议状态可丢，最多影响 2 小时内的工具回放与会话目录续接）。
- **升级指南：** 部署控制面镜像（含 Worker）后自动生效，无需配置。本轮未部署。
- **未完成：** `kin.db` 两天内从约 0.6 GB 涨到 4.6 GB，增长来源未查（扫库会加重磁盘负载，需择低峰单独排查）；生产数据未做任何处置。
- **代码统计（相对远端 `4791928c`，含新增文件）：** 业务代码 +205 −26，测试 +104 −3，文档 +6 −6（不含本节）。
- **验证：**
  - **Worker：** `gofmt`、`go vet ./...`、`go test -race ./...`、`CGO_ENABLED=0 go build ./...` 均通过。新增用例覆盖：只重写有变动的条目（未变动条目的修改时间不变）、只读续期在重启后生效、未续期条目到期删除文件、旧单文件加密迁入且只迁未过期条目、条目文件不含明文、换密钥后丢弃并删除无法解密的文件。原有“跨重启保留 + 版本比较”和 Redis 共享退回用例改用目录路径后通过。
  - **备份脚本：** 本机带并发写入试跑通过。生产 2026-11-05 04:13:57–04:25:40 UTC 手动触发一次：4.63 GB 用时 703 秒，`integrity_check` 为 ok；期间磁盘利用率约 5–26%，网关 `/healthz` 约 1 ms。修复前同一库为 38 分钟、磁盘 100%。持有读快照期间 WAL 涨到约 212 MB，属预期，备份结束后由网关正常检查点回收。

## 2026-11-05 BPS 对齐原作者 codex2api：tool_choice 降级、内置工具中继、断流补完成、密文重试、429 冷却可配与 403 恢复默认值；支持 configuration_update

- **需求：** 用户指出 BPS 的最原始源码是 james-6-23/codex2api，要求盘点差距并“补齐重点差距、修问题”；期间又报告客户端在 BPS 上收到 `basispoints does not support configuration_update; start a new request with the desired effort`，并确定推理强度规则：切换值高于请求顶层强度时以顶层为上限。
- **对照基线：** 原作者仓库在 2026-09-25～09-30 由 5 位贡献者完成 BPS 集成（约 30 个提交），10-01 在 `8f8c0afc` 移除（分支名指向上游开始返回 404 `model_not_found`）；对照 `8f8c0afc^`。vm2api 的协议包来自 hloolx/codex2api → sub2api NewAPI 一线，hloolx 的提交不在原仓库，原仓库后续功能此前未继承。
- **优化改进（Worker 协议包 `basispoints`）：**
  - **`configuration_update`**：Codex 会话中途切换推理强度时写入的历史项，不再整单拒绝。转换时去掉该项；取最后一次切换的强度，高于请求顶层强度时以顶层为上限，顶层未给时直接采用。
  - **`tool_choice`**（原作者 `parseToolChoice`）：`none` 不发目录；`required` 与指定函数/custom/内置工具降为 auto，并在协议说明末尾要求调用（指定工具时点名）；`allowed_tools` 裁剪目录与中继白名单，带 namespace 的条目只放行该工具，裸名同时匹配 namespace 内同名工具；其他形式按 auto。删除 `ErrUnsupportedToolChoice`（此前这类请求整单改走原生）。强制 `web_search` / 生图仍走原生，不变。
  - **内置工具中继**（移植原作者 `builtin_tools.go`）：声明的 `local_shell` / `shell` / `apply_patch` 以同名目录函数经 `run_officejs` 中继，客户端收到原生 `local_shell_call` / `shell_call` / `apply_patch_call`（id 前缀 `lsh_` / `sh_` / `apc_`）。流里对这些项只发 `output_item.added` / `done`。历史中的原生调用与结果先降为 `function_call` / `function_call_output`（结果渲染为 “Command N exited with code …”“Patch status:” 文本），回放与重建沿用现有逻辑。同名客户端工具优先；`apply_patch` 只接受 create/update/delete，`update_file` 的 diff 不能为空。参数按声明 schema 严格校验，不合格进入既有的纠正轮（原作者对带引号的数字静默容错，这里不采用）。
  - **断流补完成**（原作者 `TestStreamCompletesResponseCutOffAfterLastItem`）：上游在 `response.completed` 前结束时，若已开始的输出项都已完成，且最后一项是工具调用或非 commentary 的消息，就用已完成的项合成 `response.completed`，走正常的完成校验。用量沿用已观测部分，回执按既有规则标为 partial。最后一项是 commentary 或有未完成项时，仍交还错误。
- **优化改进（Worker 网关）：**
  - **密文被拒**（原作者 4e5f31f4）：BPS 返回 `invalid_encrypted_content` 时，去掉推理密文后在同一 BPS 账号重试一次。仍被拒且历史未锁定在 BPS 时，恢复原始正文改走原生（来源未知的锁定此时解除：BPS 已证明读不了），原生读不了再按两步恢复。历史锁定在 BPS 时交付错误。
  - **429 冷却**：未声明重置时间时，按账号新设置 `rate_limit_cooldown_seconds`（1–600，缺省 5 秒，原为固定 60 秒）冷却。`Retry-After` 优先，并限制在 1–600 秒。
  - **模型无权冷却提前恢复**：刷新循环按账号恢复间隔复核 access 目录（只读，不发生成请求）。目录允许且重新列出被冷却的模型时，提前解除冷却；30 分钟兜底不变。
- **默认值调整（对齐原作者）：** BPS 403 自动恢复改为默认开启，探测间隔缺省改为 1 分钟（原为默认关闭、60 分钟）。账号设置、“新增 BPS 授权时的默认设置”模板、Worker 投影与描述（`codex-account.json` / `codex-settings.json`，Worker 内同一份）同步更新。已保存的账号与模板沿用各自的值，不改线上数据。
- **Bug 修复：**
  - **运营端供应商账号池的 BPS 子路径：** “获取 BPS 模型 / 解除停用 / 停止恢复”此前被供应商管理接口白名单（`panel-routes.mjs`）以 404 拒绝，现已放行；新增 e2e 覆盖，修复前失败、修复后通过。
  - **BPS 图片端点的上游路径：** 此前一律记为 `/basispoints/api/responses`，现按 `images/generations` / `images/edits` 记录。
  - **设计文档：** 第 18 号文档的“未做多实例共享”已过时，更正为 `KIN_REDIS_URL` 共享说明。
- **上游取舍：** Gateway Worker 与 BPS 为本地定制，不涉及上游文件。原作者代码以 MIT 移植，出处记入协议包 `NOTICE.md`。未采用的原作者做法：
  - 直接用原生 ChatGPT 令牌访问 BPS：需真实账号验证，暂保持 Excel 客户端授权。
  - 带引号数字的静默容错。
  - 回放缓存 7 天：现为空闲 2 小时，缓存未命中时可按客户端完整调用重建。
  - HTTP 流 15 秒保活。
  - `**Thinking**` 摘要。
- **破坏性变更：**
  - 带 `required` / 指定工具 / `allowed_tools`、声明内置工具或含 `configuration_update` 的请求，此前改走原生，现在留在 BPS。
  - BPS 429 缺省冷却由 60 秒降为 5 秒。
  - 新授权账号默认开启 403 自动恢复，每分钟探测一次。
  - BPS 密文被拒由“直接 400”改为“重试一次后可能改走原生”。
- **升级指南：** 无迁移；部署控制面镜像（含 Worker）后生效。存量账号如需新的恢复与冷却默认值，可在账号 BPS 设置或批量编辑中调整。本轮未部署；真实 BPS 上游的内置工具中继与断流补完成未在本地验证。
- **代码统计（相对远端 `6157db7b`，含新增文件）：** 业务代码 +864 −40（含描述与四语文案），测试 +292 −85，文档 +16 −2。
- **验证：**
  - **Worker：** `gofmt`、`go vet`、`go test -race ./...` 通过。新增用例覆盖：`configuration_update`（顶层上限、顶层缺省）；`tool_choice` 降级与 `allowed_tools`；内置工具中继、历史降级、同名客户端工具优先、空 diff 拒绝；断流补完成（最终答案补、commentary 与未完成项不补）；BPS 密文重试、回退原生携带原始正文、BPS 锁定时交付错误；429 冷却缺省与 `Retry-After` 钳制；目录提前解除模型冷却与间隔节流；图片端点上游路径。
  - **Node：** 控制面相关单测 178/178；Gateway / BPS / 多 Worker / 供应商账号 e2e 9/9。
  - **Web：** `tsc -b`、Prettier、vitest（15 文件 / 78 项）通过。

## 2026-11-05 统一控制面重构：P5 复核遗留修复；整体验收定稿

- **Bug 修复（只在设置 `KIN_REDIS_URL` 时生效）：** 共享并发租约补登记期间被归还的令牌会再删一次；历史来源查询逐条检查 Redis 命令错误，查询失败不再被当成“查不到”而负缓存。
- **文档：**
  - 计划 P5.3 与运维文档第 13 节写明冷却按实例拆分字段，以及错误保护冻结的心跳通道延迟；
  - 回放比对工具说明补充事件日志长时间故障时的处理；
  - 整体验收记录（`docs/control-plane/ACCEPTANCE.md`）定稿；
  - P5 与 PF.2 审查报告记录复核通过。
- **状态：** 统一控制面重构 P0–P6 与整体验收全部关闭（P7 不做）。所有新能力开关默认关闭；生产切换与 Redis 部署未执行。

## 2026-11-05 统一控制面重构：P5 审查（R5）修复

- **Bug 修复（只在设置 `KIN_REDIS_URL` 时生效）：**
  - **跨实例并发：** Redis 短暂不可用时准入的请求不再在归还时删掉其他请求的令牌，恢复后补登记；共享租约被拒时撤回准入（不再留下 RPM 样本与会话绑定），排队位置保留；续期不会把已归还的令牌加回去。
  - **冷却共享：** 写入成功后才算已发布，失败下轮重试，每 30 秒全量重发（Redis 重启后补上）；限制按实例分别保存，读取时取最晚截止；Redis 不可用时不再按旧的远端限制屏蔽账号；原因只存类别。
  - **客户端：** 鉴权失败、只读副本、加载中等错误按不可用处理；单次操作严格受 1 秒以内的时限约束；地址格式错误时不在错误信息里输出地址。
  - **历史来源：** 同步写入，下一轮请求落到其他实例时能查到；按 Redis 剩余有效期缓存。
  - **回放比对工具：** 事件消费窗口终点改为控制面最后一次成功拉取，事件日志持续故障时也能发现缺事件（终审复核 A-N2）。
- **测试：** 新增经 Server 的真实请求测试（两实例并发上限、真实 429 冷却跨实例、BPS 续接跨实例、Redis 停止时接单）与令牌归还、准入撤回、续期竞争、实例失联、发布重试等回归测试；P5 审查报告 `docs/control-plane/reviews/P5.md` 含演练记录。
- **上游取舍：** Worker 的 `go.mod` / `go.sum` 新增 Redis 依赖（P5 预算例外，用户已认可）。

## 2026-11-05 统一控制面重构：P5 共享运行态（Redis）；终审复核遗留修复

- **新增功能（开关 `KIN_REDIS_URL`，未设置时行为不变）：** 多个 Gateway Worker 经 Redis 共享运行态。
  - **账号并发：** 账号的并发上限在所有实例合计生效，超出时按原有方式排队。
  - **冷却与冻结：** 冷却、错误保护冻结、BPS 冷却与 BPS usage-policy 退避约 1 秒内传播到其他实例，提前解除同样传播。
  - **协议状态：** BPS 工具回放、会话目录、续接快照、图片检查点与历史来源记录存进 Redis，跨实例续接与来源锁定生效。
  - **安全与降级：** 协议内容以凭据包密钥派生的密钥加密；Redis 不可用时各项退回本地行为、照常接单，恢复后自动回到共享。「Gateway Worker」页显示每个实例的共享运行态（迁移 `113`）。
- **Bug 修复（终审复核）：**
  - 回放比对工具不再对账号测试对话、已回退 VM 的请求报假的尝试差异（补写状态记为 `not_client`）；账本检查增加结算状态（死信、超过 1 小时仍待结算）；只检查各实例事件消费窗口内的回执。
  - 租约策略未知时只把不带错误码的 404 当成旧版控制面；定时刷新一律等本次启动的第一份心跳策略。
  - 主密钥文件首次创建在不支持硬链接的文件系统上回退为直接排他创建。
- **升级指南：** 默认无需操作。多 Worker 部署接入 Redis 见运维文档第 13 节（部署命令、`volatile-lru`、不需要持久化、回滚方式）；启用凭据托管前核对已固定公钥的实例（第 10 节）。本轮未部署。
- **依赖：** Worker 新增 `github.com/redis/go-redis/v9`（运行时）与 `github.com/alicebob/miniredis/v2`（测试与 e2e 辅助程序）。
- **验证：** Go 新增共享 BPS 状态（跨实例、加密、CAS、Redis 停止退回数据目录与恢复）、历史来源跨实例、跨实例并发上限、冷却与 BPS 退避传播测试；新增双 Worker Redis e2e（含 Redis 停止与恢复演练）；控制面新增共享运行态记录测试。

## 2026-11-05 统一控制面重构：整体终审（PF.2）修复

- **安全修复（开关默认关闭时不触发，生产切换前必需）：**
  - **刷新租约：** Worker 保存最近一次租约策略并在重启后沿用。全新 Worker 在收到第一份心跳策略前不做定时刷新；请求内刷新先申请租约，只有控制面是不支持租约的旧版本时才自行刷新。
  - **托管公钥：** 新实例的首个托管公钥也要管理员在「Gateway Worker」页核对指纹后确认，控制面自己拉起的同机 Worker 自动确认。确认前投影走共享凭据包。注册请求不能自报准入状态。
  - **响应签名：** 签名覆盖完整请求目标（含查询串）；账号导出响应也签名（新版 Worker 报告 `signed_exports`，控制面据此验签）。
  - **凭据库：** 不再保存代理地址，投影取来源实例当前的代理；导出账号文件前先收录，凭据库较旧时用 Worker 副本；迁移脚本的只读演练不再生成主密钥文件，首次创建主密钥文件改为排他写入；凭据库读不出时告警。
- **计费与正确性修复：**
  - **回放比对工具：** 增加“回执 → 事件”（发现事件丢失）与“回执 → 账本”（用量可信度、token、成本）两个方向；收件箱问题状态计入退出码；信封无效的事件不再让工具崩溃。
  - **事件链路：**
    - Worker 数据目录从旧快照恢复后，控制面发现事件流回退，从 Worker 已确认处重新处理；
    - 账号终态快照按纳秒数值比较时间；
    - shadow 不再让 Worker 因事件日志故障拒单；
    - 毒事件连续失败 5 次后跳过，序号缺口重试 5 轮后才接受；
    - 控制面开始消费事件时 Worker 补发完整账号终态；
    - 默认关闭时不再逐条 fsync。
  - **请求尝试补写：** 只补有使用记录的客户端请求，不写到回退 VM 的尝试行上。
  - **设置快照：** 版本取设置行自身的版本。
- **文档：**
  - 设计 5.6、6.2（信任边界、已知限制：投影仍需在线的来源实例）、6.3 更新；
  - 运维文档第 8–12 节更新（比对工具三个方向、确认外部 Worker 公钥、迁移脚本与主密钥文件位置、授权会话加密条件）；
  - `supplier-platform/18` 去掉 `routing.codex.*` 旧描述；
  - 新增整体终审报告 `docs/control-plane/reviews/PF.md`；
  - 验收记录更新。

## 2026-11-05 CPR 同步：归属不明的请求原样回传客户端 turn-state，删除本地证明缓存（CPR `1daa0623`）

- **范围：** 官方上游仍为 `6a8f9c7f`，本轮无官方上游新提交，不发版。CPR 冻结 `21d84af2`，盘点 `860fb396` 之后 5 个提交。
- **采用 CPR / 删除本地方案（`1daa0623`）：** CPR 撤销了此前的进程内 turn-state 归属证明缓存（本地按 `790f3147` 移植为 `turn_state.go`）。该缓存只在本进程记住上游交出的 token，Worker 重启、会话记录过期或请求落到另一实例后，客户端正常带回的 token 会被当作“未证明”删除，上游无法按原路由续接。现与 CPR 一致：
  - 归属不明（未钉住账号、没有会话记录）与同账号的全量请求，原样回传客户端的 `x-codex-turn-state`（请求头优先，没有时取 `client_metadata`，即 WS 首帧形状），正文与 `client_metadata`、turn metadata 中的 turn-state 字段保留；`previous_response_id` 等账号绑定字段在归属不明时照常清理。
  - 只在明确换号（`scopeDifferent`）时清理 turn-state：请求头、正文、`client_metadata` 与 turn metadata 一并删除。Live 请求的 turn metadata 同样按换号清理。
  - 删除 `worker/internal/codexgateway/turn_state.go`（证明缓存及其 4096 项容量与过期逻辑）、`Server.turnStates` 与两处 `rememberTurnState` 调用，以及对应的 `keepsVerifiedTurnState` 分支；原证明缓存测试改为新语义测试。
- **不采用：** `46b4665c` 允许按 Key 固定 `installationId`——用户 2026-11-05 决定暂不做。同一 Key 跨账号共用一个安装身份会让多个账号呈现为同一设备，涉及风控取舍；本地已有按 Key 的 `codex_client_profile`，以后有明确需求时可在其上增加，并只允许运营方配置。
- **不适用：** `21d84af2`（CPR 提示文案）、`d604adfb`（CPR 登录页）、`311e4d22`（CPR 贡献指南）。证据索引“已对齐到”推进到 `21d84af2`，下次从其之后盘点。
- **接口 / 配置 / 迁移：** 无。**破坏性变更：** 行为变化——归属不明的请求不再删除客户端回传的 turn-state。
- **升级指南：** 只需更新 Worker 二进制（随应用发布）后重启；不涉及 Node、`web/dist` 与 payload。部署另行授权。
- **验证：** Go `go vet ./...` 与全量 `go test -race ./...` 通过；新增 `TestUnknownScopeEchoesClientTurnState`（新进程无记录时头与 `client_metadata` 的 token 都回传、只在 `client_metadata` 携带也回传、`previous_response_id` 仍清理）与 `TestTurnStateClearedOnlyOnConfirmedAccountSwitch`（换号时头、正文、`client_metadata`、turn metadata 全部清理，归属不明与同账号保留）；Live 路径的既有测试覆盖换号清理。`gateway-worker-real` e2e（真实构建并启动 Worker）通过。

## 2026-11-05 Gateway 吸收 sub2api 定制版：缺省 store 补 false，加密历史优先回签发账号、被拒时同号缩减重发

- **需求：** 用户要求审查定制 sub2api（NewAPI 分支）的网关重构与 bug 修复，把做得好的部分吸收进 Codex Gateway。逐项对照约 45 项修复与 8 类机制后，按线上证据选出 3 项，用户确认“全做”。
- **依据（生产只读，近 3 天 37,185 次 Gateway 请求）：**
  - 5 次 400 “Store must be set to false”（python-httpx、codex_cli_rs）：请求缺 `store`，Worker 对齐 CPR 时漏了补默认值。
  - 21 次 `invalid_encrypted_content`，集中在 2 个会话，分别连续被拒 9 次与 11 次后放弃；多数失败的前一次成功请求在另一个账号上。加密推理只有签发账号能读，换号后客户端反复重发同一段历史，一直失败。
- **优化改进（Worker）：**
  - **缺省 `store` 补 `false`：** 选定 OAuth 账号后的请求兼容（`compat.go`）在请求缺 `store` 时补 `false`，与 CPR `normalize_codex_request_body` 相同；显式值（含 `true`、`null`）保留交给上游判定。
  - **加密历史优先回签发账号：** 历史来源锁定（`route_provenance.go`）在原生通道同时记录签发账号。请求历史含已知原生密文时，以最新一段密文的签发账号为 `HistoryOwner`：就绪时优先于会话主账号与权重，只是暂时满载时排队等它；冷却、停用、已在本请求失败或不在范围时正常选号。
  - **密文被拒同号缩减重发：** 生成前被拒（HTTP 错误或首个生成内容前的流内 `response.failed`，错误码 `invalid_encrypted_content` / `invalid_compaction` / `compaction_decode_error` 或同义消息）时不处置账号，在同一账号逐级缩减后重发，每步一次、最多两步：先去掉带密文的 `reasoning` 项与 assistant 消息、工具调用上的回放密文（明文保留）；仍被拒或拒绝点名 compaction 时，再把 compaction 换成一条说明。正文以保序 JSON 改写，其余字段与顺序不变（`encrypted_history_recovery.go`）。
- **评估后未吸收（附依据）：**
  - 空的 `completed` 视为静默拒绝并换号：线上 476 次空完成全部是 Codex Desktop 的 `generate:false` 预热，照搬会把预热打成失败。
  - 续接不可用时网关代为用完整历史重放：228 次 `previous_response_not_found` 中 167 次客户端在 60 秒内自行重发成功。
  - 首字超时后换号：成功请求首字超过 180 秒的只有 13 次。
  - 上下文超限改为流内 `response.failed`：上游已在流内下发（235 次均为 200 加流内失败）。
  - 剥离上游不识别的参数后重试：CPR 规定未知字段原样透传，线上无对应证据。
  - 单账号容量熔断：已有同号退避、离群账号停放与全池熔断，线上失败主因是上游整体过载。
  - 客户端断开后读 1.2 秒补用量：用户中途打断时生成通常远未结束，拿不到终态用量。
  - 语义提交点、前导缓冲、Retry-After 不截短、追踪头清理、turn-state、401 刷新：已按 CPR 实现。
- **上游取舍：** Gateway Worker 为本地定制功能，不涉及上游文件。缺省 `store` 属于 CPR 对齐的遗漏补齐。密文恢复采用 sub2api 的两步缩减；sub2api 只在会话跨协议迁移（BPS / Cloud）时启用，这里经用户确认也用于原生通道。BPS 通道保持原有的“不重试”。
- **破坏性变更：** 原生通道密文被拒的请求由“直接交付 400”改为“同号缩减后重发”，成功时模型失去被去掉的隐藏推理与压缩摘要，可见消息与工具调用不变；带 `previous_response_id`、续接钉号的请求与 BPS 通道不变。带已知原生密文的请求会优先排队等待签发账号（只等暂时满载，不等冷却）。
- **升级指南：** 无配置、无迁移；部署控制面镜像（含 Worker）后生效。历史来源记录新增账号字段，旧记录没有账号，不影响通道锁定；新交付的响应开始记录签发账号。本轮未部署。
- **代码统计（相对当前远端 `f48712fd`，含新增文件）：** 业务代码 +286 −19（净 +267），测试 +262 −17（净 +245），文档另计。
- **验证：** Worker `gofmt`、`go vet`、`go test -race ./...` 全部通过。新增用例覆盖：缺省 `store`（缺省补、显式保留、嵌套同名不算、非 JSON 不动）；两步缩减（字段顺序、可见内容保留、点名 compaction 一步到位、续接不缩减、无可缩减时停止）；拒绝识别（错误码与消息、防误判）；HTTP 与流内拒绝的同号恢复且不处置账号；签发账号优先、最新密文决定归属、签发账号停用时正常选号、交付后记录签发账号。真实构建 Worker 的 Gateway 端到端测试（原生、多 Worker、BPS）5/5 通过。

## 2026-11-05 统一控制面重构：复审遗留修复，P3、P4、P6 关闭

- **Bug 修复（凭据，默认关闭的开关下才会触发）：**
  - 轮换报告丢失后，持有最新令牌的 Worker 会拒绝旧投影。拒绝时现在带上本地凭据代次，控制面据此改以该实例为投影来源，账号自动恢复，不再一直被排除在调度外。
  - 重新授权与导入的代次下限改为在完成时计算，草稿有效期内其他实例的刷新也计入。
  - 刷新结果报告每次单独计时；首次失败后在后台再试两次，不阻塞请求内的刷新。
- **Bug 修复（Codex 执行设置）：**
  - 设置页修改图片张数上限时，输入中途的过渡值不会再把隐藏的提醒余量与压缩预留永久压成 0。
  - 事件补写的请求尝试也记录设置版本。
  - 启动导入 `routing.json` 前先备份；从未读到有效设置时拒绝保存（503 `settings_unavailable`），不以默认值覆盖数据库。
  - 设置描述版本改为 2；隐藏字段上的服务端错误改用本地化文案。
- **文档：**
  - 运维文档新增第 12 节（三个开关一览与推荐上线顺序），第 10 节补充在 Worker 主机本机核对托管公钥指纹；
  - 设计文档状态改为已实施（P1–P4、P6）；
  - 审查报告记录 R3 第二轮复审与 R4/R6 复核结论。
- **验证：** 新增 Go 测试（旧投影拒绝报告本地代次、结果报告后台重试）与 Node 测试（旧投影恢复、代次下限现算、撤销删除租约行、主密钥文件变化后改用新密钥、结果不明写审计、读取失败拒绝保存、导入前备份）、web 测试（过渡输入不收敛隐藏字段）。

## 2026-11-05 统一控制面重构：R4/R6 审查修复与 R3 复审修复

- **Bug 修复（R4/R6 审查）：**
  - **P0：** 升级后首次启动，原 `routing.json` 中的 8 项 Codex 本地设置会被重置为默认值。原因是导入晚于上游加载并改写文件。现在改为在启动与备份恢复时、加载 `routing.json` 之前导入。原文件先备份为 `routing.json.bak-<时间>`，再删除本地键。运维文档补充了回滚步骤。
  - **设置页隐藏字段导致保存失败：** 服务端与设置页共用联动规则（`src/shared/executor-schema/link-codex-settings.mjs`）：
    - 关闭 403 自动停用时，同时关闭自动恢复；
    - 改小图片张数上限时，收敛被隐藏的提醒余量与压缩预留；
    - 落在隐藏字段上的服务端错误列在区块底部。
  - **设置版本：** 改名为 `settings_revision`，与上游的 `config_revision` 区分（迁移 `112` 改列名）。每个请求只取一次设置快照，信封、Worker 回执、`request_attempts` 记录同一版本。心跳策略的版本与策略值来自同一快照，Worker 在健康接口与心跳中报告已应用的版本。
  - **读取出错：** 保留上一份有效设置并告警，不再缓存默认值。
  - **保存：**
    - 增加 `expected_revision` 乐观锁（冲突返回 409，页面重新载入）；
    - 合并语义统一为“对象合并一层”；
    - 开启预热必须填时刻与模型；
    - 审计记录改动前后的值。
  - **账号 BPS 设置：** 服务端改为按 `codex-account.json` 校验，错误码不变。
  - **BPS 目录补查：** 每轮最多 5 个，最久未更新的优先；失败的账号 1 小时后再试；在后台执行。
  - **表单无障碍：** 单选组支持方向键，说明与错误通过 `aria-describedby` 关联到控件。
  - **账号 BPS 表单布局：** 宿主自定义控件（BPS 模型勾选）改为整行显示，标题与说明在上方，不再把对话框撑出横向滚动条；模型勾选区不再重复显示同一段说明。
- **Bug 修复（R3 复审）：**
  - Worker 导入凭据时，两种凭据包都拒绝回退凭据代次；投影来的 BPS 令牌代次比本地旧时，保留本地令牌。
  - 重新授权与导入时，控制面给出代次下限，避免与其他实例刷新出的代次撞号。
  - 撤销 BPS 时同时删除 BPS 租约行。
  - 主密钥文件变化后，写入前即改用新的主密钥。
  - 租约行的代次取最大值；BPS 刷新写回时同时比较令牌代次。
  - 结果不明时写审计并告警；结果报告失败会重试 3 次。
  - Worker 在启动日志和健康接口中提供托管公钥指纹，「Gateway Worker」页显示新旧指纹，供确认前带外核对。
- **上游取舍：**
  - 计划 2.7 记录 P4 的预算例外：`server.mjs` +3、`request-attempts-repo.mjs` +2、`handle-codex.mjs` +5 行；
  - 同轮删除上游文件中的本地代码 239 行。
- **验证：**
  - Go `-race` 全量通过；新增导入回退保护与代次下限测试。
  - Node 全量单测通过，只有 4 个已知的环境失败；新增启动导入顺序、隐藏字段联动、读取失败、乐观锁等测试。
  - Web：`tsc`、vitest 通过；新增设置区测试。
  - 双 Worker e2e 增加两项：修改设置后两个实例在一个心跳周期内应用新版本；过期版本保存返回 409。
  - 真实 Worker e2e 的崩溃重启用例改为等到新进程以新的 `boot_id` 登记后再发请求（崩溃前最后一次心跳在 45 秒内仍显示 healthy，原写法偶发 503）。
  - 浏览器验收：设置页保存，账号导入后向导出现 BPS 步骤，账号 BPS 表单联动与保存。

## 2026-11-05 统一控制面重构：R3 安全审查修复；P4 本地设置与配置版本；P6 界面按设置描述渲染

- **Bug 修复（R3 审查，凭据托管与刷新租约；默认关闭的开关下才会触发）：**
  - **投影安全：**
    - 凭据库比 Worker 副本旧、或缺少 BPS 时，回退到 Worker 副本，不再下发“旧令牌 + 新代次”；
    - 导入的代次以凭据库为准；
    - 撤销 BPS 授权时，凭据库里的 BPS 记录一并删除；
    - 托管封装的附加认证数据绑定两种代次，Worker 拒绝低于本地代次的投影。
  - **BPS 令牌代次：** Worker 新增 `token_generation`，每次授权、导入、刷新都递增。凭据库与刷新租约按它判断新旧，轮换报告丢失后，下一次导出即可追上。
  - **主密钥：**
    - 已有凭据时主密钥文件缺失直接报错，不再静默生成；
    - 运行中进程遇到不认识的主密钥 ID 会重读文件，在线轮换可用；
    - 写文件时 fsync，轮换前自动备份。
  - **结果不明：** 换票请求已发出却没拿到响应时，Worker 报告 `ambiguous`，该账号的租约保持 10 分钟、不发给任何实例。此外：
    - 同一实例也不能在租约有效期内重复申请；
    - 单次代次增幅超过 1000 被拒；
    - 定时 BPS 刷新与请求内 401 刷新共用一把锁，并设截止时间。
  - **实例托管公钥固定（TOFU）：**
    - 首次登记后固定；之后上报的不同公钥待管理员在「Gateway Worker」页确认后才替换（迁移 `110`），确认前投影回退到共享凭据包；
    - 心跳先记录公钥再投影；
    - 能力描述里没有 `custody` 的旧版 Worker 回退到共享凭据包；
    - 文档写明了共享内部令牌就是完全信任的边界，以及退出计划。
  - **事件页响应签名** 增加覆盖状态码与路径。
  - **授权会话：** 换码结果先落库再收尾，收尾失败后重试不再重复换码；过期会话的 verifier 定期清空。
- **新增功能：**
  - **P4 本地设置与配置版本：**
    - 本地 8 个 Codex 设置键（调度、预热、重置卡、点数超额、BPS 开关、BPS 默认模板、BPS 图片、执行通道偏好）迁入控制面设置存储（迁移 `109`）。每次修改推进配置版本并写审计。
    - 首次启动时从 `routing.json` 一次性导入，并删除这些键；`routing.json` 与 `normalizeCodexRouting` 回到上游格式。
    - 新增面板接口 `GET/PUT /api/panel/gateway-workers/settings`，返回值、版本与设置描述；保存时在服务端按描述校验。
    - 配置版本随心跳策略和请求信封下发；Worker 写进回执，控制面记在 `request_attempts.config_revision`（迁移 `111`）。
    - Worker 内嵌设置描述，提供 `GET /internal/v1/schema/settings`、`/schema/account`，并在能力描述中报告版本；版本不一致时告警。
    - BPS 模型目录每 30 分钟检查一次，补查 6 小时未更新的（`/v1/models` 只读缓存）。
  - **P6 界面：**
    - 通用设置描述表单 `SchemaForm`：分组、条件显示、即时校验、文案 key、专用控件扩展。
    - 「设置 → OpenAI → Codex 执行设置」与账号 BPS 设置改为按描述渲染，显示配置版本。
    - 账号向导按 Worker 能力描述的 `authorizations` 决定是否提供 BPS 授权步骤。
    - 「Gateway Worker」页可确认替换托管公钥。
- **清理：**
  - 删除手写的调度、预热、重置卡、BPS 默认模板、BPS 图片设置组件及其测试；文案沿用原有 key。
  - `codex-route.mjs` 恢复为上游原样，本地规范化函数移到 `src/lib/executor/codex-settings.mjs`。
  - 删除 `routing-runtime.mjs` 中本地添加的调度深合并，`codex-usage.mjs` 不再直接读 `routing.json`。
  - 删除未再使用的凭据库指纹 CAS。
  - 上游文件本轮净减少 239 行。
- **升级指南：**
  - 新版本首次启动时自动导入并改写 `routing.json`（只删除本地键）。
  - 旧版面板客户端提交的这些键会被忽略，请刷新页面后在新的“Codex 执行设置”中修改。
  - 先升级控制面，再升级 Worker。
- **验证：**
  - Go：`-race`、`vet`、三平台交叉编译通过。新增结果不明、托管代次绑定、设置描述一致性等测试。
  - Node：全量单测（4 个已知环境失败除外），新增设置存储、描述校验、租约路由鉴权、凭据库在线轮换等测试。
  - Web：`tsc`、vitest（设置描述表单、BPS 表单、向导能力）。
  - 新增双 Worker 真实 e2e：并发刷新只换票一次、清空数据目录后恢复与公钥确认。
  - 浏览器验收：设置页按描述渲染、校验并保存（版本推进）；服务端拒绝非法值并标出字段。

## 2026-11-05 统一控制面重构 P3.4–P3.9、P3.11：凭据托管归控制面（默认关闭）、授权会话迁回控制面、事件页响应签名

- **需求：** 令牌以控制面为准、加密保存，按实例封装下发；授权会话保存在控制面；事件页响应可验证来源（设计第 6 节，R1 审查 P2-10）。
- **新增功能：**
  - **凭据库（P3.4）：**
    - 迁移 `106_executor_credentials.sql`，实现在 `src/lib/executor/vault.mjs`。
    - 信封加密：每条记录一个随机数据密钥，AES-256-GCM 加密；数据密钥由主密钥包裹。附加认证数据绑定账号、授权类别与代次，挪用或改代次都无法解密。
    - 写入按代次 CAS；BPS 刷新不改代次，改按轮换前令牌指纹 CAS。
    - 主密钥文件 `credential-master-keys.json`（0600）与数据库同目录；用 `scripts/rotate-credential-master-key.mjs` 新增主密钥、重新包裹、清退旧密钥。
  - **实例托管密钥（P3.5）：**
    - Worker 在数据目录生成 X25519 密钥对（`custody-key.json`），公钥随注册与心跳提交（迁移 `107`）。
    - 控制面按实例公钥封装 `custody_bundle`（临时 X25519 + HKDF-SHA256 + AES-256-GCM），只有该实例能解开。
    - 两端格式由共享夹具 `test/fixtures/executor-contract/custody.json` 互相验证。
  - **收录与轮换（P3.6）：**
    - `KIN_CREDENTIAL_CUSTODY=control` 时，从 Worker 导出账号即按代次收录：授权、导入、重新授权都会提高代次。
    - 刷新租约的持有者报告 `rotated` 时，附带新凭据包、轮换前代次与指纹，控制面 CAS 写入凭据库。
    - 投影从凭据库按实例封装。目标实例没有公钥（旧版 Worker）或凭据库还没有该账号时，回退到共享凭据包并告警。
  - **授权会话迁回控制面（P3.7）：**
    - 控制面生成 `state` 与 PKCE verifier，Worker 补上安装身份后交回，不再落盘；Worker 启动时删除旧的 `oauth-sessions.json`。
    - 会话加密保存在 `gateway_worker_oauth_sessions.session_json`（迁移 `108`），完成或过期后清空。
    - 旧版 Worker（不交回会话）仍可完成授权。
  - **迁移工具（P3.8）：** `scripts/migrate-worker-credentials.mjs` 默认只读演练，`--apply` 写入并审计；取代次最高的在线绑定导出，写入时按代次单调。
  - **导出与明文接口（P3.9）：**
    - 账号导出在 control 模式读凭据库，在 worker 模式解开导出的凭据包。
    - 删除 Worker 明文凭据接口 `GET /internal/v1/accounts/{id}/credentials`，以及控制面的 `accountCredentials`。
  - **事件页响应签名（P3.11）：** Worker 对 `/internal/v1/events` 的响应做 HMAC 签名，覆盖 `resp`、请求随机串、正文摘要与正文；控制面验签失败即视为拉取失败。
- **破坏性变更与升级指南：**
  - 先升级控制面，再升级 Worker。新版 Worker 要求控制面提供授权会话；控制面开启事件消费时，要求 Worker 支持响应签名。
  - `KIN_CREDENTIAL_CUSTODY` 默认 `worker`，行为不变。切换到 `control` 前先运行迁移工具；主密钥文件必须与数据库分开备份。
  - 账号导出要求控制面配置与 Worker 相同的 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`（托管部署自动生成）。
- **清理：**
  - 删除 Worker 授权会话的落盘读写（`loadOAuthSessions`、`saveOAuthSessions`、`OAuthSessionsPath`）、会话认领与结果缓存（由控制面按草稿串行替代）。
  - 删除明文凭据接口及其客户端方法与测试。
- **验证：**
  - Go：`-race` 全量通过。新增托管密钥持久化、跨实例或跨账号无法解开、`custody_bundle` 导入、JS 夹具互通、授权会话不落盘、事件页签名等测试。
  - Node：新增凭据库加密、CAS、篡改检测、主密钥轮换、托管收录与轮换、导出、授权会话交回与旧版兼容、响应验签等测试。
  - 真实 Worker e2e 中 primary 同时开启事件、租约与 control 托管：
    - 导入时收录代次 1；
    - 手动刷新经租约，CAS 写入代次 2；
    - 库内无明文；
    - 迁移工具演练结果为最新。
    - shadow 下迁移工具 `--apply` 收录并审计。
    - 授权会话经真实 Worker 的 BPS e2e 验证。
- **限制：**
  - 本轮未部署，生产迁移与切换（P3.10）需要单独授权。
  - control 模式下 Worker 仍在本地保留加密的令牌副本，作为投影缓存。
  - 投影的账号公开字段仍取自来源 Worker 的导出。

## 2026-11-05 统一控制面重构 P3.3：控制面指派定时预刷新；P2 第二轮复审修复

- **新增功能（P3.3，随 `KIN_REFRESH_LEASE=on` 生效）：**
  - 心跳策略的 `refresh_lease` 增加 `designated`，列出指派给本实例做定时预刷新的运行账号。指派规则：每个账号取在线实例中凭据代次最高者；同代次时按实例 ID 取第一个；实例离线后，下一次心跳即改派。
  - Worker 只对指派账号做定时刷新（原生与 BPS），其余账号等投影送来新凭据。请求内 401 与手动刷新不受指派限制，仍按租约互斥。
  - 未下发 `designated`（旧版控制面）或租约关闭时不限制。
- **Bug 修复（R2 第二轮复审）：**
  - 回放比对的放宽此前过宽：只要没有实时行就不算差异，会掩盖 primary 下补齐失败和 shadow 下实时写入丢失。现在：
    - Worker 回执增加 `operation` 字段；
    - 只有 primary 下尚未补齐的请求，以及其他模式下语音通话 `live`、搜索 `search` 这两个交付时本就不写尝试的通道，才计为 `attempts pending`；
    - 其余情况一律算差异。
  - 选号原因 `gateway_worker`、`gateway_worker_retry`、`gateway_worker_observed` 补上四语文案，界面不再显示原始标识。
  - 补齐重试只先取状态列、按到期时间筛选，退避中的行再多也不会挡住已到期的行。
- **上游取舍：** `web/src/features/logs/log-display.ts` 的选号原因表增加 3 项（9 行），测试 `log-display.test.ts` 增加 7 行。
- **运维提示：** 回放比对读到的实时尝试经写回队列落库，最近几秒内的请求可能暂时显示差异，稍后复跑即可。旧版 Worker 的回执没有 `operation`，升级过渡期内来自旧版 Worker 的语音通话与搜索会显示为差异，Worker 升级后消失。
- **验证：**
  - Go：`-race` 通过，新增指派过滤测试。
  - Node：新增指派选择、心跳策略、比对差异等测试。
  - Web：vitest、`tsc` 通过。
  - 真实 Worker e2e：三种模式连续多次通过。

## 2026-11-05 统一控制面重构 P3.2：Worker 刷新前申请租约；P1 关闭；P2 复审修复

- **新增功能（P3.2，默认关闭）：**
  - Worker 在心跳策略 `refresh_lease.required` 为真时（控制面 `KIN_REFRESH_LEASE=on`），刷新原生授权和 BPS 授权前，都先向控制面申请租约。覆盖三个刷新入口：后台刷新、手动刷新、请求内 401 刷新。刷新后报告结果：`rotated` 附新代次与新令牌指纹；上游拒绝刷新令牌时报告 `terminal`；其他失败报告 `failed`。
  - 租约被拒时，Worker 不使用手里的刷新令牌，最多等待 20 秒，看投影能否送来新凭据。控制面不可达时本次不刷新。这两种失败都不计入“恢复窗口耗尽判过期”。
  - 迁移 `105_refresh_lease_fingerprint.sql`：租约表记录最近一次轮换后新刷新令牌的指纹（SHA-256 前 8 字节）。BPS 授权刷新不改代次，申请时靠指纹识别过时令牌：指纹不同、且代次不高于该次轮换时，拒绝申请（`stale_token`），并从轮换后的持有者把新凭据投影过去（同一账号 30 秒内一次）。重新授权会提高代次，不受旧指纹限制。不带指纹的旧版 Worker 按原规则处理。
  - Worker 发往控制面的签名请求抽成公共函数，心跳与租约共用。
- **P1 关闭（R1 第二轮复审通过）：**
  - Worker 一直拿不到心跳策略、事件消费状态停在“未知”时，超过 24 小时按“不消费”处理，避免事件日志无限增长。
  - 设计 5.6 和运维文档补充“未知”状态的说明。
- **Bug 修复（R2 复审）：**
  - 迁移 103 的部分索引从未被使用：索引条件含 `OR`，SQLite 推不出可用。迁移 `104_executor_inbox_attempts_index_fix.sql` 删除该索引，改为“待补齐”“待重试”两个条件单一的部分索引；补齐查询与索引条件逐字一致，并用 `INDEXED BY` 指定。有测试断言查询计划。
  - 占位行改用显式标记 `selection_reason='gateway_worker_observed'`。此前按 `route` 为空判断，会把迁移 101 之前写入的单尝试行误当成占位行删除重写。
  - 补齐写入：
    - 插入不经写回队列，与删除占位行、标记补齐状态在同一事务内生效；
    - 每行一个保存点，单行失败只回滚这一行；
    - 失败后按 1、5、15 分钟退避重试 3 次，之后记为 `failed`（此前约 15 秒内就会用完重试）；
    - `stats()` 中的重试状态合并显示为 `retry`。
  - 回放比对：实时语音通话（calls）等通道在交付时不写请求尝试，要等 primary 下由事件补齐。这类请求在补齐前不再算差异，另计为 `attempts pending`。此前 shadow 期的比对因此永远无法达到“零差异”。
- **上游取舍：** `request-attempts-repo.mjs` 的 `record` 增加 `immediate` 参数（2 行），让补齐写入可以绕过写回队列；其余为定制文件。
- **验证：**
  - Go：`gofmt`、`vet`、`-race` 全量通过；新增 Worker 租约测试，覆盖签名、地址推导、策略开关、被拒后等投影、控制面不可达、BPS 指纹与终态。
  - Node：新增租约指纹、补齐回滚、退避与失败、部分索引查询计划、链路去重、shadow 不补齐等测试。
  - 真实 Worker e2e 三种事件模式全部通过：
    - shadow 与 primary 下，回放比对零差异；
    - primary 下同时开启刷新租约，验证手动刷新经控制面租约完成，并记录了轮换结果与令牌指纹。
- **限制：** 本轮未部署，开关默认关闭。“结果不明”查询、终态后停止发放租约、控制面统一预刷新在 P3.3、P3.6 实现。

## 2026-11-05 统一控制面重构 P3.1：凭据刷新租约（控制面部分，默认关闭）

- **需求：** OpenAI 刷新令牌是一次性轮换。多 Worker 模式下，同一账号的各个副本会各自刷新，只有第一个成功，其余副本的令牌随即失效。P3 要求同一刷新令牌只被一个实例使用（设计第 6 节）。
- **新增功能：**
  - 迁移 `102_credential_refresh_leases.sql`，租约按（账号, 授权类别 native / bps）唯一，60 秒过期。
  - `src/lib/executor/refresh-lease.mjs`：
    - 申请：其他实例持有未过期租约时拒绝；原生授权代次落后时拒绝，等投影送来新凭据。
    - 报告结果：`rotated` / `failed` / `terminal`。成功时推进该实例绑定的凭据代次，并把新凭据从持有者投影到其他实例。
  - Worker 内部接口：`POST /internal/v1/gateway/workers/credentials/lease` 与 `/release`，沿用心跳的签名校验。
  - 心跳策略下发 `refresh_lease.required`，开关 `KIN_REFRESH_LEASE=on`，默认关闭。
- **上游取舍：** `src/server.mjs` 的内部路由判断由两条精确路径改为 `/internal/v1/gateway/workers/` 前缀（1 行），以接入新接口；其余为定制文件。
- **限制：** Worker 侧在刷新前申请租约（P3.2）尚未实现，开关打开前没有实际效果；本轮未部署。
- **验证：** `executor-refresh-lease` 单测覆盖：
  - 互斥与过期重新申请；
  - 代次落后被拒；
  - 释放与投影要求；
  - 旧令牌无法释放；
  - 输入校验；
  - 开关默认关闭。

## 2026-11-05 统一控制面重构：P1 审查（R1）修复；P2 统一结果与请求账本

- **背景：** P1 交付后，由独立子智能体审查（R1）。结论是不能关闭：P0 1 项、P1 5 项、P2 10 项。逐项处置见 `docs/control-plane/reviews/P1.md`。本节同时交付 P2 已完成的部分。
- **Bug 修复（R1）：**
  - **P0（默认配置下的线上故障）：** 默认 `off` 下控制面从不确认事件，积压到 512 MiB 后 Worker 会拒绝全部请求，磁盘持续增长；控制面仍是旧版时也会触发。现在：
    - 控制面在心跳策略中下发 `executor_events.required`；
    - 不消费时 Worker 自行确认到最新序号，只保留 24 小时，积压与写入故障都不拒单；
    - 只有控制面消费时，Worker 才因事件日志故障或积压显示 `degraded` 并拒单；
    - 写入故障在 10 秒维护周期内自动尝试恢复。
  - **探测比对：** shadow 下 `probe.recorded` 按毫秒归一化后比对（此前因纳秒精度永远不匹配）。
  - **摘要口径：** 控制面按 Go 口径转义 U+2028/U+2029 后计算载荷摘要；共享夹具增加相应用例。无效事件不再卡住整条事件流，改为记为 `invalid`、跳过并告警。
  - **心跳兜底：** primary 下，只有事件链路健康（Worker 报告消费中且健康、控制面 60 秒内成功拉取过当前流）时，心跳才停写账号终态、额度与探测；否则仍由心跳写入。
  - **游标起点与旧快照：** 游标从 max(本地游标, Worker 已确认序号) 开始，切换模式时不再重放 Worker 已确认的历史；`account.state` 只应用不早于已应用快照的事件。
  - **告警与展示：**
    - 心跳水位存入 `gateway_worker_instances.executor_events_json`，「Gateway Worker」页显示事件发件箱状态（是否消费、未确认条数、积压大小）；
    - 接收器对无效、失败、缺口、积压超过 256 MiB 和日志不健康输出 `executor events:` 告警日志。
  - **复审修复（R1 第二轮）：**
    - Worker 重启后、收到第一份心跳策略前不再自行确认事件，避免跳过控制面尚未拉取的事件（`required` 改为未知、否、是三态）；
    - 卡在失败事件上时不再被判为链路健康；近 5 分钟有被跳过的账号终态快照时心跳继续兜底；
    - 告警 5 分钟内同类只输出一次；
    - 回执 `payload_hash` 的控制面规范化改为 Go 口径（转义 U+2028/U+2029），修正旧通道下这类回执被判完整性失败的问题。
  - **其他：**
    - 流标识文件丢失时沿用分段中的流标识；新建段文件后对目录做 fsync；空闲时也清理过期分段；
    - shadow 比对改为按控制面口径重算载荷摘要；
    - Go 拒绝 `null` 载荷和非法流 ID，接口增加空指针保护；
    - `ackReceipt` 改为不等待；
    - 比对工具复用 `canonicalJson`。
- **新增功能（P2）：**
  - 迁移 `101_request_attempt_route.sql` 为请求尝试新增三列：
    - 执行通道 `route`（native / bps）；
    - BPS 阶段 `stage`；
    - 凭据代次 `credential_revision`。
  - 实时写入从 Worker 响应头取这三个值。此前把阶段拼进 `action` 的写法已去掉，`action` 恢复为失败类别。
  - 控制台尝试链显示“BPS · 阶段 …”（四语文案）。
  - `src/lib/executor/result-writer.mjs`：`request.finalized` 转为请求尝试。primary 下事件入库 60 秒后补齐实时写入缺失的尝试（例如控制面在交付中途重启），已有的尝试只补 Worker 侧字段，不覆盖控制面视角的终态与交付事实。
- **P2 审查（R2）修复：**
  - 只有控制面占位行（没有 Worker 尝试摘要，例如请求已发出但连接中断）时，用事件的尝试重写整组，最后一行保留控制面终态与交付事实，不再出现矛盾记录；占位行 route 为空。
  - 事件补入的尝试一律按未提交下游记录：Worker 的 sent 只表示已发往上游。
  - 迁移 `103_executor_inbox_attempts_index.sql` 为待补齐的事件加部分索引。整批补齐先提交写回队列，再放进一个事务处理；字段已齐全时不写；补注同时回填耗时。
  - 单行补齐失败在 1 小时内最多重试 3 次，`stats()` 显示补齐状态统计，对账循环记录 tick 异常。
  - 比对工具增加请求尝试条数比较。
  - 前端抽出 `attemptRouteLabel`，并补了测试。
- **上游取舍：**
  - P2 调研确认，Claude 在控制面进程内执行，与 Codex 共用同一组上游写入函数（`RequestAttemptsRepo`、请求日志），因此不改写 Claude 路径，计划 P2.4 标记为 skipped。
  - 上游文件改动：
    - `request-attempts-repo.mjs` 插入三列；
    - `usage-logs-view.mjs` 透传两列，并补其测试；
    - 尝试链组件、类型与 `log-display.ts` 若干行；
    - 迁移清单断言。
    均在计划 2.7 的预算内。
- **破坏性变更 / 接口 / 配置 / 迁移：**
  - 新增迁移 101、103（待补齐事件的部分索引）。迁移 101 包括：
    - `request_attempts.route`、`stage`、`credential_revision`；
    - `executor_event_inbox.attempts_state`；
    - `gateway_worker_instances.executor_events_json`。
  - 心跳策略新增 `executor_events`；Worker 健康与心跳的 `events` 新增 `required`。
  - 计划新增 P3.11（事件页响应签名）。
- **升级指南与限制：**
  - 本轮未部署。部署后默认 `off` 不再有积压风险；启用步骤见 `docs/CODEX_GATEWAY_WORKER_SETUP.md` 第 8 节。
  - 每次追加 fsync 且读取持锁，按当前流量足够，已记入设计 5.6。
  - 事件补齐在入库 60 秒后进行。若控制面进程长时间挂起后才写实时尝试，实时写入会与补齐行冲突，控制面终态以补齐行为准；正常情况下不会发生。
  - 按事件写入的尝试，开始和完成时间是补齐时刻。
  - 超过 2^53 的整数在控制面按无效事件处理。
- **验证：** 全量 Go、Node、Web 与 e2e 结果见交付记录；R1 复审结果记在 `docs/control-plane/reviews/P1.md`。

## 2026-11-05 统一控制面重构 P1：执行契约事件发件箱（Worker 事件日志、控制面接收器，影子与主来源开关）

- **需求：** 按 `docs/control-plane/DEVELOPMENT_PLAN.md` 的 P1，把 Gateway Worker 回传给控制面的两条通道合并为一条持久化、可重放的事件流：
  - 回执重放；
  - 心跳中的账号终态、额度与探测。
  这是后续统一请求账本（P2）与凭据归属（P3）的基础。
- **新增功能（Worker）：**
  - `events.go`：数据目录 `events/` 下的分段事件日志。
    - 每条事件带流内序号与载荷摘要，fsync 后才算产生；启动时截掉崩溃留下的残缺或摘要不符的尾部。
    - 已确认的整段保留 24 小时后删除。
    - 事件流 `stream_id` 随数据目录生成，重建数据目录即换新流。
  - `events_http.go`：
    - `GET /internal/v1/events`（按序号分页；流不一致时返回 409 与新流）与 `POST /internal/v1/events/ack`（幂等）；
    - 每 10 秒在变化时产生 `account.state`（全部账号终态快照）与 `account.quota`。
  - 产生点：
    - 回执写入时产生 `request.finalized`（载荷与回执相同）；
    - BPS 恢复探测产生 `probe.recorded`。
  - 健康接口、心跳与能力声明增加 `contract` 版本与 `events` 水位。
  - 事件日志写入失败或未确认积压超过 512 MiB 时，健康状态为 `degraded`，并以 503 `executor_event_log_unavailable`（`not_sent`）拒绝新请求。
- **新增功能（控制面）：**
  - `src/lib/executor/contract.mjs`：事件类型、信封与摘要校验，以及 `KIN_EXECUTOR_EVENTS` 开关解析。
    - 与 Worker 共用夹具 `test/fixtures/executor-contract/events.json`，两边各有一致性测试。
  - `src/lib/executor/event-ingest.mjs`：按（实例, 事件流）游标拉取，校验后按事件 ID 去重写入收件箱，处理后向 Worker 确认，挂在 Gateway 对账循环上。
    - `off`（默认）：不拉取。
    - `shadow`：`request.finalized` 与回执 `payload_hash` 比对，`probe.recorded` 与探测记录比对；回执晚到时复查，10 分钟仍缺记为 `missing`。不改变业务数据。
    - `primary`：经与旧通道相同的写入函数生效（回执入库与对账、`recordRuntimeCredentials` 与 BPS 403 移组、`recordRuntimeQuotas`、`recordBpsProbes`），并确认清理 Worker 旧回执。心跳中的同类字段不再写入，回执重放保留为幂等兜底。
    - 处理失败不推进游标；信封无效记为 `failed` 并停止该实例。
  - 迁移 `100_executor_events.sql`：表 `executor_event_cursors`、`executor_event_inbox`（保留 7 天）。
  - `scripts/executor-replay-diff.mjs`：只读比对事件与回执的计费字段（终态、发送状态、上游状态与模型、账号、用量与置信度），有差异时退出码 1，作为切换 `primary` 前的验收工具。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。上游文件只改 `test/unit/database.test.mjs` 的迁移清单（+2 行），这是计划 2.7 写明的固定例外。
- **破坏性变更 / 接口 / 配置 / 迁移：**
  - 新增 Worker 内部接口 `/internal/v1/events`、`/internal/v1/events/ack`；
  - 新增控制面环境变量 `KIN_EXECUTOR_EVENTS`（默认 `off`，行为与改动前一致）；
  - 新增迁移 100；
  - Worker 新增数据目录 `events/`。
  - 行为变化（经 R1 审查修正，见下一节）：只有控制面消费事件时，事件日志不可写或积压超限才让 Worker 拒绝新请求；默认 `off` 下 Worker 自行确认，不拒单。
- **升级指南与限制：**
  - 部署后先设 `KIN_EXECUTOR_EVENTS=shadow` 观察，用比对脚本确认零差异后再切 `primary`。具体步骤见 `docs/CODEX_GATEWAY_WORKER_SETUP.md` 第 8 节。本轮未部署。
  - 删除回执接口与心跳重复字段（P1.10）需要生产以 `primary` 观察一个发布周期后再授权。
- **验证：**
  - Go：gofmt、vet、`go test -race ./internal/...` 全部通过，linux/amd64、linux/arm64、darwin/arm64 交叉编译通过。新增用例覆盖：
    - 事件日志：追加、读取、确认、重开、崩溃截断、篡改检测、分段轮转与清理、并发顺序、故障与积压；
    - 接口：分页、确认幂等、流变化、未签名拒绝；
    - 产生点：`request.finalized` 与回执一致，状态快照只在变化时产生；
    - 事件日志故障时拒绝请求且不触达上游；
    - 夹具一致性。
  - Node：新增契约、接收器（off、shadow 的匹配、晚到、缺失与差异，primary 生效与重复不重处理，流切换、失败重试、无效信封）与比对脚本测试。全量 428 个隔离文件只有本机已知的 4 个环境失败（`egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status`）。
  - e2e：
    - 真实 Worker 链路在 off、shadow、primary 三种模式下各跑一遍，全部通过：shadow 下全部 `matched`，primary 下全部 `applied`，回执与使用记录一致。
    - BPS、运营端与供应商账号 e2e 在 shadow 与 primary 下也通过。

## 2026-11-05 统一控制面重构启动：开发计划、进度台账、上游改动预算工具；设计补充上游同步约束

- **需求：** 用户要求按“统一控制面 + Claude / Codex 执行服务”设计最终交付程序代码。重构周期长，需要能跨会话、跨断线续接，不遗漏任务，并在每个阶段完成后由独立子智能体审查。
- **新增：**
  - `docs/control-plane/DEVELOPMENT_PLAN.md`：开发计划，包括：
    - 续接流程，依靠本机进度日志、进度台账、记忆指针与持久检出四样；
    - 硬约束、单任务流程、验证矩阵、阶段审查门与审查清单、上游改动预算；
    - P0–P7 与 PF 的逐项任务与完成标准，以及需要用户授权的节点和风险。
  - `docs/control-plane/PROGRESS.md`：进度台账，是已交付状态的唯一权威。
  - `scripts/upstream-touch-budget.mjs`（附单测）：统计改动中落在上游基线已有文件上的部分及行数，每次交付记入台账。
- **设计修订（`ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md`）：**
  - 新增 15.1“保持可同步的硬约束”：上游代码不搬家只加接入点；数据库跟随上游；设置只迁本地键；Claude 物理拆分默认不做；上游改动预算。
  - D8 由“以 PostgreSQL + Redis 为目标”改为“数据库跟随上游，跨实例运行态用 Redis”。
  - 第 16 节改为阶段概要，详细内容指向开发计划。
  - 其余章节中的数据库表述同步调整。
- **接口 / 配置 / 迁移 / 破坏性变更：** 无；不改运行行为。
- **验证：** `upstream-touch-budget` 单测通过；脚本在本次改动上输出“上游文件 0 个”；人为改动 `src/server.mjs` 时能正确计入。

## 2026-11-05 规划文档：统一控制面与 Claude / Codex 执行服务分离

- **需求：** 用户确认 Claude 与 Codex 的执行分开，入口（Key 鉴权、额度与余额预检、计费、界面、供应商权限）与控制（账号、凭据、BPS、设置、模型目录、调度策略、请求记录）统一在一套系统里，要求写成详细设计文档。
- **新增文档：** `docs/ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md`。它建立在 `ARCHITECTURE_TARGET_20261102.md`（PostgreSQL + Redis）之上，内容包括：
  - 决策与不采用的方案；
  - Codex（Gateway Worker）与 Claude（VM 槽位、API 端点）现状盘点与差距；
  - 目标拓扑与模块职责；
  - 数据所有权：业务与控制事实归控制面，执行服务只持有可重建状态；
  - 执行契约 v1：传输安全、注册与能力、投影与凭据封装、执行信封与统一结果、管理动作与设置描述、事件发件箱、健康与排空、错误分类；
  - 凭据刷新租约与版本写回；调度与跨实例运行态；协议状态共享；单一请求账本与计费口径；设置发布；界面与管理流程；
  - Claude 先以进程内适配器接入（槽位凭据保留槽内托管）；
  - 故障降级、安全、上游同步策略；Phase 0–6 实施路线、整体验收标准、待决定事项，以及现有内部接口到契约的映射。
  - `docs/README.md` 同步索引。
- **上游取舍 / 接口 / 配置 / 迁移：** 只新增文档，不改代码、接口、配置或数据库；本文不授权实施、部署或数据迁移，各阶段开工前另行确认。

## 2026-11-05 补入两份计划文档：PostgreSQL 迁移方案、主线程减负第二三阶段

- **内容：** 将 2026-11-03 编写、此前一直未纳入版本库的两份计划文档原样提交：`docs/POSTGRESQL_MIGRATION_PLAN_20261103.md`（SQLite → PostgreSQL 迁移实施方案）与 `docs/performance/process-split-plan.md`（网关主线程减负第二、三阶段计划）。后者已被“网关主线程减负：代理探测不再同步 fork `ss`”条目引用，补入后该引用不再指向缺失文件。`docs/README.md` 文档目录同步登记。
- **限制：** 两份均为“计划，未实施”，文中基线 SHA 为编写当时的值，不代表当前 main；不授权生产部署、数据迁移或发版。PostgreSQL 迁移是否启动仍需用户按文中第 9 节决定。
- **接口 / 配置 / 迁移 / 破坏性变更：** 无，仅文档。**验证：** 核对文内相对链接（`ARCHITECTURE_TARGET_20261102.md`、`performance/process-split-plan.md`）目标存在；无密钥、生产地址或跨仓库 issue / PR 引用；没有行为变化，未运行业务测试。

## 2026-11-05 使用记录：平台与分组级联约束全部下拉；恢复「上游模型审计」筛选；超管新增「端点」（入站 / 上游）与「类型」（WS / 流式 / 非流式）列

- **需求：** ① 平台与分组联动完善：选平台后，模型、分组、上游账号、槽位都只列该平台的；选分组后，模型只列分组支持的，上游账号、槽位只列该分组的；两者可叠加。② 筛选条件恢复「上游模型审计」。③ 超级管理员使用记录增加「端点」列（入站路径 / 上游路径）与「类型」列（WS / 流式 / 非流式）。
- **新增功能：**
  - **级联筛选**：`filter-options` 的 `groups[]` 增加 `platform`（anthropic / openai / mixed）与 `models`（分组模型白名单，空表示不限）；`accounts[]`、`vms[]` 增加 `groupIds`，`vms[]` 增加 `platform`。分组资源按 `group_resources` 归属：槽位直接归属；上游 API 下全部子 Key 归属该 API 的分组；Gateway 运行账号按绑定的账号资源归属；账号表行按所在槽位归属。前端 `linkage.ts`：平台约束分组（含 mixed 分组）、模型、上游账号、槽位；分组约束模型（有白名单按白名单，否则按分组平台，mixed 不限）、上游账号、槽位；切换平台或分组时清掉已落在范围外的分组/模型/账号/槽位，不在选项里的深链值保留交给后端。
  - **槽位平台**：读库 worker 解不开加密的 `vm_json`，控制面路由按已解密槽位注册表（`normalizeVmKind`）算出「槽位 → 平台」随请求传入（`vm_platforms`，只含 ID 与平台）。平台判定改为槽位账号按槽位平台、槽位 ID 本身也作账号 ID 归类。修正：生产 Codex 槽位 `codex-cn-01` 在 accounts 表上 `platform='claude'`，此前平台筛选会把它的记录归到 Anthropic。
  - **端点 / 类型列**：迁移 `099_usage_logs_endpoint_transport` 新增 `inbound_transport`、`upstream_path`、`upstream_transport`。入站方式：Responses WebSocket 构造协议请求时标记 `req.inboundTransport='websocket'`，请求日志据此落库，其余为 http。上游路径在实际发出请求处写入（只存 pathname，丢弃主机与查询串）：VM Claude 槽位执行过即 `/v1/messages`（HTTP）；API 端点取所配基址拼出的 URL；Codex 槽位 Responses 为 `/backend-api/codex/responses`，搜索 / 图片取对应端点（HTTP）；Gateway Worker 新增响应头 `X-Kin-Gateway-Upstream-Path` / `X-Kin-Gateway-Upstream-Transport` 回报最终承接尝试的路径（原生 `/backend-api/codex/responses`、BPS `/basispoints/api/responses`）与传输方式（上游 WS 成功为 websocket，回退 HTTP 为 http），失败响应只回报路径。前端「端点」列两行显示入站 / 上游，上游经 WebSocket 加 WS 标记；「类型」列入站 WS 为 WS，否则按流式标记显示流式 / 非流式。两列及上游字段仅超级管理员可见（公开投影屏蔽 `upstream_path` / `upstream_transport`）。
- **恢复：** 「上游模型审计 · 仅显示不一致」筛选（超级管理员）：`model_mismatch=1` 查询参数、`buildFilter` 谓词（旧 Codex 出站模型不算观测到的不一致）、URL `mismatch`、草稿字段与角色剥离、已激活标签与计数、四语种文案（`upstreamModelAudit`、`onlyMismatches`、`modelMismatch`、`enabled`）及测试断言；开关并入状态筛选行并与同行控件等高。
- **Bug 修复：** 见上「槽位平台」：Codex 槽位记录的平台归类。
- **破坏性变更：** `filter-options` 的 `groups[]`、`accounts[]`、`vms[]` 增加字段（只增不减，仅本面板调用）。无其他接口删除。
- **升级指南与限制：** 部署控制面（含 Gateway Worker 镜像）与面板后生效；迁移 099 只加列，历史行三列为 NULL，「端点」上游显示「-」、「类型」按流式标记。旧版 Worker 不回报上游头时 Gateway 行上游为空。Codex 槽位 Responses 经内核按路由选 WS/HTTP，传输方式不可知，上游 WS 标记只覆盖 Gateway Worker。分组/槽位归属按当前资源配置，不按历史；本轮未部署。
- **上游取舍：** 上游 `dofastted/vm2api`（`6a8f9c7f`）无此页面的级联筛选与端点/类型列，本轮为用户明确需求的定制差异；Gateway Worker 只新增两个回报头，不改调度与转发。移除条件：上游提供等效展示与筛选时改用上游。
- **清理：** `platform.ts` 的 `withPlatform` 被 `linkage.ts` 的 `scopeFilterOptions` / `reconcileFilters` 取代并删除。代码量（本轮相对上一交付）：业务 +615 / −88（净 +527），测试 +368 / −41（净 +327），含新增迁移 099、`endpoint-cells.tsx`、`linkage.ts`、e2e `usage-log-endpoint`，删除 `platform.ts`。
- **验证：** 后端：`usage-logs-view` 新增分组平台/白名单、账号与槽位分组归属、槽位平台修正 Codex 误标的用例，恢复模型不一致筛选断言，新增端点/传输 DTO 用例；`request-log` 覆盖入站 WS 与带凭据 URL 只存路径；`gateway-codex-dispatch` 覆盖 Worker 回报头与非法值；`api-backend` 覆盖 API 端点路径；`database` 迁移清单；e2e `usage-log-endpoint`（模拟槽位真实请求落库 http / `/v1/messages`）与 `usage-log-filters`（含分组新字段、越权 `model_mismatch` 被忽略）通过。Go：`codexgateway` 包测试通过，BPS 用例断言 `/bps/responses` + http、BPS 转原生断言原生路径、WS 恢复断言 websocket、回退 HTTP 断言 http。前端全量 vitest、`tsc -b`、Prettier/Biome/gofmt 通过；`filter-policy` 新增平台/分组级联与清理用例，`role-columns` 断言两列仅超管可见。浏览器实测（隔离检出 + harness 网关 + 分组/上游 API/Codex 与 Claude 槽位样本）：选 Anthropic 时分组只剩 Claude · API 与 mixed 的 KDAN、模型只剩 claude、账号与槽位排除 Codex/OpenAI；分组 Claude · API 时模型只剩白名单 opus/sonnet；分组 OpenAI 时账号只剩 Codex 槽位账号与 OpenAI API Key；KDAN 下选 claude-haiku 与 sim-01 后切到 OpenAI 两者被清空；上游模型审计开启后只剩 1 条不一致记录；端点/类型列显示 `/v1/messages`、`/basispoints/api/responses`、上游 WS 标记与入站 WS。后端全量单测见交付报告。

## 2026-11-05 BPS 对照 sub2api 与 codex2api 全部补齐：续接、图片策略与端点、细粒度失败处置、历史来源锁定、运维与导入导出

- **需求：** 复核 BPS 与定制版 NewAPI（sub2api）的 17 项差距和 hloolx/codex2api 的 4 项 BPS 应用层能力后，用户要求“全部补齐”。
- **新增功能 / 优化改进（Worker）：**
  - **历史来源锁定**（对齐 codex2api）：每个已交付响应的 response id 与输出密文摘要按调用方范围记录来源通道（只存 SHA-256，24 小时、最多 20 万条，加密落盘 `route_provenance.json`）。
    - 历史来自 BPS 只走 BPS，BPS 不可用时直接失败；来自原生不走 BPS；混合返回 400 `codex_route_history_conflict`。
    - 带密文但来源未知时保持首选通道，BPS 失败后不转原生。
    - sub2api 的“原生 WS 续接切换到 BPS”被这一机制取代（原生产生的历史留在原生）。
  - **续接**：BPS 响应完整交付后按 response id 保存“本轮完整输入 + 交付的输出项”快照（2 小时，与工具回放共用 BPS 状态存储）。下一轮 HTTP 或 WS 带 `previous_response_id` 时，在产生它的账号上展开为完整历史；查不到快照沿用原有续接逻辑。
  - **compact**：新增 `POST /v1/responses/compact`（及 `/responses/compact`），转为带 `compaction_trigger` 的普通 Responses 请求，返回 `response.compaction`，原生与 BPS 通道都可用。Responses WS 在 15 秒无数据时发送 `keepalive`。
  - **图片策略**（「设置 → OpenAI → BPS → 图片策略」，`routing.codex.bps_images`）：
    - 自动压缩历史（默认）：超过张数或合计大小上限时，在同一账号上先把可分离的历史压缩成 BPS compaction 状态，再用“压缩窗口 + 新输入”生成；压缩窗口作为输出前缀交给 Codex，检查点记在会话状态里。只对官方 Codex 客户端开启，其他客户端超限改走原生。
    - 仅提醒：接近上限提醒一次，超限要求先 compact。关闭：不限张数，只限大小。
    - 上限默认 20 张、单张 32 MiB、合计 64 MiB、提醒余量 8、预留 3，均可调。
    - 附件上传 429 在同一账号上按 Retry-After（限制在 1–5 秒）重试一次。
    - 无法解析的图片与非 Codex 客户端超限改走原生，不再直接报错。
  - **图片端点**：账号 BPS 名单含 `gpt-image-2` 时，`/v1/images/generations` 与 `/v1/images/edits` 先走 BPS 图片端点（编辑转 multipart，带完整 Excel 客户端身份）。
    - 只接受实测可用字段：非流式、png、opaque/auto 背景、moderation=auto，编辑须恰好一张 data URL 图片且无蒙版。
    - BPS 以 400/404/405/413/422 拒绝格式时同一请求改走原生；策略拒绝不改走原生。
  - **失败处置**：
    - 429 按上游 `error.scope`（account/bps/model/endpoint/model_endpoint）冷却对应范围，并采用 `resets_at`/`resets_in_seconds`；范围与本次模型/端点矛盾时只换号不冷却。附件端点冷却只影响带图请求。
    - code 为空的 403 “blocked by our usage policy”按账号 + 模型退避 30/60/120/240/300 秒，不停用账号；冷却期内的并发失败不延长期限；成功后清除。
    - 401 时刷新 BPS 授权并在同一账号重发一次（同一刷新令牌只用一次）。
    - 内容/网络安全拒绝投影为 400 `content_policy_violation`/`cyber_policy` 且不重放；其余 401/403 对调用方隐藏为 503 `basispoints_upstream_error`；BPS 5xx 换号。
    - `invalid_encrypted_content` 对齐 sub2api：不重试、不换号、不改账号状态，提示重发明文历史。
    - BPS 流空闲超时 120 秒（`KIN_CODEX_GATEWAY_BPS_STREAM_IDLE_SECONDS`），`generate:false` 预热不走 BPS。
  - **模型目录**：Worker 按账号代理官方 `{BPS}/responses/access?include_models=true`（10 分钟缓存，叠加模型无权冷却）。控制面保存到 `config.bps_catalog`；BPS 模型选择显示可用、受限与推理强度；`/models` 对经 BPS 的模型只声明目录给出的推理强度（多账号取交集）。
  - **计费**：BPS 流中断（截断、调用方中途断开）时，回执带协议转换累计的已消耗用量（含纠正轮），对账按此下限结算、标为 partial；明确的上游失败与原生/VM 路径仍不计量。纠正轮用量照旧并入成功请求的 usage。
  - **诊断**：BPS 尝试记录到达的阶段（prepare/images/attachments/compaction/responses/images_endpoint/stream），控制面写入请求尝试的 `stage` 列（迁移 101；`action` 只保留失败类别）。
- **新增功能 / 优化改进（控制面与前端）：**
  - BPS 分区与 BPS 对话框：
    - 状态行显示下次恢复探测时间、已停止或未开启自动恢复，以及暂停原因与冷却到期时刻。
    - 新增「手动解除停用」（同时清除 BPS 冷却）与「停止本次恢复」。
    - 「获取 BPS 可用模型」，并提示已选但不在目录中的模型。
    - 显示最近一次严格探测结果。
  - 批量编辑新增 BPS 设置：开关与恢复间隔覆盖，模型名单按追加/移除/替换合并；未授权账号单独报错；403 移组不参与批量。
  - 「导出账号文件 / 导入账号文件」（运营端）：
    - 导出含原生与 BPS 授权令牌（明文，导出前确认并记审计）、名称、备注、并发/RPM/权重、模型范围、BPS 设置与代理地址。
    - 导入时逐个新建账号、导入原生与 BPS 授权、套用 BPS 设置，分组与代理按本部署选择。
  - 「测试」可选通道（自动/只走 BPS/只走原生），修复此前测试不会走 BPS 的问题。新增「严格探测」：指定模型做工具往返，校验 nonce、实际通道与响应模型，BPS 严格探测结果记入账号 `config.bps_verification`。
  - 「设置 → OpenAI → BPS」可编辑「新增 BPS 授权时的默认设置」（`routing.codex.bps_defaults`），首次授权时套用，读取失败用内置默认。
  - Key 新增「Codex 通道策略」（`api_keys.codex_route`：自动 / 只走原生 / 只走 BPS，仅超级管理员可设）。只走 BPS 时，没有可用 BPS 账号的请求返回 503 `codex_route_basispoints_required`。
  - Gateway 账号用量对话框（运营端与供应商门户）可按实际授权方式（原生 / BPS）筛选，接口参数 `authorization_mode`。
- **上游取舍：** 官方上游没有 Gateway Worker 与 BPS，本节均为定制差异。
  - 与 sub2api 的差异：
    - 账务幂等键仍用控制面 dispatch，上游 `x-request-id` 按尝试记录（一次请求可能含压缩轮与生成轮）。
    - 账号导出导入只在运营端提供。
  - 与 codex2api 的差异：密文被拒采用 sub2api 的“不重试”，不采用 codex2api 的“去密文重试”。
- **破坏性变更 / 接口 / 配置 / 迁移：**
  - 迁移 `097_gateway_bps_recovery.sql`：绑定表新增 `bps_recovery`、`bps_next_probe_at`、`bps_cooldown_until`。
  - 迁移 `098_api_key_codex_route.sql`：`api_keys.codex_route`，NULL 等同 auto。
  - 新接口：
    - `GET /api/panel/codex-accounts/:id/bps/models`，`POST .../bps/unblock`，`POST .../bps/recovery/stop`（供应商 `/api/vendor/accounts/:id/bps/*` 同名）。
    - `POST /api/panel/codex-accounts/export`，`POST /api/panel/codex-accounts/import-file`。
    - `POST /v1/responses/compact`。
    - Worker `GET /internal/v1/accounts/{id}/credentials`、`.../bps/models`、`POST .../bps/unblock`、`.../bps/recovery/stop`。
  - 调度策略新增 `bps_images`、`route_policy`。
  - 无效图片与非 Codex 客户端图片超限由“400”改为“改走原生”。
- **升级指南与限制：**
  - 部署控制面镜像（含 Worker）并执行迁移 097、098 后自动生效；本轮未部署。
  - 历史来源与续接快照只在单个 Worker 实例内有效，不跨实例共享。
  - 真实 BPS 上游的图片压缩、图片端点、模型目录与 usage-policy 403 未在本地验证，需要部署后用真实账号验收。
  - 导出的账号文件含明文令牌，须按密钥保管。
  - 上游 codex2api 曾以“已停止服务”移除 BPS 集成，sub2api 与 hloolx 仍保留，部署后须先用一个真实账号做严格探测确认。
- **代码统计（相对当前远端 `e51493f3`，含新增未跟踪文件）：** 业务代码（含四语文案）+4050 −181（净 +3869），测试 +1294 −1（净 +1293），文档另计。
- **验证：**
  - **Go**：gofmt、`go vet`、`go test -race ./...` 全部通过；linux/amd64、linux/arm64、darwin/arm64 交叉编译通过。windows/amd64 因 `credential/store.go` 的 `syscall.Flock` 不能编译，与本轮无关，也不是发布目标。新增用例覆盖：
    - 历史来源锁定 4 项；
    - 续接快照展开并钉住原账号；
    - 图片策略的默认值、warn/off/auto_compact、非 Codex 回退原生；附件 429 重试与延迟钳制；
    - 429 范围解析 9 种；模型/端点范围冷却；usage-policy 退避与成功清除；401 刷新重发；密文被拒不重试；
    - 图片端点生成/编辑/格式回退/不可承载 6 种；模型目录解析与缓存；
    - 恢复状态上报、手动解除与停止恢复、凭据导出、Key 通道策略。
  - **Node**：全量 425 个隔离文件中 4 个失败，均为 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status`，在未改动的基线上同样失败（本机环境）。新增：
    - 图片策略与通道策略下发；
    - 模型目录保存与 `/models` 推理强度；
    - 解除/停止恢复与心跳状态；
    - 批量 BPS 设置；
    - 账号导出导入；
    - 默认设置模板；
    - 严格探测与通道测试；
    - BPS 中断下限结算；
    - 尝试阶段写入；
    - 用量按授权方式筛选。
  - **e2e**：Gateway e2e（含真实 Worker 的 BPS 用例）、Codex Key 目录与使用记录筛选共 10 项通过。
  - **Web**：`tsc -b`、Prettier、Biome 通过；vitest 119 文件 / 886 项通过；`vite build` 通过。全量 ESLint 的 10 个错误与基线相同，均在本轮未改动的文件。
  - **合并**：交付远端在本轮期间由 `5588eddc` 先后前进到 `e51493f3`（同步上游 `6a8f9c7f`、CPR schema 3、账号代理入池等）与 `12f4f82e`（Chat 转换支持 PDF、联网搜索与引用），均以前一交付为三方基准并入。`gateway-routes.mjs` 路由正则与账号管理测试冲突按两边合并，之后上述 Go、Node、Web 与 e2e 在合并后的树上重跑通过。

## 2026-11-04 Chat Completions 经 Codex 转换支持 PDF 文件、联网搜索、工具名与 URL 引用（CPR `10e25ce2` 部分采用）

- **需求与依据：** 上一轮把 CPR `10e25ce2` 列为待决定；用户确认先移植其中的内容映射，`max_output_tokens` 暂不改变。Chat→Responses 转换（`codex-convert.mjs`）由 Gateway Worker 与虚拟机 Codex 槽位共用，两条路径同时生效。
- **新增功能：**
  - user 消息的 `file` 内容块：带非空 `filename`、`file_data` 为 `data:application/pdf;base64,...` 时映射为 Responses `input_file`；`file_id` 引用、非 PDF、缺文件名或非 user 角色的文件块保持原有行为（不映射）。
  - tool 消息的非空 `name` 映射到 `function_call_output.name`。
  - `web_search_options`：`{}` 即要求上游执行 `web_search`，保留 `search_context_size`，`user_location.approximate` 展平为 Responses 的 `user_location`；同时下发 `tool_choice: {type: "web_search"}`。与非空函数 `tools` 或非 `auto` 的 `tool_choice` 同时出现、或 `user_location.type` 不是 `approximate` 时返回 400 `unsupported_parameter`（带 `param`），不静默丢弃调用方的工具。
  - 非流式 Chat 响应把 Responses 的 `url_citation` 投影到 `choices[0].message.annotations`（`{type, url_citation: {url, title, start_index, end_index}}`），多条 assistant 消息合并时按码点平移索引；起止非法的引用丢弃。流式与 CPR 一致，只保留 `delta.content` 中的行内链接。
- **未采用：** 保留 `max_output_tokens`——会改变发往官方 Codex 后端的报文，真实账号验证前继续剥离（`max_tokens` / `max_completion_tokens` 照旧不生效）；CPR 对其他非法 Chat 形状的严格拒绝，本地转换保持宽松。
- **接口 / 配置 / 迁移：** 无新增接口或配置；转换失败的 400 现带具体 `message` 与 `param`（原为固定文案）。无迁移。**破坏性变更：** 此前带 `web_search_options` 的请求会被静默忽略该字段，现在会真正发起搜索；同时带函数工具时改为 400。
- **升级指南：** 更新 Node 控制面后重启；不涉及 Worker、`web/dist` 与 payload。部署另行授权。
- **验证：** `codex-convert` 新增 5 个用例（PDF 与不映射情形、工具名、联网搜索与三种拒绝、`max_tokens` 仍剥离、引用偏移与非法引用），26/26 通过。引用 `codex-convert`、`handle-codex`、`handle-protocol` 的 35 个 Node 测试文件与同机 `e51493f3` 基线对比：候选 651 通过 5 失败、基线 646 通过 5 失败，失败集合相同（基线既有，均为需 Linux ELF 内核与 CLI 的 e2e），**无新增失败**。未用真实账号验证上游对 `input_file`、`web_search` 的接受情况。

## 2026-11-04 同步上游 `6a8f9c7f`（DSH 工具结果裁剪保护）；CPR 互联升级到 schema 3，冻结恢复探测不再回写 Cookie

- **上游同步：** 基线由 `b0f72b49` 推进到 `6a8f9c7f`（版本号仍为 1.4.038，CHANGELOG 新增内容在 Unreleased 下，不触发自动发版）。上游新增可选 `routing.compatibility.preserve_pruned_tool_results`：槽位 Claude 推理中，按认证密钥与 DSH 会话隔离保存成功请求的工具原文，DSH 默认裁剪后精确恢复原文前缀，避免小幅裁剪造成整段缓存重写；缺省关闭，API 直连端点不启用。全部采用上游（`tool-result-prune-cache.mjs`、`docs/PROTOCOL.md`）。
- **冲突与必要融合：**
  - `handle-protocol.mjs`：上游在入口挂裁剪快照的 `close` / `aborted` 回滚与 `finish` 提交，并把请求日志写在同一个 `finish` 里；本地早已把请求日志与计费改为 `installCommercialLog`（同一事务结算并写日志）。保留上游的裁剪回滚 / 提交监听，请求日志继续走 `installCommercialLog`，不再内联 `requestLog.finish`。
  - 上游新测试 `tool-result-prune-protocol.test.mjs` 夹具补 `apiKeyStore.canAccept`（本地商业 Key 只读预检，同 `forced-tool-choice` / `between-tools-ingress`）；本地自有的 `respond-sse` zstd 用例的响应夹具改为 `EventEmitter`，与上游同文件 413 用例的改法一致（入口现在会挂 `once` 监听）。上游断言均原样保留。移除条件：上游夹具改用真实 Key 记录时删掉对应差异。
- **CPR 同步（冻结 `860fb396`，盘点 `242ffb23` 之后 8 个提交）：**
  - **兼容性修复（`19ef4849`）：** CPR v3.40.0 起互联协议升到 schema 3，接入端只接受 3；本地 `/v1/cpr/link` 仍返回 2，已升级的 CPR 接入方会判为不兼容。现返回 schema 3，并新增能力 `key_limits`：该 Key 实际生效的并发与 RPM（并发取 Key 与所属用户上限中较小的正数，超级管理员不受用户上限约束；RPM 取 Key、用户、分组含用户覆盖中较小的正数；0 表示不限），与准入检查同源（`ApiKeyStore.effectiveLimits`）。CPR 接入方会把正数并发上限用作该互联账号的默认并发。
  - **Bug 修复（`6b362a50`）：** Gateway Worker 冻结到期后的恢复探测（含取探测模型目录）此前会把上游 `Set-Cookie` 写回账号；现在探测只回放已存 Cookie、不回写，解冻与否只由恢复任务按探测结果决定（`cookies.go`、`protection.go`）。
  - **已具备：** `bdfc2017`（Key 未开启共享时本地已返回 `403 peer_sharing_disabled`）；`f5c5a6e5` 的账号出口测试（Codex 账号「代理」页签已有测通 / 测地理）。
  - **待决定（未实现）：** `10e25ce2` Chat Completions 兼容扩展——本地 Chat→Responses 转换与虚拟机 Codex 槽位共用，保留 `max_output_tokens` 会改变发往官方 Codex 后端的报文；推荐先移植新增内容映射（PDF `file` 块、`web_search_options`、tool 消息 `name`、URL 引用），`max_output_tokens` 在真实账号验证前继续剥离。`f5c5a6e5` 的按代理批量分配账号属于平台代理池产品功能。
  - **不适用：** `13374e2a`（`/readyz` 依赖 PostgreSQL / Redis）、`789609dd`（发版）、`860fb396`（CPR 前端格式）。证据索引“已对齐到”推进到 `860fb396`，两项待决定保留在盘点表中，下次从其之后盘点。
- **接口 / 配置 / 迁移：** `GET /v1/cpr/link` 响应 `schema_version` 由 2 变为 3，`capabilities` 增加 `key_limits` 并带 `key_limits` 对象；新增可选路由配置 `compatibility.preserve_pruned_tool_results`（上游，默认关闭）。无迁移。
- **破坏性变更：** 只支持 schema 2 的旧版 CPR 接入方会把本实例判为不兼容（与 CPR 自身的升级要求一致，两端需同时支持 schema 3）。
- **升级指南：** 更新 Node 控制面、`web/dist` 与 Worker 二进制后重启；不必 `wrap-cli/sync`，不必换 payload；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。互联接入方需为 CPR v3.40.0 及以上。部署另行授权。
- **验证：** Go 全量 `-race` 通过；新增恢复探测 Cookie 测试，去掉修复后失败、恢复后通过。`cpr-peer-link` 新增 schema 3 / `key_limits` 与生效上限（Key、用户、超级管理员）用例，`api-keys` 原用例通过。Node 全量 unit（424 文件）与同机 `05e8e183` 基线（422 文件）对比：失败集合完全相同（6 项，均为 macOS 缺 Linux 环境的既有失败），**无新增失败**；新增的上游裁剪缓存与协议测试 74 项通过。本次没有 Web 改动，Web 类型检查通过。

## 2026-11-04 Codex 账号粘贴的代理加入代理池；Codex 账号详情页增加「代理」页签（健康、测通、测地理、换绑）

- **问题：** 「资源管理 → Codex 账号 → 新建账号」的代理框写着“粘贴的代理会保存到你自己的 IP 代理列表并绑定此账号”，但 Gateway 账号路径只把地址加密存进账号自身（`proxy_id` 置空），从未写入平台代理池 `proxies`，所以「设置 → SOCKS5」代理池里看不到它；列表代理标签显示「未测」，没有健康、延迟和出口地理，也没有定时探测。这句文案原属供应商表单（供应商路径确实写入供应商自己的代理资源），Codex 表单复用组件时把文案一并带过来了。Codex 账号详情页也没有虚拟机（Claude 槽位）那样的「代理」页签，无法查看绑定、测通、测地理或换绑。
- **Bug 修复：** 平台自有 Codex 账号（`vendor_id` 为空）新建或编辑时粘贴的 SOCKS5 地址，经代理池 `ensureSocks` 按主机、端口、账号密码去重写入平台代理池（打上 `openai` 平台标签），账号改为按 `proxy_id` 绑定该行；出站 `proxy_url` 与此前相同（`socks5h://…`）。同一地址再次粘贴复用同一行；池里已停用的同一代理返回 `proxy_unavailable`（“此代理已在代理池中停用，请先在代理池启用”），不再静默绕过；属于供应商的同地址代理行不收编，账号仍按原方式保存地址。先按原规则完整校验再写池，校验失败（如未选分组）不会留下代理池记录。批量编辑沿用单账号更新路径。供应商账号粘贴的代理行为不变（只存账号自身）。
- **新增功能：**
  - Codex 账号详情页新增「代理」页签，复用虚拟机详情页同一张卡片：健康环、绑定 ID、代理名称、地址、状态、延迟、认证、出口地理，以及「测通」（`POST /api/panel/proxies/:id/probe`）、「测地理」（`POST /api/panel/proxies/:id/geo`）、「设置里管理池」和换绑（从平台代理池启用、非本机出口、非供应商的代理中选择，`PATCH /api/panel/codex-accounts/:id` 提交 `proxy_id`）。Gateway 账号必须有出站代理，所以不提供「解绑」和「分配空闲出口」；出口时区不与槽位时区对比。
  - 旧账号的池外手填代理在该页签显示提示和「加入代理池」按钮：新接口 `POST /api/panel/codex-accounts/:id/pool-proxy` 读出账号已存的完整代理地址（含账密），按上面的规则写入代理池并绑定；已绑池内代理时直接返回；供应商账号返回 403，地址属于供应商代理行返回 409。仅超级管理员可用（与其他 Codex 账号接口相同）。
  - 新建 / 编辑对话框的代理说明改为“粘贴的代理会加入代理池并绑定此账号，可在代理页签测通与测地理”；供应商账号显示“只保存为此账号的出站代理，不加入平台代理池”。`AccountProxyInput` 新增可选 `help`，供应商表单仍用原文案。
- **实现：** `GatewayAccountManagement.poolPastedProxy` 在 `createDraft` 与 `update` 中、`normalize` 之前把 `proxy_endpoint` 换成池内 `proxy_id`；`poolInlineProxy` 对应新接口。前端新增 `web/src/features/gateway-worker/account-proxy-tab.tsx`；`VmProxyTab` 新增可选 `description`、`health`（`null` 时不画健康环，池外地址没有可测记录）、`compareTimezone`、`notice`，`onUnbind` / `onAllocate` 改为可选，虚拟机详情页传参不变、显示不变。新增四语文案 `common.codexInlineProxyHelp`、`codexInlineProxyVendorHelp`、`codexProxyDescription`、`codexProxyNotPooled`、`codexPoolProxy`、`codexProxyPooled`。
- **上游取舍：** 官方上游没有 Gateway Worker，本节为定制差异；写池复用上游代理池的 `ensureSocks` / `findSocks` / `addPlatform`，页签复用上游虚拟机详情页的 `VmProxyTab`，未新增代理存储或探测实现。
- **破坏性变更：** 无。**配置 / 迁移：** 无新增配置，无数据库迁移。新增接口 1 个（`POST /api/panel/codex-accounts/:id/pool-proxy`）。
- **升级指南与限制：** 部署控制面与前端后生效；本轮未部署。**不自动迁移存量数据**：已有的池外手填代理保持原样，需在账号详情「代理」页签点「加入代理池」，或在编辑对话框重新粘贴；加入后才有健康、延迟、出口地理和定时探测。代理池的「已绑定」计数只统计虚拟机槽位，Gateway 账号按 `proxy_id` 引用代理行，不占用槽位绑定名额，也不计入该计数。在代理池里修改代理的账号密码不会同步到已绑定的 Gateway 账号（与此前选择池内代理的行为相同），需在账号上重新选择一次。
- **代码量（本轮相对上一交付 `e33403ac`）：** 业务 +297 / −40（净 +257，含新文件 `account-proxy-tab.tsx` 177 行），四语文案 +24，测试 +103 / −0。
- **验证：** `gateway-account-management` 新增回归：粘贴地址写入平台代理池（`openai` 标签）并按 `proxy_id` 绑定、出站 `proxy_url` 保留账密；同一地址复用同一行；校验失败不留池记录；池内停用返回 `proxy_unavailable`；池外旧地址经 `poolInlineProxy` 加入代理池且账密不变、重复调用幂等。`gateway-*`、`proxy-pool-import`、`vendor*` 共 185 项通过，修改文件 Biome 通过。前端 `account-detail` 新增用例：池内代理页签显示说明、测通与延迟且无解绑按钮，池外地址显示提示与「加入代理池」且无测通按钮；`gateway-worker`、`vm`、`vendor`、`i18n` vitest 294 项、`tsc -b`、修改文件 ESLint / Prettier 通过。以上均在 `e33403ac` 的隔离检出中执行；未连接真实代理或 Worker。
- **补充修复（2026-11-05）：** 浏览器实测发现池外手填地址的「认证」一栏显示「无」，而这类地址实际可能带账密（Gateway 账号只存 `协议//主机`，不知道有没有账密）。`VmProxyTab` 在 `has_auth` 缺失时改为显示「—」；池内代理（虚拟机与 Gateway 账号）仍按 `has_auth` 显示「有 / 无」。`account-detail` 用例增加断言，去掉修复后失败、恢复后通过。代码量：业务 +6 / −3，测试 +2 / −0。
- **浏览器实测（2026-11-05，`341ad52a` 隔离检出 + e2e 网关夹具 + 假 Worker，本机临时数据）：** 新建账号对话框显示新说明，粘贴 `host:port:user:pass` 并生成授权链接后代理池出现该代理（`openai` 标签、有认证）；模拟的旧账号池外地址在「代理」页签显示提示与「加入代理池」，点击后得到池内绑定 ID，认证显示「有」，出现「测通 / 测地理」；对不可达地址测通得到「失败 / 8005ms」，健康分降到 42；从池中换绑后账号 `proxy_id` 随之更新并提示「已绑定」；虚拟机详情的代理页签仍显示解绑与分配空闲出口，行为不变。

## 2026-11-04 使用记录增加「平台」筛选并与上游账号、模型联动；供应商列显示上游 API 名称；删除 Session ID / 端点 / 协议 / Debug 采样筛选

- **需求：** 使用记录筛选增加「平台」，选择后「上游账号」「模型」下拉只列该平台的选项；列表「供应商」列对上游 API 行显示上游 API 名称而不是子 Key ID（`ek_…`）；按截图删除筛选表单里的 Session ID、上游模型审计（仅显示不一致）、端点、协议与 Debug 采样（仅调试记录）。上游模型审计已按 2026-11-05 需求恢复（见上方条目），下文清理与破坏性变更按恢复后的实际差异记录。
- **新增功能：**
  - 筛选 `platform=anthropic|openai`，所有角色可用。一行的平台：命中已知上游账号时按账号平台（账号表 `platform`、上游 API 子 Key 按接口协议、Gateway Worker 运行账号固定 OpenAI，含已删除账号）；未路由或账号未登记（如槽位 ID）时按模型（与价格目录 `platformOfModel` 同口径，读库连接注册确定性 SQL 函数 `usage_model_platform`）；模型也无法识别时按入站协议族。生产只读核对：`openai.chat` 入站会落到 Claude 账号，不能只按协议判平台。
  - `filter-options`：`accounts[]` 增加 `platform`，超级管理员的账号选项加入上游 API 子 Key（同名子 Key 补 ` · <ID>` 区分）；`models` 改为 `{ id, platform }[]`。前端选择平台时过滤两个下拉，并清掉已知属于其他平台的已选账号/模型（深链带来的未知值保留）；已激活标签、页面摘要显示平台。
- **Bug 修复：** 上游 API 行的供应商名称（列表、导出、详情供应商链）原先回落为子 Key ID，现解析为所属上游 API 名称。
- **Bug 修复：** 筛选表单里基于 Radix Select 的控件（平台、状态码、错误类）比同行搜索下拉高出 8px：Select 附带的隐藏原生 `<select>` 吃到 `space-y-2` 的上边距撑高单元格，在网格底对齐下把控件顶上去。三处给 Select 包一层容器，两行控件顶边一致。
- **清理：**
  - 删除筛选表单的 Session ID 输入及其专属的 `GET /api/panel/usage-logs/session-suggestions`（路由、读池白名单、能力策略、`UsageLogsView.sessionSuggestions`、前端查询与 query key、类型、单测/路由覆盖/e2e 用例）。**保留**：`sessionId` URL 参数与后端 `session_id` 过滤，调用方为统计页实时会话面板与日志详情「查看该会话」深链；深链生效时仍以已激活标签展示并可移除。
  - 删除端点（`endpoint`）、协议（`protocol`）、Debug 采样（`log_mode=debug`）三项筛选的前后端整条链路：表单组件（`request-filters.tsx` 整文件删除，`OptionSelect` 并入身份筛选）、URL 参数、草稿字段、角色剥离、后端契约与查询串、`usageLogFilters` 解析、`buildFilter` 谓词、`filter-options` 的 `endpoints` / `protocols`、已激活标签与计数、四语种文案（`debugSampling`、`searchSessionId`、`noMatchingSessions`、`allEndpoints`、`allProtocols`、`debugOnly`、`endpointFilter`）及对应测试断言（`endpoint` 文案键 2026-11-05 作为「端点」列名重新使用）。行内「模型不一致」「调试采样」徽标与详情字段不属于筛选，保留不变；`usage_logs` 列与历史数据不动。
  - 代码量（本轮相对上一交付）：业务 +258 / −418（净 −160），测试 +136 / −58（净 +78），含新增 `web/src/features/logs/filters/platform.ts`（2026-11-05 扩展为平台 + 分组级联并改名 `linkage.ts`）。
- **上游取舍：** 上游 `dofastted/vm2api` 最新 main（`b0f72b49`）的使用记录筛选同属本地定制页面，上游无平台筛选与上游 API 名称解析；本轮为用户明确需求的定制差异。移除条件：上游提供等效平台筛选与名称解析时改用上游。
- **破坏性变更：** 面板接口 `/api/panel/usage-logs*` 与 `/api/panel/request-logs/export` 不再识别 `endpoint`、`protocol`、`log_mode` 查询参数（被忽略）；`/api/panel/usage-logs/session-suggestions` 返回 404；`filter-options` 的 `models` 形状变为对象数组且不再返回 `endpoints` / `protocols`。均只有本面板调用。旧书签里的 `endpoint` / `protocol` / `debug` 参数被忽略。
- **升级指南与限制：** 部署控制面与面板后生效，无迁移；本轮未部署。未登记平台的槽位账号行按模型判定；平台筛选的计数/汇总需逐行计算平台，大时间范围下比单列等值筛选慢。
- **验证：** `usage-logs-view` 新增用例覆盖上游 API 名称、按账号/模型/协议三级判定平台、`filter-options` 平台字段与同名子 Key 区分；`request-logs-export`、`panel-route-coverage`、`usage-log-filters` e2e 随删除项更新并通过（e2e 增加按协议族兜底的平台筛选断言）；前端 `filter-policy` 新增平台联动清理用例并断言已删控件不再渲染；前端全量 vitest、`tsc -b`、修改文件 Prettier/Biome 通过。浏览器实测（隔离检出 + e2e harness 网关 + 上游 API/账号/无路由混合样本）：选 OpenAI 时上游账号只剩两把 OpenAI API Key、模型只剩 gpt 系列，列表 3 条；切到 Anthropic 时已选的 OpenAI 账号被清空，列表 3 条（含 `openai.chat` 入站落到 Claude 账号的一条）；供应商列显示 `claude-cc-7` / `OpenAI API Key`；已删控件不再出现，两行控件对齐。`web/src/features/logs/index.tsx` 中 `./model` 重复导入的 ESLint 报错为既有问题，本轮未改动。

## 2026-11-04 Gateway（Codex Worker）账号在列表与详情卡显示订阅到期

- **问题：** 「资源管理 → Codex 账号」列表里 Gateway 账号一律显示「订阅 未知」，点开详情卡也没有订阅到期。VM 槽位从 id_token 的 `chatgpt_subscription_active_until` 和 `accounts/check` 取到期，Gateway 账号的凭据只存在 Worker。Worker 已有 `GET /internal/v1/accounts/{id}/subscription`（读 ChatGPT `/backend-api/subscriptions` 的 `active_until`），但只有「完整页面」的个人资料面板实时调用，结果没有保存；`gatewayAccountAsVm` 只映射了套餐，没有映射订阅到期。
- **新增功能 / 优化改进：**
  - 控制面在 Worker 查到订阅后，把 `expires_at`、`will_renew`、`billing_period`、`checked_at` 写入账号 `config_json.subscription`（`GatewayWorkerRepo.recordAccountSubscription`），不改 `updated_at`（列表按它排序），也不进入投影到 Worker 的配置与指纹。写回发生在三处：完整页面查询 `GET /api/panel/codex-accounts/:id/subscription`；授权或重新授权完成后在后台查一次，不阻塞授权结果；控制面启动 60 秒后开始每小时补查一次，每次逐个查询未归档、有 Worker 绑定且从未查到或上次查到已超过 12 小时的账号。查不到的账号（BPS、上游失败）在当前进程内 6 小时后再试，并保留上次的值。
  - 重新授权的 ChatGPT 账号（`chatgpt_account_id`）与原来相同时保留已存订阅；换成另一个账号时清空，再重新查询。
  - 前端：`gatewayAccountAsVm` 把 `config.subscription.expires_at` 映射为 `chatgpt_subscription_active_until`，列表沿用 VM 的「订阅 日期 · Nd」显示（不足 7 天提示、已过期标红）；GPT 账号详情卡「账号」区在「过期」（access token 到期）下面新增「订阅到期」行，VM 与 Gateway 账号都显示。供应商 / 运营账号池的 Gateway 行 `subscription_expires_at`、`subscription_will_renew` 也改读这份数据。
- **上游取舍：** 官方上游没有 Gateway Worker，本节为定制差异；复用 Worker 已对齐 CPR 的订阅接口和 VM 的订阅展示组件，不新增上游请求类型或展示组件。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无新增接口、配置或迁移；`GET /api/panel/codex-accounts` 的账号 `config` 多一个可选字段 `subscription`。
- **升级指南与限制：** 部署控制面与前端后自动生效，本轮未部署。部署后约 1 分钟开始补查，已有账号逐个获得订阅到期。每个账号每 12 小时最多经自己的代理查一次 `/backend-api/subscriptions`。详情卡「过期」行显示的是 access token 到期，Gateway 账号的 token 到期仍只保存在 Worker，所以该行继续显示「—」，本轮没有改。
- **验证：** `gateway-account-management` 新增回归：查询结果写回账号且不改 `updated_at`、不进入投影配置；未到 12 小时不补查；失败时保留旧值，6 小时内不重试，之后重试成功并更新；同一 ChatGPT 账号重新授权保留，换账号后清空。Gateway 单测 8 个文件，加上 `vendor-portal-view`、`vendor-review`，共 117 项通过；`gateway-operator-accounts`、`gateway-vendor-accounts` e2e 4 项通过（确认授权后的后台查询不会阻塞或报错）。前端 `accounts-model` 新增映射用例，`gateway-worker`、`vm`、`subscription-expiry` vitest 210 项通过；`tsc -p tsconfig.app.json`、修改文件 eslint / prettier / Biome 通过。未在真实面板中点验，也没有连接真实 Worker 上游。

## 2026-11-04 上游 API 地址新建 / 编辑改为居中弹窗，key 代理改从代理池选择，可逐把测试

- **新增功能 / 优化改进：** 「上游 API」页「添加地址」「编辑」由右侧抽屉改为与「新建账号」一致的居中弹窗（`max-h-[90vh]`、`sm:max-w-3xl`），修复正文无内边距、贴边的问题；基本信息按两栏/三栏排布，「关闭 429 冷却」补说明，请求头 JSON 收进默认折叠的「高级」（已配置请求头时默认展开）；模型表加列头（上游模型 / 对外名称 / 图片 / 思考级别），删除改为图标按钮，小屏每行分组显示。
- **key 与代理：** 代理不再手填 `socks5://`，改为从代理池选择（直连 / 池内代理，排除没有可转发地址的本地出口），新建地址、追加 key 均提交 `proxy_id`，由服务端解析；已有 key 行显示脱敏 key、当前代理，可直接切换代理（立即保存）。只存了手填 `proxy_url`、没有 `proxy_id` 的旧 key 显示「已存代理地址」并原样沿用，直到重新选择。追加 key 改走已有权限校验的 `PATCH /api/panel/api-endpoints/:id`（`api_key` + `proxy_id`）；上游原有的 `POST …/keys` 路由保留不动。
- **测试：** Anthropic 协议地址的每把已存 key 及待添加的新 key 都有「测试」按钮，复用控制台接口 `POST /api/panel/anthropic/messages`（用模型表第一个上游模型、`max_tokens` 16、消息 `Hi`），结果就地显示「可用/不可用 · HTTP 状态 · 经代理/直连」及上游回复或报错；OpenAI 协议地址不显示。
- **Bug 修复：** 控制台用已存 key 测试时，若 key 只有手填 `proxy_url` 没有 `proxy_id`，此前按直连发出，与实际转发不一致；现沿用已存 `proxy_url`，调用方显式选择代理或直连时仍以选择为准。「Anthropic 控制台」改用同一个代理池选择器，旧手填代理同样显示「已存代理地址」，保存/测试时不改动。
- **清理：** 删除编辑弹窗的手填代理输入及文案 `apiEndpoints:proxyPlaceholder`、`apiEndpoints:upstreamName`，控制台内联的代理弹层及 `anthropic:proxyUnavailable`；新增共用组件 `web/src/features/proxies/proxy-picker.tsx`。为降低同步成本，组件文件名与导出名仍沿用上游的 `endpoint-detail-sheet.tsx` / `EndpointDetailSheet`。
- **破坏性变更 / 配置 / 迁移：** 无；不改动已存数据，旧手填代理继续生效。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。测试按钮只发最简请求，不带 Claude Code 的 beta / system，结果可能与客户端实际请求不同（如 `sk-ant-usr-` key 带 Claude Code 入口标记时的计费问题，转发侧已另行处理）。
- **验证：** 前端 `tsc -b`、修改文件 eslint/prettier、`api-endpoints`/`anthropic`/`proxies`/`i18n` vitest 54 项通过；后端 `anthropic-console`、`api-backend` 52 项通过，新增回归：已存 key 只有 `proxy_url` 时测试沿用该代理、显式直连仍直连；控制台载入旧代理不发送 `proxy_id`。本地起控制面（临时数据目录、mock 内核）在浏览器实际操作：编辑弹窗切换 key 代理并落库、测试结果显示、追加 key、新建地址保存 `proxy_id`、手机宽度布局；未连真实上游。

## 2026-11-04 Codex 经「OpenAI 官方」API Key 端点调用不再丢失工具历史、反复空转无输出

- **问题（生产只读核查）：** 平台 API 端点「OpenAI API Key」（类型 OpenAI 官方，`https://api.openai.com`）承接 Codex Desktop（`0.166.0-alpha.5.1/alpha.6`）的 `/v1/responses` 请求时，Codex 会话一直没有输出、响应很慢，但运营端持续产生使用记录。最近 30 条 `via=api-kernel`、`protocol=openai.responses` 记录全部为 200 `verified`，同一会话反复发起请求，每次非缓存输入固定 31–50 token、缓存读取固定（如 11497 / 27982），输出始终 16–19 token，上下文完全不增长。
- **原因：** `runApiInference` 对 Responses 入站先经 `responsesToClaude` 转成 Claude 结构，再用 `claudeToOpenAIResponsesRequest` 拼回 Responses。往返中 `function_call` / `function_call_output` / `reasoning` 条目只剩文本或被丢弃，`reasoning`、`include`、`prompt_cache_key`、`parallel_tool_calls`、`text` 等字段丢失，且未给 `max_output_tokens` 时被默认设为 1024。模型看不到自己的工具调用与结果，Codex 循环重发同一轮。
- **Bug 修复：** `src/lib/protocol/handle-protocol.mjs` 在转换前保留 Responses 原生 body 传给 `runApiInference`（`nativeBody`）；`src/lib/pool/api-protocol.mjs` 在入站协议为 `openai.responses` 且选中端点协议为 OpenAI 时，直接转发原生 body（复用既有 `stripCodexIdentity` 去掉 `client_metadata` 等身份字段，`model` 换成端点上游模型，强制 `stream: true`），不再经 Claude 往返；该路径未做工具名改写，因此也不做回写。Chat / Completions / Anthropic 入站及 Claude 端点路径不变。
- **上游取舍：** 上游 `dofastted/vm2api` 最新 main（b0f72b49）`api-protocol.mjs` 同样走 `claudeToOpenAIResponsesRequest` 往返，没有原生转发；在上游方案上保留这一处最小差异（新增一个可选参数与一个分支），复用已有身份清洗函数，不新增转换实现。移除条件：上游在 API 端点路径原生转发 Responses。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。OpenAI 端点收到的 Responses 请求改为调用方原始字段（含 `reasoning`、`include`、`prompt_cache_key`），不再被截断为 1024 输出 token。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。已发生的空转请求已计入使用记录与扣费，本轮不处理历史数据。
- **验证：** `api-backend` 新增回归：带 `reasoning`、`function_call`、`function_call_output`、`include`、`prompt_cache_key`、`client_metadata` 的 Codex 请求经 OpenAI 端点时，发给 api-kernel 的 body 等于原生 body 去掉 `client_metadata`，工具名不被回写；还原修复后该用例失败。`api-backend`、`api-openai`、`api-presets`、`api-scheduler`、`api-endpoints`、`responses-ws`、`auto-mode-api`、`review-five-fixes` 共 92 项通过；修改文件 Biome 格式通过。生产数据仅只读查询。

## 2026-11-04 同步上游 1.4.038 终版（`b0f72b49`）；Gateway 账号模型白名单增加清理按钮（CPR `242ffb23`）

- **上游同步：** 基线由 `d25f1777` 推进到 `b0f72b49`（7 个提交，版本号仍为 1.4.038，不触发自动发版）。上游新增：Sonnet 5.5 放行 `thinking: {"type":"between_tools"}`（修复 Claude Code auto 模式分类器被本地 400 拒绝；不支持的模型、`xhigh` / `max` effort 或额外 thinking 字段仍在分配账号前拒绝），以及 `kernel.json` 写出面板 `compatibility.thinking_display`。全部采用上游。
- **冲突与必要融合：**
  - `model-policy.mjs` Sonnet 5.5 条目：`capabilities` 采用上游（加 `supports_between_tools: true`）；`sort` 保留本地 3——本地整张模型排序表已按 Fable 1 / Opus 2 / Sonnet 3 / Haiku 4 重排，单改这一项会打乱面板顺序。
  - 同文件的 `reasoningEffortOf` import：本地此前删掉（Haiku 5.5 改为只支持 adaptive 后不再用它），上游新增的 `validateBetweenToolsThinking` 又要用。Git 自动合并不会补回 import，运行时会在每个 `between_tools` 请求上抛 ReferenceError；已补回，与上游一致。
  - 上游新测试 `between-tools-ingress.test.mjs` 的夹具按本地商业 Key 契约调整（与已有的 `forced-tool-choice.test.mjs` 同一做法）：本地在校验前先做只读的 Key 预检 `canAccept`（状态 / IP / 到期 / 额度，不占并发），且 Key 必须是库中真实记录、模型要经分组授权，否则先返回 403 `model_forbidden`。夹具补 `canAccept` 并先落库一条 Key；上游的全部断言（400 错误码、准入 0 次、选号 0 次）原样保留。移除条件：上游夹具改为真实 Key 记录时删掉这段差异。
- **新增功能（CPR `242ffb23`）：** Gateway 账号的模型白名单旁新增“清理未列出模型”按钮：列出当前目录未返回的已选 ID，默认不选中，确认后只从表单移除，保存账号才生效；目录未加载完成、加载失败或返回空时按钮禁用，不能把白名单清空。目录来自面板 `test-models?platform=openai`，缺失不等于失效（图像、搜索、映射目标可能不在目录中），只作为清理候选。新增四语文案 6 个键。CPR `239def9a`（PostgreSQL Key 账本）、`53a09bbf`（CPR 自身 PR 规则）不适用；证据索引“已对齐到”推进到 `242ffb23`，下次从其之后盘点。
- **接口 / 配置 / 迁移：** 无。**破坏性变更：** 无。
- **升级指南：** 上游本版要求：更新 Node 控制面与 `web/dist` 后重启；不必 `wrap-cli/sync`，不必换 payload；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。本次定制部分同样只需更新控制面与 `web/dist`。部署另行授权。
- **验证：** Node 全量 unit（422 文件）与同机 `969402dd` 基线（419 文件）对比：首轮仅候选失败的 12 项全部来自上游新测试夹具，按上文调整后 12/12 通过；其余失败集合与基线完全相同（6 项，均为 macOS 缺 Linux 环境的既有失败），**无新增失败**；Web 类型检查通过，Web 全量 116 文件 / 873 项通过（含新增白名单清理 3 项）。本次没有 Go 改动。白名单清理按钮未在浏览器里实际点击验证。
- **并行交付：** 合并期间交付远端先后由 `969402dd` 前进到 `75df4d05`（BPS 账号接入 Gateway Worker 等）与 `21c0beab`（`sk-ant-usr` 前缀官方 API Key 不再报余额不足），均以前一交付为三方基准并入其增量；`21c0beab` 只改 `api-protocol.mjs` 与其测试，与本轮无交集，只有本文件冲突（两个新条目按时间顺序并列）；双方共同改动的 `accounts-model.ts`、其测试与四语 `common.json` 自动合并，JSON 无重复键。最终树中 `worker/` 与 `75df4d05` 逐字节一致，沿用对方的 Go 验证。并入后补跑：受影响的协议、Codex 路由与数据库相关 Node 单测 23 个文件、522 项全部通过；Web 类型检查通过，全量 117 文件 / 876 项通过。
## 2026-11-04 Console 个人 / 服务账号 API Key（`sk-ant-usr-` / `sk-ant-svc-`）经网关调用不再报 “Credit balance is too low”

- **问题（生产只读核查）：** 平台 API 端点 `claude-cc-7`（类型 Claude 官方，`https://api.anthropic.com`，`x-api-key`，key 前缀 `sk-ant-usr-`）在「Anthropic 控制台」测试返回 200，但 Claude Code / Claude 桌面端经网关调用时，Opus 5.5 流式与 Haiku 5.5 非流式全部返回上游 400 `Your credit balance is too low to access the Anthropic API`，客户端显示 “Billing issue / Credit balance is too low”。只剔除 `claude-code-20250219` beta 的第一版修复（v1.4.038.13 已部署）后仍复现。
- **原因：** `sk-ant-usr-`（Console 个人 key）/ `sk-ant-svc-`（服务账号 key）是普通 x-api-key 密钥，但请求一旦带有 Claude Code 入口标记，Anthropic 就按 Claude Code 用量计费，这类 key 的 API 额度不覆盖，于是报余额不足（社区同类问题：NousResearch/hermes-agent 对该前缀误加 Claude Code 身份）。生产经该 key 自身代理逐项实测，下列任一项单独出现即 400：`anthropic-beta` 含 `claude-code-20250219`；`user-agent` 入口为 `cli` / `claude-desktop-3p`（`sdk-cli` 或不带为 200）；system 计费头 `x-anthropic-billing-header` 的 `cc_entrypoint=cli` / `claude-desktop-3p`（`sdk-cli` / `sdk-ts` 为 200）；system 中单独一块正好是 Claude Code / Agent SDK 身份句（同一句与其他内容同在一块为 200）。`x-app`、`x-stainless-*`、`x-claude-code-session-id`、其他 beta、`metadata`、流式与否均无影响。网关 API 路径原样转发了客户端的 beta、透传模式下的桌面端 UA，以及 body 里的计费头块和单独的身份块。
- **Bug 修复：** `src/lib/pool/api-protocol.mjs` 对上游 key 前缀为 `sk-ant-usr-` / `sk-ant-svc-` 的 Anthropic 协议端点：不转发调用方的 `claude-code-20250219` beta；不透传调用方 UA，统一使用网关既有的 `claude-cli/… (external, sdk-cli)`（端点配置的 UA 仍优先）；出站 body 删除计费头 system 块，并把单独成块的身份句并入其后的第一块文本（保留其最早的缓存断点；其后没有文本块时删除）。身份句与计费头判定复用 `identity/official-profiles.mjs` 既有的 `isOfficialIdentityText` / `isBillingText`。模型看到的指令文本除计费头外不变；`sk-ant-api03-` 等其他 key、OAuth 槽位、OpenAI 端点与第三方 Anthropic 兼容中转原样不变（部分中转以这些标记识别 Claude Code 流量）。
- **上游取舍：** 上游 `dofastted/vm2api` 最新 main（b0f72b49）`api-protocol.mjs` 原样转发调用方 beta 与 body，没有对应处理；在上游方案上保留这一处按 key 前缀的最小差异。移除条件：上游在 API 端点路径处理 Console key 的计费归属，或 Anthropic 不再按这些标记改变 Console key 的计费路径。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。判定依据 key 前缀与 2026-11-04 实测的标记，Anthropic 若新增识别特征需再核实；`sk-ant-svc-` 未在本平台实测，依据社区同类报告一并处理。这类 key 的 Prompt 缓存未在本轮实测命中（探测 prompt 未达缓存最小长度）。
- **验证：** `api-backend` 回归：透传模式下 Claude 桌面端请求（claude-code beta、`claude-desktop-3p` UA、计费头块、单独身份块）发往 `sk-ant-usr-` / `sk-ant-svc-` key 时，出站 beta 只剩其他 beta、UA 为 `sdk-cli`、system 合并为“身份句 + 正文”一块并保留缓存断点，`sk-ant-api03-` key 原样；清洗函数单测覆盖字符串 system、仅身份块、无变化原样返回与 key 前缀判定；还原修复后用例失败。`api-backend`、`auto-mode-api`、`review-five-fixes`、`anthropic-console` 63 项通过，修改文件 Biome 通过。生产只读查库，并经该 key 自身代理发出约 40 次最小探测；用本次清洗函数处理后的桌面端形态请求（Opus 5.5 流式两次、Haiku 5.5 标题请求）均返回 200。

## 2026-11-04 BPS（Excel Basispoints）作为 OAuth 账号的附加授权接入 Gateway Worker

- **需求：** 把定制版 NewAPI（`holeenlu/sub2api` NewAPI 分支，`54f179cde`）的“BPS 网关”整理并重构进来，产品形态与 sub2api 相同：BPS 是 OpenAI OAuth 账号上的附加授权，同一账号同时持有原生 Codex 授权与 Excel/BPS 授权；同时优化添加、编辑账号与 BPS 专属设置。同日先交付的“独立 BPS 账号”形态（`auth_type=bps`、建号时选 OAuth/BPS、“优先使用 BPS”）未部署，已被本节整体替代并清理。
- **新增功能：**
  - **授权**：
    - Worker 账号新增 `Account.BPS`（Excel 授权令牌、BPS 授权代次与通道状态）与控制面投影的 `Account.BPSSettings`。
    - Excel 客户端 `app_fnr0pYvVwwFDocDumLG3H2Bp`，授权地址 `auth.openai.com/api/accounts/authorize`（PKCE、`platform=PC`），回调落在官方 `bps.openai.com`，运营把地址栏完整链接粘回。也可导入 Excel 授权 JSON。
    - 只接受已有原生授权的账号；换码与导入都校验签发客户端、与原生同一 `chatgpt_account_id`，并拒绝 Free。
    - 撤销只删除 BPS 授权、保留设置。BPS 授权用 Excel 客户端单独刷新；多实例投影时凭据包随原生凭据迁移 BPS 令牌。
  - **协议**：协议包 `worker/internal/basispoints` 从 sub2api 直接移植（约 7.8k 行，自带约 1 万行测试；本地只加了 `compat.go` 与 `hosted_tools.go`）。
    - Responses 转为 `POST {BPS}/responses`：工具目录写进 developer 文本，function/custom 调用经 `run_officejs` 信封桥接。
    - 工具调用格式不合格时，同账号最多纠正两轮，纠正用量计入。
    - 上游 SSE 转回标准 Responses SSE 后，复用 Worker 的前导缓冲、提交、回执与失败处置。
    - **图片**：只用 sub2api 的“BPS 原生附件上传”方式，不做临时 HTTPS 中转，也不把图片地址交给 BPS。远程图片（http/https 链接）由 Worker 经账号代理下载（最多 3 次重定向、60 秒，按内容判定只接受 PNG/JPEG/GIF/WebP，单张 32 MiB、单请求合计 64 MiB，拒绝本机与内网地址），同一链接只下载一次；下载失败按调用方请求错误返回 400 `invalid_image_url`，不重试、不改走原生。之后消息与工具结果中的图片先以 multipart 上传到 `{BPS}/attachments`，再改写为 `file_id` 引用。单请求最多 20 张、并行 4 路、进程内并发上限 32；同一账号、调用方、会话、授权代次与工作区内按图片摘要复用附件 ID（1 小时、512 条）。上传被拒按本次 BPS 失败处置；上游判定附件不属于本账号时，作废缓存、同账号重新上传并重发一次。无法解析的图片改走原生。
    - **结构化输出**（`text.format` 的 json_object/json_schema）写进 developer 指令，在本地按 schema 校验终态后再交付；**compaction**（输入末尾的 `compaction_trigger`）原样转发。两者均由协议包处理，本轮补了接入验证。
    - **跨重启保留**：工具调用回放与会话工具目录在 Worker 数据目录 `bps_state/` 中按条目分文件保存（2026-11-05 起；原为单文件 `bps_state.json`），配置凭据包密钥时与账号库同样加密。按 scope 隔离，空闲 2 小时过期；单条与合计上限沿用协议包（合计 32 MiB，超出先淘汰最早过期）；目录写入按版本比较。
  - **调度**：
    - 请求模型在账号的 BPS 名单内、且请求可由 BPS 承载时，先走 BPS 通道。可承载指 Responses/Chat 流式、不续接上一轮响应、不强制使用生图或外部联网搜索；带托管工具或加密消息内容的请求，按账号的两个开关决定省略后走 BPS 还是走原生。
    - BPS 阶段满载不排队。BPS 失败可安全重放时先换其他账号的 BPS（单独计数），BPS 都不可用或换号用尽后进入原生阶段，同一账号可以再走原生。
    - 并发、RPM、额度窗口两通道共享；原生授权失效时账号仍可走 BPS。
    - 全局总开关「设置 → OpenAI → BPS（Excel Basispoints）→ 启用 BPS」（`routing.codex.bps_enabled`，默认开）。
  - **失败处置**只写账号的 BPS 状态：
    - 429 冷却 BPS 端点；
    - 403 模型无权按模型冷却 30 分钟；
    - 401 让刷新器立即刷新；
    - 账号/工作区级 403 在开启“403 自动停用”时停用 BPS；
    - 额度耗尽是同一 ChatGPT 账号的共享结论，两条通道一起跳过；
    - BPS 失败不计入原生健康分、错误保护与过载反馈。
  - **BPS 专属设置**（`config.bps`，首次授权的默认值与 sub2api 模板一致）：

    | 设置 | 默认 | 说明 |
    |---|---|---|
    | 启用 BPS | 开 | |
    | BPS 模型 | 空 | 最多 100 个，只有名单内模型走 BPS |
    | 省略不支持的工具 | 关 | |
    | 忽略加密内容 | 关 | |
    | 缓存写入按输入计费 | 开 | Worker 把终态 usage 的缓存写入归零，下游与回执同口径 |
    | 403 自动停用 | 开 | |
    | 自动恢复 | 关 | 按 1–10080 分钟（默认 60）的间隔，用名单第一个模型发极小探测，成功即恢复；每次探测的时间、模型、结果、错误码与 token 随心跳上报，记入账号探测记录（迁移 `096_gateway_bps_probes.sql`，保留 30 天），在账号详情与 BPS 对话框中显示，不进使用记录、不计费 |
    | 403 自动移组 | 关 | 移入目标分组或退出所有分组；控制面按心跳上报的停用时刻，每次停用只处理一次 |

  - **界面**：
    - 「资源管理 → Codex 账号」新建对话框在 OAuth/账号文件授权成功后进入“添加 BPS 授权（可选）”，可跳过。
    - 编辑对话框新增「BPS 授权」分区：状态、添加/重新授权、导入、撤销、开关、模型多选、高级设置。
    - 详情页「账号」页签新增 BPS 卡片；列表套餐后显示 `+BPS`（生效中）或 `+BPS!`（需重新授权或 403 停用）。
    - 使用记录详情的超管诊断显示「授权方式」；四语言文案。
    - 供应商门户「账号池」与运营端「供应商平台 → 账号池」的 Gateway 账号行菜单新增「BPS 授权」对话框：状态、添加/重新授权（授权链接或授权文件）、撤销、设置与保存。需要供应商的 Gateway 运行控制（`allow_runtime`）；只能操作本供应商的账号。
  - **模型目录**：`/v1/models?client_version=` 下发的 Codex 模型清单中，本 Key 分组内经 BPS 承接的模型不声明原生多智能体（`multi_agent_version`、`multi_agent_reasoning_effort` 为 null）。窗口超过 922,000 时收窄到 922,000，并把自动压缩阈值设为 830,000（不超过窗口的 90%），与 sub2api 同口径。名单外模型保持原样；总开关关闭时不收窄。
  - **数据**：
    - 迁移 `094_usage_logs_authorization_mode.sql`：`usage_logs.authorization_mode`（native/bps，取自 Worker 响应头 `X-Kin-Gateway-Auth-Mode`）。
    - 迁移 `095_gateway_bps_state.sql`：绑定表 `bps_state`/`bps_error`/`bps_blocked_at`，由心跳上报。
    - 迁移 `096_gateway_bps_probes.sql`：BPS 恢复探测记录（随心跳 `bps_probes` 上报，按实例、运行账号与时刻去重，保留 30 天）。
    - 均不回填历史行。
  - **接口**：
    - `POST /api/panel/codex-accounts/:id/bps/import`、`DELETE /api/panel/codex-accounts/:id/bps`。
    - BPS 授权复用 `POST /api/panel/codex-accounts/:id/drafts`（`authorization_kind: "bps_oauth"`）与既有草稿授权路由。
    - 供应商端 `GET/PATCH/DELETE /api/vendor/accounts/:id/bps`、`POST /api/vendor/accounts/:id/bps/import`（运营端经 `/api/admin/vendors/accounts/...` 同路由）；授权链接复用 `/api/vendor/accounts/:id/gateway-drafts`（`authorization_kind: "bps_oauth"`）。
    - Worker 新增 `/internal/v1/accounts/{id}/bps[/import]`。
- **上游取舍：** 官方上游没有 Gateway Worker 与 BPS，本节均为定制差异。相对 sub2api 的调整：
  - 原生授权失效不再连带停掉 BPS 通道；
  - 带托管工具或加密内容的请求在开关关闭时改走原生，而不是直接拒绝；
  - 失败时按用户要求回退原生通道；
  - 模型候选沿用站内模型目录；
  - 回放与目录用 Worker 数据目录的加密文件跨重启保留，代替 sub2api 的 Redis。

  sub2api 的 Excel 主授权（只有 BPS 的账号）、图片 relay 模式（本地托管图片的签名 URL）、供应商授权模式白名单不移植；自动登录 Worker、Mihomo、票据/Cookie、自动质量运营在 sub2api 已退役，也不移植。
- **来源与许可：** 协议包按用户确认直接移植 sub2api 源码。sub2api 仓库为 LGPL-3.0，协议包声明改编自 hloolx/codex2api（MIT），包内 `NOTICE.md` 保留原始署名并记录本次移植与本地改动。应用层按本项目结构重写。
- **破坏性变更：** 无（第一期未部署）。新增 Worker 依赖 `santhosh-tekuri/jsonschema/v6`、`tidwall/gjson`、`golang.org/x/image`，在 Go 1.25 下构建。
- **升级指南：**
  - 部署控制面镜像（含 Worker）并执行迁移 094、095 后，在「资源管理 → Codex 账号」为已有账号「编辑 → BPS 授权」添加授权，并勾选模型。
  - 全局总开关默认开启，不勾选模型时没有请求会走 BPS。
  - BPS 端点与客户端可用 `KIN_CODEX_GATEWAY_BPS_BASE_URL`、`_BPS_CLIENT_ID`、`_BPS_AUTHORIZE_URL`、`_BPS_REDIRECT_URI` 覆盖。
  - 本轮未部署。
- **清理：**
  - 删除第一期的账号类型 `auth_type=bps` 及按账号类型选号；
  - 删除 `PreferBPS`/`routing.codex.prefer_bps` 与“优先使用 BPS”设置及文案；
  - 删除建号时的 BPS 授权页签、`authorization_kind_mismatch` 与 `bps_import_unsupported`；
  - 删除 `credential_mode=bps` 与凭据类型 `bps` 列、`BPS ·` 套餐前缀；
  - 删除对应测试；Codex 后台任务的判断恢复为原有条件。
  - 迁移 094 继续使用。
- **已知限制：**
  - 跨重启保留只在单个 Worker 实例内，多实例之间不共享回放与目录（同一会话换实例时需要客户端带完整历史）；
  - 真实 BPS 上游与真实 Excel 授权未在本地验证，需要部署后用真实账号验收。
- **代码统计（含未跟踪新增文件）：**
  - 附加授权改造（`e8f06a8e`）：业务代码 +1,677 −348（净 +1,329），四语言文案 +196 −24，测试 +531 −270，文档 +43 −13。
  - 本次补齐（图片附件、跨重启保留、模型目录投影、供应商门户 BPS、接入验证）：业务代码 +629 −61（净 +568），测试 +348 −1；文档另计。
  - 远程图片下载上传与探测记录：业务代码 +427 −5，测试 +146 −0；文档另计。
  - 移植的协议包不重复计入。
- **验证：**
  - **Go**：Worker 16 个 BPS 用例通过，覆盖：
    - 名单内走同账号 BPS、名单外与总开关/账号开关/无授权时走原生；
    - BPS 429 后先换其他 BPS 再回落原生，原生健康不变；
    - 不可承载请求跳过 BPS；托管工具与加密内容两个开关；
    - 模型无权只冷却 BPS 模型；403 自动停用开关；额度耗尽两通道共享；原生凭据失效时仍走 BPS；流内失败回落原生；
    - 函数工具往返；
    - BPS 授权写入已有账号、身份不一致与 Free 拒绝；导入/撤销/Excel 刷新/凭据包；403 恢复探测；投影保留授权；缓存写入计费；
    - 图片上传为附件并在同一会话复用、附件归属失败作废缓存并重传一次、结构化输出本地校验、compaction 触发项保持末尾、回放与目录跨重启保留（含版本比较、容量上限与 2 小时过期）。

    - 远程图片经重定向下载、同链接只下载一次并上传为附件；非图片内容与 404 返回 400 `invalid_image_url` 且不触达 BPS；本机与内网地址被拒；恢复探测记录结果、上游错误码与 token，只移除已上报的记录。

    合计 25 个 BPS 用例。

    协议包自带测试、`go vet`、`go test -race ./...`（Go 1.25.14，与 CI/镜像一致）、linux amd64/arm64 编译、gofmt 均通过。
  - **Node**：新增 BPS 附加授权、设置校验与投影、导入/撤销、403 移组只执行一次、总开关下发、模型目录 BPS 投影等用例。完整单测 4,744 个中 9 个失败，均在 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status`，是已知的本机环境相关失败。
  - **e2e**：Gateway e2e（含真实 Worker）6/6 通过，其中真实 Worker 的 BPS 用例覆盖 OAuth 建号、添加 BPS 授权、配置名单、名单内经 BPS、名单外走原生、使用记录分别为 `bps`/`native`。
  - **模型目录**：新增单测覆盖经 BPS 的模型收窄窗口与多智能体、名单外保持原样；真实 Worker 的 BPS e2e 对比配置前后的 `/v1/models?client_version=` 清单。
  - **供应商门户**：新增 e2e 覆盖供应商查看、授权（`grant=bps`）、保存设置（投影到 Worker）、导入、撤销；其他供应商不能访问；关闭运行控制后拒绝。Gateway e2e 共 7/7 通过（供应商 BPS 接口返回最近探测记录）。
  - **前端**：`tsc -b`、相关 eslint、Prettier、vitest 全量 118 个文件 881 个用例通过。
  - **浏览器点验**（本地控制面 + 假 Worker）：
    - Codex 账号列表的 `GPT +BPS` 标识；详情页 BPS 卡片；
    - 编辑对话框 BPS 分区勾选模型、开启 403 自动移组后保存，接口读回一致；
    - 新建账号用账号文件授权后进入“添加 BPS 授权（可选）”，生成链接、粘贴 `bps.openai.com` 回调完成授权；
    - 运营端账号池中供应商 Gateway 账号的「BPS 授权」对话框：授权、勾选模型、保存后状态变为“已授权 · 生效中”。
  - biome 通过。
  - 未在生产验证，未部署。

## 2026-11-04 Codex 账号列表的 7D 容量预测移到读库工作线程，不再每 5 分钟冻结网关约 7 秒

- **依据（生产实测）：** v1.4.038.11 上线后 08:16–08:46 UTC 复测，在 08:27、08:32、08:37 前后出现 7.4s、4.3s、7.5s 的事件循环停顿，周期正好 5 分钟，停顿期间无任何日志、进程内存随后回落。原因是「Codex 账号」列表（`GET /api/panel/codex-accounts`，面板每几秒轮询）的 `attachListForecasts`：各账号预测缓存 5 分钟且几乎同时过期，过期后在网关主线程同步对全部账号执行 `quotaForecastForAccount`（读取本周期全部 Receipt 额度观测并逐条解析 `quota_json`，加上本周期全部 Gateway 用量行）。在生产容器内另起只读进程对生产库重算 18 个账号，合计 7.3s，单账号最长 1.0s。
- **Bug 修复：**
  - `quotaForecastForAccount` 注册到只读 SQLite 工作线程（`sqlite-worker.mjs` 现有的 `kind: 'vendor'` 方法表），新增 `pooledQuotaForecast()` 经 `pooledVendorRead()` 调用：仅共享主库且线程池可用时下发，跨线程只传 `id` / `created_at` / `quota`；其他连接与线程池异常时在当前线程原样计算。
  - `attachListForecasts` 改为异步：没有缓存或周窗口读数（已用% / 重置时间）变化时等待重算，与原语义相同；只是 5 分钟到期而读数未变时先返回旧预测、后台重算，下次轮询读到新值。同一账号同一读数的重算由并发轮询共享；较慢完成的旧读数结果不会覆盖较新的结果。
  - 单账号预测 `GET /api/panel/codex-accounts/:id/quota-forecast` 同样改走工作线程。
- **破坏性变更：** 无对外接口变化。内部导出 `attachListForecasts` 改为返回 Promise（唯一调用方已改为 `await`）。
- **升级指南：** 无配置、无迁移；部署控制面后自动生效。
- **已知限制：** 5 分钟到期后的那一次轮询返回的是上一周期计算的容量预测（读数未变，差异只来自其间新增的用量）；预测仍是只读估算，不参与计费与调度。工作线程上 18 个账号的重算仍需数秒，期间同一线程上的其他面板报表读取排在其后。
- **上游取舍：** `quota-forecast.mjs`、`gateway-routes.mjs` 为本地定制；`sqlite-worker.mjs` 为上游文件，只在本地已有的供应商报表方法表中增加一项，移除条件同该方法表。
- **验证：** 新增 `sqlite-pool` 用例：真实线程池上预测与内联计算逐字段相等；主连接未提交事务里的用量只在内联计算可见，以此证明列表预测在工作线程执行；读数未变而 TTL 到期时并发轮询立即得到旧值，随后读到刷新值。变异确认：改回内联计算或改为总是等待时该用例失败。`gateway-account-management`（含“读数变化立即重算”原用例，改为 `await`）、`gateway-quota-forecast`、`vm-quota-forecast`、`gateway-worker`、`gateway-p2`、`gateway-single-worker`、`codex-client-profile`、`usage-logs-repo`、`sqlite-pool` 单测与 `gateway-operator-accounts` e2e 通过（`gateway-worker-real` e2e 本机跳过，交 CI）。修改文件 Biome 通过。

## 2026-11-04 Gateway Worker 流内额度丢失重置时间，回执补上流内额度观测（Codex 账号“预计”恢复）

- **问题（生产 v1.4.038.11 只读核查）：** 「Codex 账号」列表成本列的“预计”有 10 个账号一直是“—”（状态无数据）。这些账号的周窗口快照只有已用比例和窗口时长，没有 `reset_at`；最近 1 小时没有请求的账号（codex-cc-6、codex-cc-7）则保留着 `/wham/usage` 给出的重置时间。同时，请求回执里的额度观测全部为空（`confidence: unknown`），Gateway 的容量预测在生产上没有任何配对历史，只能按“花费 ÷ 已用%”估算。
- **原因：**
  - 上游 WebSocket 的 `codex.rate_limits` 事件里，窗口重置字段是 `reset_at`（unix 秒）和 `reset_after_seconds`。CPR `parse_rate_limits_event` 与官方 Codex 客户端测试样例都用这两个字段名。Worker 却按 `resets_at` / `resets_in_seconds` 读取，这两个名字只在 `usage_limit_reached` 错误体里出现。结果每个流内事件都只带已用比例，`MergeQuota` 又按顶层字段整窗口覆盖，于是每个 WS 请求都会把快照里已知的重置时间清掉。
  - 回执的 `quota` 只取 HTTP 响应头。生产默认走上游 WS，额度只出现在流内事件里，所以回执一直没有额度观测。
- **Bug 修复：**
  - `parseRateLimitsEvent`（`worker/internal/codexgateway/quota.go`）改读 `reset_at`，缺失时用 `reset_after_seconds` 推算，并保留 `reset_after_seconds`。
  - 新增 `mergeQuotaWindows`，`MergeQuota` 改用它：同一窗口的新读数缺少重置时间时，如果窗口时长没变、已用比例没有回落超过 1 个百分点、原重置时间还在未来，就沿用原 `reset_at`。窗口时长变化、已用比例回落（新周期）或原重置时间已过，则不沿用。
  - 回执的额度改由 `receiptQuota` 生成：合并响应头与本次流内 `codex.rate_limits`（SSE 与上游 WS），并按合并后的窗口给出 `quota_confidence`。控制面 `quota-forecast` 从回执读取额度观测，现在能做增量采样。
- **上游取舍：** Gateway Worker 为本地定制功能，字段名按 CPR 与官方客户端对齐；不涉及上游文件。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。回执 `quota` 多出流内窗口；流已收到额度事件但没有用量的回执，`usage_confidence` 由 `unknown` 变为 `partial`。结算只认 `complete`，不受影响。
- **升级指南与限制：** 随应用镜像更新 Gateway Worker 后自动生效；本轮未部署。部署后第一个带额度事件的请求就会补回重置时间，之前已丢失重置时间的快照也在下一次请求后恢复。配对历史从部署时开始积累，已用比例要再增长 5 个百分点以上才会改用增量采样。“预计”为“—”的另一类原因（周窗口刚重置、已用不足 5%）属于有意不估，不在本节范围内。
- **验证：** 更新 `TestRateLimitsEventMergesIntoQuota`，改为按上游字段断言重置时间（把字段名改回 `resets_at` 后该用例失败，已做变异确认）。新增 `TestMergeQuotaKeepsKnownResetForSameCycle`（同周期沿用；回落、换时长、已过期不沿用）、`TestReceiptQuotaIncludesStreamRateLimits`；`TestWSTerminalPoolingRateLimitsAndMetadataTurnState` 增加回执带流内额度的断言。`codexgateway` 包 `go test -race` 全部通过，`go vet`、`gofmt` 无输出，Linux amd64 `CGO_ENABLED=0` 编译通过。生产数据仅只读查询。

## 2026-11-04 网关主线程减负（续）：调度时缓存前缀比较按请求只哈希一次，主连接缓存预编译语句

- **依据（生产实测）：** 经授权于 11-04 07:58–08:10 UTC 以 `NODE_OPTIONS=--cpu-prof --cpu-prof-interval=5000` 重建控制面容器采样 v1.4.038.10（采后恢复原配置）。剔除启动 3 分钟后的约 10 分钟窗口内主线程忙碌 53.8%；按忙碌时间：缓存前缀 `snapshotBody` 13.7%（调度阶段 `canAccept → resolveRequestRisk → cacheColdForAccount → peekCachePrefix` 对每个候选账号整段历史重新逐条 stringify + sha256）；`UsersRepo` / `ApiKeysRepo` 构造各约 3%、`groups-repo` 的 `forResource` / `resourceVersion` / `access` / `resources` 合计约 6%（每次调用重新 `db.prepare`）；`summarizeVm` 6.5% 中一半是 VM 分组查询的重复编译。
- **优化改进：**
  - **调度前缀比较：** `peekCachePrefix` 不再构建完整快照，每条消息只取一次整体哈希定位首个差异，仅在该下标建完整记录（与 `firstHistoryDiff` 同一做法）；新增可选 `known` 映射，`cacheColdForAccount` 把它挂在本请求的 `quotaRequest` 上（与 `_promptParts` 同一生命周期，请求体对象变化即重建），同一请求在多个候选账号、排队重评之间共享消息与 tools/system 哈希。输出与完整快照逐字段相同。本地 2.9MB / 300 条消息、10 个候选账号：62ms → 6ms。
  - **主连接语句缓存：** `createDatabase` 为连接包装 `prepare`，同一 SQL 文本复用同一 `StatementSync`，按最近使用保留 512 条（与读池 `sqlite-worker` 的 `cachedPrepare` 同一做法）。各 repo 每请求构造、随用随 `prepare` 的写法不变即可受益：2000 次“构造 UsersRepo + ApiKeysRepo + VM 分组与版本查询” 395ms → 12ms。认证与 Key 范围（`refreshKeyScope`、`keyScopeFromRecord`）的开销主要来自同一重复编译，随之下降，不另加结果缓存，避免授权变更后读到旧值。
- **评估后未改动：** 面板 Gateway 账号用量已由“账号成本改读小时预聚合”条目改为读汇总表，并随 v1.4.038.11 上线（本次采样在 .10 上，仍是旧实现）。Gateway 请求签名对正文做 sha256 + HMAC 两遍（约 2–4%）：省一遍需改 Node 与 Worker 的签名协议，多 Worker 混跑新旧版本时会验签失败，收益不足以承担，未改。协议拦截文本归一化（约 9%）、`listVms` 每次重新解析 VM 文件与 `summarizeCodexSlot`（约 3%）留待部署后复测再定。
- **上游取舍（例外保留）：** `cache-prefix.mjs`、`database.mjs` 为上游文件，`quota-request-risk.mjs` 的风险评估亦来自上游。依据为上述生产 CPU profile；最小范围：只改 peek 的快照构建方式与请求内哈希共享、主连接 `prepare` 的复用，判定与输出不变，`snapshotBody` / `prepareCachePrefix` 未改，读池实现未动。移除条件：上游提供等效的增量比较或语句缓存时收敛回上游。
- **破坏性变更：** 无。`peekCachePrefix` 新增可选参数 `known`，未传时行为不变。主连接上 `db.prepare` 同一 SQL 返回同一语句对象：调用方不得在迭代某条语句时再次执行同一 SQL（仓库内唯一的 `iterate` 调用不会）。
- **升级指南：** 无配置、无迁移；部署控制面后生效。本轮未部署。
- **验证：** 新增“peek 每条消息只哈希一次且与完整快照的 break 相同”测试（追加、中间消息改动、工具变更、截短、首轮），`cache-prefix` 与 `quota-critical-band` 单测通过；完整单测套件 4707 项：4679 通过、9 失败、其余跳过，9 个失败（`egress` 3、`oauth-binary` 4、`guest-identity-reader` 1、`telemetry-status` 1，均因本机缺 `bin/kin-egress` 等二进制或 Docker）在未修改基线上逐文件复跑结果相同；修改文件 Biome 通过。

## 2026-11-04 Gateway Worker 对齐 CPR：换号清理追踪上下文，大包 HTTP 回退加回差

- **需求与依据：** 用户要求把 CPR（`codex-proxy-rs`）纳入同步流程并同步 Codex Gateway Worker 的需求、优化与修复。按交付规范第 4 节冻结 CPR `main` 为 `5eaca14a`，盘点基线 `1915806b` 之后的 9 个提交并逐个读取实际 diff；与网关相关的 3 个提交已处理，其余 6 个与网关无关。
- **Bug 修复（`5eaca14a`）：** 同一请求换到另一个账号时，客户端的 `traceparent`、`tracestate`、`sentry-trace`、`baggage` 与 `x-openai-fedramp` 原样带给新账号，会把原账号的追踪与合规上下文泄给另一个账号。现在 `scopeDifferent` 时 HTTP 头、WS 握手头、正文顶层、`client_metadata`、turn metadata（头与正文）及 `ws_request_header_*` 副本一并清理；同账号和归属未知时保持原值，其他业务字段不动。落点 `account_scope.go`、`guardian.go`。
- **优化（`49cee239` 部分采用）：** 完整新链的 WS→HTTP 大小回退由固定 15 MiB 改为 15.5 MiB，并按线程加回差：超限后沿用 HTTP，帧长低于 13.5 MiB 才回 WS，避免在边界附近来回切换；预热或增量成功不再清除该偏好。带 `previous_response_id` 的请求只看 15.5 MiB，不更新线程偏好。落点 `ws.go`、`ws_budget.go`。
- **评估后未采用：** 大包 HTTP 后让下游 WS 在空闲时正常关闭、促使客户端重连发全量（`49cee239`、`0663df14`）——下游 WS 在 Node `responses-ws.mjs`，它自己展开 `previous_response_id` 做连接内重放，不依赖客户端重连，也没有按 Codex CLI 限定的同类逻辑。其余 6 个提交（插件用量与画像、PostgreSQL 16、在线更新、迁移换行、xAI 额度）与 Gateway Worker 无关。
- **接口 / 配置 / 迁移：** 无。**破坏性变更：** 无；换号请求不再携带原账号的追踪头属于预期修正。**升级指南：** 只需更新 Worker 二进制（随应用发布），无配置与迁移；部署另行授权。
- **出处与下次起点：** CPR 提交 `5eaca14a`、`49cee239`（部分）、`0663df14`（不适用）；证据索引“已对齐到”推进到 `5eaca14a`，下次增量盘点从其之后开始。
- **验证：** Go 全量 `-race` 通过；新增 5 个测试（换号清理正文/头、同账号与归属未知保留、回差区间、成功不清偏好），把换号清理改成空操作后对应测试失败，确认能拦住回归；`gateway-worker-real` e2e 通过（真实构建并启动 Worker）。仅改 Go Worker 与文档，Node 与前端未变，未重跑。

## 2026-11-04 同步流程新增 CPR（Gateway Worker）来源

- **需求与依据：** 用户要求把 `codex-proxy-rs`（CPR）纳入同步/合并流程，用于同步 Codex Gateway Worker 部分的需求、优化与 Bug 修复。CPR 与本项目没有共同 git 历史（Gateway Worker 是按 CPR 行为用 Go 重写的），所以不能套用“上游优先”和 `git merge`，需要独立的流程规则。
- **新增（仅流程文档，无业务代码改动）：**
  - `docs/CHANGE_DELIVERY.md`：第 1 节来源表新增 CPR 行；第 3 节分流新增“同步 CPR / 同步 codex worker”；第 4 节新增“CPR（Gateway Worker）同步”，规定范围（只含 Gateway Worker 及其 Node 投影、面板、迁移和测试）、触发条件、基线事实源、来源冻结、逐提交盘点的五类结论（已移植 / 已具备 / 部分采用 / 不适用 / 待决定）、需求优化与缺陷并列盘点、语义移植规则、出处写法（只写短 SHA，不写跨仓库 issue/PR 引用）、验证、基线推进和交付。
  - `AGENTS.md`：新增一条入口规则，CPR 同步同样使用 `$vm2api-sync-upstream`，基线只记录在 `docs/cpr/04-evidence-index.md`。
  - `docs/cpr/04-evidence-index.md`：只改“Gateway Worker 对齐基线”的说明段，指向交付规范；基线数据（已对齐到 `1915806b`）与盘点表未改动。
  - 本机技能 `vm2api-sync-upstream`（仓库外）新增第 8 节与触发说明，规定执行顺序；改动前已备份。
- **边界：** CPR 同步与官方上游同步是两条独立流程，同时要求时先上游后 CPR，最终仍只有一个定制提交；CPR 前进不触发发版，也不改变官方上游父提交。普通需求和官方上游同步不检查 CPR。
- **未处理 / 已知限制：** 本次只更新流程，**没有执行 CPR 业务同步**。下次增量盘点的起点是 `1915806b`；本次核对时 CPR 的 `main` 已领先 7 个提交（`0663df14`、`39aa20a1`、`621b1fac`、`28eb4708`、`aa003f7d`、`4c57a040`、`49cee239`），尚未读取 diff，不代表任何结论。
- **破坏性变更 / 升级指南：** 无；不涉及代码、配置、迁移或部署。
- **验证：** 仅文档改动：核对新增条目的交叉引用（第 4 节标题与证据索引链接）和全文无跨仓库 issue/PR 引用；未运行业务测试，因为没有行为变化。

## 2026-11-04 代理只支持 SOCKS5，撤销 HTTP / HTTPS / SOCKS5H 多协议（回到上游）

- **需求与依据：** 用户要求代理收敛到上游的 SOCKS5，系统里新增或绑定的代理都按 SOCKS5 使用。生产核对（只读，2026-11-04）：33 条代理中 32 条原为 HTTP，29 个槽位全部绑在 HTTP 代理上；这些 HTTP 代理的供应商端点在同一主机与端口同时提供 SOCKS5，32 条都通过了从生产容器发起的完整 SOCKS5 握手、认证和经代理 CONNECT（IP 与域名两种目标）。经授权，32 条已逐条改为 `socks5h`（主机、端口、账号密码未动，槽位按“等在途请求清零再重载”分批切换，最后一条 vm-06 在接受中断的前提下直接切换，期间 4 个请求失败后恢复），所以生产不再依赖 HTTP 代理，本次才删除代码。
- **采用上游 / 删除本地方案：**
  - Node：删除 `src/lib/vm/proxy-address.mjs`（`PROXY_PROTOCOLS`、`proxyDefaultPort`、保留协议名的 `proxyUrl`、`proxyEndpointOf`），全部改回上游 `socks-address.mjs`；`schedule-eligibility.mjs`、`proxy-policy-runtime.mjs`、`proxy-agent.mjs`、`proxies-repo.mjs` 与上游逐字一致。`proxy-pool.mjs` 删除协议参数、HTTP(S) 探测分支（含 TLS 握手）、去重键里的协议、编辑接口的 `protocol`，并把本地为多协议改名的 `parseProxyLine` / `parseProxyFields` / `proxyRecord` / `findProxy` / `ensureProxy` / `_findProxyRow` 改回上游的 `parseSocks5Line` / `parseSocks5Fields` / `socks5Record` / `findSocks` / `ensureSocks` / `_findSocksRow`，减少以后合并上游的冲突。面板路由不再读写 `protocol`（导入、编辑、供应商代理编辑与资源展示）；VM 包的代理 `kind` 固定 `socks5`，导入不再接受协议字段。
  - Go：整体换回上游 `worker/internal/proxy/socks5.go` 与测试，删除 `dialer.go`（HTTP CONNECT、HTTPS 到代理的 TLS）和 `http_connect_test.go`；`worker/internal/config` 的 `proxy_url` 校验恢复为仅 `socks5` / `socks5h`。Gateway Worker 删除 HTTP 代理专用路径：`upstreamEgress.forward`、明文目标的 absolute-form 转发、WebSocket 握手里的 `Proxy-Authorization`。`worker/internal/egress` 与 `worker/cmd/kin-egress` 现与上游逐字一致。
  - 前端：移除导入和编辑里的协议下拉框、`https` 默认端口联动、供应商与运营代理列表的协议筛选和“协议”列、代理行的协议徽标，导入提示和示例改为只写 SOCKS5，默认端口 1080。四语资源各删除 5 个键（`proxies.protocol`、`proxies.localDirect`、`proxies.protocolHint`、`supplierAdmin.allProtocols`、`common.protocol`），并改写 3 条文案。
- **必要融合 / 保留的最小差异（均已核实，不是“本地已有”）：**
  - 解析防护：上游 `parseSocks5Line` 会把 `http://u:p@h:80` 落到 `user:pass@host:port` 分支，导入成用户名为 `http` 的 SOCKS5 代理，静默写入错误数据。本地保留拒绝：含 `://` 但不是 `socks5://` / `socks5h://` 的行、带路径或查询串的 URL 一律作为无效行。上游修复后删除。
  - `socks5Record` 保留 `label` 参数，且 `raw` 不保存含密码的原始行（沿用此前的安全修正）；`ensureSocks` 保留扩展签名；对外的 `scheme` 字段保留，迁移后的存量行显示为 `socks5h`，行为与 `socks5` 相同。
  - 有效期与到期回退、质量检测、请求位置、供应商元数据与工作台、平台标签等与协议无关的代理功能全部保留。
- **行为变化：**
  - 出站代理 URL 统一为 `socks5h://`，目标域名一律交给代理解析（上游 Go 拨号器本就不区分 `socks5` 与 `socks5h`）；此前保留所选协议的 `proxyUrl()` 会按存储值输出 `socks5://`。
  - 供应商填写不带协议头的 `host:port`（含 `host:port:user:pass`）以前默认当 HTTP 代理，现在是 SOCKS5；提示文案改为“请输入有效的 SOCKS5 代理地址”。
  - 导入、编辑、供应商代理、Gateway 账号、VM 包导入遇到 `http://`、`https://` 一律返回无效代理，不再兼容。`PUT /proxies/:id` 传 `protocol` 不再有效果。
  - 供应商存的端点会被规范成 `socks5h://…`；`http:` 才会补尾斜杠，所以保存值不再带 `/`。
- **接口 / 配置 / 迁移：** 无新增接口、配置、依赖；**无数据库迁移，不改写任何存量数据**。`proxies.protocol` 列保留，生产里的 32 行是 `socks5h`、1 行 `socks5`，两者等价。`https-proxy-agent` 依赖保留：上游 `proxy-agent.mjs` 自己也用它做通用 HTTP(S) 请求，与代理池无关。
- **破坏性变更：** 见“行为变化”最后一条。仍在使用 `http://` 代理的部署（例如私有部署或其它环境），升级前必须先把代理换成 SOCKS5，否则这些代理会被 `proxy_url` 校验拒绝，绑定它们的槽位出口不可用。生产环境已于 2026-11-04 完成迁移。
- **升级指南：** 更新 Node 控制面、`web/dist`，并重建 Go helper（`kin-worker`、`kin-egress`、`kin-slot-gate`、Gateway Worker 随应用镜像一起更新）后重启。不需要 `fetch:payload`、`wrap-cli/sync`、槽位重建或重新授权。保留 `routing.json`、`vms/`、`data/`、`.env` 与持久化挂载；重启会中断连接。回滚：把代理改回 HTTP 需要回到上一版本，当前版本不再接受。
- **未处理 / 已知限制：** `docs/BUILD.md` 等记录“上游预编译 Go helper 不能替代”的理由已不再包含代理协议，但本地 Go 与上游仍有无关差异（`count_tokens`、`oauthcmd`、Gateway Worker 为本地专有），所以预编译二进制仍不能替代，本次不改构建链。历史交付记录（`RELAY_OPERATIONS_FEEDBACK.md` 等）保留当时的描述。
- **验证：** Node v22.23.4 / Go 1.27 / macOS，所有结果均与同机、同一交付基线（`b054bbcb`，本次合并后的起点）逐项对比。
  - Node 全量：`test:unit` 419 个文件，失败 6 项；`test:e2e` 46 个文件，失败 40 项。两者与基线完全相同（缺 Linux egress/OAuth 二进制、`/proc` 与 kernel/CLI ELF 的环境限制），**本次新增失败 0**。`gateway-worker-real` 真实构建并启动 Go Worker，没有跳过，经 SOCKS5 假代理走通 Responses over WS、Chat、HTTP+zstd 回退、Search、入站 WS 续接与 Receipts，并断言账号代理确实被用上。
  - Go：`go build ./...`、`go vet ./...`、`gofmt -l` 无输出，`go test -race -count=1 ./...` 全部通过。
  - 前端：`tsc -b`、`prettier --check` 通过，`vitest` 116 个文件 870 项通过（基线同样全过，没有测试被删除）；四语 i18n 覆盖测试通过。
  - 新增/改写的回归：`proxy-socks-only`（去重不看协议名、`http://`/`https://`/`ftp://`/带路径或查询串的 URL 被拒绝而不是误解析、`protocol` 编辑无效）；Go Worker 的 SOCKS5 假代理夹具；供应商端点规范化与拒绝 `http://`。
  - 反向清扫：逐文件核对相对上游的差异，修正了多协议遗留的 4 处生产代码（`proxy-resolve.mjs`、`proxy-geo.mjs`、`codex-models.mjs` 把 `socks5://` 转成 `socks5h://` 的转换被删，已恢复）和相应的 4 个期待值；剩余差异均为有意的本地定制。
  - 并行交付：起点 `22a095cf` 之后交付远端先后前进到 `b054bbcb`、`a0f32f84` 与 `626c6704`（后者为网关主线程减负：代理探测不再同步 fork `ss`、出口就绪改为异步；成本小时预聚合与窗口容量预测、余额扣款、额度恢复与官方点数开关等），均以前一交付为三方基准并入其增量，未覆盖或回退（`626c6704` 触及的 `egress.mjs`、`proxy-pool.mjs` 自动合并后逐处核对，异步就绪检查沿用且探测仍是 SOCKS5 握手）；其间新增的迁移 093 与本次无关，无编号冲突。上面的 Node 全量对比取 `b054bbcb` 为基线；并入 `a0f32f84` 后重跑 Go 全量（`-race`）、前端全量，并对其 20 个文件的增量涉及的 61 个 unit 文件和 4 个 e2e 与 `a0f32f84` 基线对比：候选 590 通过 1 失败，基线 585 通过 2 失败，**无新增失败**（共同失败的 1 项为基线既有的 `supplier UI endpoints…`）。并入 `626c6704` 后再对 egress、proxy、vm-package、vendor、gateway、cache-prefix、slot-recovery 相关 unit 与 3 个 e2e 同基线对比：候选 377 通过 4 失败、基线 378 通过 4 失败，失败集合完全相同，**无新增失败**；Go 全量 `-race` 通过（通过数少 1，是因为基线独有 3 项（HTTP CONNECT、协议保留、SOCKS5H 地理探测）已随多协议删除，候选独有 2 项（SOCKS5 地理探测改名、仅接受 SOCKS5））。
  - 未覆盖：Linux 专属检查与镜像构建交给 CI；未对真实供应商重新做 HTTP→SOCKS5 的探测（生产已迁移，见“需求与依据”）。本次未部署、未改生产数据。

## 2026-11-04 网关主线程减负：代理探测不再同步 fork `ss`，缓存连续性诊断只为首个差异消息建完整记录

- **依据（生产实测）：** 第一阶段减负上线后（v1.4.038.9 / .10），11-04 06:30–06:46 UTC 高峰期 86 个 10 秒窗口：事件循环利用率 0.55–0.61，92–97% 的窗口 p99 延迟 > 200ms，76–81% 出现 > 500ms 停顿，已超过 `docs/performance/process-split-plan.md` 第 0 节门槛；负载与每分钟推理量相关（r = 0.91），已计时的四个阶段只占约 2%。经授权在 06:48 对主进程做 60 秒 CPU profile（SIGUSR1 调试端口，采后关闭）：cache-prefix 的 `snapshotBody` + `describeCacheContinuity` 约 15%，面板 `listCodexAccounts → codexAccountUsage` 约 11%，代理探测 `probeOne → egressCheck → waitListen → execFileSync('ss')` 在主线程同步 fork 子进程并以 `Atomics.wait` 轮询。
- **优化改进：**
  - **代理出口探测：** `egress.mjs` 的 `portListening` 在本 PID 命名空间（未设 `KIN_EGRESS_CMD_PREFIX`，生产即此情况）直接解析 `/proc/net/tcp`、`/proc/net/tcp6` 的 LISTEN 行，需核对归属时以 socket inode 对照 `/proc/<pid>/fd`；匹配规则与原 `ss` 判定相同（精确 IPv4 主机或 `0.0.0.0` / `::` 通配）。设置了命令前缀或 `/proc` 不可读时仍走原 `ss` 路径。`waitListen` 由同步睡眠循环改为异步等待，`egressListening` / `proxyEgressReady` 随之改为异步，调用方 `proxy-pool.probeOne`、`slot-recovery` 出口检查、`startProxyEgress` 改为 `await`。
  - **缓存连续性诊断：** `firstHistoryDiff`（每次 Claude 尝试都经 `describeCacheContinuity` 调用）原先对入站、出站各建一份完整快照（逐消息哈希 + 逐块哈希 + 尾部 24 条字段印记）。现改为每条消息只取一次整体哈希定位首个差异，仅在该下标构建完整记录；出站与入站为同一消息对象时复用哈希。输出不变。
  - 本地对照（随机构造、含 7 类真实差异的 28 个用例，新旧输出逐字段相等）：`describeCacheContinuity` 3.3MB 请求体 42.5ms → 16.6ms，1.5MB 19.5ms → 8.7ms，0.6MB 9.8ms → 4.2ms。
- **Bug 修复：** 无（性能问题）。
- **评估后未改动：** 面板 Gateway 账号用量（`codexAccountUsage`）已由本日“账号成本改读小时预聚合”条目改为读汇总表（生产实测 476ms，本地对照 207ms → 5ms），本次不再移入工作线程，避免为约 5ms 的查询把调用链改为异步；该条目尚未部署，生产采样仍是旧实现。曾尝试在哈希前跳过 `cache_control` 深拷贝，基准无可测收益，已撤回、未保留。
- **上游取舍（例外保留）：** `egress.mjs`、`proxy-pool.mjs`、`slot-recovery.mjs`、`cache-prefix.mjs` 均为上游文件。依据为上述生产 profile 的可复现主线程阻塞；最小范围：只改端口检查的数据来源与等待方式、`firstHistoryDiff` 的快照构建，判定规则与诊断输出不变，`snapshotBody` / `prepareCachePrefix` / `peekCachePrefix` 未改。移除条件：上游提供等效的非阻塞端口检查或增量诊断时收敛回上游。
- **破坏性变更：** 无对外接口变化。内部导出 `egressListening`、`proxyEgressReady` 改为返回 Promise（仓库内调用方已全部改为 `await`）。
- **升级指南：** 无配置、无迁移；部署控制面后自动生效。本轮未部署。
- **清理：** 删除 `egress.mjs` 中随同步等待一起失效的 `sleepMsSync` 与 `egressWaitLock`。
- **已知限制：** `waitForListenerPid`、`listenerPid` 只在出口进程启动时运行，仍调用 `ss`，本次未改。本次未处理的 profile 热点：协议拦截（`distill-detect`、`jev-*`、`refusal-guard`，约 10%）、调度选座与 `refreshKeyScope` 每次调用重新 `prepare`（约 10%）、请求体 `structuredClone`、Gateway 请求签名哈希。
- **验证：** `cache-prefix`、`fable-cache-continuity`、`persona-outbound-contract`、`quota-critical-band`、`proxy-pool-bind`、`slot-recovery` 单测 296/296 通过；`egress` 单测 macOS 上 21 通过、3 失败、12 跳过，与未修改基点相同（缺 `bin/kin-egress`），Linux 专属用例由 CI 执行。生产只读抓取的 `/proc/net/tcp{,6}` 与 `ss -ltn` 快照上，新判定与原 `ss` 规则 369 个用例 368 个一致（唯一差异为 `127.0.0.53%lo` 这种带网卡后缀的地址，出口配置不会出现）；生产只读确认 kin-egress 监听 socket 的 inode 出现在其 `/proc/<pid>/fd`。修改文件 Biome 通过。

## 2026-11-04 Codex 账号额度用尽后默认不再消耗 ChatGPT 官方点数（新增开关，默认关闭）

- **依据（生产只读数据）：** 19 个 Gateway Pro 账号中 9 个有官方点数（余额约 5.3 万～6.2 万）。账号 92b51005 于 11-04 02:22 UTC 周窗口到 100% 后仍成功处理 412 个请求，点数余额由 53747.81 降至 53205.71（约 542 点），此前余额一直不变；无点数的 10 个账号用满后由上游 429 停放。原因是 Worker 对齐 CPR：快照有可用点数即放行，调度不按窗口百分比排除，成功推理还会解除额度停放；VM 路径的 `hasSpendableCodexCredits` 同样放开窗口上限。自动使用重置卡只在卡片到期前触发，与额度用满无关。
- **新增功能：** 设置 → OpenAI 新增“额度用尽后使用官方点数”（`routing.codex.credit_overage`，默认关闭），经 Gateway 心跳下发给所有实例，VM 路径读取共享的 routing 文件。
- **优化改进：** 关闭时，Gateway Worker 在推理响应头、流内额度或 `/wham/usage` 快照显示套餐窗口 100% 未重置且账号有点数时，把账号停放到窗口恢复（与额度耗尽同一结论，由额度刷新解除），成功推理不解除；`/wham/usage` 的可用点数不再放行。由关闭改为开启时立即解除仍有点数的停放，每次下发关闭都复核全部账号。VM 槽位不再因点数放开 5h/7d 上限。
- **CI 修复：** 第二档诊断字段遗留的 4 处 Biome 格式问题（`request-log.mjs`、`gateway-execution.mjs`、`panel-routes.mjs` 与 `request-log.test.mjs`）导致上一次推送的 unit 格式检查失败，已按 Biome 重排，不改逻辑。
- **上游取舍：** Gateway Worker 与额度停放为本地定制功能；VM 路径的点数放行沿用现有实现，只加开关判断，不涉及上游文件变更之外的重写。
- **破坏性变更：** 升级后默认不再消耗官方点数——有点数且窗口已用满的账号会停到窗口重置，可接单账号数相应减少；需要用点数补量的运营者须在设置中打开开关。
- **升级指南：** 无迁移。上线后 Worker 在首个心跳后复核全部账号；如需保持旧行为，打开该开关并保存即可，无需重启。
- **验证：** Worker 包 `go test -race` 通过，新增默认停放、成功不解除、开启解除、关闭复核、无点数账号不受影响、窗口重置后解除及 `/wham/usage` 周窗口无 reset_at 形态的回归；Node 新增开关关闭（含缺省与路由文件不可读）时 VM 槽位停放、心跳下发默认值测试，相关单测 893/893 通过；前端 `tsc -b`、eslint、prettier 通过，全仓 Biome 与 gofmt 检查通过。生产仅只读查询，未部署。

## 2026-11-04 账号成本改读小时预聚合；VM 与 Gateway 窗口容量改用 CPR 增量采样预测，列表成本列显示 7D 预计

- **依据：** 生产只读实测（10 个 Gateway 账号、1.7 万条 Gateway 记录），「Codex 账号」列表的 `codexAccountUsage` 单次要 476ms：`usage_logs` 没有 `account_resource_id` 索引，每个账号都要扫一遍全部 Gateway 记录，而列表每 5 秒轮询一次。虚拟机路径的 `billingStats` 也是每次全表聚合加逐行读取 7 天明细。用户在对照 NewAPI、codex-proxy-rs（CPR）用量窗口与成本的实现后，明确要求做 CPR 式预聚合与容量预测，并且 VM 账单统计与 VM 估算也一起改用（2026-11-04 用户决定，超出“上游优先”的默认取舍，见下方上游取舍）。
- **新增功能：**
  - **小时预聚合：** 迁移 `093_usage_cost_rollup.sql` 新增 `usage_cost_hourly`，按小时 × 计费账号键（`final_account_id` → `account_id` → `vm_id`）× 槽位 × 执行方式 × Gateway 账号 × 是否 Fable × `status` / `error_code` 汇总请求数、token、各项费用和未定价数。由 `usage_logs` 的插入、更新（成本补算、区间重算、Gateway 回执改写 `vm_id` / token / 成本）、删除（保留期清理）三个触发器精确维护；迁移时从现有记录回填（生产规模约 1300 行，回填约 0.3 秒）。成功 / 失败不在触发器里判定，读取时对 `status` / `error_code` 套用现有 `usage-log-preds` 谓词，错误码表以后改动也不会失真。另加 `usage_logs` 两个索引：计费账号键表达式 + `created_at`、`account_resource_id` + `created_at`。
  - **窗口容量预测：** 新增 `quota_observations`，VM 槽位在已用% 或重置时间变化时记一行（Codex：响应头 `persistCodexUsage` 与 `/wham/usage` 快照；Claude：响应头与 `/api/oauth/usage` 经 `_rollWindowHistory`；重置抖动 60 秒内视为同一窗口，无重置时间的读数不记，保留 9 天）。CPR 采样算法从 Gateway 实现抽为 `src/lib/usage/quota-capacity.mjs`（按 ≥5 个百分点切块、取最近 3 块加尾部外推剩余；无配对历史时退化为“本周期花费 ÷ 已用%”，即原上游口径），Gateway 周 / 月预测与 VM 的 5h / 7d / Fable 估算共用。
  - **列表成本列：** 「虚拟机」与「Codex 账号」列表的成本列在 5H / 7D / 总计下加一行「预计」，显示 7D 窗口容量 `≈$X` 与 token；无法估算时显示「—」，悬停说明原因（新增状态“额度回落，正在重新采样”、样本偏少、含未定价请求）。机架卡片与机架合计不显示。
- **优化改进：**
  - `UsageLogsRepo.costByAccount` / `_computeBillingStats`：整小时读汇总表，窗口起点所在的那一小时按账号走表达式索引读明细；滚动窗口总计由账号桶相加，不再扫 5h / 7d 原始行。删除被替代的 `_costEventsSince`、`groupCostEvents`，`costByAccount` 去掉无调用方的 `until` 参数。
  - `GatewayWorkerRepo.codexAccountUsage`：今日 / 5H / 7D / 总计全部改读汇总表加边界小时。
  - Gateway 预测 `quota-forecast.mjs` 改调通用模块，累计用量改为排序前缀和 + 二分查找（原为每个观测点重扫全部行）；修正已用比例未知时访问空样本会抛错的问题。`/api/panel/codex-accounts` 列表行新增 `usage.estimate_7d`，每个账号按周窗口已用% / 重置时间缓存，最长 5 分钟重算一次。
  - 本地合成数据（30 万行、30 个账号、7 天）对比：`billingStats` 对齐窗口 1224ms → 21ms，滚动 422ms → 8ms，`codexAccountUsage`（10 账号）207ms → 5ms。
- **Bug 修复：** Gateway 额度预测在快照没有已用比例时会因空样本抛错，现在返回“已用比例未知”。
- **上游取舍（例外保留）：** `billingStats` 及其辅助函数、`window-estimate.mjs` 的 `estimateWindow` 属于上游代码。按用户 2026-11-04 的明确决定改写：上游统计改读预聚合（输出字段与口径不变，等价性测试逐项比对直接扫描结果），上游 `estimateWindow`（花费 ÷ 已用%）由 CPR 采样替代并删除，`projectWindowRemaining`（上一窗口兜底）保留上游实现。最小范围：只动账号成本统计与窗口估算，其余上游统计（仪表盘聚合、日志、`costBetween`）不变。移除条件：上游提供等效的预聚合或容量预测时收敛回上游。
- **破坏性变更：** 估算 `status` 去掉 `unpriced`，新增 `resampling`；有未定价请求时改为照常给出金额并标记 `incomplete_cost`，不再整体不显示。`low_usage` 的含义变为“有效采样进度不足 5 个百分点”。`usage_logs` 每次写入多一次触发器 upsert 和两个索引维护，本地实测单行写入 28µs → 120µs（生产峰值每秒 1–2 次写，可忽略）。迁移 093 新增触发器，以后迁到 PostgreSQL 时需要一并移植。
- **升级指南：** 迁移 093 随启动自动执行，无配置项。上线后在每个槽位第一次记下额度观测之前，VM 估算显示“无用量读数”（Codex 槽位下一次请求、Claude 槽位下一次用量探测后恢复）；配对样本需要累积 5 个百分点以上才从“花费 ÷ 已用%”切到增量采样。部署控制面与前端后生效；本轮未部署。
- **已知限制：** 预测只读、不参与计费和调度；Gateway 列表预测最多晚 5 分钟；`quota_observations` 只记 VM 槽位（Gateway 继续用回执里的额度观测）；未在浏览器中实际查看列表新行，仅做了组件渲染测试。
- **验证：** 新增 `usage-cost-rollup`（随机 1500 行跨 9 天，经插入 / 改价 / 改槽位 / 改模型与状态 / 结算字段更新 / 保留期删除后，对齐与滚动窗口逐账号和直接扫描比对；回填与触发器结果一致；去掉边界小时读取后测试失败，已做变异确认）、`vm-quota-forecast`（观测去重与重置抖动、无历史退化、增量采样、回落重采、账单统计附带预测）、Gateway 列表预测缓存与重算、成本列预测行渲染；更新估算、账单查找、统计线程、迁移清单用例。Node 单测全量 419 个文件中 415 个通过，失败的 4 个（`egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status`）在未修改的 `22a095cf` 上同样失败；受影响范围 115 个文件 1144 项与 `panel-billing-worker`、Gateway 账号、Fable 用量上限、用量刷新 e2e 通过；前端 `tsc -b`、相关 9 个测试文件 83 项、修改文件 ESLint / Prettier、后端修改文件 Biome 通过。生产数据仅只读查询。

## 2026-11-04 用户余额弹窗支持扣款，管理员扣回的金额退回域共享余额

- **问题：** 「用户」页 → 余额与流水弹窗只能充值，金额输入框限制最小 0.000001，输入负数被浏览器拦下；超管后端已有 `operation: subtract`，但界面没有入口；管理员只能从域共享余额转出，无法扣回误充的金额。
- **新增功能：** 弹窗增加「充值 / 扣款」切换，金额仍填正数，按钮随之显示「确认充值 / 确认扣款」，扣款时显示去向说明；「充值原因」改为「原因（选填）」。超管扣款直接减少其直接创建用户（或管理员域）的余额；管理员扣款通过反向转账把金额从同域普通用户退回域共享余额，双方各写一条 `transfer` 流水，审计动作 `wallet.reclaim` 记在被扣款用户上。
- **接口：** `POST /api/panel/users/:id/balance` 对管理员接受 `operation: "subtract"`（此前仅 `add`），其他值返回 403；超管行为不变。扣款金额超过用户可用余额返回 409 `insufficient_balance`；同一幂等键不能反向重放（409）。
- **上游取舍：** 资金体系为本地定制功能；复用现有 `RelayBilling.transfer`（新增 `reclaim` 选项只改审计对象），不新增扣款路径。
- **破坏性变更 / 配置 / 迁移：** 无。
- **升级指南与限制：** 部署控制面与前端后生效；本轮未部署。不同域、非直接创建关系的权限边界不变。
- **验证：** `admin-wallets` 新增扣款用例（管理员扣回、幂等重放、反向重放冲突、超额 409、跨域 404、非法操作 403、审计对象、超管直接扣款），该文件 8 项通过；Biome、`tsc -b`、ESLint、Prettier、i18n 测试通过；本地临时库实测界面以管理员扣款 5（用户 10→5、共享余额 10→15）、超额扣款提示「可用余额不足」。

## 2026-11-04 Gateway 账号 5H / 7D 成本在额度窗口已过重置时与虚拟机同口径

- **问题：** 「Codex 账号」列表与详情、供应商账号池的 5H / 7D 成本与 Token 按 Worker 上报的额度窗口对齐：重置时间在未来时取 `[reset − window_minutes, now]`。重置时间已经过去、Worker 还没复核拿到新快照（正常账号在重置 2 分钟后复核，耗尽账号 10 秒后）这段时间里，Gateway 统计直接退回“最近 5 小时 / 7 天”滚动窗口，把上一个额度窗口的消耗也算进来；虚拟机行（`extraWindowSince`）同样情况下从重置时刻起算。
- **Bug 修复：** `GatewayWorkerRepo.codexAccountUsage`（`src/lib/gateway-worker/gateway-repo.mjs`）改用 `extraWindowSince` 计算窗口起点：重置在未来时取 `reset − window_minutes`，已过重置时从重置时刻起算，没有重置时间才回退滚动窗口。窗口时长仍优先取 Worker 上报的 `window_minutes`。供应商门户账号池复用同一函数，一并生效。
- **上游取舍：** Gateway Worker 为本地定制功能，复用上游已有的 `extraWindowSince`，不新增窗口计算逻辑。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无；接口字段不变。
- **升级指南与限制：** 部署控制面后自动生效，无需前端构建；本轮未部署。与虚拟机路径一致，起点不按窗口时长截断：重置时间长期未刷新时，窗口会从那次重置一直算到现在（有用量的窗口会在重置后几分钟内被 Worker 复核，实际影响很小）。
- **验证：** `gateway-account-management` 新增用例覆盖已过重置、未来重置、无重置回退三种起点（改前已过重置用例得 5、期望 1，失败；改后通过），该文件 22 项通过；连同调用 `codexAccountUsage` 的 `vendor-portal-view`、`vendor-review` 单测共 45 项通过；修改文件 Biome 通过。

## 2026-11-04 Gateway 容量拒绝先同号退避再换号、提交前预算 60 秒、无可接单 Codex 槽位时不回退 VM

- **依据（生产 v1.4.038.7 只读数据，11-03 13:35～11-04 05:00 UTC）：** 14,505 次 Gateway 请求中 4,832 次以 `server_error` 失败，集中在 01–04 点；高峰期各账号容量拒绝率均为 30%～36%（与并发上限无关），出现拒绝的分钟里 76% 同时有 3 个以上账号被拒；首次被拒后换号只有约 25% 成功；同一会话换号的请求未缓存输入占比 25.2%，同号 5.5%。同期 5,998 次回退 VM 全部以 `no_codex_vm` 503 结束。
- **优化改进：**
  - **容量拒绝：** `server_is_overloaded` / `slow_down` 改为先同号退避（最多 3 次，500ms 起翻倍、单次最长 8s，遵守 `Retry-After`）再换号，对齐 CPR RetryThenRotateAccount；客户端重试抑制只作用于 503 `server_error`。全池过载熔断保留，在同号退避用完后计数，停止时 `Retry-After` 至少 3 秒。
  - **提交前预算：** 同号重试与换号的总时长上限由 30 秒调到 60 秒，容下 3 次同号退避加 1～2 次换号；`Retry-After` 超过剩余预算时仍不截短、原值交回客户端。不照搬 CPR 的 240 秒等待，避免长期占用并发名额。
- **Bug 修复：** Gateway 未发出请求时，只有分组绑定的 Codex VM 中存在能接单的槽位（凭据可用、未停用、在服务时段内、允许该模型；额度停放的槽位仍算）才回退 VM；否则原样交付 Worker 的错误与 `Retry-After`，不再以笼统的 `no_codex_vm` 503 结束。
- **测试稳定性：** `panel-users` e2e 在网关子进程仍写请求日志时直连 SQLite 改库，偶发 `database is locked`（上一次推送 CI 即因此失败）；三处直连改为带 5 秒 busy timeout。
- **上游取舍：** Gateway Worker 与回退为本地定制功能，不涉及上游文件。VM 路径（`handle-codex.mjs`）的过载规则保持立即换号，不在本节修改。
- **破坏性变更：** 上游整体过载时，单个请求在交付失败前最多多等约 3.5 秒的同号退避；回退条件变严，分组只绑定了不可用 VM 时客户端会收到 Worker 的原始错误而不是 `no_codex_vm`。
- **升级指南：** 无迁移与配置变更。亲和保持 `preferred`、单账号并发保持运营设置；上线后观察同一会话相邻两轮的换号率，若仍高于约 20% 再评估切换 `strict`。`Retry-After` 实际分布由上一节新增的 `retry_after_ms` 积累后再细调预算。
- **验证：** Worker 包 `go test -race` 全部通过，更新并新增回归覆盖容量同号退避后换号、同号恢复不换号、退避序列与 Retry-After 上限、单账号耗尽、全池熔断（同号退避后计数、Retry-After 至少 3 秒）、流内过载、健康池继续换号、客户端重试抑制；Node 新增“分组有 VM 但无可接单槽位时不回退”与 `hasServiceableCodexSlot` 判定测试，受影响范围单测与 `panel-users` e2e 通过。生产数据仅只读查询，未部署。

## 2026-11-04 Gateway Worker 第二档对齐 CPR：上游 WS 连接管理、请求头与身份、OAuth、调度细节、额度展示与请求诊断

- **背景：** 上一节修正了第一档偏差，本节补全按 CPR 源码逐项对照后剩余的第二档差异；API Key 上游账号/PAT 导入与多 Worker 刷新租约按决定暂不实现。
- **上游 WS 连接管理（对齐 CPR transport/websocket）：** 每条连接有读循环，空闲时每 25s Ping，断线即剔除，每 5s 清扫失效、超龄与空闲连接；冷建连经全局建连名额（128/1024，后台入池 16）与按“源站 + 账号出口”分开的半开熔断（只计冷建连，opening 5xx/超时记失败）；新链与持久续接最多等 800ms 建连，超时本次走 HTTP、后台连接入池；首个语义输出前断线同账号恢复（5 次，200ms 起退避）；completed 与 interrupted 回池并作为连接内续接唯一可用的响应，其他 incomplete、failed 与 `error` 帧丢弃连接；预热、入站 WS 的 store=false 新链与连接内续接必须走 WS，不可用时要求客户端重放；`response.create` 保留 `stream:true`，握手带 turn-state；`codex.rate_limits` 不转发、并入额度，metadata 帧的 turn-state 交给客户端；发送超时 5 分钟、不限消息大小；官方发布核验启动即执行，失败 1～60s 退避重试。
- **请求头与身份：** 原生 Responses 按 CPR 黑名单透传其余入站头（Node 与 Worker 两层过滤），转换协议与 Live 仍用白名单；session/thread、turn metadata、`x-client-request-id` 缺省值与 `betaFeatures` 等正文字段按 CPR 优先级推导为请求头；API Key 账号也带画像身份头；客户端与 TLS 会话按“账号 + 代理”隔离。
- **OAuth：** 授权 URL 改为 127.0.0.1 回调、画像 Desktop 版本、两个 stable_id 与内外层 streamlined；回调必须带 code 与 state（常量时间比较、16KiB 上限、90s 互斥认领），供应商门户路径不再接受只交 code；刷新改为 JSON 正文、画像 originator/UA、30s、64KiB、校验 id_token、缺失字段保留原值；刷新失败记录脱敏诊断；新增默认关闭的 OAuth 恢复日志（`KIN_CODEX_GATEWAY_OAUTH_RECOVERY_LOG`）。
- **调度细节：** 客户端轮次 300s 内已因 503 server_error 失败时跳过同号退避；Cloudflare 挑战只让 Cookie 过期、路径封禁清空 Cookie；`Retry-After: 0` 不冷却；关闭排队时返回 503 `account_capacity_unavailable`；健康分只计 CPR 闭集错误；建连重试 500ms 起翻倍带抖动；排队平手按权重。
- **额度与账号：** 具名额度桶（响应头与 `/wham/usage`）在账号详情展示；额度拒绝后 1～3s 回读 `/usage` 只更新展示；`x-models-etag` 变化时刷新目录；套餐泛化值不覆盖具体 SKU；人工恢复重置全部凭据状态；停用账号也保持刷新；头像地址取自账号资料，不再接受调用方 `source`。
- **请求诊断（对齐 CPR 5100f633）：** 迁移 `092_gateway_request_diagnostics.sql` 新增使用记录的错误分类、结构化上游错误、WS 关闭码、续接不可用原因、连接退出原因、重试等待，以及请求尝试的上游请求 ID 与 cf-ray；Worker 经失败响应头与流式 trailer 交付，日志详情“网关诊断”区块显示，只对超级管理员投影。
- **上游取舍：** Gateway Worker 为本地定制功能，对照对象是 CPR，不涉及上游文件取舍。
- **破坏性变更：** 原生 Responses 请求会透传更多调用方请求头（黑名单之外的头）；必须走 WS 的请求在 WS 不可用时返回 `previous_response_not_found`；Cloudflare 挑战不再冷却账号；头像接口忽略 `source` 参数；Worker 握手回调地址由 localhost 改为 127.0.0.1。
- **升级指南：** 迁移 092 只加 NULL 列，历史行不变。Worker 与控制面一起升级。OAuth 恢复日志默认关闭，开启后数据目录会保存原始令牌，需按安全要求控制目录访问。
- **已知限制：** 空闲时才 Ping（流式期间由 300s 流空闲超时判定）；多值请求头合并透传；cyber_policy、客户端重试抑制与会话绑定只在单个 Worker 进程内；没有 `recovered` 关联事实；Worker 目录不按 Key 范围选账号（控制面按分组目录作答）；不支持 API Key 上游账号、PAT 导入与跨实例刷新租约。
- **验证：** Worker 包 `go test -race` 全部通过，新增回归覆盖熔断半开、快路径入池复用、终态回池与 rate_limits/metadata、语义边界前恢复、空闲断线不复用、必须走 WS 的预热、身份头推导、具名额度桶与套餐归一、恢复与回读、目录 ETag、API Key 画像头、授权 URL 与回调校验、刷新报文与恢复日志、调度细节、客户端重试抑制、诊断头与 trailer、刷新失败诊断；Linux amd64 `CGO_ENABLED=0` 编译通过。Node 受影响范围 572 项单测通过（含新增黑名单透传、诊断记录、trailer 读取、诊断投影权限与迁移清单）。前端 `tsc -b`、修改文件 eslint/prettier 与 14 个相关测试文件通过；未在浏览器中实际操作，未调用真实 OpenAI。

## 2026-11-04 上游代理探测改为经隧道验证（版本仍为 1.4.038）

- **来源与范围：** 官方上游从 `04d3a5980dfa672772eeebb3ad23bae46c93216e` 推进到 `d25f177756606602422cbdc44040d4d562ce50d6`（VERSION 与根 CHANGELOG 未变，仍为 1.4.038），增量为上游 PR 878（代理探测经隧道验证）及随后的测试格式化提交。以已交付 `1dfe64bd06072abdd8a56aeaa19529d0c54f7181` 为合并起点，只涉及 `src/lib/vm/proxy-pool.mjs` 与 3 个测试文件。
- **采用上游：** 本机/私网地址上的 SOCKS5 转发器（sing-box、clash、3proxy 等）以前只要监听端口能连上就判健康，后端节点失联也发现不了。现在完整采用上游的“握手 → 用户名密码认证 → CONNECT”流程：先经代理连 `1.1.1.1:443`，目标不可达时再试 `8.8.8.8:53`，成功才算存活，延迟取经隧道的往返时间。远端 SOCKS5 出口仍只做握手。新增错误码：`proxy_auth_required`、`proxy_auth_failed`、`proxy_auth_unsupported`、`egress_unreachable`、`egress_timeout`。上游新增的探测测试原样保留。
- **行为变化：** 代理应答“无可接受的认证方式”（`0xff`）以前被当作健康，现在判为探测失败；本机转发器后面的节点失联时被判为不可用，从而退出自动分配。探测失败只影响代理健康状态与自动分配，不删除代理，也不解除已有绑定。
- **必要融合：** 无。此前为 HTTP/HTTPS 出口保留的“TCP/TLS 连通即成功”分支已随多协议功能一起删除（见 2026-11-04 “代理只支持 SOCKS5”），探测与上游逐字一致。
- **新增功能 / 接口 / 配置 / 迁移：** 无新增接口、配置、依赖或数据库迁移。
- **破坏性变更：** 见“行为变化”。
- **升级指南：** 只更新 Node 控制面后重启（部署完整应用镜像亦可）。不需要 `web/dist`、payload、`wrap-cli/sync`、槽位重建或重新授权。保留 `routing.json`、`vms/`、`data/`、`.env` 与现有持久化挂载；重启会中断连接。本次推送的版本号未递增，只触发普通 CI，不自动发版。
- **验证：** Node v22.23.4/macOS。引用代理池的 36 个单测文件（含上游新增的探测测试）315 项全部通过，同机 `1dfe64bd` 基线同一批 310 项通过，差的 5 项正是新增测试，逐项对比无新增失败。HTTP 出口连通、端口关闭、非 SOCKS 监听三种情况的探测结果与基线一致。无 e2e 直接引用代理池。Biome 格式检查通过。未改前端、迁移、payload 与 Go，不重复跑全量；全量矩阵与 Linux 检查由 CI 负责。本次没有部署生产，也没有操作生产数据。

## 2026-11-04 Codex 账号行菜单与详情卡增加「编辑账号」

- **需求：** 用户要求 Codex 账号列表的行菜单（「…」）增加「编辑账号」。
- **新增功能：** Codex 账号页行菜单首项新增「编辑账号」，点击详情卡底部同样新增「编辑账号」按钮，均打开原有的账号编辑对话框（名称、分组、代理、并发、RPM、权重、模型范围、调度、备注）。详情页的编辑入口保持在「账号」页签。虚拟机页不显示该项。
- **实现：** `VmActions` 新增可选 `openEdit`，未提供时行菜单与详情卡不渲染；Codex 列表页与详情页提供该回调。新增四语文案 `vm.vmActionMenu.editAccount`、`vm.vmDetailCard.editAccount`。「分配给分组」保留（与虚拟机菜单一致，同样打开编辑对话框）。
- **上游取舍：** 官方上游没有 Gateway Worker，本节为定制差异；虚拟机菜单与详情卡不变。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。**升级指南：** 部署前端后生效；本轮未部署。
- **验证：** Web `tsc -b`、Prettier 检查与 `vitest run` 116 个文件 868 项通过；新增断言：Gateway 详情卡显示「编辑账号」、虚拟机详情卡不显示。改动文件 ESLint 唯一错误为 `vm-action-menu.tsx` 既有的重复 `@/i18n` 导入（本轮未引入）。未在浏览器中目检菜单。

## 2026-11-04 Codex 账号页代理列、标识与详情概览继续对齐虚拟机页

- **问题：** 用户对照截图指出 Codex 账号页仍有不少地方与虚拟机页不一致：状态列代理只显示灰色 `主机:端口` 文本，而虚拟机显示带地球图标、健康底色与延迟的代理标签；账号次行显示完整资源 id `account_<uuid>`；详情页概览是自绘的两张卡片，与虚拟机详情页「现状 / 额度 / 运行」状态板、计费窗口不同。
- **优化改进：**
  - 代理：Gateway 账号按 `proxy_id`（平台代理池 id 或供应商代理资源 id）或手填地址的主机端口匹配代理池记录，列表、机架卡片、详情卡、详情页统一使用虚拟机的代理标签（健康底色、延迟、名称）；池外手填地址显示「未测」。超管点击标签探测出口时，池内代理调用 `POST /api/panel/proxies/:id/geo`，池外地址不可点。
  - 标识：列表、机架卡片中 Gateway 账号 id 只显示 uuid 首段（如 `06a6f35e`），悬停显示完整 id；虚拟机仍显示槽位 id。
  - 详情页概览直接复用虚拟机详情页的状态板（现状、额度含券查询 / 重置券、运行）、计费窗口（5H / 7D / 今日，含输入输出与缓存）与按模型成本；「运行」栏把槽位调度与内核字段换成 Gateway 字段：并发（在途 / 上限）、RPM 上限、权重、Worker 同步、投影。页头与虚拟机一致加入节点标签与运行 / 停止文字，去掉重复的账号状态标签。账号页签的代理字段同样使用代理标签。
- **实现与清理：** 删除 `VmActions.renderProxy` 扩展点及 `StatusCell` 的 `proxy` 参数、机架与详情卡的分支（恢复上游 `ProxyChip` 直接渲染），删除 `ProxySummary`、`AccountIdentity`、`AccountState`、`AccountUsage`；新增 `VmActions.exitProbePath`（代理标签探测接口，未提供时为 VM `/exit-probe`）。`OpenaiQuotaPanel` 与列表的券操作一样支持 `VmActions.openaiQuota` 覆盖；`VmStatusBoard` / `VmOverviewTab` 新增可选 `runtime`（替换「运行」栏槽位字段，未提供时虚拟机不变）。券查询 / 重置券逻辑抽成 `useGatewayQuota`，列表与详情页共用。后端 `listCodexAccounts` 的 `usage` 增加 `window_5h_*` / `window_7d_*` 的 `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`。新增四语文案 `common.codexRpm`、`codexWorkerSync`。
- **上游取舍：** 官方上游没有 Gateway Worker，本节为定制差异；`ProxyChip` 在虚拟机页的行为与上游一致，`renderProxy` 删除后 `vm-list-table.tsx` 的代理渲染恢复为上游写法。
- **破坏性变更：** 无。**接口 / 配置 / 迁移：** 无新增接口、配置或迁移；`GET /api/panel/codex-accounts` 的 `usage` 多 8 个窗口 token 字段。
- **升级指南：** 部署控制面与前端后生效；本轮未部署。
- **已知限制：** 池外手填代理没有健康与延迟数据，只显示「未测」；计费窗口按账号额度窗口起点统计（与列表成本列同口径）。
- **验证：** Web `tsc -b`、Prettier 检查与 `vitest run` 116 个文件 868 项通过，改动文件 ESLint 无错误；新增测试：代理池匹配（池 id / 供应商资源 id / 主机端口 / 池外地址）与探测路径、计费窗口映射、短 id、详情卡代理标签（健康底色与延迟）、详情页复用状态板与计费窗口且不显示槽位调度；Node `gateway-account-management` 21 项通过（新增窗口 token 拆分断言），Biome 通过。本机以临时数据（`account_<uuid>` 账号、池内代理与手填代理）启动控制面与前端，对照虚拟机页目检列表、详情卡与详情页概览。

## 2026-11-04 Gateway Worker 按 CPR 功能级对照修正 WS 复用、长流截断、额度与凭据判定、亲和与 cyber_policy，新增自动使用重置卡

- **背景：** 增量提交已追到 CPR `1915806b`，但按传输、凭据与额度、执行与调度、数据面四个方向逐项比对 CPR 源码后，Worker 有多处与 CPR 行为不一致，部分会产生错误行为。本节修复影响最大的一档，其余差异列入实施文档“已知差异”。
- **Bug 修复：**
  - **WS 跨会话复用：** 上游 WS 空闲池原来只按账号分键，A 会话握手的 session-id、thread-id、turn metadata、UA 会被 B 会话复用。现按账号 + 出口 + 调用方范围 + 会话锚点 + 握手画像头分键（CPR `websocket_pool_key`），没有会话锚点的连接用后即关。
  - **turn-state 重放：** 复用连接时每轮都重放首次握手的 `x-codex-turn-state`，客户端拿到过期 token。现在握手响应头只交付建连后的首个响应（CPR `reusable_websocket_metadata`）。
  - **长推理流被截断：** Worker `http.Client.Timeout`、执行上下文与控制面到 Worker 的计时器都把流式正文算进 900 秒，超过 15 分钟的流会被切断。现在 900 秒只约束提交前；上游正文按 300 秒读取空闲判定中断（CPR `UPSTREAM_STREAM_IDLE_TIMEOUT`），控制面收到响应头后改为 330 秒套接字空闲。
  - **额度判定：** 推理响应头显示 100% 就排除账号、可用点数被忽略、冷却到期即放行。现在额度耗尽是访问结论：只由 usage_limit/402 错误与 `/wham/usage` 快照设置（`allowed` 优先，`allowed=false` 或显式 `limit_reached` 判耗尽，可用点数直接放行），只由证据解除，reset 时刻过去本身不放行；额度与目录接口只有 402 改变账号事实。
  - **凭据终态：** 原来永不判过期终态，并在请求内刷新重放。现在对齐 CPR：AT 过期的账号不可选；401 时只有“AT 已过期且仍在 2 小时恢复窗口内”保留待刷新，其余判过期终态并换号；窗口过后刷新失败判终态；推理、额度、目录、预热与 Live 都不在请求内刷新。
  - **cyber_policy：** 原来直接把 400 交给调用方。现在可安全重放并换号，同一会话排除该账号 1 小时，全部被排除时返回 400 `cyber_policy`（未发送），会话内成功一次即清除。
  - **亲和：** 会话绑定按调用方范围隔离；preferred 的会话主账号优先于权重层；strict 下后代线程/子代理只跟随已有绑定账号（不可用时有界等待，不换号）；strict 绑定已迁到其他账号时旧账号的续接返回 `previous_response_not_found`。
  - **重置卡：** 同一账号的消费按账号锁串行，避免并发连续消费两张卡；列表上限 100 → 1024；`reset` / `already_redeemed` 结果码解除额度冷却。
- **新增功能：** Gateway 账号“自动使用重置卡”（默认关闭，账号编辑与批量编辑中按账号开启）。Worker 每天在 UTC+8 次日随机时刻发现可用卡片，在到期前 `lead_minutes`（设置 → OpenAI，默认 10）消费最早到期的一张；可选“剩余周额度上限”；消费前先把幂等键落盘，结果不明沿原键重试；只由一个在线实例执行；账号详情显示下次检查、下次使用与最近结果。
- **上游取舍：** Gateway Worker 为本地定制功能，上游 `dofastted/vm2api` 没有对应实现；对照对象是 CPR，本节在既有定制上修改，不涉及上游文件的取舍。
- **破坏性变更：** 行为变化而非接口变化——401 不再触发请求内刷新重试；AT 过期的账号在定时刷新成功前不可选；额度耗尽账号在快照或成功推理证明恢复前不再按时间自动放行；无会话锚点的请求不再复用上游 WS 连接。
- **升级指南：** 无迁移。账号投影新增 `reset_credit_auto`，升级后每个 Gateway 账号会按新指纹重新投影一次（幂等）。`routing.codex.reset_credit` 缺省按 10 分钟、不限周额度归一。Worker 与控制面需一起升级（控制面托管同机 Worker 时随镜像自动更新）。
- **已知限制：** 账号页“额度用尽”展示仍按窗口百分比推导，与 Worker 访问结论在有可用点数或 reset 刚过时可能短暂不一致（调度以 Worker 为准）；cyber_policy 会话排除只在单个 Worker 进程内；CPR `5100f633` 的请求记录诊断字段与第二档差异（WS 快路径与半开熔断、身份头补全、OAuth 报文形态、客户端重试抑制等）未在本节处理。
- **验证：** Worker 包 `go test -race` 全部通过，新增回归覆盖 WS 池按会话/调用方隔离与 turn-state 不重放、会话锚点顺序、提交后长流不被截断与空闲超时、额度访问结论与按证据解除、401 换号与恢复窗口、cyber_policy 换号与会话排除、亲和四种情形、自动重置卡（到期前消费、幂等键复用、周额度门槛与实例指定）；`CGO_ENABLED=0` 编译 `kin-codex-gateway` 通过。Node `gateway-*`、`codex-route`、`codex-client-profile`、路由相关单测通过，新增长流不被控制面计时器截断的用例（还原修复后失败）。前端 `tsc -b`、修改文件 eslint/prettier、i18n 与 Gateway 账号组件测试通过；未在浏览器中实际操作新开关与设置项，未调用真实 OpenAI。

## 2026-11-04 API Key 端点转发 Claude Code 请求不再因 `cache_control.scope` 400

- **问题（生产 v1.4.038.5 只读核查）：** 11-04 01:32 起 `via=api-kernel`（分组走平台 API 端点「Claude API Key」→ `https://api.anthropic.com`，`x-api-key`）的 Claude 请求全部失败，至 02:13 共 155 次 400 `system.2.cache_control.ephemeral.scope: Extra inputs are not permitted`，Opus 5.5 / Fable 5.1 / Sonnet 5.5 / Haiku 5.5 都受影响；调用方为 Claude 桌面端第三方推理模式与 agent-sdk（`claude-cli/2.1.308–2.1.317`）。该链路此前没有流量，同日 01:36 端点配置模型后才开始承接。
- **原因：** Claude Code 2.1.3xx 在 `system[2]`（及消息断点）的 `cache_control` 中带 `scope: "global"`（prompt-caching-scope beta）。槽位 OAuth 路径在出站前已有 `stripCacheScopeFields` / `sanitizeAnthropicBodyForBetaTokens` 清洗；`runApiInference` 作为原生兼容边界原样转发调用方 body，没有接上这一清洗，API Key 账号的 Messages 拒绝该字段。
- **Bug 修复：** `src/lib/pool/api-protocol.mjs` 构造 Anthropic 出站 body 时调用既有的 `stripCacheScopeFields`，只删除 `cache_control.scope`，保留 `type` 与 `ttl`（含 1h）；OpenAI 端点分支、请求头与 beta 合并不变。
- **上游取舍：** 上游 `dofastted/vm2api` 最新 main（177051ba）`api-protocol.mjs` 同样原样转发，没有对应处理；在上游方案上保留这一行最小差异，复用已有清洗函数，不新增实现。移除条件：上游在 API 端点路径清洗 `cache_control.scope`。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。经 API Key 端点转发时不再携带 `scope: "global"`，缓存仍按调用方的断点与 TTL 生效。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。同时段 GPT（如 `gpt-6.1-sol`）出现的 `stream closed before response.completed` 与此无关：生产记录显示为 Codex 槽位不足（`no_codex_vm`）、Worker 本地排队满/超时，以及上游在多个账号上直接返回 `response.failed`（`server_error` / `capacity_unavailable`），排队超过 15 秒后网关已先回 200 保活，属于容量问题，本节未改动。
- **验证：** `api-backend` 新增回归：调用方带 `prompt-caching-scope` beta、`system[2]` 与消息块带 `scope: "global"` 时，实际发给 api-kernel 的 body 只剩 `{type, ttl}`；还原修复后该用例失败。`api-backend`、`auto-mode-api`、`review-five-fixes`、`api-openai` 48 项通过；修改文件 Biome 格式通过。生产数据仅只读查询。

## 2026-11-04 供应商用量统计与账号列表共享账号用量快照，不再每次等待整套账单统计

- **问题（生产 v1.4.038.5 只读核查）：** 前一节部署后，运营端「用量统计」仍要 1.9–3.5 秒、账号列表约 1.5 秒。拆开计时：报表本身（`vendorUsage`，已在读库工作线程）约 0.3 秒，`accountPortalRows` 约 0.15 秒，其余都在等 `buildUsage` 的账号行（单独调用 `/api/panel/usage` 为 1.3–2.5 秒）。`buildUsage` 的大头是 `billingStats`：生产只读实测全部历史按账号汇总 235ms、近 7 天约 8.3 万行明细逐行取出分桶 717ms，合计约 1.4 秒；它在专用账单线程上串行执行，缓存随每次写库失效，生产推理持续写入，所以每次轮询都重算。用量统计还在报表算完后才开始取账号状态，两段串行相加。同期不发请求时主线程 `/healthz` 也会停顿到 285ms（推理流量本身），本节不涉及。
- **优化改进：**
  - 新增 `src/lib/vendor/shared-snapshot.mjs` 的 `createSharedSnapshot()`：同一份快照在开始加载后 10 秒内直接复用；1 分钟内先用它响应，同时在后台刷新一次；超过 1 分钟或尚无快照时等待加载。并发请求合并为一次加载；加载失败保留上一份快照，下次调用重试，后台刷新的失败不会成为未处理的 Promise 拒绝。
  - 供应商路由的 `presentAccounts`（运营端账号列表、用量统计，供应商门户账号列表与账号详情）改为读取这份共享的 `buildUsage` 账号行快照，不再每个请求各算一次。
  - `GET /api/admin/vendors/usage` 的报表与账号状态改为 `Promise.all` 并行获取（报表在读库工作线程，账号状态在主线程）。
- **未采用的方案：** 只取 `quotaFromAccount` 额度字段替代 `buildUsage`——生产只读对比发现账号 `telemetry` 还使用账单统计的 5h/7d 窗口费用、请求数、token 以及在途数、邮箱，只取额度会让这些字段变为 `null`，已放弃。`billingStats` / `_costEventsSince` 属于上游代码，按“上游优先、最小定制差异”不改。
- **行为变化：** 上述供应商视图中账号 `telemetry` 里来自 `buildUsage` 的字段（额度利用率与重置时间、窗口费用/请求数/token、在途数、邮箱）最多比实时晚一个快照周期：页面每 15 秒轮询时约 15 秒，最长 1 分钟。账号的 VM 状态（凭据、冷却、调度开关）与 Gateway 冻结/额度事实仍每次实时读取；新建账号在下一次刷新前可能暂无这些用量字段。总览、虚拟机列表等其他页面仍各自直接调用 `buildUsage`，不受影响。
- **上游取舍：** 供应商平台为本地定制功能，改动只在其路由与新模块内。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无；接口字段不变。
- **升级指南与限制：** 部署控制面后自动生效，无需前端构建；本轮未部署。轮询中的用量统计预计约等于报表耗时（生产实测约 0.3 秒）与 `accountPortalRows`（约 0.15 秒）中较长的一项；距上次访问超过 1 分钟后的第一次请求仍要等一次完整的 `buildUsage`（约 1.5 秒）。以上为按生产分项实测推算，未在部署后验证。
- **验证：** `shared-snapshot` 单测 4 项（含 `--unhandled-rejections=strict`）覆盖并发合并、10 秒复用、过期先返回旧值并只后台刷新一次、超过 1 分钟必须等待、失败保留旧值并重试；编写中发现并修正了“刚加载完立即再读时仍拿到上一次结果”的问题。供应商相关 unit/e2e、`sqlite-pool`、`panel-billing-lookup` 119 项中 114 项通过，失败的 5 项（`vendor-admin.e2e` 两项“no_available_group”、`vendor-platform.e2e` 账号名称断言、`vendor-review.e2e` S11/S12“group_required”）在未修改的 HEAD 上同样失败。修改文件 Biome 通过。生产数据仅只读查询。

## 2026-11-04 无 account_uuid 的槽位用量窗口不再读到旧导入残留账号（5h / 7d 显示 0%）

- **问题（生产只读核查）：** vm-29（官方 Setup Token）在虚拟机列表「用量窗口」一直显示 5 小时 0%、7 天 0%，且没有重置倒计时；实际当天已承接 4,000+ 次请求。`accounts` 表中该槽位有两条记录：`id=vm-29` 承接全部真实请求，响应头记录 5h 30%、7d 21% 及重置时间；`id=740d6107-…` 是 10-30 导入旧凭证留下的 uuid 键行（同 `vm_id`，2 次请求、响应头为空、最后一次探测为 10-31 失败）。
- **原因：** 官方 Setup Token 不携带账号身份，vm.json 无 `account_uuid`，调度 `accountIdOf` 因此以 `vm.id` 记账、写入响应头用量。面板 `findAccount` 在无 uuid 时按 `vm_id` 取第一条匹配行，命中了排在前面的旧 uuid 键行，于是读到初始的 0% 与空重置时间，并把旧 uuid 当作该槽位的 `account_uuid` 返回。
- **Bug 修复：** `findAccount`（`src/lib/admin/panel-api.mjs`）在槽位无 uuid 时先取 `account_id === vm.id` 的有效行（即调度实际记账的行），找不到再沿用原来按 `vm_id` / `account_id` 的匹配；有 uuid 时逻辑不变。
- **上游取舍：** 上游 `dofastted/vm2api` 最新 main（177051ba）中 `findAccount` 匹配逻辑相同，同样会命中旧行；在上游方案上保留这一处最小差异（多一个优先条件）。移除条件：上游让面板与调度共用同一账号键，或导入时清理被替代的账号行。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。无 uuid 槽位面板返回的 `account_uuid` 不再显示旧行的 uuid（与调度实际使用的键一致）。
- **升级指南与限制：** 部署控制面后自动生效，无需前端构建；本轮未部署。生产库中 vm-29 的旧行 `740d6107-…` 未删除（数据处置单独授权），修复后面板不再读取它。
- **验证：** `panel-cred-status` 单测在原 Setup Token 用例中补充“旧 uuid 键行排在前面”的场景，改前返回旧行、改后返回 `vm-01`；面板相关单测（`test/unit/panel*.test.mjs` 及 `gateway-codex-dispatch`、`responses-ws`）264 项全部通过；修改文件 Biome 通过。生产数据仅只读查询。

## 2026-11-04 供应商账号与用量接口不再逐账号全表扫描、冻结网关主线程，用量报表移到读库工作线程

- **问题（生产 v1.4.038.3 只读核查）：** 运营端打开供应商平台各菜单都很慢。逐个计时供应商接口：供应商列表、代理、结算、计价都在 10ms 内，`GET /api/admin/vendors/accounts` 与 `/usage` 每次 4.6–6.5 秒；请求期间每 20ms 采样 `/healthz`，最长停顿 4.5 秒，即这段时间整个 Node 进程（其他面板请求和推理流量）都被冻住。账号页、用量页每 15 秒轮询一次，所以切到任何菜单都要排队。
- **原因：**
  - `accountPortalRows` 为每个账号调用两次 `vendorUsageSummary`（累计、今日）。该查询的 `vm_id` 过滤作用在 `vendorAccountLogs` 派生出的 `COALESCE(u.vm_id, 'gateway:'||…)` 列上，SQLite 无法下推，每次都扫描整张 `usage_logs`（生产 7.4 万行）。11-03 条目认为这里“按 `vm_id` 走索引、约 100ms”，并不成立；随数据增长已到每账号约 0.5 秒。账号详情与供应商门户用量的 `readVendorUsage`（汇总、首条时间、趋势、模型、按账号、5h/7d/30d 窗口共 8 条查询）同样如此。
  - `vendor_usage_facts` 分支从不收窄，每条查询都对全部 fact（生产 9,689 行）做 `NOT EXISTS` 与 JSON 关联，固定约 20ms；`usage_logs` 分支每行都重新 `json_extract` 一遍 `vendor_resources.config_json` 来关联。
- **优化改进：**
  - `vendorAccountLogs(usageScope, factsScope)`：`vendor_resources` 的 `runtime_vm_id` / `vm_resource_id` / `execution_kind` 先在 `MATERIALIZED` CTE 中每条查询解析一次；两个分支都可先收窄范围再关联。
  - `condition()` 按传入的键生成两个分支的范围：虚拟机账号 `u.vm_id IN (…)` 与“关联到这些虚拟机的账号的 fact”，Gateway 账号 `u.execution_kind='gateway_worker' AND u.account_resource_id IN (…)` 与对应账号的 fact，`vendor-history:<供应商>` 为该供应商的 fact；均带同样的时间条件，`usage_logs` 走 `idx_reqlog_vm(vm_id, created_at)`。外层原过滤保留不变，结果不变。`vendor-account-usage.mjs` 内全部查询改用该范围。
  - 新增 `vendorUsageSummaries()` 一次 `GROUP BY vm_id` 取回多个账号的汇总；`accountPortalRows` 由每账号 2 次查询改为总共 2 次。
  - 运营端用量统计 `vendorUsage` 的 fact 分支按 `f.vendor_id` 与时间收窄（fact 的供应商即其自身 `vendor_id`，范围精确）。
  - 账号用量详情（运营端与供应商门户 `GET …/accounts/:id/usage`、Gateway 账号 `…/usage`）、供应商门户 `GET /api/vendor/usage` 与运营端 `GET /api/admin/vendors/usage` 的报表改在现有只读 SQLite 工作线程池（`sqlite-worker.mjs` 新增 `kind: 'vendor'`）执行，主线程只等待结果。新增 `vendor-read-pool.mjs` 的 `pooledVendorRead()`：仅当传入的是共享主库且线程池已启用时下发；独立连接（测试、工具）与线程池异常时在主线程原样执行。日期参数先在主线程校验，`VendorError` 的错误码与 HTTP 状态不变。`supplierAccountUsage` / `supplierUsage` 及对应查询服务改为异步，新增导出 `readVendorUsagePooled()`。
- **清理：** 无范围版本 `VENDOR_ACCOUNT_LOGS` 已无调用方，删除。
- **上游取舍：** 供应商平台为本地定制功能，上游无对应实现。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无；接口响应不变。
- **升级指南与限制：** 部署控制面后自动生效，无需前端构建；本轮未部署。工作线程读取的是已提交数据，写入延后队列中尚未落库的几条最新请求会在下次刷新出现，与日志页一致。运营端账号列表 `accountPortalRows` 的两次分组汇总（8 个账号合计约 0.15 秒）仍在主线程执行；账号与用量接口各执行一次的 `buildUsage`（约 1.2 秒）原本就在读库工作线程上。
- **验证：**
  - 生产容器内用只读库对比线上实现与本轮代码（临时文件已删除，未改动生产数据、配置或容器）：
    - 全部 26 个账号 ID（含 Gateway）的累计与 24 小时汇总逐字段相等；52 次逐账号查询合计 25.1 秒，新实现 2 次分组查询合计 0.27 秒。
    - 账号详情 `readVendorUsage`：10 个账号 × 全部 / 7 天 / 今天 / 自定义区间共 40 组逐字段相等，合计 132.7 秒 → 7.7 秒（平均每次 3.3 秒 → 0.19 秒）。
    - 供应商门户用量（含 `vendor-history:` 键）：2 个供应商 × 4 个区间共 8 组相等，27.8 秒 → 2.5 秒。
    - 运营端用量统计 `vendorUsage`：起止时间固定的全部用例（全部 / 单个供应商、含按账号过滤）结果相等，3.1 秒 → 2.1 秒；未传起止时间的用例只有 `period` 字段不同，因为新旧两次调用各自取当前时间算缺省值。
    - 运营端账号列表 `accountPortalRows`（8 个账号）输出逐字节相同，5,169ms → 151ms。
    - 用本轮工作线程代码打开生产只读库，执行时每 5ms 计时主线程：账号详情 vm-31 全部时间段，线上同步实现 4,055ms 且主线程停顿 4,055ms，新实现 270ms、主线程最大间隔 5ms；vm-29 近 7 天 4,046ms/4,046ms → 305ms/5ms；运营端全部供应商近 7 天 375ms/375ms → 296ms/6ms。三组结果与线上实现逐字段相等。
  - 本地 Node：`sqlite-pool` 新增回归——主连接未提交事务中的日志只被主线程同步读取看到、工作线程看不到，以此证明报表在工作线程执行；结果与同步读取相等；非法日期仍以 `invalid_usage_range` / `invalid_period` 拒绝。供应商相关 unit/e2e、`sqlite-pool`、`system-time` 与 `database.test.mjs` 158 项中 153 项通过；失败的 5 项（`vendor-admin.e2e` 两项“no_available_group”、`vendor-platform.e2e` 账号名称断言、`vendor-review.e2e` S11/S12“group_required”）在未修改的 HEAD 上同样失败，与本项无关。修改文件 Biome 通过。

## 2026-11-04 撤销 Gateway 使用记录的 safety-buffering 响应头记录，并删除对应两列

- **撤销：** 按用户要求撤销同日新增的 `x-codex-safety-buffering-enabled` / `x-codex-safety-buffering-faster-model` 记录功能，以下改动全部移除：
  - 控制面采集与落库
  - 使用记录 DTO 字段与角色裁剪项
  - 超级管理员列表与详情展示、四语文案
  - Worker 在 WS 复用连接上交付这两个头
  - 对应测试
- **迁移：** 新增 `091_drop_usage_logs_safety_buffering.sql`，删除 `usage_logs.safety_buffering_enabled` 与 `safety_buffering_faster_model`。已在生产执行的 `090_usage_logs_safety_buffering.sql` 保留不改；新装环境依次执行 090、091，最终没有这两列。
- **破坏性变更：** 已记录的两列数据随列删除。部署前已导出备份。
- **不变项：** `response_model` 仍只记上游流内回显的 `response.model`，「上游响应 / 模型不一致」只在两者确实不同时显示。
- **升级指南：** 部署控制面镜像（含 Worker）后，启动时自动执行 091。
- **验证：**
  - 迁移清单测试、074 升级用例（真实 SQLite、已有数据、090→091 重复执行）通过。
  - 受影响的 Node、前端与 Go 测试通过。

## 2026-11-04 Gateway 回执与对账按 dispatch 访问使用记录不再整表扫描

- **问题（生产只读核查）：** 回执回填与对账以 `WHERE dispatch_id=?` 查找、更新 `usage_logs`。已有索引 `idx_usage_logs_gateway_dispatch(execution_kind, gateway_instance_id, dispatch_id)` 以 `execution_kind` 打头，这些语句不带该条件，执行计划为 `SCAN usage_logs`。生产 7 万行时单次约 41 ms；每张回执至少执行 3 次（更新前查询、`UPDATE`、更新后查询），对账器另有 2 处，都在 Node 主线程上同步执行，开销随使用记录线性增长。
- **优化改进：** 5 处语句都加上 `execution_kind='gateway_worker'`，改走已有索引，生产同条件实测约 0.26 ms。生产核对：带 `dispatch_id` 的使用记录全部是 Gateway 记录且没有重复，条件不改变结果。
- **上游取舍：** 官方上游没有 Gateway Worker，本节为定制差异。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无，未新增索引。
- **升级指南：** 部署控制面镜像后自动生效；本轮未部署。
- **验证：** 新增用例在真实迁移出的库上断言查询与更新走 `idx_usage_logs_gateway_dispatch`，不带条件时为整表扫描；回执、对账与 Gateway 相关单测 90 项通过，biome 通过。未在生产验证，未部署。

## 2026-11-04 Gateway 热路径开销收敛：Worker 正文改写、Node 逐行解析与写库，Gateway 分支拆为独立模块

- **背景：** 2026-11-04 Node + Go Worker 架构复核提出的第三组改进（P1-6、P1-7、P2-8、P2-9）。实施前先实测，按实测结果取舍。
- **优化改进：**
  - **Worker 正文改写（P1-7）：** 2.5 MB 请求体每次尝试的改写由约 39 ms 降到约 15.5 ms（本机 Apple Silicon 基准）。
    - Fast 档位、账号范围、关联 ID 映射只改顶层字段，此前每一步都用 `encoding/json` Decoder 把多 MB 的 `input` 完整扫描复制一遍。现在 `rewriteObject` 只做结构扫描（字符串转义与括号配对）界定成员边界，未改动的成员原样透传；输出与原实现逐字节相同（对照测试覆盖空白、转义、中文键、嵌套与 2.5 MB 正文）。
    - `service_tier`、`previous_response_id`、`client_metadata`、`model` 等只读少数顶层字段的判定，改为只取对应成员（`topLevelSubset`），不再为此完整解析整个正文。
    - 请求位置改写需要修改嵌套的 `input` 内容，仍完整解析（约 10 ms），未改动。
  - **签名（P1-7）：** Node 与 Worker 计算内部 HMAC 时分段写入，不再为大正文拼接副本；签名值不变（对照与跨语言回执用例验证）。
  - **Node 逐行解析（P1-6）：** Gateway 流每个事件最多解析一次，用量与档位从同一个事件对象读取（此前终态事件最多被解析 3 次）。首个生成内容之后，`*.delta` 增量行不再解析（这类事件不带用量、终态、响应 ID 或模型；`type` 不在首位时照常解析）。一条 50 个增量的流，解析次数由 57 次降到 20 次以内。
  - **写库（P2-9）：**
    - 续接归属每个响应 ID 只写一次（此前 `response.created`、`in_progress`、`completed` 各写一次）。仓储按数据库连接复用，60 秒过期清理节流恢复生效（此前每个请求新建仓储，每次都重新编译语句并执行一次清理）。
    - Gateway 尝试记录一次写入（此前先插入再更新）。
    - 回执入库只补齐已有的待结算任务，不再为每张回执新建对账任务。生产此前约每两天 474 条空转任务（`billing_context_missing`），随之消失。
  - **结构（P2-8）：** Gateway 分支（约 450 行）从 `handle-codex.mjs` 拆为 `handle-codex-gateway.mjs` 的 `dispatchCodexGateway`；原先用带标签代码块与 `break` 回退 VM，改为返回回退标记，由 Codex 入口决定是否改走 VM。两条路径共用的 `responseClosed`、`sessionFrom`、`normalizeServiceTier`、`commitCodexDelivery` 移到 `codex-hop-shared.mjs`。同时删除一个此前已无引用的 `normalizeOpenAIQuotaPolicy` 导入。`handle-codex.mjs` 由 2589 行降到约 2120 行。
- **与复核方案的差异（按实测或代码核实取舍）：**
  - **未做流末摘要事件（P1-6 原方案）：** 复核时认为 Worker 在流末附摘要可减少待结算。核实后，Node 与 Worker 解析的是同一份字节流，生产里"缺用量的成功请求"实为被错记成功的失败请求，已由前两节修复；摘要只会重复传输 Node 已有的信息，不新增协议。
  - **未改签名格式（P1-7 原方案"只签哈希"）：** 实测 3.4 MB 正文签名 2.6 ms，只签哈希约 1.0 ms，每请求只省约 1.5 ms。改格式会让外部管理的多 Worker 在滚动升级期间新旧版本互相验签失败，且需长期保留双格式兼容，因此只做不改协议的分段写入。
  - **未合并 VM 与 Gateway 的流观察（P2-8 原方案"共用流观察器"）：** VM 路径的观察嵌在内核调用的重试、推理回退与续接回调中，与 Gateway 的职责不同。本次共用计时（`stream-timing.mjs`）、用量归一与上述小工具，不合并两者的观察流程，以免改变 VM 路径行为。
  - **保留 `gateway_worker_dispatches` 写入（P2-9）：** 该表在代码中只写不读，但承担运维诊断用途（本次排查即按它统计各分发状态）。每请求 1 次插入、1～2 次更新，代价小；删表属于数据处置，未执行。
- **复核修复（同日全量复核发现）：**
  - **心跳投影不再聚合全部历史用量：** 心跳投影原先调用账号列表页的 `listCodexAccounts`，每 15 秒在 Node 主线程上对全部历史 Gateway 使用记录按账号做不限时间窗口的 `COUNT`/`SUM`，而投影用不到这些数据，且该列表会清掉 `secret_json`，导致还要逐个账号再查一次。现改用只取 `id`、`status`、`config_json`、`secret_json` 的 `listProjectableAccounts`，绑定一次取出后按账号分组。
  - **编辑后不再多一轮投影：** 运营编辑同步与供应商编辑原先各自拼装 PATCH 载荷、不带配置指纹，每次编辑后的下一次心跳都会因指纹不一致再导出并 PATCH 一次。现统一由 `gatewayAccountPatch` 生成（期望配置、指纹与版本），三处共用；供应商编辑在分组、代理或状态变化时下发完整运行配置。
  - **投影防重入改为进程级：** 心跳路由与面板手动注册路由各有服务实例，原先按实例对象记录，两者可对同一 Worker 并发投影。
  - **凭据终态同步落盘：** 运行时状态改为延迟落盘后，凭据终态（过期、封禁、失效、待验证）也会延迟最多 2 秒；进程异常退出时，已判定不可用的凭据会恢复为可用。现在凭据终态变化时同步落盘。
  - **加密落盘不再生成带缩进的明文。**
  - **修复 Worker 测试偶发失败（`725da8b2` 的 CI `worker` 任务失败）：** 运行时状态延迟 2 秒落盘的计时器可能在用例结束、`t.TempDir()` 正在递归删除目录时写入临时文件，清理报 `directory not empty`（`TestWarmupSendsMinimalRequestAndSyncsQuota` 恰好耗时 2.00 秒）。生产不受影响。延迟时长改为包级变量，测试包在 `TestMain` 中设为 0（同步落盘），验证延迟落盘的用例临时开启；`Store` 新增 `Close()`，停止计时器并写出最终状态，之后的运行时变化同步写盘，`Serve` 退出时调用它。
  - 补充 Worker 收到退出信号后等待在途请求、写出运行时状态并以 `context.Canceled` 返回的测试。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。内部模块拆分不改变对外行为；对账任务只在实时日志判定待结算时存在。
- **升级指南：** 部署控制面镜像（含 Worker）后自动生效；本轮未部署。
- **验证：**
  - Go：`rewriteObject` 与原 Decoder 实现对照、非法输入报错；`topLevelSubset` 同名取最后一个、缺失与非法；2.5 MB 正文的档位、父响应与路由提示读取。`go test -race ./internal/codexgateway/`、`go vet` 通过，Linux amd64/arm64 编译通过。
  - Node：单次解析与跳过增量行（旧代码下解析 57 次，用例失败）；仓储复用、尝试一次写入、回执只补齐已有任务；既有对账用例改为断言不再新建空转任务。Codex 与 Gateway 相关单测 854 项通过。
  - Go 包 `go test -race -count=3` 连续三遍通过（覆盖上述偶发失败）。
  - 复核修复：编辑同步后的下一次心跳跳过、投影不调用带用量聚合的账号列表、两个服务实例不能对同一实例并发投影；凭据终态不经 `Flush` 即在磁盘上；`Serve` 退出时写出运行时状态并返回 `context.Canceled`（旧实现返回 `ErrServerClosed`）。
  - 引用 Codex、Gateway、协议入口、面板与供应商路由的单测 1207 项通过；真实 Go 二进制 Gateway e2e 5 项通过。
  - 全量 Node 单测 415 个文件中 411 个通过；失败的 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 为既有环境相关失败，在 main 上同样失败。
  - `vendor-platform.e2e` 的「supplier UI endpoints enforce zero limit…」在改动前基线 `725da8b2` 上同样失败（供应商 Codex 虚拟机详情名称为 `vm-02`，用例期望账号邮箱），与本轮改动无关，未处理。
  - 未在生产验证，未部署。

## 2026-11-04 Gateway 心跳只投影有差异的账号，Worker 账号库加密落盘、运行时状态合并写盘

- **问题（生产只读核查）：**
  - 每 15 秒一次心跳，控制面都会对每个账号无条件导出凭据、PATCH 运行配置并写投影记录。生产 19 个账号的 `last_projected_at` 都等于最近一次心跳时间，即每 15 秒 38 次内部调用、19 次整库重写。
  - Worker 每处理一次上游响应（额度头、成功清理、冷却、Cookie、保护计数、租约释放），都在全局落盘锁下把整个 `accounts.json` 重新序列化写盘。
  - 该文件以明文保存 OAuth token、代理地址与 Cookie。
  - 另外，Worker 收到 SIGTERM 时 `ListenAndServe` 立即返回、进程以错误退出，没有等待在途请求。
- **优化改进：**
  - 心跳回报各账号的凭据代次、投影版本与配置指纹（`account_revisions`）。控制面按期望运行配置计算指纹并随 PATCH 下发（分组、状态、容量、模型、代理、代理 WS 上限与请求位置），只对绑定未同步、指纹或版本不一致的账号重新投影；代理或出口位置变化会改变指纹，照常同步。
  - 已确认停用且实例版本不旧的归档账号不再随每次心跳重复停用；实例回到旧版本（如从旧备份恢复）时仍会停用。
  - Worker 首次注册同样带回报，按差量投影；手动触发或旧版 Worker 没有回报时按全量投影；同一实例的投影不并发执行。
  - Worker 的额度、冷却、Cookie、保护计数与租约等运行时状态改为合并延迟落盘（最多 2 秒）；凭据与配置变更（新增、PATCH、重新授权、凭据状态、恢复）仍同步落盘。
- **安全：** `accounts.json` 以 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` 按独立用途派生的密钥做 AES-256-GCM 整体加密，与 Worker 间凭据 bundle 的密钥不同。已有明文账号库首次启动时自动改写为密文。缺少或错误的密钥会拒绝启动，不会以空账号库覆盖原有凭据。未配置该密钥（不接控制面的本机调试）时保持明文。
- **Bug 修复：** Worker 收到 SIGTERM 后最多等待 8 秒让在途请求结束（控制面托管的强杀宽限为 10 秒），写出未落盘的运行时状态后正常退出。此前直接以错误退出，既不等待在途请求，也会丢失运行时状态。
- **新增：** `kin-codex-gateway -unseal-accounts`，在 Worker 停止时把加密账号库改回明文，仅用于回滚到旧版 Worker。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更：** 升级后 `accounts.json` 变为密文，旧版 Worker 无法读取，回滚前须先执行 `-unseal-accounts`。`KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` 必须保持不变：托管模式默认保存在 `data/runtime-secrets.json`，外部 Worker 在 `.env`。
- **接口 / 配置 / 迁移：** 心跳新增 `account_revisions` 字段，Worker 账号 PATCH 新增 `config_fingerprint`；无新增配置项，无数据库迁移。
- **升级指南：** 部署控制面镜像（含 Worker）后自动生效，首次启动即完成账号库加密迁移；本轮未部署。升级前确认 `data/runtime-secrets.json`（或 `.env`）中的密钥会随数据目录保留。
- **已知限制：**
  - Worker 异常崩溃（非 SIGTERM）时，最多丢失 2 秒内的运行时状态（额度、冷却等），由后台额度刷新与后续请求重新学习；凭据不受影响。
  - 落盘密钥与 Worker 进程在同一主机，加密主要防止数据目录、备份或日志收集中的明文泄露，不防同机 root。
- **验证：**
  - Go 新增：配置指纹的写入、保留与心跳回报；账号库加密、明文自动迁移、缺少或错误密钥拒绝启动、`UnsealAccountStore` 回滚；运行时状态不在请求路径同步写盘、`Flush` 后可读出。并发落盘用例改为 `Flush` 后校验最新状态。
  - `go test -race ./internal/codexgateway/` 与 `go vet` 通过，Linux amd64/arm64 `CGO_ENABLED=0` 编译通过。
  - Node 新增：心跳回报一致时不调用 Worker，指纹不一致或实例缺账号时重新投影，同一实例投影不并发；归档账号按回报版本决定是否重复停用。Gateway 与协议入口相关单测 515 项通过。
  - 真实 Go 二进制 Gateway e2e（含运营、供应商开户）5 项通过。biome、gofmt 通过。
  - 未在生产验证，未部署。

## 2026-11-04 发布检查避免 E2E 网关启动资源竞争

- **问题：** Release workflow 默认并发执行 11 个 Node 测试文件；每个 E2E 文件都会启动独立 SQLite 网关。GitHub runner 同时执行迁移和端口探测时，网关可能超过测试 harness 的 8 秒启动窗口，导致发布前检查以 `gateway failed to start` 失败；本地同一组 80 项业务检查通过。
- **修复：** Release workflow 的身份、授权和更新契约检查固定 `--test-concurrency=1`，让网关按文件串行启动，避免资源竞争；不改变业务代码、发布条件或产物。
- **验证：** Node 22 下按发布 workflow 的完整 11 文件命令通过 80/80；串行耗时约 9.5 秒。


## 2026-11-04 Gateway 调用方中途断开记为取消，不再记为成功

- **问题：** Gateway 流式响应已提交后，调用方在终态事件前断开时，控制面会停止读取并通知 Worker 取消；但实时日志落到成功分支，记为 `final_state=verified`。没有 usage 的成功记录随后进入待结算，最终等不到用量。结果是成功率虚高，断开请求混在成功里无法单独统计。
- **Bug 修复：** 提交后、终态前调用方断开的 Gateway 请求，记为 `final_state=cancelled`、`error_code=client_cancelled`。计费按已确认的口径（2026-11-04 用户确认：不计费，单独统计）：
  - 断开请求不扣费。
  - 仍会等回执确认：Worker 已收到终态且回执带完整用量时，按实际用量结算；回执终态为 `cancelled` 时，由对账直接记为不计量（`request_not_completed`），不进入 dead letter。
  - 提交前取消、失败与截断保持直接不计量。
- **行为说明：** 是否等待回执的判定统一由 `awaitsGatewayReceipt` 给出，计费入口与测试共用同一规则。
- **上游取舍：** 官方上游没有 Gateway Worker，本节为定制差异；不计费口径与 VM 路径（只对 `verified` 计量）一致。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。历史记录不回写。
- **升级指南：** 部署控制面镜像后生效；本轮未部署。
- **验证：**
  - 新增回归用例：调用方在终态前断开时记为 `cancelled` / `client_cancelled` 并通知 Worker 取消（旧代码下得到 `verified`，用例失败）；结算等待判定覆盖成功、结果不明、提交后断开、提交前取消、失败、截断与 usage 完整七种情况。
  - 引用协议入口与 Gateway 执行的 21 个单测文件共 490 项通过，biome 检查通过。
  - 未在生产验证，未部署。

## 2026-11-04 Gateway Worker 失败请求不再进入待结算与 dead letter，使用记录补尝试次数

- **问题（生产只读排查，v1.4.038，11-03 13:35–18:17 UTC）：** Gateway 上线约 4.7 小时，`gateway_worker_dead_letters` 积压 496 条 `settlement_pending / usage_evidence_incomplete`，全部未处理，另有 501 条 Gateway 使用记录停在 `settlement_pending`。16:51 重新部署后的约 85 分钟内仍新增 151 条。对照回执，几乎全部是不可能扣费的请求：提交后上游过载（回执 `upstream_error / capacity_unavailable`）、提交前被拒（400 `invalid_request`）。原因有二：
  - `finalizeCommercial` 只要 Gateway 请求的 usage 不完整，就标记 `settlement_pending` 并带计费上下文入队对账，没有看终态。失败请求本来不会扣费（与 VM 路径一样只对 `verified` 计量），却一律等回执补齐用量。
  - 每张回执入库都会建对账任务；对账器先判断用量是否完整、再判断有没有计费上下文，失败请求的回执没有完整用量，重试 10 次后全部写入 dead letter，使用记录的 `billing_status` 永远停在 `settlement_pending`。
  - 另外 Gateway 使用记录的 `attempt_count` 一直为空（尝试明细已写入 `request_attempts`，汇总列未填）。
- **Bug 修复：**
  - 只有终态为 `verified` 或 `ambiguous` 且 usage 不完整的 Gateway 请求才标记 `settlement_pending` 等回执；`upstream_error`、`incomplete`、`rejected`、`cancelled` 直接记为 `unmetered`。
  - 对账器在应用回执后，回执终态为 `upstream_error`、`incomplete`、`cancelled` 时任务直接记为 `unmetered`（`request_not_completed`），并把该请求仍为 `settlement_pending` 的使用记录改为 `unmetered`；没有计费上下文的任务先于用量检查记为 `unmetered`（`billing_context_missing`，上下文随后到达会照旧重新打开任务）。两者都不再写 dead letter。成功或结果不明、确实缺用量证据的请求仍按原规则重试 10 次后进入 dead letter。
  - Gateway 使用记录 `attempt_count` 记 Worker 回传的上游尝试次数（`X-Kin-Gateway-Attempts`，含同号重试与换号）；没有逐次记录但已拿到账号头时记 1。
- **核对后无需改动：** 提交后流内失败记为 `upstream_error` 与错误码、Worker 缓冲到首个生成内容才提交、Gateway 流式首字节与首 Token 计时，当前 main 均已实现（见本页 11-04 前几节）。生产缺计时、终态为空的 618 行全部产生于 16:51 之前的旧构建；之后的 309 行计时与终态完整。重新部署后仍有 121 条提交后的过载失败记为 `verified`，是因为 v1.4.038 早于上述修复，部署当前 main 后生效。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异；不计量规则与本项目 VM 路径（只对 `verified` 计量）一致。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。
- **升级指南：** 部署控制面镜像后生效；本轮未部署。生产已有的 dead letter（截至 18:17 UTC 496 条）与 `settlement_pending` 使用记录（501 条）不会被自动改写（只处理新任务）；如需清理属于数据处置，需另行授权。
- **已知限制：** 对账器以回执终态判断是否可能扣费；回执缺失时仍按实时日志的计费上下文处理。
- **验证：** 新增 3 个回归用例，旧代码下均失败、修复后通过：真实 `handleProtocol` 入站 Responses WS 两轮（提交后过载记 `unmetered`、不入对账、`attempt_count=1`；成功但无 usage 记 `settlement_pending` 并入对账，且两轮都不产生扣费）；对账器四种任务（失败回执带上下文、提交前被拒、成功无上下文、成功缺用量）分别得到 `request_not_completed`、`request_not_completed`、`billing_context_missing`、继续重试，且不写 dead letter；Worker 尝试记录两次时 `attempt_count=2`、默认 1。`gateway-codex-dispatch` 与 `responses-ws` 共 67 项通过，`biome check` 通过。未跑 Go 测试（Go 未改动），未在生产验证，未部署，未做任何数据修复。

## 2026-11-04 Gateway Worker 排空时可换实例、WS 原生续接沿用模型映射、计价模型与 VM 同口径

- **背景：** Gateway Worker 全链路复核（建号、选号、重试、错误码、使用记录、回执与结算）发现以下确定性缺陷。
- **Bug 修复：**
  - Worker 排空期间返回的 503 `gateway_worker_draining` 现在带 `X-Kin-Gateway-Send-State: not_sent`。此前缺少该头，控制面不会在 drain 到下一次心跳之间换实例，也不会回退 VM，请求直接以 503 交给调用方。
  - 入站 Responses WS 的连接内原生续接，改为沿用展开请求经清洗、模型映射、Fast 别名等处理后的顶层字段，只取原始帧的增量 `input` 与 `previous_response_id`。此前原生帧直接发往 Worker：配置模型映射时，正文与 `x-codex-routing-hint` 的模型会和选号、计费用的映射后模型不一致，客户端元数据清洗也被跳过。
  - Gateway 使用记录的 `upstream_model` 改为实际发送的模型，与 VM 路径同一契约；上游回显只记在 `response_model`。此前取回显模型，实时日志按回显计价，回执回填再按发送模型重算并覆盖，同一请求的 `total_cost`、`pricing_model` 前后不一致。上游未回显模型时，`gateway-worker` 与 `codex-kernel-fallback` 记录不再拿发送模型冒充回显：模型重定向标记与“模型不一致”筛选只看真实回显。
  - 回执回填不再覆盖实时日志已按完整 usage 计好的成本，包括冻结报价和按张生图、按次搜索的分组媒体计价。只有实时日志 usage 不完整时，才按回执的完整 usage 计价。客户实际扣费（`actual_cost`、`billing_charges`）此前和现在都不受影响。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。历史使用记录不回写；“模型不一致”筛选对已有 `gateway-worker` 行改按真实回显判断。
- **升级指南：** 部署控制面镜像（含 Worker）后自动生效；本轮未部署。
- **已知限制：**
  - 保活提交 200 SSE 之后，上游的 `x-codex-turn-state` 头无法再写回 HTTP 调用方，这是 HTTP 头只能发一次的限制，未处理。
  - 原生续接增量 `input` 内若有拦截规则需要改写的内容，仍以原始帧为准。
  - 降智（回显模型与请求模型不同）仍只记录、不换号，扣费仍按准入时冻结的请求模型报价。
- **验证：**
  - Go 新增：排空 503 带 `not_sent`。`go test -race` 覆盖 `internal/codexgateway` 与 `cmd/kin-codex-gateway`，Go 1.25.0 darwin/arm64，gofmt 通过。
  - Node 新增：使用记录发送模型与回显分开记录；WS 原生续接沿用映射后模型且只带增量 input；回执不覆盖已计价成本。
  - 受影响单测 10 个文件、210 项通过（gateway dispatch/account/worker、request-log、usage-logs view/repo、responses-ws、database 等），biome 检查通过。
  - 未跑 Gateway e2e，未在生产验证，未部署。

## 2026-11-04 Gateway Worker 上游过载收敛、取消透传、按账号排除未同步绑定与回退 VM

- **背景（11-03 生产复核）：** Gateway 请求约 55% 失败于上游 gpt-6 系列整体过载（`server_is_overloaded`，同期 VM 路径同样）。全流程复核发现 Worker 的处理放大了影响：失败平均要 11 秒才返回，Codex Desktop 收到的错误看不出原因，取消不生效，一个账号未同步会让整个 Gateway 返回 503。
- **Bug 修复：**
  - 上游过载收敛到 VM 路径同一规则：过载不再同号重试（原 3 次、500ms 起退避到 8s，单请求最多约 16 次上游尝试）；因过载换号超过 1 次且全池近期失败率中位数 ≥30% 时停止换号，交付 503 并带 `Retry-After: 3`；失败率 ≥70% 且高出其余账号 25 个百分点的离群账号停放 60 秒（全池一起失败时不停放，避免高峰清空账号池）。提交前同号重试与换号总时长不超过 30 秒（不含首次排队）。
  - 过载原因不再丢失：流内 `response.failed` 交付为标准 `{"error":{type,code,message}}`；解析上游错误时找到错误对象后只从它取字段（原先缺 `type` 时会取到事件类型 `response.failed`，可能让过载分类失效）。WS 错误帧改从 `response.error` 取码与提示，并在 `headers` 携带 `retry-after`；WS 适配层的 `writeHead` 改为与 `setHeader` 合并，`retry-after` 不再被覆盖（VM 路径同样受益）。
  - 取消透传：调用方在 Worker 返回前断开、WS 中断或关闭时，控制面断开到 Worker 的请求，Worker 随请求上下文停止排队、重试与换号；分发记为 `cancelled`，使用记录 `final_state=cancelled`、`error_code=client_cancelled`。
  - 不再因单个账号未同步跳过整个实例：某实例上 pending/drifted/blocked 的运行账号经信封 `pool_scope.exclude_accounts` 逐个排除，其余账号照常接单（原先编辑账号或一次投影失败即可让单 Worker 部署整体 503）。
  - Worker 账号库落盘串行化：持落盘锁后再取快照，避免并发写同一临时文件导致文件损坏或旧快照最后落盘覆盖新凭据。
- **新增行为：** Worker 明确未发出请求（无可用实例或账号）、不是 Gateway 续接、调用方尚未收到任何内容、路由未强制 Gateway（`routing.codex.gateway_worker.preference` 不为 `gateway_worker`）且分组也绑定了 Codex VM 时，改走 VM，使用记录 `via=codex-kernel-fallback`。分组只绑定 Gateway 账号时仍返回 503。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。过载处理由原先对齐 codex-proxy-rs 的“同号退避 3 次后换号”改为与本项目 VM 路径一致的池级规则：生产数据显示过载是全池同时发生，同号重试只会加压；codex-proxy-rs 若后续改为池级判断可再对齐。
- **破坏性变更：** 上游过载时单请求的上游尝试次数与等待时间显著减少，客户端会更早收到 503（带 `Retry-After`）；分组同时绑定 VM 时，Gateway 无法接单的请求改由 VM 执行（此前直接 503）。
- **接口 / 配置 / 迁移：** 内部信封 `pool_scope` 新增 `exclude_accounts`；无新增对外接口、配置或迁移。
- **升级指南：** 部署控制面镜像（含 Worker）后生效；本轮未部署。需要禁止回退 VM 的分组，把路由 `codex.gateway_worker.preference` 设为 `gateway_worker`，或只在分组绑定 Gateway 账号。
- **已知限制：** 全池过载判断基于 Worker 进程内的账号反馈，重启后需重新积累；过载本身来自上游，本轮只减轻放大与等待。落盘并发测试在旧实现下也能通过（竞争窗口难以稳定复现），只作回归保护，修复依据是代码审查。
- **验证：** Go 新增与改写测试：过载直接换号不同号重试、全池过载停止换号并带 `Retry-After: 3` 且保留过载提示、健康池继续换号、离群账号停放而全池过载不停放、提交前总时长、流内失败交付体、`exclude_accounts` 跳过未同步账号、并发落盘后可读且与内存一致；`go vet`、`go test -race ./...` 通过，linux amd64/arm64 编译通过。Node 新增：WS 错误帧保留 `response.failed` 内的码、提示与 `retry-after`（修复前得到 `invalid_request_error`）；Worker 客户端取消时断开请求并标记分发 `cancelled`、Gateway 分发记为 `cancelled`（修复前挂起超时）；未发出请求在分组有 VM 时回退、只有 Gateway 或强制 Gateway 时不回退（修复前不回退）；实例因未同步账号只排除该账号；下一节“流内过载可重试”的 Go 用例按本节规则改为换到另一账号重试。完整 `npm run test:unit` 411/415 个文件通过（`egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 为已知环境相关失败）；Gateway e2e（含真实 Worker）与 `panel-users` 通过；`biome format`、gofmt 通过。未在生产验证，未部署。

## 2026-11-04 Gateway Worker 流内过载可重试，失败不再以 200 成功记录

- **问题（生产只读排查，v1.4.038）：** 部署上一轮修复后，成功请求的成本已与实际扣费一致，但仍有大量 0 token、$0、状态 200、终态 `verified` 的 Gateway 记录。对照 Worker 回执，这些请求都是上游在 SSE 流里以 `response.failed`（`server_is_overloaded`，回执记为 `capacity_unavailable`）失败，且只尝试了一次。原因有二：
  - Worker 的流前导窥视只把 `response.created`、`response.in_progress`、`codex.rate_limits` 视为可重放；上游在失败前先发出其他不含内容的结构事件（如空推理输出项；同时期上游响应头新增 `x-codex-safety-buffering-enabled`）时，Worker 提前把 200 流交给控制面，之后到来的过载失败既不能同号重试也不能换号。
  - Node 把流里的 `response.failed` 当作正常终态记为 `verified`，没有错误码。
- **修复：**
  - Worker 前导阶段缓冲到首个生成内容或终态事件才提交（对齐 CPR：未归一为输出的事件不触发交付；生成内容判定与控制面 `stream-timing.mjs` 的首 Token 规则一致：非空增量、带文本/拒答的内容块、带名称或参数的工具调用）。流内过载因此按既有规则同号退避重试、换号，耗尽后以 503 交付，控制面记为失败状态。缓冲上限沿用 1 MiB / 64 个事件。
  - Node 对已提交后才出现的流内失败（`response.failed` / `error`）记 `final_state=upstream_error` 与上游错误码；这类请求已向调用方发出 200，状态码如实保留 200。
- **影响：** 首个生成内容之前调用方暂时收不到 `response.created` 等结构事件（HTTP 流式调用方仍由 15 秒 SSE 保活覆盖）；首字节、首 Token 时间口径不变。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。**升级指南：** 部署控制面镜像（含 Worker）后生效；本轮未部署。
- **验证：** Go 新增复现用例：上游先发 created、in_progress、空推理输出项再报 `server_is_overloaded`，修复后同号重试并交付第二次的成功结果（旧实现直接以 200 交付失败流，用例失败）；生成内容判定 7 例。Node 新增：流以 `response.failed` 结束时记 `upstream_error` 与 `server_is_overloaded`（修复前记为 `verified`）。Go `go vet`、`go test -race ./...` 与 linux amd64/arm64 编译通过；完整 `npm run test:unit` 411/415 个文件通过（`egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 在 main 上同样失败）；Gateway e2e（含真实 Worker）通过；`biome format`、gofmt 通过。未在生产验证。

## 2026-11-04 Codex 授权弹窗粘贴回调链接后不再横向撑破

- **问题原因：** `CodexCredentialPanel` 的「回调 URL」与账号文件文本框沿用基础 `Textarea` 的 `field-sizing: content`，浏览器按整段未断行的回调链接计算最小宽度（实测 1409px，弹窗内容区 510px）。弹窗是 `grid` 布局，网格项按该最小宽度撑开整列，于是 Gateway 账号「重新授权」/新建授权、供应商账号授权等弹窗出现横向滚动条，授权链接、回调输入框和标题被截到可视区外。
- **Bug 修复：** 两个文本框加 `wrap-anywhere`（`overflow-wrap: anywhere`），长链接和 JSON 长 token 在框内任意位置换行，最小宽度不再随内容增长；弹窗宽度回到设定值，无横向滚动。基础 `Textarea` 组件不改，仅限这两处。
- **上游取舍：** 上游同一面板的这两个文本框同样没有换行处理，官方暂无修复；本次只在两处加 class 的最小差异，上游修复同一问题后改用上游方案并移除。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。**升级指南：** 部署控制面后自动生效；本轮未部署。
- **已知限制：** 无。
- **验证：** Chromium 中用构建产物 CSS 复现弹窗结构：修复前文本框宽 1409px、弹窗 `scrollWidth` 1457 > `clientWidth` 510；加 `wrap-anywhere` 后文本框 462px、无横向溢出。`npm run build`（含 `tsc -b`）与 ESLint 通过。

## 2026-11-04 Gateway 账号凭据失效在列表与详情直接显示，不再显示「可用」

- **问题原因：** Worker 在账号上记录凭据终态（`credential_state`：expired/invalid/banned/unverified）与最近错误，但控制面只通过请求回执（Receipt）回写账号运行态。没有流量的账号（如生产 `codex-cn-4@kdanmobile.com`，access token 2026-11-01 过期、刷新失败）不会产生回执，Codex 账号列表与详情一直显示「可用」，运营看不出需要重新授权。
- **优化改进：**
  - Worker 心跳新增 `account_credentials`：有凭据终态的账号及其最近错误（如 `credential_refresh_failed`），每次上报完整集合，未列出即可用。刷新成功、请求恢复、人工恢复或重新授权后 Worker 清除终态，下一次心跳（15 秒内）同步回控制面。
  - 迁移 `089_gateway_account_credential_state.sql` 为 `gateway_worker_account_bindings` 新增 `credential_state`、`credential_error`（NULL 表示可用）；`GatewayWorkerRepo.recordRuntimeCredentials` 按实例整体替换；`GET /api/panel/codex-accounts` 返回这两个字段。未上报该字段的旧版 Worker 不改动已有值。
  - 前端 `gatewayAccountAsVm` 把凭据终态映射为 `availability.key='bad'`，先于调度开关判断（与 VM 一致），文案复用 VM 已有的原因标签：刷新失败 → 「刷新失败」，expired → 「凭证过期」，invalid → 「凭证失效」，banned → 「凭证吊销」，unverified → 「凭证不可用」。Codex 账号列表状态列与详情页抬头同时生效（账号池页不经此映射，本次未改）；expired 且仍有 refresh token 时 `usable` 保持 true，与 Worker 仍会在发送前重试刷新的调度行为一致。
- **上游取舍：** Gateway Worker 为定制功能，官方上游无对应实现；状态文案与判定顺序沿用 VM 列表既有规则，不新增文案。
- **破坏性变更 / 接口 / 配置：** 无破坏性变更；新增心跳字段 `account_credentials`、账号列表字段 `credential_state` / `credential_error`，无新配置。**升级指南：** 部署控制面与 Worker 后自动迁移并生效；本轮未部署。只升级控制面时字段保持 NULL（显示与原来相同），Worker 升级后的首次心跳开始同步。
- **已知限制：** 多 Worker 时列表取最近更新的绑定，与 `last_error` 等既有字段同口径。
- **验证：** Go `TestHeartbeatReportsPeakConcurrencyAndAccountInflight` 覆盖心跳上报与清除；Node 新增 `recordRuntimeCredentials` 用例（落库、未知账号忽略、旧 Worker 不清除、空集合清除），`gateway-account-management` 与 `database`（迁移列表）40 项通过；前端 `accounts-model` 新增刷新失败与终态映射用例，`gateway-worker` 2 个文件 8 项通过；`tsc -b`、ESLint、Prettier、Biome、gofmt 通过。

## 2026-11-04 Gateway 账号详情「账号」页签不再把运营踢回登录页

- **问题原因：** 生产 `codex-cn-4@kdanmobile.com`（迁移自 VM vm-01）的 access token 于 2026-11-01 过期，Worker 刷新失败（`credential_state=expired`、`last_error=credential_refresh_failed`）。Worker 的 `upstreamStatusForClient` 按设计把上游 401 原样回给控制面，`/api/panel/codex-accounts/:id/profile` 等 Gateway 面板路由又把这个 401 透传给浏览器；前端 `panelFetch` 把任何面板 401 都视为会话过期，清会话并跳回登录页。打开「账号」页签时 `ProfilePanel` 请求 `/profile`，于是必然被登出。同一原因也让 `/wham/usage` 返回 401，该账号从未写入额度快照，列表「用量窗口」5 小时 / 7 天为空。
- **Bug 修复：** `createGatewayWorkerRoutes` 的面板响应统一把 401 改为 502，与 `panel-routes.mjs` 的 `upstreamFetchStatus` 规则一致；覆盖 profile / subscription / avatar、查询额度等账号动作、Worker 实例操作和账号管理异常。错误码与文案保持 Worker 原值，前端照常显示「暂时无法读取账号资料」或操作失败原因。Worker 内部回调路由（`/internal/v1/gateway/*`）的 401 不受影响。
- **上游取舍：** Gateway Worker 为定制功能，官方上游无对应路由；沿用上游既有的「上游 401 不得成为面板 401」规则，不新增前端特判。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无；这些 Gateway 面板接口在上游账号 401 时由 401 改为 502。**升级指南：** 部署控制面后生效；本轮未部署。`codex-cn-4@kdanmobile.com` 需在详情页「重新授权」后才会恢复额度与资料数据（数据处置，不在本次代码范围内）。
- **已知限制：** 无（列表把凭据失效显示为「可用」的问题由下一条修复）。
- **验证：** 新增单测：本地 Worker 桩对 profile 与额度查询返回 401，面板路由回 502 且保留 `profile_unavailable`；未改路由时该用例得到 401 而失败。`gateway-account-management` 19 项通过；Biome 检查通过。

## 2026-11-04 槽位凭证不再出现在客户端错误与请求日志中；拒绝含非 ASCII 字符的粘贴 Token

- **问题原因：** 生产 vm-29 授权时粘贴的 Setup Token 混入了空格与形近字符（西里尔 `х`、乘号 `×`），像是截图识别或手工录入所得。导入未校验字符，原样落盘；Claude Code 组 `Authorization` 头时报 `Header '14' has invalid value: 'Bearer sk-ant-oat01-…'`，每个请求都 502 `cli_error`。该报错文本带完整 Token，`mapUpstreamError` 原样写入客户端 JSON 错误体 / SSE error 帧，请求日志 `usage_logs.error_message` 也未脱敏（生产 40 行，均为 vm-29）。原有 `redactSecrets` 的 `sk-ant-` 规则不匹配下划线、`Bearer` 规则遇到空格或非 ASCII 即停，即使经过脱敏，Token 后半段也会露出。
- **Bug 修复：**
  - `pastedAccessTokenToOauth` 去掉终端换行折行产生的空白；去空白后仍含非可见 ASCII 字符时返回 400 `access_token_invalid`，提示从终端直接复制原文。`looksLikeOfficialSetupToken` 同样只接受可见 ASCII。运营端导入的 `panelImportErrorPayload` 改为沿用错误自带的 4xx 状态（原先未知错误一律 500）。
  - `security.mjs` 新增纯文本脱敏 `redactSecretText`，`redactSecrets` 改为复用它：`Bearer sk-ant-…` 遮到引号或行尾为止，`sk-ant-` 规则覆盖下划线。`mapUpstreamError` 在生成客户端错误前对上游 / 槽位错误文本脱敏；请求日志摘要的 `error_message` 落库前脱敏。
- **上游取舍：** 错误映射与请求日志为既有定制代码的修正，官方上游没有对应的 Token 回显防护；不新增兼容路径。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无；客户端看到的错误文本中凭证部分显示为 `***REDACTED***`。**升级指南：** 部署控制面后生效；本轮未部署。生产库中 vm-29 已有的 40 行 `error_message` 仍是明文，需另行授权处理；该 Token 已经外泄（返回给了调用方），应在 claude.ai 吊销并由供应商重新生成后再授权。
- **已知限制：** 不带 `Bearer` 前缀、且中间含空格的损坏 Token，只遮到第一个空格为止；Codex Gateway Worker 回执的 `error_message` 不在本次范围内。
- **验证：** 新增单测：终端折行拼接与形近字符拒绝、`redactSecretText` 遮住带下划线与损坏尾部的 Token、`cli_error` 返回客户端已脱敏、请求日志摘要已脱敏；Node 全量单测（基于 v1.4.038 同步后的 main）4661 项中 4633 通过、9 项失败，失败集中在 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 四个文件，在未改动的 HEAD 上同样失败（本机 macOS 环境相关，交 Linux CI）；e2e `vendor-account-draft`、`gateway-vendor-accounts` 通过，`credentials` 的 slot reset 失败为既有问题。
## 2026-11-03 上游 v1.4.038 同步

- **来源与范围：** 官方上游从 `e3a60858fe5d2c4beb931ffced31800a4cd58e8b`（v1.4.037）推进到 `04d3a5980dfa672772eeebb3ad23bae46c93216e`（v1.4.038）；以已交付 `4fcff3a40bb4d7a1e7e53de270a090d0feb74ddd` 为合并起点；合并期间交付远端先后前进到 `a635484c806714eb898f6049340470622d94f2fb`（并行任务的 Gateway 账号页、Setup Token 等改动）和 `6b974f41089490d44b7fd3bb83584d338c88eb1b`（Gateway 运行负载、迁移 088），均以前一交付为三方基准整体并入其增量，未覆盖或回退。上游增量：#869 集群页改为机器总览、#871 VM 取消活跃、#872 设备亲和换号后迁移 sticky 绑定、#873 图像模型可直接用于 Chat/Responses、#874 第三方入站缺失 TTL 的缓存断点按会话 TTL 补齐、#876 节点槽健康探测瞬时失败不再判故障。根 CHANGELOG 与上游逐字一致。
- **采用上游 / 删除本地方案：**
  - sticky 换号迁移（#872）：采用上游 `ownMove` 判定（出站会话账号或已拿到席位且原账号本轮未溢出时允许迁移），删除本地 `seatMove`、成功路径传入的 `{ seated: true }` 及其对 `replaceSession` / `allowMove` 的附加。行为差异：本地方案迁移时会同时换新出站会话，上游只迁移绑定、保留会话复用规则。
  - 槽位监护（#876）：`kernel-watchdog.mjs` 与上游逐字一致。删除本地 10-30 交付的短探测复核（失败后用 `timeout_ms` 独立复核、`recover` / `clearRecoveredFault` / `acceptHealthyKernel`、`health_cache` 与 `cooldown` 不计恢复次数），以及只测这些行为的 4 个用例和 2 个参数化用例。行为差异：节点槽改为连续 3 次传输失败才进入恢复；本机 Docker/KVM 槽单次 800ms 探测超时不再先复核，直接进入原有退避恢复（首次等待 60s，仍有上限）。
  - 集群页（#869）：采用上游机器总览，删除本地 `local-board.tsx`、`local-link.tsx`、`remote-list.tsx`（本地改动只有多语言化，上游已删除这些组件）。
  - VM 取消活跃（#871）、第三方缓存 TTL（#874）、`docs/API.md`：采用上游。
- **必要融合（上游无法满足的已核实契约，最小差异）：**
  - 图像模型对话（#873）：上游调用的 `runWithCodexKey` 在本地已被商业 Key 门禁取代，原样合入会在运行时报 `ReferenceError`。改为与本地 `POST /v1/images` 相同的契约：分组关闭生图返回 `403 image_generation_disabled`；API 直连后端改走 `handleApiImages`，无分组且非平台归属的 Key 返回 `403 api_backend_forbidden`；Key 席位用 `apiKeyStore.acquire`，由 `handleProtocol` 统一释放和结算；配置读单请求快照，并传入 Gateway Worker。上游转换与应答逻辑未改。上游提供等价 Key 门禁与分组生图契约后收敛。
  - 取消活跃路由：本地已把 VM 维护路由拆到 `panel-vm-maintenance-routes.mjs`，`/api/panel/vms/:id/deactivate` 放在 `/activate` 同一模块；`/admin/...` 旧路由和 `deactivateVmSlot` 与上游一致。
  - 槽位恢复计数：保留本地 `rust-kernel-supervisor.mjs` 在“等待到健康、未执行启动”时返回 `reason: 'already_up'` 的 2 行改动。上游 watchdog 只在 `already_up` / `busy` 时不计恢复次数，而上游 supervisor 这条路径返回 `started_in_vm`，会把未执行任何启动的等待计为一次恢复。上游补齐后删除。
  - 节点主机统计：保留本地 `~/.tapmodels` 进程路径（品牌目录），加入上游新增的磁盘统计行。
  - 多语言：上游新界面为硬编码中文，按四语 i18n 契约移入资源，中文显示与上游逐字一致。`cluster` 每种语言新增 116 条（96 个键，其中 10 个复数键各 3 份）、删除被删组件独用的 36 条；`vm` 新增 4 个键、删除失效的 `sync14008AlreadyActive`。唯一豁免为 `{{GiB}}G` 容量单位。本地 `cluster/i18n.test.ts` 改用上游 `buildLocalMachine`，仍逐语言校验状态文案随语言切换；上游 `model.test.ts`、`connection-rows.test.ts` 固定 zh-CN 后断言不变。
  - 集群页权限与账号池列：上游以 `role === 'admin'` 判断管理权限、从 `/vm-pools` 读槽位所属账号池。本地最高角色为 `super_admin`（`admin` 是只管用户的运营管理员），账号池已由 VM 分组取代且 `/vm-pools` 已退出，原样合入会编译失败并错放管理按钮。改为 `super_admin` 判断，该列显示槽位 `vm.groups` 的分组名（四语“分组”）。上游改为分组或角色模型一致后收敛。
  - 继续沿用的既有例外：TTL 补齐与热路径配置读单请求快照 `requestRouting`；桌面端连接探测分支。
- **新增功能 / 接口 / 配置 / 迁移：** 新增 `POST /api/panel/vms/:id/deactivate`（上游）；Chat/Responses 支持图像模型（上游）；集群页机器总览（上游）。无新增配置、依赖或数据库迁移。
- **破坏性变更：** 第三方调用方依赖隐式 5m 缓存断点的，需改为显式 `ttl: "5m"` 或带 `x-kin-cache-ttl: 5m`（上游 #874）。sticky 换号不再强制换新出站会话。本机槽位单次健康探测超时不再先复核（见上）。
- **升级指南：** 从 v1.4.037 升级需同时更新 Node 控制面与 `web/dist`（集群页、VM 操作和多语言资源有变化；部署完整应用镜像即可）后重启。`deploy/payload.json`、`deploy/arm64-cli.json`、Go worker 均未改变，不需要 `fetch:payload`、`wrap-cli/sync`、槽位重建或重新授权。保留 `routing.json`、`vms/`、`data/`、`.env` 与现有持久化挂载；控制面重启会中断连接。
- **验证：** Node v22.23.4/macOS，在并入 `a635484c` 后的最终组合树上运行根 `test:unit`（415 个文件）与 `test:e2e`（46 个文件），与同机 `a635484c` 基线逐项比较：unit 失败 6 项、e2e 失败 40 项，均与基线完全相同（macOS 缺 Linux egress/OAuth 二进制、`/proc` 与 kernel/CLI ELF），本轮新增失败 0；并入前对 `4fcff3a4` 基线比较结果相同；再并入 `6b974f41` 后，迁移清单、Gateway、Codex、图像轮次、监护与路由覆盖等 635 项定向测试通过，前端 `tsc -b` 与全量 vitest 862 项复验通过，Go worker 仅含该并行交付自身改动、由 CI 执行。前端 `tsc -b` 通过、全量 vitest 116 个文件 862 项通过（含四语 i18n 覆盖）、Prettier 全仓通过；修改的 Node 文件 Biome 通过。新增 Chat 图像轮次“分组关闭生图返回 403、不占 Key 席位”回归，去掉对应检查后该用例失败、恢复后通过。`/deactivate` 在各角色下与 `/activate` 权限结果一致。Linux 专属测试与镜像构建由 CI 执行；本轮未部署生产、未操作生产数据。

## 2026-11-04 Gateway Worker 使用记录补齐性能与出站 Session，修复成本清零与状态码覆盖，并发显示峰值与账号在途

- **问题（生产只读排查，v1.4.037.4）：**
  - Gateway 请求的使用记录没有出站 Session、首字节（TTFB）、首 Token（TTFT）、生成时间，因此也算不出输出速率。
  - 成本列被清零：对账任务把数据库里的回执行交给 `applyReceiptToUsage`，该函数只读 `receipt.usage`（数据库行的 usage 在 `usage_json`），按 0 token 算出 0 元并用 `COALESCE` 覆盖了实时日志已算好的成本。实际扣费（`actual_cost`、`billing_charges`）不受影响（11-03 13:00 后 199 条已结算共 $28.49），但成本明细以及账号 5H/7D 费用、供应商费用等按 `total_cost` 汇总的统计都变成 0。
  - 状态码被覆盖：回执回填用上游 HTTP 状态覆盖使用记录的 `status`。上游以流内 `response.failed`（`server_is_overloaded`）失败时 HTTP 仍是 200，于是交付给调用方的 503 被改成绿色 200，看起来像“成功但没计费”。同时段 Gateway 有 281 条此类失败，虚拟机路径同样有 332 条 `server_is_overloaded`，属于上游 gpt-6 系列整体过载，Gateway 并未多失败。
  - 并发：实例卡片只显示最近一次心跳那一刻的在途数（约 15 秒采样一次）。按使用记录计算，同时段平均在途 0.91、峰值 6（13 个 Key、32 个会话），所以显示 1 并非算错，但看不到峰值；各账号的在途数也没有上报。
- **修复：**
  - Worker 在响应头 `X-Kin-Gateway-Outbound-Session` 回传实际发往上游的会话 ID（OAuth 账号为按安装身份映射后的 UUID）；Node 记为出站 Session。Gateway 流式请求按虚拟机路径同一口径（`stream-timing.mjs`）记录首字节、首 Token 与生成时间，输出速率随之可算。
  - `applyReceiptToUsage` 同时读取 `usage`/`usage_json`；没有 token 证据时不计价，不再用 0 覆盖成本；不再改写状态码，终态只在实时日志未知（空或 ambiguous）时用回执补全（`completed` 记为 `verified`，与虚拟机路径一致）。
  - Gateway 非流式失败分支记录 `final_state=upstream_error` 与错误码（优先上游 `error.code`，其次 Worker 错误类别），不再记为无错误码的 `rejected`。
  - 心跳新增 `peak_concurrency`（两次心跳之间的峰值在途，上报后从当前在途重新计）与 `account_inflight`（各运行账号在途，含 Guardian 并发池）。控制面落库（迁移 `088_gateway_runtime_load`），实例卡片显示“在途（峰值 N）”，Codex 账号列表与账号池的 Gateway 行按在线实例汇总在途数，与虚拟机行一样显示并发占用。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更：** 无。新增响应头与心跳字段为内部协议，旧 Worker 不上报时峰值与账号在途为 0。
- **接口 / 配置 / 迁移：** 迁移 `088_gateway_runtime_load`（`gateway_worker_instances.peak_concurrency`、`gateway_worker_account_bindings.inflight`，均为新增列）；无配置变化。
- **升级指南：** 部署控制面镜像（含 Worker）后生效；本轮未部署。已被清零的历史成本列可用现有 `POST /api/panel/pricing/reprice`（`since`/`until`）按使用记录 token 重算官方成本（不改变已结算的实际扣费）；本轮未执行任何数据修复，需要时单独授权。已被改成 200 的历史失败记录状态码无法从现有数据恢复（终态仍为 `upstream_error`）。
- **已知限制：** 上游 gpt-6 系列过载导致的失败本身不在本轮处理范围（虚拟机路径同样存在）；生成时间仍要求首 Token 存在且耗时大于 0。
- **验证：** 新增回归均先确认修复前失败：对账传入数据库行时按 `usage_json` 计价、无 token 回执不清零成本、流内失败不被上游 200 覆盖（`gateway-codex-dispatch`）；Gateway 流式请求记录出站 Session、首字节与首 Token，非流式失败记 `upstream_error` 与上游错误码；Go 测试覆盖出站会话头与上游实际 session-id 一致、心跳峰值与账号在途上报及峰值重置；控制面心跳负载落库、离线实例在途不计（`gateway-account-management`）。Go `go vet`、`go test -race ./...` 通过，linux amd64/arm64 编译通过；完整 `npm run test:unit` 408/412 个文件通过（失败的 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 在 main 上同样失败）；Gateway e2e（含真实 Worker，复查使用记录已写入首字节与首 Token）与 `panel-users` 通过；Web `tsc --noEmit`、Prettier、`vitest run` 855 项通过，`biome format`、gofmt 通过。未在生产验证，未部署，未做任何数据修复。

## 2026-11-04 供应商粘贴官方 Setup Token 授权后账号永不调度

- **问题原因：** 供应商在开户草稿中粘贴 `claude setup-token` 生成的 `sk-ant-oat01-…`，请求走 `POST /api/vendor/account-drafts/:id/import`。该分支忽略前端传来的 `type` / `scope: inference`，不识别官方 Setup Token，按普通 OAuth 落盘（`source: access-token`、无 `expires_at` / `scopes`、无 refresh token）。Worker 因此把凭证当作待刷新（`refresh_window`），刷新必然失败（`OAuth refresh failed`），调度判定无有效期也无 refresh token，账号一直不被选中；面板仍显示「可调度」。生产 vm-28 自 11-01 授权起 0 请求即为此原因。运营端 `POST /api/panel/vms/import` 已正确识别，两个入口逻辑不一致。
- **Bug 修复：** 抽出 `pastedAccessTokenToOauth`（`src/lib/oauth/claude-setup-token.mjs`），运营端导入与供应商草稿导入共用：官方 oat，或声明 inference 且没有 refresh token 时，落为 `official-setup-token`（`user:inference`、一年有效期、无 refresh）；声明 inference 但带 refresh token 时为 `setup-token`；其余仍为普通 access token。运营端原有内联逻辑删除，行为不变（仍额外接收 `email` / `account_uuid` / `org_uuid`）；供应商入口仍不接受这些身份字段，由 `enrichOauthIdentity` 补全。
- **上游取舍：** 供应商门户与开户草稿为定制功能，官方上游无对应入口；运营端导入逻辑来自已有定制，本次仅移入共享函数。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。**升级指南：** 部署控制面后生效；本轮未部署。已按旧逻辑授权的供应商 Setup Token 账号需重新授权一次（或由运营端「重新导入」同一 token）；生产 vm-28 已于 2026-11-03 经运营端导入接口重新提交原 token 修正，修正前的 vm.json 与脱敏 DB 行备份在服务器 `/opt/tapmodels/backups/vm-28-reauth-20261103T160301Z/`，修正后已正常承接请求。
- **验证：** `claude-setup-token` 单测新增粘贴 token 归类用例（无类型提示的官方 oat、inference + refresh、普通 token）；相关单测 6 个文件 34 项通过；e2e `vendor-account-draft`、`gateway-vendor-accounts` 通过；`credentials`（slot reset）与 `panel-api`（OpenAI 调度保存 2 例）的失败在未改动的 HEAD 上同样存在，与本次无关；Biome 检查通过。

## 2026-11-03 Codex 账号页点击行与详情页对齐虚拟机页

- **需求：** 运营端「资源管理 → Codex 账号」（`/console/#/codex-accounts`）的内容和样式与「资源管理 → 虚拟机」一致：点击行或卡片先弹详情卡，再从「完整页面」进入独立详情页。
- **新增功能：**
  - 点击账号行 / 卡片改为弹出与虚拟机相同的详情卡（`VmDetailCard`）：状态、用量窗口、今日 / 7 日请求、账号与槽位信息及测试、统计、重新授权、刷新令牌、恢复状态、分配分组等按钮均走 Gateway 账号接口；调度开关调用 pause / resume，代理显示代理端点主机。「完整页面」进入新详情页 `/console/#/codex-accounts/<账号 id>`；虚拟机页仍进入 `/vm/<id>`。
  - 新增 Codex 账号详情页，页头与虚拟机详情页相同：返回列表、切换账号下拉、平台 / 形态 / 状态标签、调度开关、查看统计与刷新令牌按钮；四个页签：**概览**（身份与状态、5H / 7D 用量窗口与成本、按模型成本，取自账号用量接口全部时间范围，与「查看统计」共用缓存）、**账号**（账号属性：归属、分组、代理、投影、授权代次、备注，编辑与重新授权按钮；额度与重置卡；账号资料）、**测试**（与测试弹窗相同的测试面板）、**运维**（额度预测、账号错误保护、最近错误、归档账号）。页面不显示内部运行账号 ID。
- **Bug 修复：** Gateway 账号在列表、卡片和详情卡中形态标签误显示「容器」，节点卡片规格行同样显示「容器」，现显示「Gateway」（悬停说明「Gateway Worker 共享执行，无容器或虚拟机」）；列表「类型」列的优先级原为占位「优先级-—」，现显示账号权重（权重 1–100 与调度等级同为高者优先，未设置按 Worker 默认 1）。列表调度开关原先在操作失败时除错误外仍提示「已开启 / 已关闭调度」，成功时还会多弹一条「账号操作已完成」，现只由开关提示一次实际结果。
- **优化改进：** 列表页去掉筛选栏右侧多余的手动刷新按钮（列表每 5 秒自动刷新，与虚拟机页一致）；详情区各面板（额度与重置卡、账号资料、额度预测、账号错误保护）改为与虚拟机详情页相同的卡片版式。
- **实现与清理：** 删除 Codex 账号页的右侧详情抽屉（`Sheet`）及其专属文案键 `common.codexDetails`（四语）；抽屉里的身份、状态、额度组件移入 `account-runtime-panels.tsx` 供详情页使用。列表与详情页共用的账号操作抽成 `account-actions.ts`，账号列表 / 目录查询抽成 `accountsQueryOptions` / `accountCatalogQueryOptions`。`VmActions` 增加可选 `detailRoute`（详情卡「完整页面」路由，缺省为虚拟机详情页）；适配器 `gatewayAccountAsVm` 写入 `runtime_type: 'gateway'` 与 `schedule_level`；`runtimeTypeOf` 识别 `gateway` 形态，详情卡对该形态不显示仅虚拟机适用的槽位调度区块与内存区块。路由 `codex-accounts.tsx` 改为 `codex-accounts/index.tsx` + `codex-accounts/$id.tsx`（与 `vm/` 相同结构）。新增四语文案：`common.codexSwitchAccount`、`codexSearchAccounts`、`codexProperties`、`codexLastError`，`vm.runtimeChip.gateway`、`gatewayWorker`。
- **上游取舍：** 官方上游没有 Gateway Worker 与 Codex 账号页，本节均为定制差异；虚拟机页、详情卡与详情页的行为对普通虚拟机不变。
- **破坏性变更：** 无。原先点击 Codex 账号行打开的右侧抽屉改为详情卡 + 详情页。
- **接口 / 配置 / 迁移：** 无新增后端接口、配置、迁移或依赖；详情页使用已有的 `GET /api/panel/codex-accounts/:id` 与 `/usage`。
- **升级指南：** 部署前端后生效；本轮未部署。
- **已知限制：** 节点卡片规格行对 Gateway 账号仍显示节点名「local」；切换账号下拉只列出未归档账号（已归档账号可从列表「显示归档」进入）。
- **验证：** Web `tsc -b`、Prettier 检查与 `vitest run` 114 个文件 852 项通过；本轮新增 / 修改文件 ESLint 无错误（全量 ESLint 的 10 条错误均在本轮未改动的既有文件）。新增测试：适配器形态 / 权重映射、按模型成本行映射、详情卡对 Gateway 账号链接到 `/codex-accounts/<id>` 且不显示槽位调度、虚拟机仍链接 `/vm/<id>`、详情页渲染页头 / 概览且不含运行账号 ID、`RuntimeChip` 与 `runtimeTypeOf` 的 Gateway 形态。本机以临时数据目录启动控制面与前端开发服务，对照虚拟机页逐一目检 Codex 列表、详情卡、详情页四个页签。

## 2026-11-03 分组资源弹窗不再因首项为 Gateway 账号锁住 VM 页签

- **问题原因：** 19 个 Codex VM 迁为 Gateway 账号并绑定 KDAN、OpenAI 分组后，两组资源列表首项都是 `gateway_worker_account`。生产 v1.4.037.4 前端仍按首项类型选默认页签，`value` 取到 undefined 整页 500（main 已由「分组绑定 Gateway 账号后……管理资源页 500」一节修复，尚未部署）。main 中 `ResourcePicker` 的页签锁定仍按首项类型判断，首项为 Gateway 账号时 VM 与 API 两个页签都被锁住，与后端 `isVmBackendKind`（Gateway 账号属 VM 后端）不一致。
- **修复：** 新增 `web/src/features/groups/resource-backend.ts` 的 `groupBackendKind`：分组含 API 端点即为 API 后端，否则有资源即为 VM 后端。弹窗默认页签与 `ResourcePicker` 页签锁定共用该函数；`ResourceKind` 类型随之移入该文件，替代原先打开弹窗处的分支判断。保存、优先级与混合后端校验不变。
- **上游取舍：** 官方上游没有 Gateway Worker，属定制差异内调整；不新增兼容路径。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。**升级指南：** 部署前端后生效；本轮未部署，生产仍需部署当前 main 才能消除 500。
- **验证：** 新增 `resource-backend.test.ts` 3 例（Gateway 账号与 VM 混合或单独时为 VM 后端、API 端点为 API 后端、空分组不锁定）；Web `tsc -b`、修改文件 Prettier 与分组测试通过；ESLint 无新增问题（`groups/index.tsx` 的 `no-extra-boolean-cast` 与 `resource-picker.tsx` 的 `useMemo` 依赖警告为既有）。未在浏览器中点验。

## 2026-11-03 账号池显示供应商 Gateway 账号，与虚拟机账号同样的内容与操作

- **问题：** 供应商新建的 OpenAI 账号已固定由 Gateway Worker 执行。这类账号虽会出现在供应商门户与运营端「供应商平台 → 账号池」，但 5H/7D 额度、套餐、邮箱、并发、RPM、优先级为空；名称留空时一直显示 `account_<id>`；行内「详情」因接口缺 `owner`/`cooldowns` 导致页面报错；编辑分组按虚拟机版本比对，永远返回 409；「授权」走虚拟机凭据面板无法使用，「虚拟机设置」点了无反应；更新的 drifted 绑定会把已同步账号误判为待授权。
- **修复与改进：**
  - 账号池 Gateway 行补齐 telemetry（`vendor-portal-view.mjs`）：优先已同步实例的绑定；5H/7D 用量与重置时间取 Worker 上报的额度窗口（按时长归类，与运营端 Codex 账号页同口径，抽出 `gatewayQuotaWindows` 共用）；套餐取额度 `plan_type` 或配置；邮箱、并发、RPM、权重取账号配置；错误保护冻结或用尽未重置的额度窗口显示为受限冷却（不是故障），窗口内请求/费用/Token 与运营端同源。
  - 供应商授权完成时把授权邮箱、套餐写入账号配置；名称留空则改为授权邮箱（与虚拟机账号一致）。
  - 账号详情接口对 Gateway 账号返回与虚拟机账号同形状的归属、代理地区、冷却（新增冷却类型「额度用尽」，四种语言）；编辑分组按 Gateway 资源版本比对；Gateway 账号选择「自动挑选代理」时明确返回 400 `proxy_source_unsupported`，不再静默忽略。
  - 新增已有 Gateway 账号的重新授权：`POST /api/vendor/accounts/:id/gateway-drafts` 及其 `/:draft/oauth/generate-auth-url`、`/oauth/exchange-code`、`/import`，复用运营端 Codex 账号的草稿与 OAuth 流程；运营端账号池走 `/api/admin/vendors/accounts/...` 同一路径。每步校验账号归属、执行方式、未归档与 `allow_runtime` 策略，草稿只属于创建者且须与路径账号一致；响应不含 Worker 运行信息。
  - 前端：两个账号池的「授权」对 Gateway 账号打开 Gateway 授权面板（OAuth / 账号文件），隐藏「虚拟机设置」；供应商门户不再提示「账号缺少虚拟机」。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更：** 无。`telemetry` 只是补齐原为 null 的字段并新增 `execution_kind` 类型声明；新接口为新增。
- **接口 / 配置 / 迁移：** 新增上述重新授权接口（`docs/PANEL_API.md`）；无配置或迁移。
- **升级指南：** 部署控制面与前端后生效；本轮未部署。已存在的名称为 `account_<id>` 的供应商 Gateway 账号不会自动改名（生产当前没有供应商 Gateway 账号），可在编辑中修改。
- **已知限制：** 「资源管理 → Codex 账号」对齐虚拟机页的改造在另一会话进行，不在本节；Gateway 账号的订阅到期等资料当时只在运营端 Codex 账号页实时查询，账号池不显示（2026-11-04「Gateway 账号在列表与详情卡显示订阅到期」已改为写回账号并在列表、卡片与账号池显示）；未在真实面板中人工点验。
- **验证：** 新增 `vendor-portal-view` 单测（额度窗口按时长归类、优先 synced 绑定、套餐/邮箱/并发/权重、7D 用尽受限与冻结优先、恢复可调度；修复前因 drifted 绑定误判失败）；`gateway-vendor-accounts` e2e 新增用例：两个账号池都列出该账号且名称/邮箱为授权邮箱、详情同形状、按版本编辑分组、自动代理被拒、供应商账号文件重新授权推送到原运行账号、其他供应商建草稿与盗用草稿被拒、运营端同路径可用、关闭 `allow_runtime` 后 403（修复前名称为 `account_<id>` 失败）；工作台组件测试覆盖 Gateway 行的额度、邮箱、费用单元格。

## 2026-11-03 修复 Gateway Worker 托管重启用例计时不稳

- **Bug 修复（测试）：** `gateway-worker-supervisor.test.mjs` 的“崩溃按退避重启”用例在首次 1 秒退避后只固定等待 1.1 秒，CI 负载高时定时器晚触发即失败（main `6d0c928e` 的 CI unit 因此失败，与该提交改动无关）。改为轮询等待重启发生，最长 5 秒；“退避期内不重启”的断言保留。业务代码无变化。
- **破坏性变更 / 接口 / 配置 / 迁移：** 无。**升级指南：** 无需操作。
- **验证：** 该用例本地连续 3 次通过。

## 2026-11-03 Codex 账号名称统一与文案精简

- **优化改进：**
  - 使用记录、统计与「上游账号」筛选里，Gateway Worker 请求按创建账号时的「账号名称」显示（留空时为授权邮箱），不再显示内部运行账号 ID（`gwacct_…`）；超管的上游账号筛选项新增未归档的 Gateway 账号，按名称搜索、按运行账号 ID 精确筛选。运行账号 ID 仍是 Worker、绑定表与回执的内部主键，没有改名或迁移；Codex 账号详情不再单列「运行账号」。
  - 供应商门户新建 OpenAI 账号固定由 Gateway Worker 执行，表单不再显示「执行方式」；授权说明改用 Gateway 文案，不再出现「一槽一号」「换票经槽 SOCKS5」等虚拟机提示。Anthropic 账号与已存在的 OpenAI 虚拟机账号不变。
  - Codex 账号页精简文案：去掉调度开关的 CPR 对照说明、「全部模型」说明、OAuth/auth.json 引导段、新建弹窗中与标题说明重复的「首次授权即创建账号」；新建、编辑、重新授权、权重、额度预测、批量编辑与 OAuth 回调说明缩短为一句。批量编辑去掉每个字段旁的「适用 N 个」；调度开关、模型范围在选中账号取值一致时直接预填，「当前：…」只在取值不一致（或代理这类未预填的字段）时显示，并发、RPM、权重、备注不再重复显示当前值。
- **清理：** 删除不再使用的文案键 `vendor.executionKind` / `executionVm` / `executionGatewayWorker`、`common.codexScheduleHelp` / `codexModelAccessAllHelp` / `codexGatewayCredentialHelp` / `codexRuntimeAccount` / `codexBulkApplies`（四种语言）。
- **上游取舍：** 官方上游没有 Gateway Worker，本节均为定制差异。
- **破坏性变更：** 供应商门户无法再新建 OpenAI 虚拟机账号；未开放 Gateway Worker 开户策略（`/api/panel/gateway-execution-policies` 的 `allow_create`）的供应商新建 OpenAI 账号会收到 403「当前供应商未开放 Gateway Worker 开户」，需超管先开放。
- **接口 / 配置 / 迁移：** 无新增接口、配置或迁移；`/api/panel/usage-logs/filter-options` 的 `accounts` 对超管多返回 Gateway 账号（`id` 为运行账号 ID，`name` 为账号名称）。
- **升级指南：** 部署控制面与前端后生效；本轮未部署。历史 Gateway 使用记录无需回填，按运行账号实时解析名称；账号改名后历史记录同步显示新名称。
- **已知限制：** 已归档的 Gateway 账号不出现在筛选项里（与虚拟机账号一致），其历史记录仍显示名称。未在真实面板中人工点验。
- **验证：** 新增使用记录回归：已投影与未投影的 Gateway 运行账号都显示账号名称、筛选项返回名称、按运行账号筛选只命中本账号（修复前显示 `gwacct_account_x`）；使用记录、统计、请求日志与导出相关 Node 单测 109 项通过；Gateway e2e（供应商建号、超管建号、真实 Worker）与 `panel-users` 通过；Web `tsc --noEmit`、Prettier 检查与 `vitest run` 112 个文件 844 项通过，eslint 无错误（`account-create-form.tsx` 2 条既有 react-refresh 警告）。

## 2026-11-03 Codex 账号列表与卡片对齐 VM 列表

- **需求：** `/console/#/codex-accounts` 的列表和卡片与 `/console/#/vm` 完全对齐。
- **实现：** Codex 账号页不再自绘表格和卡片，改为直接使用 VM 页的 `FleetPulse`（分区概览与筛选）、`VmTable`（同列、同单元格、可拖动列序并恢复默认）、`VmRack`（机架分区，小 / 中 / 大三档卡片）和选择 / 批量编辑栏。抽出共用筛选栏 `vm-list-toolbar.tsx`（搜索、排序与方向、卡片尺寸、列表 / 卡片切换），VM 页与 Codex 页共用。账号经 `gatewayAccountAsVm` 转为 VM 行形态；排序和搜索也使用 VM 的 `sortVms` / `filterVms`，代理 id 参与搜索。
- **Gateway 差异的注入方式：** 在 `VmActions` 上增加可选扩展点，未提供时 VM 页行为不变：`setSchedulable`（调度开关走 Gateway pause/resume）、`openaiQuota`（券查询 / 重置券走 `/api/panel/codex-accounts/:id/quota` 与 `/reset-credits`，结果不明时保留幂等键重试）、`renderProxy`（显示代理端点主机，不调用 VM 出口探测）、`packageExport: false`（不显示打包 JSON）；`openRecovery` 改为可选（Gateway 账号不显示恢复服务）。`SchedulableSwitch` 增加 `onToggle`，`VmSelectionProvider` 增加 `renderBulkEdit`（使用 Gateway 批量编辑），选择框只出现在可编辑行（已归档账号不可选）。行菜单与 VM 一致：测试链接、查看统计、重新授权、刷新令牌、分配给分组、恢复状态、删除（归档账号）；点击行或卡片仍打开 Gateway 账号详情侧栏。
- **清理：** 删除 `account-table.tsx`（自绘列表）、卡片区、自有状态汇总按钮、20 条分页、自有排序 / 视图开关与行菜单，以及四语中失效的 9 个 `common` 文案键（`codexConcurrencyRpm`、`codexGatewayChip`、`codexNext`、`codexPrevious`、`codexSelectAll`、`codexSelected`、`recoverCooldown`、`refreshCredentials`、`testAccount`）。视图与卡片尺寸偏好分别存于 `codex-accounts-view` / `codex-accounts-card-size`。
- **行为变化：** 类型列改为 VM 的调用形式与优先级（不再显示并发 / RPM，详情与编辑仍可查看和修改）；不再分页，与 VM 列表一样一次显示全部筛选结果；“显示已归档”开关保留在筛选栏。
- **接口 / 配置 / 迁移：** 无新增后端接口、配置、迁移或依赖。破坏性变更：无。部署前端后生效，本轮未部署。
- **验证：** 前端 TypeScript 通过；`src/features/vm`、`src/features/gateway-worker`、`src/lib` 48 个测试文件 441/441 通过，i18n 完整性测试通过；修改文件 Prettier 通过，ESLint 无新增错误（`vm-action-menu.tsx` 的重复 `@/i18n` 导入为既有问题）。未在浏览器中逐页目检。

## 2026-11-03 Gateway Worker 对齐 CPR v3.39.1（187af363）

- **范围：** 盘点 codex-proxy-rs 自 `e0b7a841`（Gateway Worker 开工时本机 CPR 检出）至 `187af363`（v3.39.1）的 27 个提交：与网关相关 12 个，其中 4 个需要改动，其余已具备或不适用；15 个为依赖升级、Windows 构建、插件、部署文档、发版与 CPR 自身前端/PostgreSQL 修复，与网关无关。逐条结论与下次增量盘点起点记录在 `docs/cpr/04-evidence-index.md`「Gateway Worker 对齐基线」。
- **Bug 修复：**
  - WS 托管搜索声明识别（CPR `79083a56`，openai/codex 仓库 570 号 issue 同类问题）：上游 WS 连接按首个请求是否声明搜索定型，原先只看顶层 `tools`，漏掉 Responses Lite 在 `input` 的 `additional_tools` / `tool_search_output` 中携带的 `web_search` 声明（Worker 自身的搜索历史兼容也会补这类声明），可能把需要搜索的请求发到首包未初始化搜索的连接上被上游拒绝。现两处都识别；名为 `web_search` 的函数工具或消息正文中的字样不再误判为搜索声明。
  - turn state 归属证明（CPR `790f3147`）：归属不明的全量请求（未钉住账号、没有 `session-id` 或会话记录过期）以前一律清掉 `x-codex-turn-state`。现 Worker 为上游交给客户端的 token 保存摘要证明（Client Key、账号、会话、线程、turn id 与 token；成功与失败响应都记录；保留时长同会话亲和、最多 4096 项，API Key 账号换凭据后不继承），同一 turn 带回已证明的 token 时在请求头与 `client_metadata` 中保留；伪造、换 turn、换账号或换 Client Key 的 token 仍清理，证明不放行 `previous_response_id`。上游失败响应的 `x-codex-turn-state` 现由 Worker 与 Node（Responses 协议）交还客户端。
- **优化改进（出站请求头，CPR `2016bda0` / `e7c24781`）：** HTTP、WS 握手、Live 与目录请求以本账号安装身份写 `x-codex-installation-id`（与 `client_metadata` 同值，WS 握手中排在官方顺序表之后），调用方的值仍丢弃；`traceparent`、`tracestate`、`sentry-trace`、`baggage`（含正文与 turn metadata 中的同名字段及 WS `ws_request_header_*` 副本）与 `x-openai-fedramp` 改为原样透传；`x-openai-account-routing-override` 仍只取部署配置。
- **Retry-After 上限（CPR `0ff1a729`）：** 超过上限不截短、放弃同号等待改走换号或原错误出口的行为原已具备；`KIN_CODEX_GATEWAY_MAX_RETRY_AFTER_SECONDS` / 配置文件 `max_retry_after_seconds` 显式 0 现表示不接受正数等待（原先 0 回落为 240），缺省仍为 240，负数视为未配置。CPR 是面板运行设置，这里保留环境变量/配置文件，不新增面板项。
- **已具备、无需改动：** `7b05b14a`（模型拒绝只认 `model_not_found` + 400/403/404，`unsupported_value` 为请求错误）、`e7c24781`（路由覆盖头只取部署配置）、`6f71b27c`（互联池摘要计入只由额度提供的套餐）。**不适用：** `a92b95c4`（代理延迟只由 IPv4 一次查询计时，无双栈拉长问题）、`187af363` / `be35f8a6` / `d22ec298`（CPR 作为接入方同步与展示其他 CPR，本项目只实现被接入方 `/v1/cpr/link`）、`26de6712`（CPR PostgreSQL 配置快照竞争）。
- **上游取舍：** 官方上游 `dofastted/vm2api` 没有 Gateway Worker，本节均为定制差异，对齐对象是 codex-proxy-rs 的行为。
- **破坏性变更：** 发往 OpenAI 的请求现在带调用方的 trace 头与 `x-openai-fedramp`；不希望外发 trace 时可在设置页「隐私规则」删除这些请求头。显式配置 `KIN_CODEX_GATEWAY_MAX_RETRY_AFTER_SECONDS=0` 的部署从“240 秒”变为“不接受正数等待”。
- **接口 / 配置 / 迁移：** 无新增接口、迁移或依赖；配置仅上述 0 语义变化。
- **升级指南：** 部署控制面镜像后随托管 Worker 生效；本轮未部署。无数据处置。
- **已知限制：** 真实 OpenAI 账号下 trace/fedramp 透传与 installation id 头的上游表现、WS 搜索连接切换未在生产验收；turn state 证明只在单个 Worker 进程内存中，Worker 重启或多 Worker 之间不共享（与 CPR 进程内实现一致）。
- **验证：** Go `go vet ./...`、`go test -race ./...` 全部通过，linux amd64/arm64 交叉编译通过；新增 Lite 搜索声明识别 6 例、turn state 证明端到端（失败响应 token 回传、伪造/换 turn 清理、成功 token 记录、不放行 `previous_response_id`）与范围/过期/容量单测、Retry-After 上限配置语义单测，WS 握手头序指纹测试锁定安装头与 trace 位置；turn state 端到端测试在去掉修复后失败。Node `gateway-codex-dispatch` 27 项通过（含 trace/fedramp 透传与失败响应 turn-state 交还）；完整 `npm run test:unit` 408/412 个文件通过，失败的 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 在 main 上同样失败（依赖 Linux 环境或外部二进制）；Gateway e2e（含真实 `kin-codex-gateway` 二进制）全部通过。

## 2026-11-03 Key 的 CPR 互联共享仅超级管理员可设置（界面与后端）

- **需求：** 用户要求管理员（admin）与普通用户在「API 密钥」页创建、编辑 Key 时不显示「CPR 互联共享」与「上游客户端画像」两个区块，并要求后端同样限权。
- **前端：** `web/src/features/keys/index.tsx` 中「CPR 互联共享」区块与「上游客户端画像」一样只对超级管理员渲染；非超管提交创建/编辑时不再携带 `peer_sharing`（与 `codex_client_profile` 同一做法）。超级管理员的创建、编辑行为不变。
- **后端：** `panel-api-key-routes.mjs` 新增 `denySuperAdminOnlyFields`，`POST /api/panel/api-keys` 与 `PATCH /api/panel/api-keys/:id` 对非超管请求中出现的 `peer_sharing` 返回 403 `forbidden`（“只有超级管理员可以设置 Key 的 CPR 互联共享”），原有 `codex_client_profile` 限权并入同一函数（PATCH 行为不变，POST 本就不写入该字段）。批量编辑 `PATCH /api/panel/api-keys/bulk` 的白名单本就不含这两个字段，未改。
- **上游取舍：** CPR 互联共享与客户端画像均为定制功能（上游无对应界面），属定制差异内调整；不新增兼容路径。
- **接口 / 配置 / 迁移：** 无新增接口、配置、迁移或依赖。破坏性变更：管理员/用户通过 API 直接创建或编辑 Key 时若携带 `peer_sharing` 会被拒绝（403）。数据：已开启互联共享的管理员/用户 Key 保持原设置继续生效（`GET /v1/cpr/link` 可用），只能由超级管理员修改或关闭；本轮未处置历史数据。部署控制面与前端后生效，本轮未部署。
- **验证：** Web `tsc -b`、修改文件 ESLint 与 Prettier 通过；`src/features/keys` 44/44 通过。新增回归：用户与管理员创建/编辑携带 `peer_sharing` 均 403 且不新增 Key、不改写原值，超管可设置（还原后端修复后失败）；`panel-api-key-routes`、`panel-acl`、`codex-client-profile`、`cpr-peer-link`、`panel-route-coverage` 与 `api-keys`、`panel-users`、`super-admin-key-billing` e2e 共 47/47 通过，Biome 格式通过。

## 2026-11-03 用量窗口与成本列恢复上游

- **需求：** 用户要求 VM 列表“用量窗口”和“成本”两列整列采用上游 `e3a60858` 方案，移除定制代码及文件，包括同列的额度查询/重置操作。
- **成本列：** “总计”恢复上游含义：账号累计官方价消耗与累计 Token（`vmTotalCost` / `vmTotalTokens`）。删除 `vmProjected7d`、`VmLedgerRow` 的可空金额与 `estimated` 字段、`≈` 标记和“—”占位；单台成本账、机架汇总（`rackTotals`、机架头、小档单元）同步恢复。
- **用量窗口列：** 倒计时列恢复上游 `3.25rem` 定宽截断（较长倒计时如 `6d11h38m` 可能被截断），列最小宽度恢复 208px；删除 Fable 行的“Fable 已达 x% 上限”提示（`usage-meter.tsx` 恢复上游，Fable 周上限仍在状态列和详情页显示）。
- **同列额度操作：** GPT 券查询、Claude 限额查询/重置恢复上游：只显示最近一张/一次重置的到期倒计时（详情面板），删除逐张到期列表与 `reset-credit-expiries.tsx`、额度操作后额外刷新用量统计查询、Claude 操作后 `usage_refreshed=false` 的提示；四语文案中失效的 `creditExpiry`、`usageRefreshFailed` 键已删除。
- **后端：** 7D/5H 实时估算门槛恢复上游 5%（`ESTIMATE_MIN_USED_RATIO`、“用量<5%”四语文案）；撤回 credits 账号 429 保留窗口读数的例外，`persistCodexUsage` 恢复上游在 429 时清空低于上限读数的行为。
- **有依据保留：** 四语翻译与 UTC+8 时间格式（全站本地化，非本列口径）；`QuotaWindowRow` 导出（供应商账号池复用）。后端额度重置流程的状态处理保持不变：重置成功后写入 `cleared_windows`、清除耗尽冷却并回读用量，影响调度可用性与窗口费用起点，且仍返回 `usage_refreshed` 字段（前端不再展示）；如需同样恢复上游，需单独处理。
- **接口 / 配置 / 迁移：** 无新增接口、配置、迁移或依赖。生产 `logging.retain_days=8`（2026-11-03 经面板修改，备份 `/root/tapmodels-config-backups/routing.json.20261103-before-retain8`）保持不变：上游窗口统计同样直接读取 `usage_logs`。破坏性变更：成本“总计”从 7D 预计改为累计；部署控制面与前端后生效，本轮未部署。
- **验证：** 前端 TypeScript 通过；`src/features/vm`、`vm-usage`、`i18n` 相关 28 个测试文件 267/267 通过；修改文件 ESLint、Prettier 通过。后端 `window-estimate`、`codex-quota-stale`、`usage-logs-repo`、`panel-billing-lookup` 51/51 通过，恢复为上游的文件与基线逐字一致（`window-estimate.mjs`、`usage-meter.tsx` 及对应测试）。

## 2026-11-03 分组绑定 Gateway 账号后供应商 VM 被移出调度、管理资源页 500

- **问题原因：** 13:29 超管在「Codex 账号」新建 Gateway 账号 `codex-cn-5@kdanmobile.com` 并绑定 Coding 分组后：① 供应商运行策略 `vendorRuntimeBlock` 仍把分组内任何非 VM 资源视为混合后端，Coding 下 5 个供应商槽（vm-25/26/28/29/31）全部判为 `vendor_scope_revoked` 移出调度（vm-31 13:00–13:29 处理 185 次，之后 5 次）；而 Gateway 账号的建号与分组可选规则早已允许 VM 与 Gateway 账号同组，两处规则不一致。② 分组「管理资源」弹窗按第一个资源类型选默认页签，Coding 按 `resource_id` 排序首项为 Gateway 账号，弹窗不支持该类型，`value.includes` 取到 undefined 整页 500；且资源保存接口先删分组全部资源再写入，即使不崩溃也会顺带删掉 Gateway 账号绑定。同类旧规则还在 `validateVmGroups`（VM 页 / 批量编辑把 VM 加入该分组被拒）与分组视图 `supported_platforms`（供应商门户不再列出该分组）。
- **修复：** 新增 `isVmBackendKind`（VM 与 Gateway Worker 账号同属 VM 后端，API 端点单独成后端），`validateVmGroups`、分组视图与 `vendorRuntimeBlock` 统一使用该规则；分组资源 `PUT /api/panel/groups/:id/resources` 只替换 VM / API 端点，保留由「Codex 账号」页维护的 Gateway 账号绑定，分组含 Gateway 账号时仍拒绝写入 API 端点。弹窗默认页签只在 VM / API 间选择，并提示“此分组还绑定了 N 个 Gateway 账号，保存时会保留”（四语）。
- **上游取舍：** 官方上游没有供应商平台与 Gateway Worker，属定制差异内的规则对齐；不新增兼容路径。
- **接口 / 配置 / 迁移：** 无新增接口、配置或迁移；资源 PUT 不再删除 Gateway 账号绑定。破坏性变更：无。
- **升级指南与限制：** 部署控制面后生效；本轮未部署。部署前的临时恢复：在「Codex 账号」页把该 Gateway 账号移出 Coding，供应商槽下一次刷新即恢复调度。分组绑定 Gateway 账号后，该分组的 Codex 请求只走 Worker（既有行为），供应商的 Codex VM 在该分组不再接 Codex 流量。
- **验证：** 新增回归：供应商 VM 分组混入 Gateway 账号不阻断、混入 API 端点仍阻断；资源 PUT 保留 Gateway 绑定且拒绝 API 端点、`validateVmGroups` 接受含 Gateway 账号的分组（还原修复后两条均失败）。`relay-operations`、`vendor-audit`、`vendor-review`、`vm-bulk-edit`、`gateway-account-management` 73 项与 `slot-delete-groups`、`gateway-operator-accounts`、`gateway-vendor-accounts` e2e 通过；Web `tsc -b`、Prettier、`src/i18n` 与分组测试通过，Biome 通过。`groups/index.tsx` 原有 1 处 `no-extra-boolean-cast` lint 错误与本次无关，未改。

## 2026-11-03 供应商阻断的槽位不再显示为“开关开 + 调度关”

- **问题原因：** 用户反馈 vm-28/29/31 在账号池列表开关为开，状态却显示“调度关”。生产只读核查：三个槽于 13:04 加入 KDAN 分组，而所属供应商只授权 Coding 分组，`vendorRuntimeBlock` 判定 `vendor_scope_revoked`，`summarizeVm` 据此把 `schedulable` 置为 false。面板的 `resolveSlotState` 对未迁移记录只认“不可调度 / 调度关”两类原因，供应商阻断等系统 hold 原因落空后读到活跃可用性 `off` 也不处理，最终返回 `on`；开关按 `on` 显示为开，状态列按可用性 `off` 显示“调度关”，真正原因被隐藏。只影响面板显示，号池选号不读该状态，不受影响。
- **修复：** `schedule-state.mjs` 在 `schedulable=false` 且 `schedule_disabled_reason` 属于系统 hold（`vendor_disabled`、`vendor_paused`、`vendor_archived`、`vendor_scope_revoked`、`vendor_proxy_disabled`、`vendor_policy_unavailable`、`maintenance`、`proxy_cooldown`）时返回“受限”并带原因；面板显示“受限 · 供应范围已撤销”等，开关提示“调度开，当前受限”。前端 `BACKEND_STATUS_LABELS` 补齐 6 个供应商原因的四语文案，不再在英文/日文界面显示中文原文。
- **上游取舍：** 官方上游没有供应商平台与供应商阻断，属定制差异的修正；未新增兼容路径。
- **接口 / 配置 / 迁移：** 无新增接口、配置或迁移；面板 `schedule_state` 对上述情形由 `on` 改为 `restricted`。破坏性变更：无。
- **升级指南与限制：** 部署控制面后生效；本轮未部署。vm-28/29/31 本身仍需在面板把它们移出 KDAN，或为供应商授权 KDAN 后才恢复调度（数据未改动）。
- **验证：** 新增后端回归（四种 hold 原因 + 可用性 `off` 均解析为受限）与前端回归（中/英文案）；`schedule-state`、`availability`、`schedule-state-registry`、`vm-schedulable-credential` 单测，Web `vm-status`、`schedulable-switch`、`src/i18n` 测试，`tsc -b`、ESLint、Prettier、Biome 均通过。

## 2026-11-03 Gateway Worker 随控制面自动运行

- **Bug 修复：** 发版升级后「资源管理 → Gateway Worker」一直显示“控制面托管：Gateway 未开启，Worker 未运行”。原因是托管启动受 `KIN_CODEX_GATEWAY_ENABLED` / `routing.codex.gateway_worker.enabled` 总开关控制，默认关闭且没有界面入口。现取消该总开关：`bin/kin-codex-gateway` 存在时控制面始终托管启动同机 Worker，升级即换新版本并自动注册。
- **行为：** Codex 请求是否走 Worker 只看 API Key 所在分组是否绑定 Gateway 账号；未绑定的分组保持 Codex VM，行为不变。`routing.codex.gateway_worker.preference=vm` 可强制全部走 VM，`KIN_CODEX_GATEWAY_SUPERVISE=0` 改由外部启动 Worker。
- **清理：** 删除 `KIN_CODEX_GATEWAY_ENABLED`、`routing.codex.gateway_worker.enabled`（已保存的 `enabled` 字段不再读取，下次保存路由时被规整掉）、托管状态 `disabled` 与对应四语文案；Gateway 关闭时停止 Worker 的分支一并删除，`stopped` 只在控制面关停时出现，页面不再单列文案。
- **升级指南：** 无需操作。已在 `.env` 写了 `KIN_CODEX_GATEWAY_ENABLED` 的可删除该行（不再读取）。

## 2026-11-03 Codex Gateway Worker 合入 main（Node 控制面 + Go Worker，对齐 codex-proxy-rs）

- **范围与默认：** Codex 账号新增执行方式 `gateway_worker`，与 Codex VM 槽位并存。控制面始终托管同机 Go 进程 `kin-codex-gateway`；分组绑定 Gateway 账号后，该分组的 Codex 请求由 Worker 执行，未绑定的分组保持 Codex VM。Claude VM、Codex VM、API 端点路径与既有账务不变。来源为本仓库 `codex-gateway` 分支（`b43c5db7`）相对旧定制 `02a44730` 的全部增量，本次以三方合并叠加到当前 main。
- **新增功能：**
  - **账号：** 资源管理「Codex 账号」页由超管直接创建平台自营账号（使用现有 OpenAI 分组与代理，OAuth 或 auth.json 授权，无需预建供应商）；供应商门户新建 OpenAI 账号可选 Gateway Worker 执行方式。OAuth PKCE 在 Worker 换码，凭据只存在 Worker，Worker 之间以 AES-GCM 凭据包投影。支持编辑、暂停/恢复、刷新、重新授权、归档与批量编辑；详情显示 5h/7d 额度窗口、credits 与重置卡（超管可消费）、额度预测、各实例错误保护冻结、账号资料统计、订阅周期与官方头像。
  - **执行：** Responses、Chat Completions、Completions、Images（generations/edits）、独立 Search、模型目录（含 `GET /v1/models/{model_id}`）与入站 Responses WebSocket 原生透传；Live 语音 `/v1/live`、`/v1/realtime`、`/v1/realtime/calls`（含 sideband WebSocket 与 hangup，翻译/转写/SIP 等返回 501）。Worker 内完成选号（权重层 + smart 评分、会话亲和、Guardian 独立并发池、账号 FIFO 有界等待）、错误分类与同号重试/换号、凭据提前刷新与 401 刷新重试、额度观测与后台刷新（耗尽须两次确认或窗口滚动才解除）、按 UTC+8 时刻预热、套餐模型目录与资格、分组 Fast 三态、账号错误保护（冻结经心跳在实例间共享）、Drain 截止。上游默认 WebSocket（连接池、恢复预算、按代理连接上限），HTTP 正文 zstd，复现官方 Codex 的 TLS（native-tls / rustls，配置自定义 CA 时 rustls + HTTP/2）与 WS 握手指纹，TLS 会话按出口复用；关联 ID 按账号映射、trace 头透传、`x-codex-installation-id` 按账号写入，turn-state 仅同账号或经归属证明回放，Cookie 按凭据代次保存。
  - **出站身份与改写：** 设置页「上游客户端画像」（Desktop/CLI × macOS/Linux/Windows，自动跟随官方稳定发布并可滞后，或固定版本、自定义 User-Agent；Worker 每 24 小时核验 npm、appcast、MSIX、DEB 官方制品），API Key 可单独覆盖；「隐私规则」（turn metadata、Desktop Git 上下文、环境文本、正文、请求头的正则替换/固定值/改键名/删除，规则级事务，失败跳过或 400 `privacy_policy_rejected`，可试运行）；「请求位置」（全局位置，代理可继承、手动或跟随出口探测，改写时区上下文与 web_search 位置）；请求兼容（reasoning 历史清理、搜索历史补声明）。流式请求在 Worker 排队或重试超过 15 秒时先建立 SSE 并保活，之后的错误改为流内失败事件。
  - **计费与分组：** 分组可按张计费生图、按次计费网页搜索；Gateway 用量按 VM 口径记账（input 扣除缓存，reasoning 属于 output），按实际发送的 service tier 计价，回执与实时日志对账。Key 新增「CPR 互联共享」开关与只读 `GET /v1/cpr/link`。
  - **运维：** 控制面托管同机 Worker（`bin/kin-codex-gateway` 存在时自动启动，崩溃按 1～60 秒退避重启，日志带 `[codex-gateway]` 前缀并入控制面输出，随控制面升级换版本）；内部 token 与凭据包密钥未配置时由控制面生成并保存在 `data/runtime-secrets.json`。默认单 Worker 模式，另一个接单实例的注册返回 409 `gateway_single_worker`。「资源管理 → Gateway Worker」页显示实例、托管状态与模式，可做健康检查、Drain 与恢复；Worker 回执先落盘，控制面每 60 秒对账；`npm run health:codex-gateway` 发起签名健康探测。
- **接口 / 配置 / 迁移：**
  - 面板接口：`/api/panel/gateway-workers*`、`/api/panel/codex-accounts*`、`/api/panel/codex-client-profile*`、`/api/panel/codex-privacy*`、`/api/panel/codex-request-location`；内部接口：`/internal/v1/gateway/workers/register|heartbeat`、`/internal/v1/gateway/receipts`；对外：`/v1/live`、`/v1/realtime*`、`/v1/cpr/link`、`/v1/models/{model_id}`。
  - 配置（`.env.example`）：控制面读取 `SUPERVISE`（默认托管，0 改为外部启动）、`MULTI_WORKER`（默认单实例）、`INTERNAL_TOKEN`、`CREDENTIAL_BUNDLE_KEY`（留空自动生成）、`REQUIRE_MTLS`、`ALLOW_INSECURE`、`TLS_CLIENT_*`；Worker 另读监听、实例 ID、数据目录、回连地址、并发与超时等键（托管时由控制面补齐默认值），以及 `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE`。
  - 迁移 079–087（全部为新增表/列/约束）：`079_codex_gateway_worker`、`080_codex_gateway_completion`、`081_platform_gateway_accounts`、`082_group_media_billing`、`083_api_key_peer_sharing`、`084_codex_fast_mode_proxy_ws`、`085_api_key_codex_client_profile`、`086_gateway_account_freezes`、`087_proxy_request_location`。在 `codex-gateway` 分支上原为 077–085，为避开 main 已用的 078 与已跳过的 077 顺延两位。
- **上游取舍与融合：** 官方上游 `dofastted/vm2api` 没有 Gateway Worker 或等价能力，以上均为定制新增。与 main 已有决定的冲突按 main 收敛：
  - 尝试记录沿用 main 已采用的上游 `request-attempts-repo.mjs`（write-behind、无 `send_state` 列）；Gateway 不再给 `request_attempts` 增加 `execution_kind`、`gateway_instance_id`、`dispatch_id`、`receipt_id`、`usage_confidence` 五列（无读取方）。Worker 实例、dispatch 与回执由 Gateway 自有表记录；发送状态只在内存与回执中用于换实例判定。
  - API Key 编辑沿用 main 的 `KeyLimitFields` 与 `prepareUpdate`，在其后追加互联共享与画像覆盖；分组页沿用 main 的 `ResourcePicker`；供应商用量沿用 main 的 `vendorAccountLogs(usageScope)`，补入 `gateway:<账号资源>` 归属；main 已撤销的 Codex 会话熔断与过载压缩不恢复。
  - 原同机侧车 compose overlay 已由控制面托管取代并删除；外部启动脚本 `scripts/codex-gateway-start.sh` 保留给多 Worker 与跨主机。
- **破坏性变更：** 未绑定 Gateway 账号的分组无行为变化。绑定 Gateway 账号的分组的 Codex 请求只走 Worker；Worker 不可用时返回 503 `gateway_worker_unavailable`，不回退 VM。按 `codex-gateway` 分支旧编号执行过 077–085 的测试数据库不能直接升级，需重建。
- **升级指南：** 先备份 SQLite 与 `data/` 目录。部署包含本提交的控制面镜像（amd64/arm64 镜像已包含 `kin-codex-gateway`），首次启动自动执行迁移 079–087，控制面生成密钥并启动 Worker；需要时在「资源管理 → Codex 账号」添加账号并绑定分组。多 Worker 或跨主机部署见 `docs/CODEX_GATEWAY_WORKER_SETUP.md`。保留 routing.json、vms/、data/、.env 与持久化挂载。
- **已知限制：** 真实 OpenAI OAuth 与付费推理、真实代理出口、mTLS 证书链、多 Worker 压测与生产滚动升级尚未在目标环境验收；Worker 离线或版本不一致没有告警；Gateway 不可用时不回退 VM；显式开启多 Worker 后账号限额按实例计算。`docs/CUSTOMIZATION_FILE_INDEX.md` / `CUSTOMIZATION_CURRENT_FILE_MAP.md` 是上游同步时生成的快照，下次同步重新生成。
- **验证：** 合并后完整 `npm run test:unit` 408/412 个文件通过，失败的 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 在 main（`7f9b730b`）上同样失败（依赖 Linux 环境或外部二进制）；Gateway 相关 e2e（`gateway-worker-real` 构建并启动真实 `kin-codex-gateway` 二进制、`gateway-vendor-accounts`、`gateway-operator-accounts`、`codex-key-catalog`）与 `panel-users` 全部通过；Go `go vet ./...`、`go test -race ./...` 通过，`kin-codex-gateway` 等命令 linux amd64/arm64 交叉编译通过；Web `tsc --noEmit`、Prettier 检查、`vitest run` 112 个文件 848 项通过；`biome format` 与 gofmt 全仓通过（`codex-gateway` 分支遗留的 20 个 Node 文件格式问题一并修正）。真实 OpenAI 账号、代理与生产环境未验收。

## 2026-11-03 修复会话绑定不随座位迁移导致出站 session 每次重建

- **问题原因：** 生产只读排查：同一入站会话 `949fe2aa…` 在 16:31:43–17:10:48（北京时间）连续 59 条请求都在同一账号、同一 `vm-03` 上成功，却产生了 59 个不同的出站 session。原因有三层：一是座位路径 `selectSeat` 按设计先选设备亲和 VM（`seatHomes` 顺序为设备、会话 pin、家族），会话 pin 仍指向 `vm-01`，实际却落在 `vm-03`；二是 `failover-runner` 的 `bindAll` 遇到“旧 pin 属于其他账号”就一律跳过，只放行同一请求内故障转移的 `ownMove`，成功后 pin 一直留在 `vm-01`；三是 `outbound_session: rebuild` 模式只在绑定 VM 与实际 VM 相同时才复用 session，否则用“入站会话 + 本次尝试时间”生成新 ID，于是每轮都换号。缓存仍有命中，但上游看到的会话持续变化。上游 `034dad44` 同样存在该问题。
- **修复：** `failover-runner.mjs` 的成功收尾 `bindAll` 对座位授予的选择（`selected.seatKey`）传 `seated: true`。旧 pin 属于其他账号、且该账号本轮没有因 `slot_busy` 容量溢出（`spilled`）时，以 `allowMove` + `replaceSession` 把 pin 迁到座位所在 VM，并写入本次实际发出的出站 session；下一轮绑定 VM 与实际 VM 一致，复用同一 session。直连路径（探针、pin VM、无座位请求）、`slot_busy` 借用、他人已移动的 pin（`pinMoved` / `ifGeneration`）仍不改写。
- **上游取舍：** 上游没有等效修复，存在可复现的生产回归，按例外保留最小差异：只在成功收尾时让座位决定同步到会话 pin，不改变座位选择顺序、session 生成算法或 `rebuild` 配置。上游让 pin 跟随座位或改变 rebuild 复用条件后，收敛并删除此差异。
- **接口 / 配置 / 迁移：** 无新增 API、配置、依赖或迁移。破坏性变更：无。行为变化：座位落在其他账号并成功后，会话 sticky 记录迁到该 VM/账号（`generation` +1），出站 session 改为该 VM 首次发出的 ID。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。已卡住的会话在部署后的下一次成功请求时自动迁移，无需处理数据。排查中 `vm-01` 的 `slot worker timeout after 3000ms` 与自动重启可能影响路由切换，未在本项处理。
- **验证：** `failover-runner.test.mjs` 新增两项：pin 在 `vm-01`、座位连续授予 `vm-03` 时，首轮成功后 pin 迁到 `vm-03`，三轮出站 session 完全相同（修复前的 HEAD 上失败）；pin 所属账号本轮 `slot_busy` 溢出时 pin 与 session 保持不变。failover-runner、sticky-router、pool-scheduler、seat-planner、session、account-protection-failover 共 262/262 通过；完整 `npm run test:unit` 395/399 个文件通过，失败的 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 在未修改的 HEAD 上同样失败（依赖 Linux 环境或外部二进制）；Biome 检查 2 个变更文件通过。

## 2026-11-03 修复网关内存涨满崩溃：cache-prefix 摘要树只保留尾部，选号不再重复写 VM 文件

- **问题原因：** 生产 v1.4.037 的 Node 主进程长期接近 100% CPU，并且 06:04、07:03、07:44、08:27 四次以退出码 134 自动重启。崩溃日志为 `Ineffective mark-compacts near heap limit ... JavaScript heap out of memory`：进程每次运行约 43 分钟后，堆涨到默认约 2 GB 的上限。经授权，在 v1.4.037.1 上通过本机回环调试端口做了 12 分钟只读剖析（采集后已关闭端口并删除文件）：
  - **内存：** 采样期间新分配且仍存活的 556 MB 中，294 MB（53%）来自 Claude `prepareCachePrefix` → `snapshotBody` → `partRecord` → `valueStamp`。上游 `7c76e7ae`（10-20）给每条消息、每个内容块都存一棵逐层字段摘要树，按 `account:session` 保留 60 分钟。线上 Claude 上下文中位数约 38 万 token，每小时约 108 个会话键，每个快照约 3 MB，不到一小时就把堆填满。
  - **CPU（60 秒，主线程空闲 1.8%）：** cache-prefix 前缀比对约 25–30%；Codex 选号约 17%，其中 `syncCodexQuotaSchedule` → `markVmRestriction` 在每次准入时把每台受额度限制的 VM 文件重写一遍（`updated_at` 每次都变），连带原子写盘改名、fs.watch 同步写库（含加密）和 JSON 缓存失效，约 11%。当时有 10 台 VM 处于 7 天额度限制。此问题上游 `e3a60858` 同样存在。
  - 已移除的会话熔断与过载压缩重试经计时只占约 0.2% 个核，与此无关。
- **修复：**
  - `cache-prefix.mjs`：字段摘要树只为最后 24 条消息（`STAMPED_TAIL`，与 `IMAGE_WINDOW` 一致）保存；更早的消息仍保留整条消息摘要、角色、键名、图片计数，以及每个内容块的类型和摘要。断点位置、`kind` 分类、缓存标记放置和“第几个块变化”保持精确；断点落在尾部之前时，存储一侧没有字段树，`fields` 回退为已有的 `{ change: 'digest' }`。当前请求一侧和同一请求入站/出站对比（`firstHistoryDiff`）按需从请求体重建字段树，明细不变。新增测试用导出 `cachePrefixStampedMessagesForTest`。
  - `oauth-credentials.mjs`：`markVmRestriction` 在原因和截止时间都未变化时直接返回，不写文件。`vm-registry.mjs`：`_local` 类且无截止时间的限制，只在确有残留截止时间时才先清除，避免“清除一次、再写回一次”。
- **效果（本地等规模对比）：** 50 个约 400 条消息的 Claude 会话，快照保留内存由 70.4 MB 降到 16.5 MB（−77%），构建耗时由 2.2 秒降到 1.25 秒；受限 VM 在状态不变时选号零写盘。
- **上游取舍：** 两处都是上游代码，存在可复现的生产回归（内存耗尽崩溃、每请求重复写盘），按例外保留最小差异：不改变断点检测、标记放置、额度判定或写入语义，只减少保存的诊断明细和无变化的写入。上游修复内存保留或写入幂等后收敛并移除。
- **接口 / 配置 / 迁移：** 无新增 API、配置、依赖或迁移。破坏性变更：尾部 24 条之前的缓存断点日志只给出块级变化，不再给出字段级明细；受限 VM 的 `updated_at` 不再在每次请求时刷新。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。Node 默认堆上限（约 2 GB）未调整；如需余量，可另行授权设置 `NODE_OPTIONS=--max-old-space-size`。剖析中的其余热点（jev/distill 拦截约 16%、每次调用新建仓库导致 SQLite 重复 `prepare` 约 8%、每个请求对 Claude 整段对话的哈希）未在本项处理。
- **验证：** 新增 `test/unit/vm-restriction-write.test.mjs`（未变化不写文件、截止时间或原因变化仍写入、`_local` 限制多次同步不重写），在修复前的代码上两项均失败；cache-prefix 新增尾部内编辑保留字段明细、深处编辑只保留尾部字段树并回退 `digest`、同请求对比在深处仍有字段明细三项，原深处编辑用例按新行为更新，31/31 通过。主工作区 `node_modules` 在验证期间被外部清空，因此在隔离检出中 `npm ci` 后运行完整 `npm run test:unit`：395/399 个文件通过，失败的 `egress`、`oauth-binary`、`guest-identity-reader`、`telemetry-status` 在未修改的 HEAD 上同样失败（依赖 Linux 环境或外部二进制，由 CI 覆盖）；全仓 Biome 2.5.11 检查 867 个文件通过。

## 2026-11-03 Codex 429 短停放不再显示为“5h 限制”

- **问题原因：** 用户反馈 Pro 订阅账号 `codex-cc-08`（vm-09）显示“5h 限制，剩余 <1m”。生产只读核对：该账号上游 `x-codex-*` 响应头只计量 7D 窗口（`primary` 10080 分钟，已用 64%），另一侧 `secondary` 窗口为 0 分钟、已用 0，没有 5H 窗口。08:57:06Z 上游返回一次 429，响应头里没有满额窗口，`ingestCodexHop` 按 `CODEX_DEFAULT_PARK_MS` 把账号停放 60 秒并写入 `codex_limited_until`，到期时间 08:58:07Z 与截图中的恢复时间一致。上游 `e3a60858` 的 `codexQuotaWindowReason` 只要发现停放就返回 `quota_5h_header`，不区分窗口满额和 429 短停放；面板 `enrichVm` 又把任何不含 `5h` 的原因写成“7d 限制”。所以这次短停放显示成了“5h 限制”。
- **修复：** `codex-slot-pool.mjs` 中 `codexQuotaWindowReason` 只在 5H/7D 窗口确实满额时返回 `quota_5h_header` / `quota_7d_header`；没有满额窗口的停放返回 `rate_limited`，按现有状态表显示“限流中”。停放到期后 `evaluateCodexQuotaSchedule` 用 `isAccountRestrictionReason` 识别并清除这条受限（原先只认 `quota_5h|quota_7d`）。面板 `enrichVm` 按 `^quota_(5h|7d)` 取窗口，写法与 `evaluateAccount` 的硬封锁分支一致；没有窗口时显示“限流中”且不带 `window`；Codex 槽位存储的 `rate_limited` / `account_quota_exhausted` 与窗口类原因一样以实时额度判断为准。停放时长、调度判断和恢复时间不变。
- **上游取舍：** 上游 `e3a60858` 的 `codexQuotaWindowReason`、`hasQuotaRestriction`、`enrichVm` 都有这个误标，无法满足需求，因此在上游实现上保留 3 处最小差异。上游区分 429 停放与窗口满额后，收敛到上游写法并删除这些差异。
- **接口 / 配置 / 迁移：** 无新增接口、配置、依赖或迁移。Codex 无满额窗口时的 429 停放，`quota_policy.reason`、`restriction_reason`、`availability.reason` 由 `quota_5h_header` 改为 `rate_limited`，`availability.window` 改为 null。破坏性变更：无。
- **升级指南与限制：** 部署控制面后生效；本轮未部署。存量停放最长 60 秒，到期后自动清除，不需要处理数据。另外，该账号 08:00Z 后的 1,036 次上游尝试中只有 181 次返回 200，31 次是 429，其余多为 502。这与本次标签问题无关，需要另行排查。
- **验证：** 新增回归覆盖生产同款 Pro 读数：无满额窗口的停放返回 `rate_limited`、写入受限且截止时间等于停放到期时间、到期后清除。原“显式停放优先于 credits”的断言改为期望 `rate_limited`。在只含本次改动的隔离检出中，引用 Codex 槽位池、配额调度、面板与 Codex 协议的 27 个测试文件及 availability / schedule-state 测试共 465/465 通过；修改文件 Biome 与 `git diff --check` 通过。

## 2026-11-03 撤销 Codex 过载触发的上下文压缩与会话熔断

- **需求核查：** 这套逻辑不是用户需求。2026-11-01 用户只要求分析 `502 servers are currently overloaded` 的原因；排查代理根据单个会话（gpt-6.1-sol 先成功 18 次、随后在 6 台 VM 上连续失败 35 次）推断“最可能是累计上下文触发了上游保护”，未验证就实现了会话级过载恢复。同一份证据中该会话带同样上下文改用 `gpt-5.6-luna` 即成功，更符合模型容量不足。11-02 的工具配对修复、熔断时机修复和续写 409 都建立在这个未验证的前提上。上游 `e3a60858` 没有其中任何部分。
- **生产证据（2026-11-01 17:00 至 11-03 08:00，只读）：** 11-02 01–03 点旧逻辑在同一账号原样重发同一请求，25–36% 直接成功，说明过载是瞬时的，与请求内容无关；过载率随时段在全部账号上同步涨落（高峰 40–76%，低峰接近 0），与上下文大小无关；48 小时内 astra/sol 成功完成上下文超过 272k 的请求 2,391 次（最大 764k）；586 次“同一会话连续 ≥5 次过载”中只有 21 次发生在池成功率 ≥ 80% 时，且集中在 11-02 01:39–02:30 高峰开始阶段。网关压缩只作用于单次请求，客户端下一轮仍发送完整历史，即便真是上下文原因也无法持续解决。代价则很明确：会话熔断在 11-02 产生 8,753 条、11-03 六小时内产生 671 条 `503`；压缩会在用户不知情时删除旧 reasoning/工具历史，并使 prompt cache 前缀失效。
- **移除范围：**
  - 删除 `src/lib/pool/codex-session-overload.mjs` 及其测试：会话 + 模型过载计数、一次上下文恢复、60 秒会话冷却。
  - `handle-codex.mjs`：删除冷却会话入池前的 `503 codex_session_overloaded`、过载后的 `codexContextFallback` 压缩重试、跨槽位沿用恢复后历史、结束时合成会话 503、带 `previous_response_id` 的请求过载时返回 `409 codex_context_compaction_required` 的分支、提示文案常量与 `codexOverloadLooksSessionScoped`；`runCodexKernelHop` 删除仅供该回退使用的 `fallbackForResult` / `onFallback` 钩子，保留上游的 `reasoningHistoryFallback`。
  - `codex-context-budget.mjs`：删除 `codexContextCompactionRequired` 与只供过载回退使用的 `force` 选项及 `info.preflight` 字段。
  - `runtime-metrics.mjs` 删除 `context_retry` 阶段；更新 `docs/API.md`、`docs/RELAY_OPERATIONS.md`、`docs/cpr/05-codex-scheduling.md`。
- **现行行为：** 过载只走跨槽位故障转移，并受离群账号停放与池整体过载换号上限约束（见下一条）。带 `previous_response_id` 的请求只能在原账号继续，过载时直接返回上游过载错误。按模型上下文窗口的首次 hop 前预压缩（2026-11-02，来源于用户关于网关 272K / 客户端 500K 的需求）保留，未在本轮重新评估。
- **有依据保留：** `error-class.mjs` 中 `codex_session_overloaded → overloaded` 一行保留，因为请求日志分类在读取时计算（`enrichLogRow`），删除后保留期内的历史日志会从“过载”变为“不可用”。调用方为用量/错误日志读取，数据来源为 2026-11-03 前写入的 `usage_logs`；默认日志保留 8 天，2026-11-11 后移除该行及对应测试断言。历史日志本身不做处置。
- **上游取舍：** 收敛到上游：上游不按会话熔断，也不因过载改写请求历史。
- **接口 / 配置 / 迁移：** 无新增；移除错误码 `503 codex_session_overloaded`、`409 codex_context_compaction_required`、日志字段 `codex_context_recovered` / `codex_context_recovery` / `codex_session_overload_breaker` 和运行时阶段 `context_retry`。破坏性变更：持续过载的会话不再被熔断 60 秒，而是返回上游过载错误；处理过 409 `codex_context_compaction_required` 的客户端不会再收到它。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。`docs/CUSTOMIZATION_FILE_INDEX.md` / `CUSTOMIZATION_CURRENT_FILE_MAP.md` 是上游同步时生成的快照，仍列出已删除文件，下次同步时重新生成。
- **验证：** Codex/OpenAI/故障转移/调度/错误分类/请求日志/运行时指标相关测试 738/738 通过；改写的上下文预压缩测试改用真实超出预算的输入触发（不再依赖 `force`），10/10 通过；残留检查只剩上述有依据保留的分类映射及其测试；修改文件 Biome 与 `git diff --check` 通过。

## 2026-11-03 Codex 上游过载：离群账号停放、池级限制换号与重试预算修正

- **问题原因：** 用户反馈 Codex VM 每个 5 并发未用满，但客户端发会话很慢且经常报错。生产 v1.4.037 只读排查 `/v1/responses` 近 6 小时：入池排队等待约 0，网关容量不是瓶颈。错误主要是上游 `502 server_is_overloaded` 1,461 条、本地会话熔断 `503 codex_session_overloaded` 671 条、`504 codex_retry_deadline` 258 条。按上游尝试统计，UTC 01–10 点高峰期 40–76% 的尝试被上游以过载拒绝，低峰接近 0；它与单账号在途数和上下文大小均无明显关系。网关的处理放大了这个问题：
  - 每个请求平均打出 3.8–3.9 次上游尝试，每次过载尝试耗时 p50 3 秒、p90 10.7 秒，因此请求要 15–47 秒才失败。
  - `codex-cn-01` 自 05:20 起过载率持续 85–91%，同时段其他账号多在 0–30%，但它仍持续被派请求：过载不停放账号，线上 `quota_reset_priority` 策略也不看失败率。
  - 同一请求在两个账号上过载即触发上下文压缩，随后整会话熔断 60 秒；该机制已整体移除，见上一条“撤销 Codex 过载触发的上下文压缩与会话熔断”。
  - `total_retry_deadline_ms` 从请求进入网关、读取请求体之前开始计时。线上配置改为 10 秒后，40 分钟内有 215 个请求在上传请求体后一次也没派发就返回 504。
- **修复：**
  - `openai-account-runtime.mjs` 新增池级信号：`openAIPoolFailureBps` 取 15 分钟内有反馈账号的失败率中位数（至少 3 个账号），`openAIPoolOverloaded` 在中位数 ≥ 30% 时成立，`openAIOverloadOutlierHold` 在账号失败率 ≥ 70% 且比其余账号中位数高 ≥ 25 个百分点时给出 60 秒 `overload_outlier` 停放。
  - 过载结果只在账号是离群账号时停放，其余过载仍不停放，保留 2026-11-02 修复（逐次停放会在高峰把池子停空）。
  - 池整体过载时，每个请求最多因过载换号 1 次，随后返回上游过载错误并附 `Retry-After: 3`，日志写 `codex_pool_overload_stop`。
  - 重试总预算改为从进入 Codex 调度时计时；`first_token_ms` 等日志计时仍从入口 `t0` 计算。
- **上游取舍：** 上游 `e3a60858` 对所有 5xx（含过载）停放账号 30 秒，没有池级判断或换号上限。逐次停放在本地生产已证实会在高峰同时冷却 7–16 台 VM，因此保留最小差异：只增加基于现有失败 EWMA 的相对判断，不新增配置、持久化或调度策略。上游提供能区分池级过载与账号故障的机制后，收敛并移除这些差异。
- **接口 / 配置 / 迁移：** 无新增 API、配置、依赖或迁移。新增停放原因 `overload_outlier`、日志字段 `codex_pool_overload_stop`。破坏性变更：池整体过载时，请求最多尝试 2 个账号就返回 502 和 `Retry-After`，不再用完 `max_account_switches`。`total_retry_deadline_ms` 不再包含请求体上传时间。
- **升级指南与限制：** 部署控制面后自动生效；本轮未部署。池级信号在进程内，重启后需要至少 3 个账号产生反馈才启用。上游高峰过载本身无法由网关消除，本项只减少放大、误熔断和慢失败。另建议在面板把 `failover.total_retry_deadline_ms` 恢复为 60000–120000，当前 10000 短于正常首字时间（20–30 秒）。slot 内 kernel 返回的 `no_capacity: credential busy`（高峰每小时约 100 次）尚未查明，未在本项处理。
- **验证：** 新增回归：池中位数的 3 账号门槛与 15 分钟窗口、池整体过载不算离群、单个坏账号被停放、离群账号停放而池级过载不停放（端到端）、池级过载时 4 个账号只尝试 2 个并返回 `Retry-After: 3`、入口已过 60 秒仍可派发、调度阶段超时不派发。Codex/OpenAI/故障转移/调度相关 40 个测试文件 631/631 通过，新测试重复 5 次稳定；修改文件 Biome 与 `git diff --check` 通过。生产仅做只读查询，未改动配置、数据或容器。

## 2026-11-03 上游 v1.4.037 同步

- **来源与范围：** 官方上游从 `008b8d6ff864726f07de51062324ed449df03549`（v1.4.036）推进到 `e3a60858fe5d2c4beb931ffced31800a4cd58e8b`（v1.4.037）。本批上游只有版本号和根 `CHANGELOG.md` 发版条目；采用上游完整 Changelog，不保留旧的 Unreleased 文案。
- **上游取舍：** #866 的 `inline-tools-2026-09-15` 协议行为已随上游此前提交进入当前代码树，本批只是正式发版收口；没有新的代码冲突、权限/账务/持久化变更或被替代实现清理。
- **接口、配置与资产：** 无新增接口、配置、依赖、迁移或数据处置。`deploy/payload.json`、`web/dist`、`share/wrap-cli`、Go worker/OAuth helper 和 ARM64 配置相对 v1.4.036 均未变化。
- **升级指南：** 从 v1.4.036 升级到 v1.4.037，只更新 Node 控制面并重启；不需要 `fetch:payload`、`wrap-cli/sync`、槽位重建或 web/dist 更新。保留 `routing.json`、`vms/`、`data/`、`.env`。如果部署机尚未完成 v1.4.036 的 Node + web/dist 更新，可直接部署本版完整应用，同时补齐 Node + web/dist；无需先部署中间版本。
- **验证与发布：** 合并无文本冲突；根 Changelog 与上游逐字一致，版本为 `1.4.037`，payload/CLI/web 差异检查无变化。代码未变，不重复运行业务测试；由 CI 负责标准环境检查。发布副作用按版本递增规则核验，未在本地执行生产部署或数据操作。

## 2026-11-03 修复上游同步后的 CI 格式门禁

- **修复：** 格式检查发现 `test/unit/panel-billing-lookup.test.mjs` 一行超过 Biome 规则，按工具建议换行；不改变生产代码、测试语义、接口、配置、迁移、payload 或部署行为。
- **上游取舍：** 上游 `008b8d6ff864726f07de51062324ed449df03549` 已完整集成；本项仅修正 tapmodels 定制提交中的测试格式，保留 CI 门禁要求，后续按同一 Biome 版本自动检查。
- **验证与发布：** 该测试 11/11 通过，修改文件 `biome format` 与 `git diff --check` 通过。此前 v1.4.036 Release 已公开；本次同版本提交只触发 CI，不移动既有 tag/Release，不重建镜像，不部署生产。

## 2026-11-03 供应商用量统计不再全表扫描、阻塞网关主线程

- **问题原因：** 运营端进入供应商平台各页面都很慢。生产 v1.4.036 只读排查：nginx 日志中只返回 1.7 KB 的 `GET /api/admin/vendors` 耗时 4ms–5.1s，`/api/panel/me` 平均也要 1.07s，说明主要是网关主线程排队；容器内每 20ms 采样 `/healthz` 40 秒，超过 200ms 的停顿累计约 26 秒。在生产容器内用只读库逐个计时供应商接口的核心函数：供应商列表、结算设置、资源列表都在 3ms 内，账号视图 `accountPortalRows` 约 100ms，而运营端用量统计 `vendorUsage` 每次 740–1150ms，且整段同步执行在主线程上。用量统计页每 15 秒轮询一次，每次都让推理、调度和所有面板请求一起排队约 1 秒。原因是该查询按 `vendor_id` 过滤，而 `vendor_id` 由 `usage_logs` 经 `json_extract` 关联 `vendor_resources` 得出，无法使用索引：每条 SQL 都扫描整张 `usage_logs`（生产 46,207 行）并逐行做 JSON 关联，汇总、按账号、按日期三条 SQL 各扫一遍。
- **修复：** `vendorAccountLogs(usageScope)` 允许在 `usage_logs` 分支做 JSON 关联之前先收窄范围，`VENDOR_ACCOUNT_LOGS` 保持为无范围版本，供应商门户的现有调用不变。`vendorUsage` 传入的范围为“所选供应商的虚拟机资源 `runtime_vm_id`”或“所选供应商 `vendor_usage_facts` 中的请求”。一行的 `vendor_id` 只能来自已保留的 fact 或虚拟机关联，因此这个范围是外层过滤的超集；外层 `vendor_id`、时间、账号和模型过滤原样保留，结果不变。SQLite 改用 `idx_reqlog_vm(vm_id, created_at)` 与 `idx_reqlog_reqid` 两个索引的多索引 OR 查询。
- **上游取舍：** 供应商平台是本地定制功能，上游 `008b8d6f` 没有对应实现，不存在可采用的上游方案。本项只改本地定制查询，不新增与上游的冲突面。
- **接口 / 配置 / 迁移：** 无新增 API、配置、依赖或迁移；`GET /api/admin/vendors/usage` 响应不变。破坏性变更：无。
- **升级指南与限制：** 部署控制面后自动生效，不需要前端构建；本轮未部署。本项只消除用量统计这一个主线程热点。全部面板页面普遍偏慢的根因仍是面板与推理网关共用一个 Node 线程，见 `docs/performance/` 的后续计划；账号池和用量页每次请求仍执行一次 `buildUsage` 和约 100ms 的 `accountPortalRows`（每个账号两次按 `vm_id` 走索引的用量汇总），本轮未改动。
- **验证：** Node 22.23.4/macOS：`node --test test/unit/vendor-*.test.mjs test/unit/system-time.test.mjs` 88/88 通过，其中新增回归“虚拟机关联变化后，已由 fact 归属的日志仍计入供应商，无关虚拟机的日志不计入”。去掉范围中的 fact 条件后该用例失败，确认覆盖该分支。`test/e2e/vendor-platform.e2e.test.mjs` 6 项中 5 项通过；第 3 项断言账号名称应为邮箱、实际为槽位 id，未修改的基线上同样失败，与本项无关。修改文件 Biome 通过。生产容器内用只读库对比线上实现与最终代码：全部供应商 7 天、30 天、截至当前时刻以及两个单独供应商，共 5 组结果逐字段相等，耗时由 738–852ms 降到 25–99ms。临时文件已删除；没有改动生产数据、配置或容器。

## 2026-11-03 Claude 号池按预计排队时间快速失败

- **问题原因：** 生产 2026-11-02 只读统计：Claude 请求 9,485 次，排队超时 `pool_queue_timeout` 1,596 次（756 次直接回 529，840 次是流式请求，60 秒后先回 200 和 keepalive，再在流里报错），65% 等了 60–120 秒，最长 226 秒。分组 Claude 的 6 个账号里，vm-03、vm-04、vm-06 的 7D 额度用尽；vm-05 的 7D 在 96%，处于周额度保护区，一次只放行 1 个请求。有效并发约 11 个（vm-07 5 个、claude-cn-1 5 个且与 Coding 分组共用、vm-05 1 个），而峰值约 20–26 个 Opus 长请求同时在跑。座位队列先在 home VM 等 45 秒，再进全局队列等 30 秒，外层重试截止 120 秒，所以排不上的请求要空等 1–2 分钟才失败，客户端随即重试再排一次（单个密钥 30 分钟内 52 次请求中 45 次超时）。
- **修复：**
  - 新增 `queue-wait-estimate.mjs`：`HoldTimeTracker` 按 VM 记录每次预留从获取到释放的时长（EWMA，α=0.2，满 5 个样本才给出均值）。`estimateQueueWaitMs` 把前面排队的请求数加 1，除以各 VM“槽位数 ÷ 平均占用时长”之和。槽位数取 `maxConcurrency`，周额度保护区或 `quota_band_inflight` 时按 1 计，新座位同时受 `session_slots` 限制。
  - `SeatPlanner.queuedAhead` 按实际授予顺序计数：已就座会话的并发等待（`conc`）优先，其次是该 VM 的座位等待，再是按到达顺序接受这些 VM 的全局等待。
  - `selectSeat` 每次入队后、每 2 秒刷新时都估算一次。预计等待超过该请求剩余可等时间（`conc` 与全局为各自截止时间；sticky 座位等待为 sticky 窗口加随后全局等待，并取 home 与全池中较快的一侧）时，立即返回 `pool_wait_estimate_exceeded`。故障转移映射为 `529 pool_overloaded`（“号池负载过高，稍后再试”），`Retry-After` 为预计等待，上限 120 秒，用量日志写 `estimate=Ns`。
  - 保守退化：任一参与的 VM 没有足够样本，或因冷却、RPM、熔断探测等非并发原因繁忙、且可能在剩余时间内恢复时，不估算，保留原有排队逻辑。冷却到预算之后才恢复的 VM 不计入容量。
- **上游取舍：** 上游 `008b8d6f` 的座位队列同样等满 sticky 和 fallback 窗口才报 `pool_queue_timeout`，没有预计等待或快速失败。生产容量不足时可复现长时间空等和反复重试，按例外保留最小差异：只新增占用时长统计、队列位置计数和一个提前返回点，没有改变授予顺序、等待窗口配置或故障转移策略。上游提供等效的准入估算或排队快速失败后收敛并删除这些差异。
- **接口 / 配置 / 迁移：** 新增选号失败原因 `pool_wait_estimate_exceeded`，错误详情增加 `estimated_wait_ms`；HTTP 仍为 529 `pool_overloaded`。无新增配置、依赖或数据库迁移。破坏性变更：容量不足时，部分请求由排队 30–120 秒后失败改为立即失败，`Retry-After` 由 1 秒或座位释放时间改为预计等待时间。
- **升级指南与限制：** 部署控制面后生效；本轮未部署。进程重启后需要每个 VM 先完成 5 次请求才开始估算，此前沿用原逻辑。估算按平均占用时长计算，长短请求混合时会有偏差；快速失败只减少空等和重复排队，不增加容量，根本解决仍需补充账号或调整分组。无会话标识的直接选号路径（探测、固定 VM 诊断）不变，最长仍等 30 秒。
- **验证：** 新增回归：占用时长样本门槛与 EWMA；排队等待按槽位速率计算（含保护区和座位上限）；无样本、可能及时恢复的冷却、RPM 限制时不估算，超出预算的冷却不计容量；`queuedAhead` 授予顺序；预计等待 60 秒、预算 2 秒时 500ms 内返回且不残留排队；预计等待在预算内时照常排队并获得座位；摘要文本含 `estimate=`。引用调度器、座位、故障转移和路由策略的 17 个 Node 测试文件 519/519 通过，错误映射与流式排队相关 4 个文件 42/42 通过；修改文件 Biome 与 `git diff --check` 通过。生产只做只读统计，没有改动生产数据或配置。

## 2026-11-03 虚拟机账号栏显示账号名称，订阅账号即订阅邮箱

- **问题原因：** 资源管理 → 虚拟机 → 账号栏首行只认 `vm.email`，没有邮箱时退回槽位 id；次行的名称判断把“`vm-NN` 且无邮箱”一律视为“未绑定账号”。供应商账号池添加、尚未取得授权邮箱的槽位（如名称为 `turning041312@icloud.com`、`Yuzulin8888` 的 vm-28 / vm-31）已有凭证和账号名称，却显示 `vm-28` + “未绑定账号”，与账号池的 `email || 名称` 展示不一致。
- **修复：** `web/src/lib/vm-kind.ts` 统一账号口径：订阅账号即订阅邮箱，无邮箱时用账号名称（与槽位 id 不同的 `name`），再退回槽位 id。`slotAccountLabel`（列表/弹窗/用量等 `SlotIdentity`）、`slotNameLabel`（名称不再被判为未绑定）和机架卡片 `slotCredentialLabel`（已导入凭证且有账号名称时显示名称，空槽仍显示“空槽”）共用同一规则。`web/src/features/vm/vm-list-table.tsx` 账号栏首行显示账号，次行只显示与首行不重复的名称，名称与账号相同时显示槽位 id，消除邮箱与名称重复两行。
- **上游取舍：** 上游无供应商账号名称来源，账号仍以邮箱为准；本地仅在无邮箱时补用名称，上游提供等价账号名称字段后收敛。
- **接口 / 配置 / 迁移 / 破坏性变更：** 无；不改写 VM 或供应商账号数据。
- **升级指南与限制：** 部署前端产物（`web/dist`）后生效；本轮未部署。名称为默认槽位 id 且无邮箱的槽位仍显示槽位 id，未绑定时次行显示“未绑定账号”。
- **验证：** `web` 下 `tsc -b`、修改文件 ESLint / Prettier 通过；`vitest run` 112 个文件 848 项通过（新增 `vm-kind.test.ts` 名称账号用例）。生产库只读核对 vm-28 / vm-31 的 `vms.name` 与 `vendor_resources.name` 一致、`email` 为空。未做浏览器实页验证。

## 2026-11-03 修复分组“保存资源”后整页 500

- **问题原因：** 分组 → 资源弹窗点击“保存资源”成功后，`onSuccess` 把 `resourceGroup` 置为 null 关闭弹窗。Radix Dialog 带 `animate-out` 退出动画，动画期间 `DialogContent` 仍挂载并重新渲染，`ResourcePicker` 收到 `group={resourceGroup!}`（实际为 null），读取 `group.resources` 抛出 TypeError，被根路由 `errorComponent` 渲染为整页 500。点击“取消”或关闭弹窗走同一路径。资源实际已保存，刷新页面即可看到。2026-11-02 删除槽位条目中未定位的整页 500 即此问题。
- **修复：** `web/src/features/groups/index.tsx` 仅在 `resourceGroup` 存在时渲染 `ResourcePicker`，删除非空断言。保存请求、优先级、混合后端校验等行为不变。
- **上游取舍：** 分组资源弹窗为本地商业分组功能，上游没有对应页面；无需收敛。
- **接口 / 配置 / 迁移 / 破坏性变更：** 无。
- **升级指南与限制：** 部署前端产物（`web/dist`）后生效；本轮未部署。
- **验证：** `web` 下 `tsc -b` 通过，修改文件 Prettier 通过；ESLint 仅报告 HEAD 既有的 169 行 `no-extra-boolean-cast`，与本次无关。本地无运行中的控制面，未做浏览器复现。

## 2026-11-03 上游 v1.4.035–v1.4.036 同步

- **来源与范围：** 官方基线从 `f8f9ddf662496343f5e8cb0122ba4ed9e2f8bb7b`（1.4.034）更新到 `008b8d6ff864726f07de51062324ed449df03549`（1.4.036）；以已交付 `6506aad57aee3b00fbb1eb85cd3c15d50df68d52` 为合并起点，先合入 1.4.035（`9aa3d872`），推送前复核上游已前进，再只合入新增批次。上游增量为 #847（只返回 weekly 窗口的官方用量不再丢弃）、#848（guest OAuth 换票不再传控制面 loopback 代理）、#854（persona `# Environment` 锚定首个 user）、#861（面板 `usage_logs` 读改到只读 worker 池，请求日志与尝试记录改为 write-behind 批量写入）、#864（JEV 按 Key 展示用量与脱敏标识）及 D-08 零引用导出清理；1.4.036 批次为 #850/#865（官方 Claude Code 重写后补齐无 TTL 缓存断点、官方家族识别不再跳过重写、移除 `x-kin-strict-passthrough` 请求头、native cli-hop 读取 `kernel.json.default_cache_ttl`）与 #866（`tool_definition` 时补 `inline-tools-2026-09-15` beta）。最终 main 为新上游加一个累计定制提交；根 CHANGELOG 与上游逐字一致。
- **采用上游 / 删除本地方案（用户 2026-11-03 明确要求：冲突功能一律采用上游）：**
  - 请求日志写入：采用 #861 的 write-behind，`RequestLogStore.finish` 在开启时延迟批量写入并吞掉写入错误。删除本地 `strict` 模式（商业计费请求的用量日志与扣费同事务、失败即回滚）及 `handle-protocol` 的 `strict: !!req.relayBilling` 传参。扣费本身仍在原事务中完成；用量日志行改为事务提交后的批量写入，写入失败只记日志，不再回滚扣费。
  - 用量日志查询：采用上游 `readUsage` / `usageRead` 只读 worker 池与同步回退。删除本地 `panel-usage-query-service.mjs` 及其单测、路由覆盖清单引用。本地已有的 ranking 接口和管理员范围 `logsOwner` 接入同一读池：worker 白名单补 `ranking`，回退分支沿用 `ctx.db || getDb()`。`/request-logs/stats` 的权限判定沿用本地（非超管只看自身范围）。
  - guest OAuth：采用 #848，Linux guest 一律传空 `proxy_url`，由槽位 `kin-eg-*` 透明出口选路。删除本地 `guestProxyUrl`（本地出口为空、远程出口传绑定代理 URL）；`oauth-binary` 测试采用上游 fixture 写法。
  - JEV 用量面板：采用 #864 的 Key 用量表与脱敏标识，删除本地“Key 指纹”列。上游界面文案为硬编码中文，按本项目四语 i18n 契约移入 `risk` 资源（新增 24 个键，删除失效的 `jevFingerprint`），展示内容与上游一致。
  - cache-prefix：上游与本地新增测试互不重叠，两组都保留。
  - 官方家族透传（1.4.036）：采用上游 `officialFamilyBodyPassthrough` 单一判定和 `fillMissingCacheTtl`，删除本地“API 直连对已识别官方流量二次套用 persona”的补丁分支和 `x-kin-strict-passthrough` 读取，三条推理路径统一由透传开关决定。必要融合：判定和 TTL 解析读取本地已有的单请求配置快照 `requestRouting`（而非上游的 `getRouting()`），保证同一请求内配置一致；桌面端连接探测的 `max_tokens: 1` 分支保留。上游没有单请求快照契约，提供等效机制后收敛。`docs/PROTOCOL.md` 同时保留本地部署说明段和上游新增的缓存契约段。
  - 尝试记录：`request-attempts-repo.mjs` 与上游逐字一致（write-behind）。用户确认不保留本地补丁，同次删除：`send_state` 写入/读回及单调合并、`failover-runner` 中仅供该列使用的发送状态跟踪（`SEND_STATE_RANK`、`sendStateOf`、`attemptSendState` 及 `onSendState` 向 `callAttempt` 的传递）、`handle-protocol` 对它的转发、`handle-codex` 写入 `complete()` 的 `sendState`、`usage-logs-view` 的 `sendState` 字段及对应单测。`request_attempts.usage_json` 改为上游原样存储（含 `attribution`；2026-11-05 起重新剥离，见当日“usage_json 不再保存 attribution”一节）；`billing_charges` 仍经 `usageForStorage` 裁剪，该计费模块上游没有，不在冲突范围内。Codex 重放判定、Go worker 回报和 `attemptFacts` 仍在内存中使用发送状态，与这一列无关，不受影响。
- **新增功能 / 接口 / 配置 / 迁移：** 新增 JEV Key 用量表（上游功能）；面板读取改走只读 worker 池（上游）。新增迁移 `078_drop_request_attempt_send_state.sql`，删除 `request_attempts.send_state` 列（用户 2026-11-03 授权删除该列；未改写已应用的 058；编号跳过曾分配给已撤回汇总表的 077）。无新增配置或依赖。
- **破坏性变更：** 商业计费请求的用量日志不再与扣费同事务。极端情况下（进程在批量提交前退出、写库失败），扣费已生效但对应 `usage_logs` 行可能缺失；此前这种情况会整体回滚。这一变化按用户决定采用上游行为。guest OAuth 不再向 helper 传远程代理 URL，依赖透明出口；未使用 `kin-eg-*` 网络的非标准执行路径会改为直连宿主默认路由。控制面启动时自动执行 078，删除 `send_state` 列及其中历史值（不可恢复）；日志页尝试明细不再返回 `sendState`。新的尝试记录 `usage_json` 恢复保存 attribution，长会话单行可达数十至数百 KB，表体积按保留天数相应增大；已写入的旧行不变（2026-11-05 起已重新剥离）。
- **升级指南：** 从已部署 v1.4.034（本定制）升级只需更新 Node 控制面和前端产物（`web/dist`），然后重启；首次启动自动执行迁移 078（`ALTER TABLE … DROP COLUMN`，需 SQLite ≥ 3.35，镜像内 Node 22 自带满足）。如需保留 `send_state` 历史，升级前先备份数据库。`deploy/payload.json`、`deploy/arm64-cli.json`、Go worker 均未改变，不需要 `fetch:payload`、`wrap-cli/sync`、重启槽位或重部署 OAuth helper。1.4.036 起调用方不能再用 `x-kin-strict-passthrough` 请求头跳过入站清洗；依赖该头的客户端改用协议页的官方家族透传开关。保留 routing.json、vms/、data/、.env 及持久化挂载；控制面重启会中断连接。
- **验证：** Node v22.23.4/macOS，对比同机旧交付 `6506aad5`：根 `test:unit` 397 个文件，失败 6 项，与基线逐项相同（egress DNS/就绪 3 项、READ_IDENTITY 硬件探测、guest OAuth 二进制、telemetry 退役，原因都是 macOS 缺 Linux 二进制或 `/proc`）；`test:e2e` 43 个文件，失败 40 项，与基线逐项相同（缺 kernel/CLI ELF 等）；本轮新增失败 0；合入 1.4.036 批次后，协议/缓存/persona/Go worker 相关 39 个测试文件 905/905 通过，再跑全量 unit/e2e 结果与上述基线仍逐项相同。迁移 078 用旧定制建库（含 `send_state` 数据）升级后，列已删除、其他数据保留，重复打开无错误。前端 `src/features/risk` 与 `src/i18n` 3 个文件 15/15 通过，`tsc -b` 通过；修改文件 Biome、Prettier 与 `git diff --check` 通过。Linux 专属测试和镜像构建由 CI 执行。本轮没有部署生产，也没有操作生产数据。

## 2026-11-03 GPT 凭证吊销写入槽位、无可用账号即时 503、上游订阅信息落盘

- **问题原因：** 生产 2026-11-02 客户端连续收到 `exceeded retry limit, last status: 429`。只读排查：分组 Coding（group 5）只有两个 GPT 槽。vm-25 的 OAuth 被上游吊销：用该槽凭证、走它自己的代理请求 `wham/usage` 与 `codex/models`（均不带模型）都返回 `401 token_revoked`（"Encountered invalidated oauth token for user"），与 plus 套餐和 astra 模型无关，它此前已成功处理约 20 次 `gpt-6-astra`。vm-26 的 7D 额度 100%，到 2026-11-04 才恢复。网关遇到 401 只把账号放进进程内 5 分钟冷却，不写槽位记录，所以供应商账号池和虚拟机页仍显示“正常”。冷却期间两个槽都不可用，准入逻辑仍等满 30 秒再回 `429 pool_overloaded`，客户端把它当限流重试 5 次后报错；冷却结束又用真实请求试 vm-25，于是 401 和 429 大约每 5 分钟交替出现。另外，GPT 槽的订阅到期只取 id_token 里登录时的 `chatgpt_subscription_active_until`（plus 账号为 null，显示“订阅 未知”），`wham/usage` 返回的邮箱被丢弃，`accounts/check` 里的订阅计划、续费日期、支付渠道从未读取；供应商账号池也没有到期字段。
- **修复：**
  - `codexRevokedCredential`（`codex-slot-pool.mjs`）只认上游明确的凭证吊销：401 且错误码或正文含 `token_revoked`、invalidated oauth token、`refresh_token_reused`/`refresh_token_invalidated`、token has been revoked。普通 401（如 token 过期，kernel 还能自己刷新）不受影响，仍是 5 分钟冷却。
  - 推理、联网搜索和图片三条 Codex 链路命中上述错误时，把槽位写为“不可调度 · 凭证吊销”（复用现有 `oauth_revoked`），两个面板直接显示，调度持续排除，重新导入凭证（`credential_import`）或操作员恢复后才清除。请求期间凭证已被重新写入（凭证代际变化）时不写，避免误伤刚导入的新凭证。已向客户端输出数据的请求不写。
  - `orderCodexSessionSlots` 在没有任何 `normal` 候选（全部冷却、冻结或额度用尽）时标记 `unavailable`。准入逻辑看到该标记且最早恢复时间晚于等待截止时间时，不再等待，立即返回 `503 pool_unavailable`（“号池当前没有可用账号”），`Retry-After` 为最早恢复时间。仅因并发或 RPM 满而无空位时，仍排队等待，超时后返回 `429 pool_overloaded`，行为不变。
  - 额度查询（`queryOpenaiQuota`）同时请求 ChatGPT `accounts/check`，解析订阅计划、是否有效订阅、到期/续费/取消日期、是否续费、购买渠道、币种、计费周期、欠费、试用和停用标记，写入 `vm.codex.subscription`（不保存订阅 id、用户 id、名称和功能列表）；`wham/usage` 的邮箱写入 `vm.codex.email`，套餐缺失时用 `accounts/check` 的套餐补齐。该请求失败时保留上一次快照，不影响额度查询结果。GPT 凭证导入完成后立即做一次额度查询（不轮换 refresh token），新槽不必等人工点“查询额度”才有套餐和到期。
  - 槽位摘要：GPT 的订阅到期优先取 `accounts/check` 的续费/到期日期，没有时退回 id_token 声明；`subscription_type`、`billing_type`（iOS→Apple 内购、Android→Google Play、web→Stripe）、`subscription_updated_at` 对 GPT 槽不再固定为 null。供应商账号池 `telemetry` 增加 `subscription_expires_at`、`subscription_will_renew`，账号详情显示“订阅到期 · 自动续费/不续费”；虚拟机页提示文案改为“以账号查询或凭证为准”。
- **上游取舍：** 上游 `f8f9ddf6` 的 `codexFailureHold` 对 401 同样只做进程内冷却，准入同样等满再回 `capacity_unavailable`，额度查询同样不读 `accounts/check`。生产可复现上述错误显示和无效重试，按例外保留最小差异：只新增吊销识别、写入既有 `oauth_revoked` 状态、无可等待账号时提前返回，以及订阅快照字段；没有改写上游的冷却时长、换号策略和额度解析。上游提供等效的凭证失效持久化、空池快速失败或订阅查询后收敛并删除这些差异。
- **接口 / 配置 / 迁移：** Codex 入口新增 `503 pool_unavailable`（details.reason=`accounts_unavailable`）响应；GPT 槽摘要新增 `subscription`，并填充 `subscription_type`、`billing_type`、`subscription_updated_at`；供应商 `telemetry` 新增 2 个只读字段。新增一个上游只读请求 `accounts/check`，只在额度查询和 GPT 凭证导入时发出。无新增配置、依赖或数据库迁移。破坏性变更：所有 GPT 账号都处于冷却、吊销或额度用尽时，客户端由约 30 秒后的 429 改为立即 503；依赖 429 重试的客户端会更早看到失败。
- **升级指南与限制：** 部署控制面和前端后生效；本轮未部署。已经被吊销、但部署前没有再次请求的槽，要等到下一次真实请求返回 401 时才会被标记；生产 vm-25 仍需重新授权导入。存量槽要等下一次额度查询或重新导入后才有订阅快照。Claude 侧未改：生产 Claude 槽大多为官方 setup-token（无 profile 权限），上游 profile 也没有订阅到期或支付日期字段，现有导入/刷新时写入的套餐、限速档和计费渠道保持原样。
- **验证：** 新增回归：吊销识别正负样例；吊销后槽位写入 `oauth_revoked` 并在冷却结束后仍不被调度；全部冷却时 1 秒内返回 503 且带 `Retry-After`；部分槽繁忙时仍为 `capacity_unavailable`；`accounts/check` 解析不含 id；额度查询写入邮箱、套餐、续费日期、渠道并反映到摘要；账号查询失败保留旧快照。引用改动文件的 60 个 Node 测试文件 673/673 通过；前端 vendor 与订阅到期 9 个文件 75/75 通过；TypeScript、修改文件 Biome/Prettier 通过。生产只做只读核对（凭证吊销、kernel 401 正文、`accounts/check` 字段形态），没有改动生产数据或配置。

## 2026-11-03 同一额度窗口用尽统一显示为“5h/7d 限制”

- **问题原因：** 账号 7D 额度用尽，网关有两条路径写入受限：① 定期读取上游响应头发现 7D 为 `rejected`，写 `quota_7d_header`，显示“7d 限制”；② 请求直接被上游 429 拒绝，`RateLimitService.handle429` 已从响应头解析出是 7D 窗口并取 7D 重置时间，但原因码只写 `account_quota_exhausted`（运行时硬封锁读作 `rate_limited`），显示“限流中”。生产只读核对：vm-03、vm-04 走 429 路径，响应头里 7D `utilization: 1 / status: rejected`；vm-06、vm-26 走被动路径。同为 7D 用尽，一组显示“7d 限制”，另一组显示“限流中”。
- **修复：** `availability.mjs` 新增 `accountLimitReason`：原因码为 `rate_limited` 或 `account_quota_exhausted` 时，若响应头或额度快照表明 7D（优先，与 `anthropic429Reset` 取重置时间的顺序一致）或 5H 窗口已被拒且未过重置时间，就归为 `quota_7d_header` / `quota_5h_header`；否则保持原码，没有点名窗口的 429 仍显示“限流中”。运营面板的运行时硬封锁与受限原因、供应商账号池的受限原因都经这一函数映射；`evaluateAccount` 遇到窗口类硬封锁时显示“5h/7d 限制”并带 `window`。只改变显示与原因归类，调度判断、封锁截止时间和恢复逻辑不变。
- **上游取舍：** 上游 `f8f9ddf6` 的 `handle429` 同样只记 `rate_limited`，面板显示“限流中”。按用户要求统一同一窗口的口径，在显示投影处保留最小差异，没有改写存储的原因码或上游的写入路径；上游统一归类后收敛并删除 `accountLimitReason`。
- **接口 / 配置 / 迁移：** 无新增接口、配置、依赖或迁移；`restriction_reason` / `availability.reason` 对窗口类 429 改报 `quota_5h_header` / `quota_7d_header`。破坏性变更：无。
- **升级指南与限制：** 部署控制面后生效，存量受限账号会直接按新口径显示；本轮未部署。若 429 时响应头未带窗口状态、额度快照也无拒绝记录，仍显示“限流中”。
- **验证：** 新增回归：429 + 7D 拒绝映射为 7D、5H 快照拒绝映射为 5H、无窗口或已过重置时间保持原码、过载码不受影响、`evaluateAccount` 显示“7d 限制”；供应商投影 `account_quota_exhausted` + 7D 拒绝显示“7d 限制”。在只含本次改动的隔离检出中，引用面板、可用性、调度、限流与供应商投影的 34 个 Node 测试文件 527/527 通过；修改文件 Biome 与 `git diff --check` 通过。

## 2026-11-03 供应商账号池额度/限流受限不再显示为异常

- **问题原因：** 生产 vm-26（OpenAI）上游响应头报告 7D 已用 100%，网关按 `quota_7d_header` 写入临时受限，预计 2026-11-04 15:37（北京时间）自动恢复；该 VM 的 `schedulable` 仍为 true。供应商账号池的投影 `accountReasonFromSummary` 把 `temp_unschedulable_reason` 当作故障原因读取，`failureCategory` 又把所有不认识的代码归为 `unknown`，于是账号被判为“异常 / 未分类故障”，悬浮提示是裸代码 `quota_7d_header`，开关显示关闭且被禁用。运营账号池对同一状态显示“7d 限制 / 限流中，预计 … 自动恢复”，调度开关保持开启，两边口径不一致。
- **修复：** 供应商投影改用运营端已有的状态标准 `stateOfReason`（`schedule-state.mjs`，四态：调度开 / 调度关 / 不可调度 / 受限）。受限码（额度窗口、429 限流、冷却、过载、维护等）和无状态码不再进入故障原因与故障分类；`telemetry` 新增 `schedule_state: 'restricted'`、`restriction_reason`、`restriction_text`。前端状态徽章以琥珀色显示受限文案（如“7d 限制”“限流中”），悬浮提示复用运营端“{原因}，当前不参与调度，预计 {时间} 自动恢复”的文案。调度开关保持开启并可操作，因为受限会自行解除，不需要操作员干预。凭证吊销、过期、组织禁用、代理不可用等不可调度原因仍显示“异常”并锁定开关，行为不变。
- **上游取舍：** 上游 `f8f9ddf6` 没有供应商平台；本次只让既有供应商投影复用上游同源的 `schedule-state.mjs` 状态表，没有新增状态码或映射表。
- **接口 / 配置 / 迁移：** 供应商账号接口 `telemetry` 增加上述 3 个只读字段；`unschedulable_reason`、`failure_category` 对受限账号改为 null。没有新增配置、依赖或迁移。破坏性变更：无。
- **升级指南与限制：** 部署控制面和前端后生效；本轮未部署。受限期间实际仍不接新请求，开关只表示操作员意图；恢复时间取网关记录的受限截止时间。
- **验证：** 新增后端回归，覆盖 `quota_7d_header` 与 `rate_limited` 投影为受限、无故障分类；新增前端回归，覆盖徽章文案、恢复提示和开关保持开启可用。供应商与调度状态相关 Node 测试 98/98 通过；前端 vendor、supplier-admin、调度开关 12 个文件 84/84 通过；TypeScript、修改文件 Prettier/ESLint/Biome 和 `git diff --check` 通过。生产 vm-26 的状态字段为只读核对。

## 2026-11-03 消除网关主线程的周期性停顿：出口进程检查与面板账号快照

- **问题原因：** 2026-11-02/03 对生产 v1.4.034 只读排查。在服务器本机每 20ms 请求一次 `/healthz`：p50 为 1ms，但会周期性停顿 200–900ms，期间推理流、面板和调度全部排队。用 strace、perf 和 nginx 日志按时间对齐后，定位到两个来源：① 内核看门狗每 20 秒运行一次出口桥自愈，每个已绑定的 kin-egress 都要用 `execFileSync` 同步 fork 三个 shell（`kill -0`、`cat /proc/N/cmdline`、`readlink /proc/N/exe`）。33 个出口每轮 fork 约 63 次，每次都从 800MB 的 Node 进程 fork，单轮停顿 500–900ms。② 打开的面板每 5 秒轮询 `/api/panel/vms`、`/api/panel/usage`。`findAccount` 每次调用都重新取一次完整的账号快照（1 次全表查询，外加每个账号 2 次分配记录查询，生产 33 个账号约 3ms），而 `enrichVm`、`findRuntime`、账单窗口对每台 VM 各调一次。12 台 VM 时，一次 `/vms` 要取 37 次快照、执行 461 条 SQL，生产上每次占用主线程 280–1000ms。
- **修复：** 没有设置 `KIN_EGRESS_CMD_PREFIX`、kin-egress 与网关在同一 PID 命名空间时（生产就是这种情况），进程存活、cmdline、exe 是否已删除以及 kin-egress 进程扫描，都改为在进程内用 `process.kill(pid, 0)` 和读取 `/proc` 完成，不再 fork。设置了该前缀的 Docker Desktop/WSL 开发环境仍走原来的 netshoot 命令。面板的 VM 列表、VM 详情、用量、总览和账号池快照，每个请求只取一次账号快照，传给 `enrichVm`、`findRuntime` 和账单窗口共用。`findAccount` 新增可选参数 `accounts`，不传时行为不变。总览的快照提前到 `enrichVm` 之前读取；`enrichVm` 中可能发生的写入（冷却清理、调度迁移）不影响快照中的任何字段。
- **上游取舍：** 上游 `f8f9ddf6` 的 `egress.mjs` 与 `findAccount` 写法和本地改动前一致，没有等效实现。生产实测这两处造成了可复现的主线程停顿，因此按例外保留最小差异，只改同一 PID 命名空间下的探测方式和面板请求内的快照复用。上游提供等效实现后收敛并删除这些差异。
- **接口 / 配置 / 迁移：** 无新增 API、配置、依赖或迁移；面板响应内容不变。破坏性变更：无。
- **升级指南与限制：** 部署控制面后自动生效，无需前端构建。本轮未处理：调度维护每 5 秒一次、在生产上约 220–250ms 的停顿（会读取各槽位凭据、做内核健康检查并写入心跳），以及面板请求中逐台 VM 读取 settings 和分组的 SQL（`/vms` 仍有 317 条）。另外，SSE 逐行解析在本地按真实形态压测为每个请求 3–4ms CPU，峰值时不到一个核的 1%，不是瓶颈，因此没有改动。生产效果需要部署后重测 `/healthz` 停顿来确认。
- **验证：** Node 22.23.4/macOS。出口、槽位恢复、代理和面板相关的 18 个单测文件共 266 项：251 项通过、12 项因平台跳过、3 项失败。这 3 项失败在未修改的基线上同样出现，原因是 macOS 没有构建 `bin/kin-egress`（ENOENT），Linux CI 会构建该二进制。新增回归测试断言每个面板构建器只取一次快照，基线上为 8 次，测试失败。5 个面板/账单 E2E 文件共 27 项：24 项通过，3 项失败，失败项与基线完全相同（两项 OpenAI scheduling HTTP、一项 API billing raw usage）。差分验证：用同一份种子项目分别启动基线和新代码，对比 `/vms`、`/usage`、`/dashboard` 和两个 `/vms/:id` 的响应，排除随机 SMBIOS、运行路径、时间戳和耗时字段后差异为 0。SQL 条数：`/vms` 从 461 降到 317，`/usage` 从 107 降到 59，`/dashboard` 从 359 降到 215。在生产容器内只读对比 35 个 PID（33 个在跑的 kin-egress 加 2 个对照），新旧探测结果 0 处不一致；全部探测耗时从 216ms 降到 2.1ms，进程扫描从 65ms 降到 1ms。本次没有部署生产，也没有改动生产数据或配置。

## 2026-11-02 修复 Codex 过载时健康 VM 被移出调度

- **部分撤销（2026-11-03）：** 冷却会话入池前直接返回 `503 codex_session_overloaded` 的部分随会话熔断一并移除；过载不逐次冷却 VM 的修复保留，并由离群账号停放补充。

- **问题原因：** 生产库 2026-11-02 UTC 01:00–10:00 有 8753 次 `codex_session_overloaded`，同期 19–21 台 GPT VM 中同时在跑的 Codex 尝试最多约 30 个（容量 5×VM），入池等待 p90 却达 15–20 秒。两处叠加：① `codexFailureHold` 把上游 `server_is_overloaded`（502/503/529）当作账号故障，给该 VM 加 30 秒 `upstream_5xx` 冷却；一个过载会话按故障转移依次试过的每台 VM 都被冷却，UTC 06 时段 19 台里平均 7–8 台、最多 16 台同时处于冷却，而同一 VM 上其他会话同期仍在正常成功。② 会话已进入 60 秒冷却时，请求仍先排队、占用一个 VM 席位，再在席位内直接返回 503，空占排队和并发名额。
- **修复：** 明确的 502/503/529 过载结果不再设置账号冷却，只交给既有跨槽位故障转移、会话级上下文恢复与 60 秒会话冷却处理；无过载标记的 5xx、传输错误、401/403/429 冷却保持不变。会话冷却期间的请求在入池前直接返回 `503 codex_session_overloaded`，附剩余 `Retry-After` 与 `details.retry_after_ms`，不选 VM、不排队、不计尝试次数。用剩余冷却时长查询替代原布尔判断，删除席位内的重复拦截分支，错误文案合并为一个常量。
- **上游取舍：** 上游 `f8f9ddf6` 同样对全部 5xx 冷却 30 秒；会话冷却为本地定制。按生产数据（过载与同 VM 他会话成功并存）保留最小差异：仅过载类结果跳过账号冷却。上游区分过载与账号故障后收敛并移除本例外。
- **接口 / 配置 / 升级：** 无新增接口、配置、依赖或迁移；冷却期返回码与文案不变，新增剩余等待字段。部署控制面后自动生效；进程重启清除进程内冷却状态。破坏性变更：无。
- **验证：** 新增过载不冷却 VM、他会话可继续调度，以及冷却会话不占席位的回归；Codex 相关 6 个测试文件 131/131 通过，修改文件 Biome 与 `git diff --check` 通过。本地按生产形态复现：修复前一次过载令 4 台 VM 全部冷却、他会话 1.5 秒后 429；修复后他会话立即成功、冷却请求 0 ms 拒绝。本次未部署生产、未操作生产数据。

## 2026-11-02 主线程与大请求处理测量

- **新增与优化：** 既有超级管理员 `GET /api/panel/database/metrics` 增加 `runtime`：10 秒完整窗口的主线程事件循环利用率及延迟分布，并按实际解压后请求大小记录同步 JSON 解析、Claude/Codex 整包转换、上下文预检/恢复的次数、异常、总/平均/最大耗时和固定直方图；同时保留本次启动以来的阶段累计。首个窗口前为 `null`，多观察者读取不重置。固定阶段、流量分类和大小桶，弱引用关联字节数，不保存正文、路径、凭证或身份，不重新序列化请求来量大小。
- **范围与清理：** 沿用现有诊断权限、请求体限额/错误和计时生命周期；上传、异步解压和上游等待不计为同步计算。没有计算线程池、账务或调度迁移、流式逐块跨线程、第三方监控依赖、新 HTTP 路由、配置或数据库迁移。无被替代的业务实现需要保留；没有改写或删除历史数据。账单统计线程仍可能执行历史补价，已在运维说明明确它并非严格只读。
- **上游取舍：** 交付时保留并发任务已交付的 1.4.034 上游父提交 `f8f9ddf662496343f5e8cb0122ba4ed9e2f8bb7b`（本任务没有另行同步上游）；该基线无上述测量能力，仅在现有入口和同步调用外加计时及一个内存指标模块。上游提供等价窗口、隐私和权限契约后可收敛。
- **破坏性变更 / 升级：** 无；部署控制面后自动启用，无前端构建要求。利用率不是 CPU 百分比，延迟含 20ms 采样分辨率，阶段次数包含重试；只覆盖已列出的处理阶段。依据实测再决定是否实施两线程大请求计算池，不能仅凭 CPU 高或单线程事实扩大线程数。指标字段与读法见 `docs/RELAY_OPERATIONS.md`。
- **验证：** 指标、压缩请求体、SSE 边界与上下文预算 48 项测试通过；并发上游交付后，对最终 1.4.034 文件树开启指标，重验相关 Codex/Anthropic/API 协议 161 项和诊断权限/有效 Chat 流式与非流式 HTTP 4 项，均通过。定向 Linux 补丁镜像内 31 项通过。旧 Responses E2E 的 3 项失败在未修改基线复现：它们将 Claude 模型发到现有策略禁止的 `/v1/responses`，并非本次计时引入；没有改写这些无关路由契约。小请求微基准 5 轮、每轮 10 万次，计时开启的中位额外开销约 0.24µs/次，不等同于生产吞吐验收。
- **生产观测与限制：** 2026-11-02 仅在指定服务器已运行的 `v1.4.032.4-billing-worker-20261102` 上叠加 6 个指标源文件，保留旧镜像和回滚配置，没有部署后续 main 的其他变更。UTC 12:07:09–12:10:19 的 19 个完整窗口共 15 次推理解析：主线程 ELU 加权均值 7.17%、范围 1.60%–14.20%，所测同步阶段合计占活跃时间 2.47%；事件循环最大延迟 386ms，窗口 P99 最大 56ms。健康探测 357/357 返回 200、P95 4.25ms，指标接口 19/19 成功。该低流量样本不能代表峰值吞吐，也不足以支持计算线程池；因此本轮止于测量。只读检查时待历史补价行数为 0，并不保证未来无写锁竞争；没有新增账务线程或改动补价/扣费语义。

## 2026-11-02 上游 v1.4.033–v1.4.034 同步

- **来源与范围：** 官方基线从 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5` 更新到 `f8f9ddf662496343f5e8cb0122ba4ed9e2f8bb7b`；以实际已交付 `be5183a44c49e6803ad6df9e10ff22c56d4d9cd1` 为合并起点，保留其后续有效定制。最终 main 为新上游加一个累计定制提交；根 CHANGELOG 与上游一致。下方历史条目中的基线和验收描述属于各次交付记录。
- **采用上游 / 清理：** 采用标准 Anthropic 入站清洗、关闭官方家族透传时剥离 caller billing 和 UA、第三方工具名规范化、官方 CLI 的 system/缓存断点保留、API 直连强制人设分支、调用方 system/instructions/developer 风险审计及官方提示词白名单、槽位暂存文件 finally 清理。移除旧的 `officialFamilyBodyPassthrough` 调用与无条件强制人设分支，不保留两套策略；本版会改变未开启透传的 caller billing/UA 行为，属于有意采用的上游协议变更。
- **必要融合：** 两处冲突按语义合并：API 入口保留商业分组授权与计量事实；协议入口的新增设置读取沿用单请求配置快照，保留已确认的桌面端连接探测。上游没有对应商业权限/快照/桌面端契约，例外仅限这些接入点，提供等效契约后可收敛。
- **已复现回归修复：** 新上游将第三方工具改为 `mcp__`，API 直连却未携带回包反向映射，真实 handler + 本地 mock kernel 回归收到 `mcp__lookup` 而非原来的 `lookup`。复用既有 Anthropic 还原函数，在 API 流读取边界补齐 Anthropic/Responses 工具名还原并把映射传入；覆盖 JSON、SSE 和 Responses→Chat 并行工具调用。只恢复声明过的工具名，不改工具参数；上游补齐此回包契约后移除本例外。
- **新增功能 / 配置 / 数据：** 无新增对外接口、用户配置、依赖、数据库迁移或数据处置；新增 1 处 API 回包工具名还原处理，其他均为既有链路调整。此前累计定制含迁移及前端修改，未部署这些定制的机器仍需配套升级，不能用本轮无迁移推断跨版本无需迁移。
- **升级指南：** 从已完整升级的 v1.4.032 系列到本版，上游增量仅需更新 Node 控制面并重启；部署 fork 的完整应用镜像会同时带上匹配 web/dist。`deploy/payload.json`、`deploy/arm64-cli.json`、Go helper 与 web 源码在本轮均未改变；payload 仍为 `payload-2026.11.01-codex-image-kernel`、cli-node `8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b`，已匹配该资产的机器不必 fetch:payload、wrap-cli/sync、重启槽位或重部署 OAuth helper。更早版本须先按部署文档核对跨版本资产要求。保留 routing.json、vms/、data/、.env 和现有持久化挂载；控制面重启会中断连接。amd64 在 v1.4.034 正式发布后于部署宿主执行现有安装脚本 `upgrade --version v1.4.034 --dir <现有安装目录> --no-sync-wrap`（仅适用已确认资产匹配者）；ARM64 没有正式预构建控制面产物，沿用原 Compose 配置从本版源码重建控制面。
- **发布门禁修复：** 发版检查发现旧 `release.test.mjs` 禁止 Vite 使用任何 `readFileSync`，与此前网站图标内容哈希读取资产冲突。断言现仅禁止应用版本常量/版本文件注入，保留 VERSION 单一来源约束，允许合法资产读取；完整发版身份/权限/更新契约组 80/80 通过。首次自动发版已触发，但在此旧断言失败，未公开 Release；其 v1.4.034 tag 已锁定修复前源码，按现行规则不移动或删除标签。
- **验证与边界：** Node v22.23.4/macOS：22 个相关测试文件，639 项通过、2 项平台跳过、0 失败；含真实本地 HTTP/SQLite 商业授权和账单集成。修改文件语法、根 Biome 859 个文件与 diff 检查通过。无前端/Go/payload 改动，不重复本地构建；Linux、全前端和镜像发布由 Actions 验证，成功触发或草稿不等于公开发布。本次未部署生产、未调用真实供应商、未操作生产数据。

## 2026-11-02 用量统计复用账号池状态徽章

- **修复与优化：** 供应商平台 → 用量统计的账号“状态”列复用账号池 `AccountStatusBadge`，统一正常、异常、冷却、暂停、归档及凭证状态的颜色、文案和悬浮原因；只展示状态，不提供调度开关。账号池原有开关和布局保持。
- **接口与清理：** 现有 `/api/admin/vendors/usage` 按账号返回资源 `status` 和账号池同源的安全 `telemetry` 投影，替代仅返回扁平运行状态的映射；删除用量统计的纯文本状态渲染和账号池内联重复徽章。无账号关联的历史用量仍显示“—”，金额、请求数和日期口径保持。没有新增接口、配置、迁移或调度执行路径。
- **上游取舍：** 普通修复沿用 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5`，不附带同步；该上游无供应商平台对应实现，按用户明确要求保留最小展示差异，未来上游提供等价状态契约时收敛。
- **验证：** 账号池组件及状态模型 14 项测试通过；真实 HTTP 的用量日期和账号状态投影 2 项回归通过，覆盖暂停、归档、无账号历史数据及指标不变；TypeScript、修改文件 ESLint/Prettier/Biome 和 diff 检查通过。本地浏览器确认五类徽章、冷却/异常原因及状态列无调度开关。
- **升级与限制：** 前后端配套部署后生效；用量接口的 `status` 现为资源生命周期，运行状态使用 `telemetry.state`（内部消费者已同步更新）。无其他破坏性变更；没有发版、生产部署或数据处置。

## 2026-11-02 API 密钥批量编辑

- **新增功能：** `/console/#/keys` 增加逐行选择、全选当前筛选结果、选择计数和一个“批量编辑”入口；同一弹窗选择服务分组、启停、Key 并发、USD 总额、请求次数、RPM、5 小时／24 小时／7 天滚动金额上限、UTC+8 到期时间及 IP 白名单／黑名单，直接保存。每次 1–500 把 Key，切换筛选清空选择，保存成功关闭并刷新列表，失败保留草稿。
- **接口与权限：** 新增 `PATCH /api/panel/api-keys/bulk`，请求 `{ ids, patch }` 只发送勾选字段。逐把复用现有所有权／管理员管理域检查和属主分组授权；严格校验非负数、整数上限、状态、带时区有效期及 IP/CIDR。所有更新与 `key.bulk_update` 审计在一个 SQLite 事务完成，任一失败整批回滚；返回更新数量，不返回密钥明文。
- **优化与清理：** 单个与批量编辑共用用量／有效期／IP 表单组件，沿用相同分区、双列布局、控件、文案及 7／30／90／180 天和不过期快捷按钮；批量侧完整展示字段，仅增加是否应用的勾选，快捷期限自动勾选有效期。共用服务端分组更新校验，移除原有重复表单和字段定义；没有废弃接口、额外兼容层或开关。未勾选字段保持原值；0 解除对应 Key 限额，明确勾选并留空有效期／IP 规则才清除。现有 Key 状态随额度恢复规则继续有效，不重置已用额度、资金、套餐消耗或密钥。
- **上游取舍：** 保持已交付上游父提交 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5`。该基线没有上述运营批量编辑能力；按本轮明确需求在现有 Key 更新链上增加最小差异，若后续上游提供满足相同权限与字段契约的实现，再收敛替换。
- **破坏性变更：** 无。**升级指南：** 部署对应控制面及前端后生效；无新配置、依赖或数据库迁移，本轮不执行生产部署或生产数据处理。
- **验证与限制：** Node 定向测试 21/21，API Key HTTP E2E 8/8，前端字段／展示及 i18n 测试 17/17，前端构建（含 TypeScript）、修改文件 ESLint、Biome／Prettier 通过。最终共用布局的浏览器可视验收因浏览器控制工具连接失败而未完成。没有真实供应商调用。分组候选沿用当前用户列表，最终按每把 Key 属主授权检查；不存在部分成功。

## 2026-11-02 修复删除槽位后分组资源残留

- **Bug 修复：** VM 列表和详情页删除成功后统一取消旧列表请求、移除该槽位的缓存行及详情缓存，并刷新 VM、分组和总览；避免详情页只刷新总览，返回分组时仍出现已删除槽位。
- **持久化与失败路径：** VM 数据库删除与分组解绑进入同一事务，更新所有受影响分组及资源版本并保留审计；删除不再依赖 API Key Store 才清理分组，也不再吞掉清理失败后返回成功。清理失败保留槽位文件和数据库关系，返回可重试错误；保留单一删除与分组版本规则。
- **历史残留：** 分组读取、容量数量和复制资源排除运行记录已不存在的 VM，仍保留现存空槽、停用槽及 API 资源。读取不删除历史数据库行；用户通过现有“保存资源”操作替换成员时清除该组残留。没有新增迁移或擅自清理生产数据库。
- **上游取舍与清理：** 沿用官方基线 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5`（1.4.032），不附带同步；上游没有商业分组关联契约。采用现有删除入口、分组版本和审计，移除路由中有条件且吞异常的重复解绑路径；仅为已确认的删除一致性保留必要差异，上游提供等价生命周期契约后收敛。
- **新增功能 / 破坏性变更：** 无。无新增接口、用户配置、依赖或数据库结构；仅修复既有删除、读取与缓存更新路径。
- **验证 / 升级与限制：** Node 22.23.4/macOS 下相关 Node 单测 51/51、真实本机 HTTP 删除→分组/VM 列表→旧版本拒绝 1/1、前端缓存回归 2/2 通过；TypeScript、修改文件 ESLint/Biome/Prettier 与 diff 检查通过。部署对应前后端后生效，本轮未部署、未发版、未触碰生产数据或调用真实供应商。截图中的整页 500 缺少现场异常证据，未宣称已定位其独立原因。

## 2026-11-02 将面板账单统计移出网关主线程

- **原因与修复：** 生产 CPU 采样确认账号账单聚合、七日明细分组及窗口计算占住推理请求共用的事件循环。`RequestLogStore.billingStats()` 改由一个专用 Node 工作线程执行；首页、VM 列表/详情、用量、供应商账号展示和通知快照完整等待异步结果。保留原账单公式和舍入语义，未采用试验性的 SQL 重写。
- **一致性与边界：** 工作线程单独打开现有 SQLite，沿用缓存/mmap 调优，不执行迁移。每次统计使用一致读事务；`data_version` 发现其他连接写入后清除统计缓存。主连接的数据版本及写入计数防止新入账请求复用旧的进行中快照；尚未执行的同窗口查询合并，最多等待 16 个不同查询、超时 30 秒后拒绝并终止线程，后续请求可重建。历史成本补价保持原有一分钟节流与计算路径，移到线程的读事务前执行；只读诊断跳过补价。
- **生命周期与清理：** 备份恢复在替换 DB/WAL 前停止统计线程，恢复后重新绑定连接；退出时等待线程关闭。删除面板五处重复的同步账单包装，统一处理异步失败；无效 SQL 草稿不进入交付。调度席位、扣费、推理路由继续使用现有主进程状态。
- **接口 / 升级：** 无新 HTTP 接口、用户配置、依赖、schema 或数据迁移；内部 `billingStats` / `buildUsage` 改为异步，调用方已一起调整。部署后自动启用，增加一个 SQLite 连接及工作线程；账单计算本身仍消耗 CPU，其他未改造的同步查询仍可能影响主线程。
- **上游取舍：** 当前上游父提交未提供面板统计线程隔离，保留上游聚合与账单契约，在存储门面与生命周期处增加最小隔离；上游提供等效异步统计和恢复一致性时可收敛。不多开整个网关进程。
- **验证：** 同版本 Linux 镜像内相关单测 101 项通过；真实 HTTP 回归覆盖首页、用量、VM 列表、新入账可见和供应商账号列表/详情。生产库只读快照 36,970 条、28 个分组逐字段对拍一致：同步计算 587ms、主线程计时回调 0 次/最大间隔 588ms；工作线程计算 602ms、主线程回调 118 次/最大间隔 5ms。此数据证明线程隔离，不代表计算吞吐提升。供应商 admin 旧 E2E 的两处 `no_available_group` 失败在未修改基线同样复现，已用有效授权分组的现有 portal E2E 验证变更路径。
- **生产实施：** 2026-11-02 在指定服务器基于已运行的 `v1.4.032.4` 仅叠加本修复 9 个源文件，构建本地补丁镜像并更新容器；旧镜像及 `.env` / Compose 配置留档。上线后两类面板接口 8/8 返回 200 且包含账单；并发健康检查 93/93 成功，短样本 P95 从 321ms 降到 163ms。未将其他 main 新变更打包部署，未发布新 Release，未清理生产账单数据；后台仍存在其他同步路径，本次结果不代表全站延迟或吞吐上限验收。

## 2026-11-02 修复网站图标过期缓存

- **修复与清理：** HTML 初次请求图标即携带内置素材内容哈希；品牌加载后保留构建哈希并添加自定义图片版本，恢复默认不再复用固定缓存键。上传/跳转及所有默认图标响应统一 no-store。删除无引用旧霓虹 Logo，提取共享图标路径集合以防两类响应遗漏。
- **采用与例外：** 保持已交付上游父提交与既有静态服务、品牌配置/权限；上游静态图片的一天缓存不满足可修改品牌契约，仅对网站图标例外，哈希 JS/CSS 保持上游缓存策略。上游提供等效品牌缓存契约后可收敛。
- **接口 / 升级：** 无新接口、用户配置、依赖、迁移或破坏性变更；版本化 HTML 和源站策略随应用部署生效。反代需让图标精确路径绕过静态缓存，操作说明见 BRANDING_AND_RELEASE.md。
- **验证与线上状态：** 品牌/favicon/静态服务 Node 10 项、前端品牌 8 项、TypeScript 与生产构建通过；产物图标 URL 与 ICO/PNG SHA256 一致。tapmodels.ai 已完成 11 个图标路径的 Nginx 缓存排除、备份、语法检查和平滑重载，公网旧地址和版本地址均返回新品牌图片，控制台 200。未替换应用容器、未改生产品牌数据、未发版；本轮源码改动尚需后续部署。

## 2026-11-02 修复 Codex 工具历史与多槽位过早会话熔断

- **部分撤销（2026-11-03）：** 调度修复中的会话熔断与过载后上下文恢复已整体移除；工具调用成对裁剪仍用于按上下文窗口的预压缩。

- **已复现的原因：** 旧压缩路径会拆开工具调用和结果；过载又在内外两层重复计数并过早触发会话 503，健康候选尚未尝试。恢复后的 input 仅用于当前槽位，再切换会重新发送原历史。现有这些缺陷可复现，但不能仅凭供应商 overload 文案断言其真实容量不足或上下文超限。
- **工具历史修复：** `function_call`、`custom_tool_call`、`computer_call` 按 `call_id`（缺失时使用 `id`）分组成对裁剪；最近 18 项中的结果保护其较早的调用。完整历史中的孤立结果会清理并记录数量，低于预算时仅清理孤立项，不额外裁剪有效历史；`previous_response_id` 续写不进入裁剪。保留增量字节核算，按历史顺序处理分组，避免恢复平方级序列化。
- **调度修复：** 可重放过载只在 hop 内计数，连续过载允许一次上下文恢复；恢复后的 input 传给后续槽位，同时按目标账号重建会话身份。健康候选继续在既有尝试数、切换数与截止时间内尝试，结束后仍过载且本轮已尝试恢复才合成会话 503。删除内层重复熔断分支和失效计数变量。预算耗尽不再标记未执行的恢复。
- **错误分类：** `codex_session_overloaded` 与中文过载信息归入“过载排队”。保留同账号过载不原样重试、已提交 SSE 不重放、续写账号归属与 60 秒冷却保护。
- **上游取舍：** 沿用 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5`，没有同步上游；该基线没有本定制会话保护/预压缩模块，保留修复已复现缺陷所需的最小差异，未来有等价上游契约时收敛。
- **范围与升级：** 无新增接口、用户配置、依赖、迁移或生产数据处理。仅修改既有预压缩、恢复与故障转移路径；部署控制面后生效，本轮未部署。没有实施动态 70%–80% 阈值、TTL 持久化或 Conversation 接口；普通 overload 的供应商容量/上下文归因仍需请求级生产证据，不能用槽位总数推断。
- **验证：** 定向覆盖短历史多槽位故障转移、长历史恢复后换槽成功/耗尽返回 503、三种工具类型成对移除与跨保护边界保留、孤立修复不额外裁剪；Node 22.23.4/macOS 下相关 6 个测试文件 112/112 通过，Node 语法、Biome 与 diff 检查通过；未调用真实供应商推理。

## 2026-11-02 Codex 上下文压缩去掉平方级序列化

- **问题原因：** `compactCodexInput` 的删减循环每删一项就 `body.input.filter(...)` 重建整个数组，并对剩余全部历史重新 `JSON.stringify` 估算 token，开销随删除条数呈平方增长。会话过载恢复（`codexContextFallback` → `force: true`）恰好是对最长的历史走这条路径，而预检压缩在每个 Codex 请求上无条件执行。生产近 2 小时 5,615 次请求中有 2,971 次（53%）为 `codex_session_overloaded`，于是形成「过载 → 烧 CPU → 响应更慢 → 更多过载」的回路；主线程 perf 采样显示 `JsonStringifier::SerializeString` 20.2% 加 `String::Utf8Length` 8.7%，JSON 序列化占到约三成 CPU。
- **修复：** 逐项序列化一次并缓存各项字节数，之后按「各项字节和 + 两个方括号 + `count-1` 个逗号」增量推算剩余 token，删一项只做一次减法；数组过滤从循环内移到循环后只做一次。阈值、保护最近 18 项、可删项判定与返回的 `info` 字段均保持不变——只改计算方式，不改压缩行为。
- **等价性验证：** 新增的 `itemBytes` / `arrayTokens` 与 `estimateCodexInputTokens` 逐字节等价（数组中的 `undefined` 按 `null` 计 4 字节）。随机对拍 1,200 例新旧实现输出，`info` 与结果数组全部深度相等（其中实际压缩 633 例、返回 `null` 567 例）；另有 3,000 组字节公式一致性检查通过，覆盖中文、emoji、引号与反斜杠转义。
- **实测收益（force 路径，中位数 / 7 次）：** 240 轮会话（720 项）345.2ms → **5.6ms（×61.8）**；120 轮（360 项）71.5ms → 3.4ms（×20.9）；60 轮 1.9ms → 1.7ms、30 轮 1.2ms → 0.9ms，短历史无回归。平方项正好在长历史上爆炸，而长历史正是会话过载的触发条件。
- **测试：** `codex-context-budget` 新增增量字节核算回归，跨 40 种长度比对 `retained_tokens` 与全量序列化结果——因为 token 按 4 字节向上取整，单字节偏差只有约 1/4 概率改变结果，单一用例抓不住。已用变异测试确认该回归能捕获逗号项（`count-1` → `count`）与括号项（`2` → `0`）算错。Codex 相关 6 个测试文件 59 项全过，Biome 格式无改动。
- **范围与限制：** 不新增接口、配置项、依赖、迁移或生产数据处理。需重建镜像并升级容器后生效。本修复只消除压缩自身的平方开销，不改变上游 Codex 会话过载的发生率，也不改变「面板与推理网关共用单线程进程」这一根因。

## 2026-11-02 SQLite 页缓存与 mmap 上限

- **问题原因：** `node:sqlite` 的 `DatabaseSync` 没有异步 API，每条查询都在主线程上同步跑完——面板一次聚合查询跑多久，事件循环就冻多久，同一进程里所有流式推理连接一起卡住。而 SQLite 默认只给 2MB 页缓存、不启用 mmap，对 555MB 的库远远不够：生产 strace 实测主线程每 5 秒约 10.9 万次 `pread64`，占系统调用耗时的 69%。
- **改动：** `createDatabase()` 在现有 PRAGMA 之后增加 `cache_size`（默认 256 MiB）与 `mmap_size`（默认 1 GiB），均可用 `KIN_DB_CACHE_KIB` / `KIN_DB_MMAP_BYTES` 覆盖，后者设 `0` 可完全关闭 mmap；非法值回落默认。两者都是上限而非预分配，按需增长。
- **实测收益（生产库，中位数 / 5 次，热身后）：** 30 天按 VM 聚合 297.4ms →（仅缓存）127.3ms →（仅 mmap）118.8ms →（叠加）**112.4ms**；7 天按用户聚合 107.0ms → 62.7ms；全历史按模型聚合 173.3ms → 133.3ms。两项命中不同环节——mmap 省系统调用，页缓存省重复读。
- **接口 / 数据：** 不涉及 schema、迁移、接口、DTO 或生产数据处理。常规连接及 `backup-worker.mjs` 经 `createDatabase()` 生效；后续新增的面板统计连接复用相同 `dbTuning()`，不重复执行迁移；`scripts/audit-*.mjs` 几个独立只读审计脚本自开连接，不在此范围且不在热路径。
- **上游取舍与清理：** 上游基线未设置这两个 PRAGMA。这是按本部署实测规模保留的最小必要差异，不改动上游已有的 `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`；内存受限的部署可用环境变量调回接近默认（`KIN_DB_CACHE_KIB=2000`、`KIN_DB_MMAP_BYTES=0`），无需改码即可退出该差异。
- **验证：** Node 单测 389/393 个文件通过；数据库相关 7 个文件 72 项全过。失败的 4 个文件（`egress` 3 项、`guest-identity-reader` 1 项、`oauth-binary` 4 项、`telemetry-status` 1 项）在临时还原本改动后失败数完全一致，属本机未构建 Go helper（`bin/kin-oauth-auth` ENOENT）与 Linux 专有预期导致的既有失败，与本改动无关。另已核对 PRAGMA 实际生效值及四种环境变量情形（默认、自定义、`=0` 关闭、非法回落），Biome 格式检查无改动。
- **范围与限制：** 生产容器的 `/opt/tapmodels/src` 为镜像内置（非挂载），本改动需重建镜像并升级容器后才生效，环境变量无法提前绕开；本轮未执行构建、发布或部署。该调参只减少同步查询时长，不改变「面板与推理网关共用单线程进程」这一根因。

## 2026-11-02 反代面板路由有界超时与目标架构文档

- **运维背景：** 面板与推理网关共用同一个单线程 Node 进程，推理流量占满事件循环时面板接口排队数十秒；`location /` 的 24h 读超时让浏览器只能无限等待，既看不到错误，积压连接又继续拖慢上游。生产实测控制台首字节一度 11～45 秒，重启后的 VM 集群重建窗口内直接表现为打不开。
- **文档变更：** `docs/DEPLOY.md` 新增「面板动态路由的有界超时」一节：`/api/`、`/console/`、`= /` 封顶 120s；WebSocket 运维终端（`/api/panel/{cluster/nodes,vms}/*/shell`）保留 3600s；席位/队列 SSE（`/api/panel/pool/stream`）24h；连通性探测（`/api/panel/probe`）300s；`location /` 继续保留 24h 给推理流式与 `/v1/responses` 的 WebSocket。共用代理设置收敛到 `snippets/tapmodels-app-proxy.conf`，各 location 只覆盖自身超时。
- **取值依据与陷阱：** 封顶值按生产全量访问日志取——非长连接的面板接口最长观测 102s，取 120s 不会误杀当前能返回的请求，只截断本来会无限挂起的那些。文档同时记录 `/api/` 必须用普通前缀 location 而非 `^~`：`^~` 会跳过正则 location，使 shell 终端被 120s 切断。新增面板长连接接口时必须同步加豁免。
- **规划文档：** 新增 `docs/ARCHITECTURE_TARGET_20261102.md`（对照定制 NewAPI 与 codex-proxy-rs 后形成的 PostgreSQL + Redis 目标业务、数据与迁移架构，属目标设计，尚未切换生产数据库）与 `docs/cpr/06-codex-multi-account-single-vm.md`（单一 Codex VM 多 OAuth 账号的 PRD、产品原型与技术实现方案）；`docs/README.md`、`docs/cpr/README.md` 同步索引。
- **范围与限制：** 仓库侧本轮只改文档，不含应用代码、接口、配置项、依赖、迁移或生产数据处理。nginx 站点配置不由 `deploy/install.sh` 生成，重建反代时需照此文档手工落地。生产 nginx 已按该方案应用并 reload（`nginx -t` 通过，改动前配置已备份至 `/root/nginx-backups/`），3 分钟实流观察无 504、`/v1/responses` 最长 78s 未被截断、WebSocket 握手仍由应用返回 401 而非挂起；120s 封顶尚未在真实挂起场景下被触发验证。该超时是事件循环饱和下的护栏，不是根因修复——根因仍是面板与推理网关共用单线程进程。

## 2026-11-02 修复运营端分组选择与用户分组授权保存

- **问题原因：** （1）API 密钥 → 编辑 API Key 的“服务分组”选项在分组请求进行中被整体清空，而“超级管理员自用 Key”一行仍然渲染，下拉的“加载中”提示因此不显示，看起来只剩这一个选项；输入框同时回退为原始分组 ID。打开弹窗会主动失效分组查询，每次编辑都会落入这个窗口，接口报错前的重试期间也只表现为空列表。（2）用户管理 → 编辑用户的“分组授权”使用浮层下拉，展开后覆盖弹窗底部的“取消 / 保存用户”；点击保存实际命中浮层里的分组行，表单不提交，也没有任何提示。（3）保存成功后 `onSuccess` 等待 `invalidateQueries` 完成，刷新结束前突变仍为 pending，保存按钮保持禁用，再次保存无反应也无提示。
- **修复：** 分组选项保留已取回结果，仅在确实没有数据时判定为加载中；加载提示与已有选项同时显示；编辑态把 Key 当前分组按名称列出，避免显示裸分组 ID。分组授权选择器改为表单内联展开，不再生成浮层，弹窗底部按钮始终可点击。用户与 API Key 的保存回调不再等待缓存失效完成。
- **接口 / 数据：** 无接口、配置、迁移或生产数据变更；`/api/panel/groups?available_to=` 与用户 PATCH 行为保持不变。
- **上游取舍与清理：** 上游基线没有对应修复；本次只调整既有组件渲染与查询状态判定，未新增兼容层或开关，并移除分组授权对 Popover 浮层的依赖。
- **验证与限制：** web TypeScript 检查通过，`vitest run` 110 文件 / 840 用例通过，Prettier 与 ESLint 对修改文件通过（仅既有 react-refresh 警告）。本地 gateway + Vite 控制台复现并回归两个缺陷：注入 4 秒延迟时分组下拉显示“加载中”并按名称列出当前分组，请求返回后可选全部分组；分组授权展开时“保存用户”可达，一次点击即保存并关闭弹窗；连续保存不再被禁用。未执行 Docker、真实供应商调用、生产部署或数据迁移。

## 2026-11-02 修正供应商账号状态映射的 CI 格式检查

- **问题修复：** 按 Biome 2.5.11 的规范拆分 `src/lib/admin/panel-routes.mjs` 中的长数组映射表达式，恢复 `format-check` 门禁通过。
- **范围 / 升级：** 仅格式调整，无运行时行为、接口、配置、依赖、迁移、资产或生产数据变化；部署后无需额外操作。
- **验证：** Biome 定向格式检查与 `git diff --check` 通过。

## 2026-11-02 供应商平台用量统计按账号汇总并显示状态

## 2026-11-02 将 Codex 上下文覆盖改为 OpenAI 模型配置

- **配置入口：** 删除 Astra/Sol 的固定 `500000` 常量；OpenAI 模型配置新增网关生效上下文窗口，未设置时跟随上游 `catalog.context_window`，可随时恢复跟随上游。
- **统一生效：** 配置覆盖同时用于 Codex 原生目录、客户端目录下载、网关首次 hop 前预压缩和 `previous_response_id` 上下文判断；上游 `catalog.context_window` 与 `max_context_window` 保持只读事实。
- **默认与升级：** Astra/Sol 默认恢复为上游同步的 `272000`。已有旧版固定覆盖不会继续强制 500K；如仍需 500K，请在 `/console/#/models` → OpenAI → 对应模型 → 配置中显式设置并保存，再重新下载本地 `codex-models.json`。
- **验证与范围：** 增加策略覆盖与跟随上游回归，更新 Codex 目录和前端模型配置文案；无新增接口、迁移或生产部署。

## 2026-11-02 修复 Codex 上下文压缩产生孤立工具结果

- **问题原因：** 上下文压缩删除旧 `function_call` 时，可能保留对应的 `function_call_output`；重试请求因此触发上游 400（`No tool call found for function call output`），随后被外层重试链包装成 429/重试耗尽。
- **修复：** 压缩后按 `call_id`/`id` 校验 `function_call`、`custom_tool_call` 和 `computer_call`，删除没有对应调用的结果项，避免发送孤立工具结果。
- **验证与范围：** 新增上下文压缩工具调用配对回归；无新增接口、配置、迁移或生产数据处理。

## 2026-11-02 修复 Codex 过载错误的重复重试

- **问题原因：** Codex 上游返回 `503 server_is_overloaded` 时，原策略把容量/槽位过载误当成同账号瞬时错误，在同一槽位按 `max_same_account_retries` 重复发送，再进入跨账号故障转移；生产日志因此集中出现 3 次尝试的 503，延长失败请求并放大无效上游调用。
- **修复：** 明确的 502/503/529 过载结果不再执行同账号重试，直接交给既有跨槽位故障转移；普通可重放 `server_error`、传输失败和已确认可重放错误仍沿原同账号重试策略。会话级上下文恢复和过载冷却逻辑保持不变。
- **验证与范围：** 新增过载跳过同账号重试回归，并更新过载策略单测；Codex 相关 Node 测试 101/101 通过，Biome 检查与 `git diff --check` 通过。无新接口、配置、迁移或生产数据处理；需部署控制面后生效。

## 2026-11-02 统一 Tapmodels 默认 Logo 与网站图标

- **品牌素材：** 将系统内置 Logo 和 favicon 从旧的霓虹箭头替换为 Tapmodels 黑色/青绿色方块标识；登录页、控制台侧栏、供应商入口和浏览器网站图标使用同一套默认样式。
- **品牌设置：** 保留运营后台 `/console/#/settings/branding` 的品牌名、Logo、网站图标 URL/上传配置；管理员保存的自定义素材继续覆盖内置默认值，网站图标仍优先使用 favicon，未设置时回退 Logo。
- **交互修复：** 登录页自定义 Logo 改为与控制台侧栏相同的尺寸和容器，不再缩成小图标或套用不一致的固定深色背景。
- **范围 / 升级：** 无新接口、配置项、依赖、迁移或生产数据处理；部署匹配的前端静态资源后默认品牌自动生效，已保存的自定义品牌无需迁移。
- **验证：** Web TypeScript、修改文件 Prettier、品牌设置/favicon 前端测试 7/7、品牌后端测试 3/3 通过；未执行生产部署。

## 2026-11-02 修正 Codex 上下文能力与续写过载恢复

- **部分撤销（2026-11-03）：** 续写过载返回 `409 codex_context_compaction_required` 与“重复过载后的兜底裁剪”已移除；首次 hop 前预压缩保留。

- **历史实现（已被后续配置化修复取代）：** Astra/Sol 曾由部署覆盖固定为 `500000`，并保留上游 `max_context_window`；现行行为见本文件顶部“将 Codex 上下文覆盖改为 OpenAI 模型配置”。
- **上下文处理：** 请求首次发送前按模型 `context_window`、输出预算和输入估算量预先裁剪旧 reasoning/tool 项，保留用户/系统消息与最近 18 项；重复过载后的兜底裁剪继续保留。
- **续写协议：** 带 `previous_response_id` 的请求发生上下文过载时，不再切换账号重试，返回 `409 codex_context_compaction_required`，要求移除 `previous_response_id` 并提交压缩后的完整 `input` 历史。
- **范围与升级：** 无新增配置、依赖、迁移或生产数据处理；部署控制面与模型目录后生效。客户端需处理新的 409 错误并支持完整历史重提。
- **验证：** 新增模型目录覆盖、按窗口预压缩和续写协议回归；本地 Node 不可用时由 CI 执行 Node 单测，未执行真实上游推理或生产部署。

## 2026-11-02 修正 guest OAuth 代理参数回归

- **问题修复：** Linux `kin-oauth-auth` 的 CI 换票回归因控制面把所有带代理 ID 的 VM 都误判为已启用透明出口，向 helper 传入空 `proxy_url`；测试中的远程 SOCKS 出口因此无法到达 token endpoint，CAI 与 Setup Token 换票均失败。
- **实现：** 恢复按 egress 类型选择参数：本地出口传空地址，远程绑定出口继续传 `boundProxyUrl`。`slotNetworkForVm()` 只用于容器网络配置，不能单独证明透明代理已接管请求。
- **清理与范围：** 删除错误的透明出口判定及不再需要的导入；不改变 OAuth state、PKCE、cookie 换票、凭据落盘和遥测契约，不涉及数据库、payload、生产部署或数据处理。
- **验证：** `database` 与 `distill-detect` 定向 Node 测试 64/64 通过；Web 点名文件 Prettier 检查通过；Linux helper 回归交由 GitHub Actions 标准 Linux 环境复核。

## 2026-11-02 延长完整 unit CI 门禁超时

- **问题修复：** 完整 Node unit 套件在格式修复后运行超过原 8 分钟门禁，Job 被超时取消；将 `.github/workflows/test.yml` 的 unit Job 超时调整为 15 分钟，避免完整受影响回归被基础设施超时截断。
- **范围 / 升级：** 仅 CI 流程配置调整，无业务运行时、接口、配置、依赖、数据库迁移、镜像资产或生产部署变化。
- **验证：** 前一轮 `format-check`、contracts、ARM64 native CLI 和定向 `handle-codex` 测试已通过；本次由新的 CI 运行验证完整 unit 套件。


## 2026-11-02 修正 Codex 处理器格式检查失败

- **问题修复：** 修正 `src/lib/protocol/handle-codex.mjs` 与 `test/unit/handle-codex.test.mjs` 的 Biome 格式，消除 CI unit 阶段的格式门禁失败。
- **范围 / 升级：** 仅格式调整，无运行时行为、接口、配置、依赖、迁移或资产变化；不需要数据库处理、槽位重建或生产配置变更。
- **验证：** `handle-codex` 单元测试通过，Biome 定向格式检查与 `git diff --check` 通过。


## 2026-11-02 修复 Codex 专用链路模型与推理强度丢失

- **Bug 修复：** Codex Responses、WebSocket 和兼容协议进入专用处理器后，日志字段以原始入站请求为权威；即使外层日志已经被映射模型或默认强度预填，也会覆盖 `requested_model` / `reasoning_effort`，避免出站/计费模型覆盖客户端模型。客户端请求 `gpt-6-astra`、高推理，实际出站或计费为 `gpt-5.6-terra` 时，使用记录保存 Astra/high，计费模型继续为 Terra，并由真实响应模型触发不一致提示。
- **范围与兼容：** 不改变模型映射、路由选择、计费模型、价格或结算；不把上游模型反写为客户端请求模型。旧记录没有保存请求模型或真实响应模型时仍不推测回填。
- **验证：** Codex 专用链路回归覆盖外层日志为空及已预填 Terra/medium 两种情况；Codex、请求日志和使用记录视图共 113 项通过，Web 日志相关测试随现有套件 840 项通过，diff 检查通过。未部署生产。

## 2026-11-02 虚拟机统一批量编辑

- **新增功能：** 虚拟机列表与机架共用选择、当前筛选结果全选和单一“批量编辑”入口。单页表单支持分组追加/移除/替换、人工调度开关、并发、RPM、GPT 选槽权重和 Claude 调度等级；默认不修改，恢复继承为显式操作。混合平台显示适用数量，分组按明确选定的平台操作。
- **交互：** 点击“保存”直接校验并持久化；全部适用字段保存成功后关闭弹窗、刷新列表、清除成功目标选择并轻提示，无预览/二次提交/成功结果页。失败保留草稿和逐字段结果；刷新失败与写入失败分别提示。
- **可靠性与权限：** 超管专用，最多 500 台。整批预校验权限、归档、版本、平台和数值，调度启用保留自动限制及供应商控制。SQLite 分组全批事务、字段写前记录、操作 ID 去重、断线查询和只重试未完成字段，防止成功字段被重放覆盖。新操作表和现有审计持久保存结果；浏览器标签保留非敏感未确认请求供刷新后恢复。
- **采用与必要融合：** 保持官方基线 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5`（1.4.032），不附带同步上游。采用既有 VM 持久化、运行态投影、调度状态和分组版本事务；仅增加已确认的跨字段批量编辑协调与界面。上游没有等价的统一选择/直接保存及可恢复批量记录，待提供等价契约后收敛。
- **清理：** 删除旧批量分组弹窗及四语专属文案，移除重复选 VM 流程；单台分组和已文档化 `/vms/groups/batch` 保留，与新路径共用平台/执行后端校验。既有全局策略接口保留，不修改无关操作。
- **接口 / 升级：** 新增快照 POST、保存 POST、操作结果 GET 共 3 个接口；新增迁移 `076_vm_bulk_edits.sql` 和 1 张操作记录表，无新增用户配置或依赖。部署匹配前后端并运行既有启动迁移后生效；分组仍写 SQLite，VM 调度配置沿用权威记录与运行态投影，不另做存量数据迁移。无破坏性 API 变更；只改变旧批量分组 UI 入口。
- **验证与限制：** Node 24.22.1/macOS；新增后端 13 项、既有策略/分组 39 项、真实 HTTP/重启 1 项、前端相关 23 项、国际化 5 项通过；TypeScript、修改文件格式/lint 和 diff 检查通过（1 条 Fast Refresh 开发警告）。浏览器在隔离测试数据验证机架/列表共享选择、直接保存后关闭与分组刷新。延续单进程控制面，跨 SQLite 与文件写入不保证整批原子回滚，部分完成按字段报告；未部署生产、未操作生产数据、未调用真实上游。详见 `docs/VM_BULK_EDIT.md`。

## 2026-11-01 Codex Responses 会话级过载恢复

- **已撤销（2026-11-03）：** 本条会话级过载恢复与 60 秒会话冷却已整体移除，见“撤销 Codex 过载触发的上下文压缩与会话熔断”。

- **Bug 修复：** 连续 `server_is_overloaded` 不再对同一会话无条件轮询全部 GPT 槽位。会话在短窗口内重复过载后只执行一次上下文恢复，保留最近输入并移除旧 reasoning/tool 历史；恢复仍失败时进入 60 秒会话级冷却，返回 `503 codex_session_overloaded` 和 `Retry-After`，提示稍后重试或新建会话。
- **诊断与边界：** 仅作用于未提交的 OpenAI Responses/Codex 请求；带 `previous_response_id` 的续写不改写服务端上下文，已提交 SSE、传输错误和短请求不做历史裁剪。原有槽位级 failover、账号冷却、错误消息脱敏和计费路径保持。
- **实现与升级：** 新增进程内会话过载状态模块和通用上下文恢复函数，无新增 API、配置、依赖、数据库表或迁移。部署控制面后生效，进程重启会清除进程内过载状态。
- **验证：** 新增会话过载 guard 与上下文裁剪回归；已完成修改文件 Node 语法检查和 `git diff --check`。本机没有 Node/Docker daemon，完整 Node 单测交由 CI 标准环境执行；未执行真实上游推理或生产部署。

## 2026-11-01 供应商账号留空名称使用授权邮箱

- **功能与行为：** 供应商添加和超级管理员代添加账号的名称提示统一为“留空则自动使用授权邮箱”，覆盖四语。留空创建的账号在 Claude 凭证落盘、订阅资料成功刷新或 GPT 凭证提交获取邮箱后，使用完整授权邮箱作为账号名称；手填名称和授权前主动改名保留。账号池沿用 `telemetry.email` 优先的展示与复制规则，无邮箱时显示账号名称，不猜测订阅邮箱。
- **实现与清理：** 用既有 `vendor_resources.config_json` 的 `name_from_authorization` 标记未完成自动命名，成功命名或主动改名即移除；同名表单提交和备注修改不取消待命名状态。按账号、供应商及绑定运行时 ID 核对关联，并排除已归档资源。删除两处供应商表单复用 VM 自动编号提示的路径；独立 VM 新建仍用原自动编号契约。没有变更已存量名称或生产数据。
- **上游取舍：** 保持官方基线 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5`（1.4.032），采用现有 OAuth 身份、凭证持久化与 profile 流程。上游没有供应商资源的自动命名需求，保留仅此需求所需的共享命名函数和三个资料写入调用点；上游提供等价供应商命名契约后收敛。没有附带同步上游。
- **接口 / 数据 / 升级：** 无新 API、用户配置项、依赖、表或迁移；新增 1 个按需临时 JSON 字段、1 个共享命名分支，复用 3 个既有身份写入入口。无破坏性变更。部署匹配前后端后对新建账号生效；获取不到邮箱时先保留临时名称，之后获取到邮箱再命名，历史账号不会根据名称模式猜测并批量改写。VM ID、运行时名称及历史账单保持原值。
- **验证：** Node 24.22.1/macOS；相关账号资料、凭证、供应商平台与账号投影单测 61 项通过，真实 HTTP/SQLite 授权草稿回归 1 项通过，覆盖供应商 OAuth 自动命名、管理员 Claude/GPT 空名称和自定义名称、跨运行时拒绝、延迟邮箱与手动改名保护。前端账号相关 15 项通过，TypeScript、修改文件格式/lint（既有 3 条警告，0 错误）和 diff 检查通过；Chrome 在隔离本地真实页面确认两端占位提示。国际化检查 4 项通过、1 项因模型页 4 处既有硬编码文案失败，已在未修改的 `6d149f02` 主工作区复现。未执行真实供应商授权、生产部署或数据迁移；同版本推送仅触发 CI，不发版。

## 2026-11-01 修正发布权限契约测试和 Fast 别名多语言

- **Bug 修复：** Release 的 ACL 测试仍在聚合路由源码搜索 `/schedulable`，上游将接口拆至 VM maintenance 模块后产生误报。改为调用真实 `createPanelHandler`，验证调度、清除冷却两个 POST 经实际注册到达处理器（不存在 VM 返回 `vm_not_found`），并验证管理员、用户和供应商均被权限门禁拒绝。删除旧源码正则扫描和专属读取逻辑，后续路由文件拆分不再引发同类误报。
- **多语言修复：** Fast 别名区域的标题、公开开关无障碍名称、priority 提示、不可用说明与三种失败原因接入简中、繁中、英语和日语资源；保持别名可用性和权限逻辑。
- **范围 / 升级：** 无新接口、配置、依赖、迁移或破坏性变更，当前上游父提交保持不变。文案随匹配的前端资源部署后生效，无需生产数据处理或槽位重建。
- **验证：** ACL 定向测试 7/7 通过；Release 同组身份、权限与更新契约回归 80/80 通过；国际化和模型策略测试 10/10、TypeScript 通过；标准 Linux 构建与完整前端由重新发起的 GitHub Release 验证。

## 2026-11-01 上游 1.4.032 同步与 tapmodels 定制收口

- **来源与提交形状：** 以 `dofastted/vm2api/main` 的 `6ff6efd2af5a9819dcb9a6116f9ac5c2d68684f5` 为冻结基线，将现有 tapmodels 定制树重建为一个唯一子提交；交付目标为 `holeenlu/vm2api/main`。上游 `CHANGELOG.md`、`VERSION`、`deploy/payload.json` 按上游内容采用。
- **采用上游功能：** GPT `<model>-fast`/`priority` 别名、Codex Images（生成、编辑、Responses 图像工具、计费与白名单）、Codex kernel 大图像 WebSocket 与增量 SSE 解码、目标 VM egress OAuth 换票与槽内 bootstrap。
- **必要融合：** 保留 tapmodels Gateway Worker/路由 facade、供应商与事实层、四语模型面板、`codex_metadata`/上下文窗口策略、OAuth 草稿字段和现有权限边界；Fast 字段接入现有模型策略和面板。
- **上游优先清理：** token exchange 不再由控制面重复 `enrichOauthIdentity`，由 `kin-oauth-auth` 在目标 VM 出口完成 bootstrap；导入和授权交换路径均跳过重复 enrich。没有保留无依据的控制面重复代理检查。
- **版本与资产：** 应用版本升至 `1.4.032`；payload 切换为 `payload-2026.11.01-codex-image-kernel`，包含 `kin-codex-kernel`、`kin-worker`、`kin-egress`、`kin-slot-gate` 及 `cli-node 8484c4c5…`。无数据库迁移、无新增依赖、无生产数据处置。
- **破坏性变更：** GPT Fast 别名只有目录声明 `service_tiers[].id=priority` 且模型已启用/公开时可用；其他 `<model>-fast` 在本地拒绝。OAuth 换票需要目标 VM execution context，直接宿主路径仍要求代理。
- **升级指南：** 已部署机须同步 Node 控制面与 `web/dist` 后重启；在控制面容器或带 Node 的源码环境执行 `npm run fetch:payload`，核对 payload SHA256 后执行 `wrap-cli/sync` 并使用 `restart:true`，再等待槽位健康。保留 `routing.json`、`vms/`、`data/`、`.env`；ARM64 控制面按 `deploy/arm64-cli.json` 重建镜像。代码推送不代表生产已部署。
- **验证与限制：** Node 语法及 GPT policy、Codex mapping/convert、Images、模型目录、图片工具和槽位白名单等受影响测试通过。完整隔离套件在 macOS 留下缺少 `bin/kin-egress`、Unix socket `EINVAL`、硬件/遥测夹具等环境失败；前端测试工具链未能在本检出建立 `web/node_modules/.bin/vitest`，前端测试待 CI 标准环境验证。未执行真实 OAuth、Docker/KVM、GitHub Release 或生产部署。

## 2026-11-01 VM 测试/凭据路由、Codex 全入口事实层与发布契约补齐

- **重构 / 优化：** 新增 `panel-vm-test-routes.mjs` 和 `panel-vm-credential-routes.mjs`，分别承接 VM test-chat、test-models、test-schedule、credential clear、reset-fingerprint 和 reconcile-fingerprint；聚合面板继续负责认证、能力门禁和公共响应上下文。
- **协议可靠性：** Codex Responses、Search、Images 入口统一产生 `RequestFacts`、`AttemptFacts`、`RetryBudget` 和 `DeliveryCommit`；Responses WebSocket 经 `handle-protocol` 继承同一事实链。候选选择、重试正文、SSE/WS 输出、错误码和计费入口保持不变。
- **用量/结算：** 结算预览先冻结 `SettlementSnapshot`，记录金额是否已知；不改历史迁移、SQL、价格版本或付款边界。
- **前端与发布：** VM/日志查询统一使用 `panelQueryKeys`，补充 VM 级失效关系；发布脚本增加资产名称与 linux/amd64 镜像契约校验。
- **供应商投影：** `vendor/projections/usage-projection.mjs` 接入 admin/supplier/account usage query facade，明确未定价费用为 `null`、缓存证据不完整时不计算 total_tokens。supplier-admin 页面 query key 统一到 `supplierQueryKeys`。
- **VM/OAuth：** `panel-vm-runtime-routes.mjs` 承接 VM reload、shell-ticket、collect-identity；`panel-vm-oauth-query-routes.mjs` 承接 credential/setup-token session 查询；`oauth-route-context.mjs` 统一 slot 路径、credential state 和 refreshable 规则。
- **前端：** 认证、用户、分组、模型、设置、风险、统计、订阅、供应商、VM package 和 branding 查询继续迁移到 `panelQueryKeys`，接口 URL、权限和页面行为保持。
- **发布/部署：** release contracts 增加部署 tag、宿主架构和镜像 tag 纯策略，并让 guest image policy 复用统一 tag 解析。
- **安装脚本：** 新增 `deploy/install_contracts.py`，`deploy/install.sh` 复用纯 tag、架构和镜像 tag contract；保留 Docker 地址池、ARM64 QEMU、compose、槽位 kernel/CLI 同步和生产配置保护。
- **VM seed settings：** 新增 `panel-vm-seed-routes.mjs`，迁移 seed-settings 读写、debug telemetry log、代理时区跟随、锁/CAS 和 native/remote publication；原字段、状态码和响应 envelope 保持。
- **VM package：** 新增 `panel-vm-package-routes.mjs`，承接 package export、update、create/import；owner scope、代理绑定、时区填充、worker reload、bring-up 和 package DTO 保持。
- **VM reset：** 新增 `panel-vm-reset-routes.mjs`，承接 destroy/recreate、代理重新分配、启动、凭据/调度状态和失败返回；reset mode 与 runtime envelope 保持。
- **VM maintenance：** 新增 `panel-vm-maintenance-routes.mjs`，承接调度 hold/resume、schedulable、cooldown/circuit reset、activate、旧 Claude CLI 410 和 VM 删除；保持 drain、代理解绑、DB 镜像清理、权限及原响应。
- **OAuth mutation：** 新增 `panel-vm-oauth-mutation-routes.mjs`，承接授权链接、换票、credential PUT、OAuth→Setup Token 和 refresh；保留 Codex/Claude 分支、代理要求、供应商 VM 校验、worker 换票及 profile 刷新。
- **VM provision：** 新增 `panel-vm-provision-routes.mjs`，承接 `/api/panel/vms/create`；保留运行时/机器配置、节点预检、KVM、指纹、locale、代理分配、时区跟随、启动失败状态和 boot DTO。
- **VM import：** 新增 `panel-vm-import-routes.mjs`，承接 Codex、Console API Key、sessionKey、Sub2API JSON 导入和身份 enrichment；修复无 worker credential 时查询空值导致的面板 500，凭据缺失继续按无凭证返回。
- **前端 query 收口：** 生产前端不再直接写 query key/invalidation 数组，日志子查询、全局 panel 失效和 VM/供应商/分组/备份刷新统一使用 `panelQueryKeys`；缓存前缀和接口 URL 不变。
- **运行事实读方：** quota availability 使用 `projectQuotaWindow` 处理 5H/7D reset，slot runtime 结果增加 `transport_health` 投影；保留原 runtime health 字段和未知值语义。
- **供应商 usage projection：** 账号 query service 与供应商门户 totals/today 统一经过 `projectVendorUsage`，未知费用、缓存不完整和 total_tokens 保持明确未知，不改 SQL 或门户响应字段。
- **前端 query facade：** 集群 Docker/preflight/slot-image、统计图表、日志 ranking 及供应商刷新失效改用共享 `panelQueryKeys`，接口 URL 和页面行为保持。
- **前端列/导出 facade：** 日志列可见性和 JSONL/CSV 导出查询由 `features/logs/model.ts` 统一转出，主表、全屏表与导出入口共享同一模型；角色白名单、CSV 字段和查询参数保持。
- **验证：** Node v24.22.1 语法检查；panel route coverage、VM package、Codex Responses/Search/Images、settlement snapshot 共 86 项通过；TypeScript 检查通过；Python release 全套 66 项通过（含新增契约测试）。未执行真实 Linux/Docker/KVM/OAuth/egress、GitHub Release、生产部署或生产数据操作。

## 2026-11-01 VM 只读路由、供应商服务边界与前端失效关系收敛

- **重构 / 优化：** 新增 `src/lib/admin/panel-vm-read-routes.mjs`，承接 VM 列表、详情、fleet-status 和 create-options 的只读处理；认证、能力门禁、租户范围、kernel health 和原响应 DTO 保持在现有面板上下文中。新增 vendor account/proxy/usage/settlement command/query facade，并迁移真实供应商 usage、账号 runtime、授权草稿和结算调用；原 SQL、幂等、付款、归档和权限规则继续由既有实现负责。
- **前端：** 扩展 `web/src/lib/query-keys.ts`，新增 `query-invalidations.ts`，统一 VM、代理、供应商、供应商后台和用量视图的失效关系；代理写操作已接入共享 helper，缓存数组和请求 URL 保持兼容。
- **新增文件：** 1 个 VM route factory、1 个 route 单测、5 个 vendor facade、1 个 vendor facade 单测、1 个前端 invalidation helper 和 1 个 Vitest 文件。
- **验证：** Node v24.22.1/macOS；VM route、panel route coverage、vendor facade 共 7 项单测通过，Web invalidation 4 项通过，Web TypeScript 检查通过，`git diff --check` 通过。未改变数据库 schema、HTTP URL/状态码、协议、Docker/KVM、生产凭据或部署行为；未执行生产部署。

## 2026-11-01 协议运行事实旁路接入

- **重构 / 优化：** 在 `handle-protocol` 现有 failover 入口记录 `RequestFacts`、有界 `RetryBudget`、`AttemptFacts` 和单向 `DeliveryCommit`。事实层通过现有 `applyAttempt`、`onSendState`、`onCommit` 回调接入，包含流式 keepalive 和非流式 Claude hop 的下游提交。
- **兼容与边界：** 不改变候选选择、重试次数、SSE/WS 输出、错误码、正文重放规则、usage/settlement 算法或数据库字段；未改 Images、Search、Codex 和 Responses WS 独立入口。原 handler 的 request log、billing 和 runner 状态仍为权威执行路径。
- **验证：** Node v24.22.1/macOS；协议零重试/零用量、出站日志和相关 15 项回归通过，Node 语法检查与 `git diff --check` 通过。未执行真实上游推理或生产部署。

## 2026-11-01 执行上下文与代理绑定事实收敛

- **重构 / 优化：** `execution-context.mjs` 新增不可变 `createExecutionContext`，PoolScheduler 的 per-attempt execution context 构造已迁移；新增 `proxy-binding.mjs` 输出脱敏的 VM/代理绑定事实，供 transport、VM 和测试 adapter 共用。
- **兼容与边界：** 保留原 `vmJsonPath`、`vmCliHomePath`、slot credential 优先级和所有运行字段；未改变 Docker/KVM、透明出口、guest payload、代理协议或 OAuth 凭据。代理事实不包含用户名、密码或其他秘密。
- **验证：** Node v24.22.1/macOS；execution context、proxy binding、pool routing 和 Codex scheduling 共 15 项回归通过，Biome 与语法检查通过。未执行 Linux/KVM 或生产验收。

## 2026-11-01 VM fleet command route seam

- **重构 / 优化：** 将 `/api/panel/vms/fleet-update` 与 `/api/panel/vms/reconcile-fingerprints` 抽到 `panel-vm-command-routes.mjs`；写入内容、routing 注入、body 限制和 `{ ok, data }` envelope 保持不变。启动、停止、重置及 credential 操作继续留在聚合 handler，等待各自运行时边界核对。
- **验证：** Node v24.22.1/macOS；VM command factory 和 panel route coverage 5 项通过，Biome、语法和 `git diff --check` 通过。未执行真实 fleet roll、Docker/KVM 或生产部署。

## 2026-11-01 OAuth execution context seam

- **重构 / 优化：** 新增 `oauth-execution-context.mjs`，账号资料刷新使用统一的 `CredentialFacts`、VM 标识和脱敏 `ProxyBinding`；profile 调用仍通过原 slot worker 和原凭据权限判断。
- **兼容与边界：** 不改变 token exchange、guest payload、代理协议、OAuth 权限规则、VM 文件字段或真实凭据；上下文只作为 adapter/test seam。
- **验证：** Node v24.22.1/macOS；OAuth execution context 单测、账号资料、credential facts 和 guest readiness 回归通过，未执行真实 OAuth 换票或生产部署。

## 2026-11-01 Release contract facade

- **重构 / 优化：** 新增 `scripts/release/release_contracts.py`，集中表达上游版本、X.Y.Z.N 定制版本、release tag 和“单一上游父提交”输入契约，供 release planning/publish/guard 后续逐步复用。
- **兼容与边界：** 本批将版本/tag 校验 facade 接入 `plan.py` 与 `publish.py`，没有改变 workflow 触发条件、同版本不发版规则、payload SHA/version guard、guest/KVM 顺序、镜像 tag 或生产部署权限。
- **验证：** Python release contract 单测通过；未执行 GitHub Release、镜像发布或生产部署。

## 2026-11-01 Transport health projection

- **重构 / 优化：** 新增 `src/lib/transport/transport-health.mjs`，统一 transport health 的 status、reachable、process_up、healthy 和 ready 投影；缺失证据保持 `null`。
- **兼容与边界：** 仅提供只读 adapter/test seam，未修改 kernel client、Docker/KVM、guest payload、网络协议或生产运行状态。
- **验证：** Node v24.22.1/macOS；transport health、执行上下文、OAuth execution context 和调度相关 8 项回归通过。

## 2026-11-01 VM lifecycle route seam

- **重构 / 优化：** 新增 `panel-vm-lifecycle-routes.mjs`，承接 `/api/panel/vms/:id/start`、`recover`、`stop`；保留供应商启动分支、powerOnSlot/recoverSlot/stopSlot、调度状态写入、公开 VM/boot/runtime/kernel envelope 和原 URL/状态码。
- **清理与边界：** 从 `panel-routes.mjs` 删除对应重复执行路径，其他 VM 写操作继续保留在聚合路由；未修改 Docker/KVM、guest payload、代理网络或真实运行时协议。
- **验证：** Node v24.22.1/macOS；lifecycle factory、panel route coverage、slot-recovery、runtime-state 和相关 VM 回归通过；未执行真实 VM 启停或生产部署。

## 2026-11-01 Usage log query adapter

- **重构 / 优化：** 新增 `panel-usage-query-service.mjs`，将 usage-logs 的 keyset 列表、排名、汇总、筛选项、会话建议、活动会话和导出读取统一到 query adapter，`panel-routes` 已迁移真实调用方。
- **兼容与边界：** 保持 `UsageLogsView` 的 SQL、分页游标、租户 owner filter、未知值和返回 DTO；未修改 usage_logs schema、计费、结算或日志清理策略。
- **验证：** Node v24.22.1/macOS；panel usage adapter、panel route coverage、UsageLogsView 和 RequestLog 共 77 项回归通过。

## 2026-11-01 VM diagnosis route seam

- **重构 / 优化：** 将 `GET /api/panel/vms/:id/diagnose` 抽到 `panel-vm-diagnose-routes.mjs`，继续调用 `diagnoseSlotServices`，保留租户与超管的错误/日志脱敏边界。
- **兼容与边界：** URL、状态码、诊断 DTO、watchdog 注入和权限分支不变；删除聚合 handler 中的重复路径，未修改 VM runtime、Docker/KVM 或 guest payload。
- **验证：** Node v24.22.1/macOS；diagnosis factory、route coverage 和 slot-recovery 相关回归通过。

## 2026-11-01 VM probe route seam

- **重构 / 优化：** 将 `/api/panel/vms/:id/probe` 与 `/api/panel/vms/:id/exit-probe` 抽到 `panel-vm-probe-routes.mjs`，保留 `buildProbeOne`、真实出口 geo probe、代理/节点选择和失败状态映射。
- **兼容与边界：** URL、状态码、probe DTO、无代理/节点出口行为保持；删除聚合 handler 中的重复路径，未修改探测协议或网络运行时。
- **验证：** Node v24.22.1/macOS；probe factory、exit-probe、probe status 和 panel route coverage 8 项回归通过。

## 2026-11-01 VM quota/reset route seam

- **重构 / 优化：** 新增 `panel-vm-quota-routes.mjs`，承接 OpenAI quota refresh/reset 和 Claude reset query/redeem 路由；保留原 quota persistence、reset credit、idempotency-key、错误映射与公开响应。
- **兼容与边界：** 删除聚合 handler 中的重复执行路径，未修改 quota 算法、供应商结算、账户池或外部平台协议。
- **验证：** Node v24.22.1/macOS；quota/reset、panel route coverage 和 quota persistence 共 41 项回归通过。

## 2026-11-01 Frontend feature model facade

- **重构 / 优化：** 新增 `features/vm/model.ts`、`features/logs/model.ts` 和 `features/vendor/model.ts`，统一 VM display/runtime/schedulable、日志状态/未知费用和供应商 portal model 入口；VM 列表与供应商账号工作台已迁移真实调用方。
- **兼容与边界：** 保持现有 DTO、未知费用 `null` 语义、VM 名称规则、供应商表格字段和 query key；未修改后端 API 或缓存结构。
- **验证：** Web Vitest 2 项和 TypeScript 检查通过。

## 2026-11-01 前端 Panel Query Key 基础收敛

- **重构 / 优化：** 新增 `web/src/lib/query-keys.ts`，统一 panel dashboard、usage、API Key、API endpoint 的 React Query key 生成；迁移现有查询函数，key 数组内容和缓存命中关系保持不变。
- **验证：** Node v24.22.1/macOS；Vitest query-key 回归和 Web TypeScript 检查通过。未改变 URL、接口、UI 或生产缓存数据。

## 2026-11-01 补齐事实层基础 facade 与凭据事实接入

- **重构 / 优化：** 新增 `UsageFacts`、`QuotaWindowProjection`、`SettlementSnapshot`、`RequestFacts`、`AttemptFacts`、`DeliveryCommit`、`RetryBudget` 和 `CredentialFacts` 纯模块，统一未知值、发送状态单向推进、下游提交终态、配额窗口和凭据能力表达。
- **调用方接入：** `usage-evidence` 新增 canonical facts 读取方法并保留原 snapshot 契约；账号资料刷新改用 `CredentialFacts` 判断 profile/refresh 能力，保留旧 OAuth 缺 scope 兼容和 inference-only/API Key 拒绝规则。
- **边界：** 未修改数据库 schema、迁移、HTTP DTO、结算算法、协议重试路径、token 交换、代理和生产配置；本批只增加纯 facade 与一个资料刷新调用方迁移。
- **验证：** Node v24.22.1/macOS；事实层、usage evidence、账号资料、OAuth readiness 相关回归通过，Biome 与 `git diff --check` 通过。未执行生产部署。

## 2026-11-01 面板备份管理路由渐进式拆分

- **重构 / 优化：** 将 `/api/panel/backups` 的列表、手动创建、计划配置、下载、恢复和删除处理抽到 `src/lib/admin/panel-backup-routes.mjs`，`panel-routes.mjs` 继续负责认证、能力门禁和聚合分发。
- **兼容与边界：** 保持备份文件下载头、SHA256、恢复确认、在途请求保护、恢复错误映射、计划字段和所有 URL/状态码不变；未修改备份格式、数据库、生产数据或其他任务的供应商文档。
- **新增 / 破坏性变更 / 升级：** 新增 1 个内部 route factory 和 1 个定向单测文件；无需配置、迁移或数据处理。
- **验证：** Node v24.22.1/macOS；备份 E2E 5/5、factory、路由覆盖和 Biome/diff 检查通过。未执行生产部署。

## 2026-11-01 面板 API Endpoint 路由渐进式拆分

- **重构 / 优化：** 将 `/api/panel/api-endpoints` 的列表、创建、修改、删除、模型发现以及 endpoint key 增删改处理抽到 `src/lib/admin/panel-api-endpoint-routes.mjs`，`panel-routes.mjs` 继续负责认证、能力门禁和聚合分发。
- **兼容与边界：** 保持 endpoint DTO 脱敏、代理解析、保存凭据校验、模型发现错误映射、`apiScheduler.reload`、事务边界、分组资源解绑和所有 URL/状态码不变。未新增公共 API、配置、迁移或持久化字段；未纳入其他任务正在修改的供应商文档。
- **新增 / 破坏性变更 / 升级：** 新增 1 个内部 route factory 和 1 个定向单测文件；部署代码后自动生效，无需配置或数据处理。
- **验证：** Node v24.22.1/macOS；API endpoint、endpoint credentials、Anthropic console、面板 ACL、路由覆盖和 factory 回归共 29 项通过；Biome 与 `git diff --check` 通过。未执行生产部署或真实供应商/付费推理。

## 2026-11-01 面板 API Key 路由渐进式拆分与兼容导出修复

- **重构 / 优化：** 将 `/api/panel/api-keys` 列表、创建、修改、连接信息、揭示、轮换、配额重置、删除和统计处理抽到 `src/lib/admin/panel-api-key-routes.mjs`，`panel-routes.mjs` 只保留认证、能力门禁和聚合分发。旧的 Key scope、字段白名单、owner 校验和账务/用量读取继续复用。
- **Bug 修复：** 补回 `pool-scheduler.mjs` 对 `formatPoolSelectionSummary` 与 `normalizePoolConfig` 的兼容导出。此前策略抽取后协议 handler 仍从旧路径导入摘要函数，导致网关启动时报 ESM named export 缺失；新增回归防止旧调用方再次失效。
- **兼容与边界：** API URL、状态码、响应字段、密钥明文/哈希、配额单位、轮换和删除语义、租户隔离、数据库事务边界均保持不变。未新增公共 API、配置、迁移或持久化字段。
- **验证：** Node v24.22.1/macOS；API Key route factory、路由覆盖、PoolScheduler 兼容导出和面板权限相关单测通过；API Key E2E 7/7 通过，Biome 与 `git diff --check` 通过。未执行生产部署或真实供应商/付费推理。

## 2026-11-01 面板用户管理路由渐进式拆分

- **重构 / 优化：** 将 `/api/panel/users` 的 GET、POST、PATCH、DELETE 处理抽到 `src/lib/admin/panel-user-routes.mjs`，由 `panel-routes.mjs` 继续负责认证、能力门禁和聚合分发。新 factory 复用原 `panelUsers`、供应商身份、事务、审计、会话撤销和响应适配，不移动业务逻辑。
- **兼容与边界：** 保持用户创建、供应商账号初始化、角色/状态修改、密码会话撤销、管理员作用域、删除归档、事务边界、状态码和 `{ ok, data }` 响应不变。静态 route coverage 已支持聚合路由和 domain factory 同时扫描；没有修改公共 API、数据库、迁移、供应商权限或前端行为。
- **新增 / 破坏性变更 / 升级：** 新增 1 个内部 route factory 和 1 个单测文件；配置、依赖、持久化字段和生产执行路径均为 0。部署代码后自动生效，无需配置或数据处理。
- **验证：** Node v24.22.1/macOS；面板用户 factory、路由覆盖、ACL、租户保护、用户仓储和供应商后台相关回归共 47 项通过；Biome 检查与 `git diff --check` 通过。未执行生产部署或真实供应商/付费推理。

## 2026-11-01 管理路由权限与资源作用域渐进式重构

- **重构 / 优化：** 将面板 HTTP 方法/路径授权矩阵抽到 `src/lib/admin/capability-policy.mjs`，将平台资源 owner scope 抽到 `src/lib/admin/resource-scope.mjs`，将 `panel-routes` 的公共依赖适配抽到 `src/lib/admin/route-context.mjs`。`panel-acl.mjs` 和 `resource-owner.mjs` 保留原导出作为兼容 facade，`panel-routes` 与 `pool-scheduler` 只迁移一个调用方到新模块。
- **兼容与边界：** 保持 `createPanelHandler` 构造签名、面板 URL、HTTP 状态码、响应 DTO、角色规则、资源归属、调度 owner scope、数据库和运行时配置不变；未改变 capability、供应商归属、计费、结算、迁移或生产数据。没有引入第二套长期执行路径，旧路径只承担兼容导出。
- **新增 / 破坏性变更 / 升级：** 新增 3 个内部模块和 3 个定向单测文件；公共 API、配置、依赖、迁移、持久化字段和前端行为均为 0。部署匹配代码后自动生效，无需配置或数据处理。
- **验证：** Node v24.22.1/macOS；新增 capability/resource-scope/route-context 单测及既有 panel ACL、租户保护、面板更新、调度策略和 JEV 面板回归共 40 项通过；Biome 格式/检查与 `git diff --check` 通过。未执行生产部署或真实供应商/付费推理。

## 2026-11-01 修复模型重定向后的不一致提示

- **问题修复：** 使用记录的模型审计现在始终比较客户端真实请求模型 `requested_model` 与上游真实响应模型 `response_model`。当客户端请求 `gpt-6-astra`、中间路由/计费模型为 `gpt-5.6-terra`、上游响应也是 `gpt-5.6-terra` 时，超管列表会显示请求模型、第二行“上游响应：gpt-5.6-terra”和橙色“模型不一致”。
- **原因：** 前端此前把计费/生效模型作为响应比较基准；模型被重定向后，出站模型与上游响应相同，掩盖了客户端请求与实际响应之间的差异。后端已有 `model_mismatch` 字段继续作为权威判断，未改动计费模型、价格和结算口径。
- **兼容与范围：** 普通用户、管理员和全屏列表继续隐藏内部上游响应模型；缺少真实响应模型的历史 Codex 记录不推测补写，也不显示虚假的不一致提示。无新增接口、配置、迁移或生产数据处理。
- **验证：** 新增“请求模型与计费模型不同但响应等于计费模型”的后端回归；日志前端 39 项、请求日志后端 57 项通过，TypeScript、Prettier 和 diff 检查通过。未部署生产。

## 2026-11-01 修复账号池刷新订阅资料置灰

- **Bug 修复：** 账号列表之前只用 `has_access` 判断是否可刷新；闲置 OAuth 账号的 access token 保存在槽内 worker，`vm.json` 常只保留 `has_refresh`，因此“刷新订阅资料”错误置灰。现在只要存在 access 或 refresh 凭证且不是明确不支持的凭证类型，就允许进入槽内 profile 请求，由 worker 负责必要的换票。
- **安全边界：** 明确 inference-only、官方 Setup Token、Console API Key、Codex 和无凭证账号仍不可刷新；旧 OAuth 缺少 scope 镜像的兼容判断继续保留。查询失败、权限拒绝和身份不一致仍保留旧资料，不绕过供应商归属或后端权限。
- **上游取舍 / 升级：** 保持当前上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`，只修正凭证存在性判断并补齐 VM summary、refresh-only 回归。无需配置、迁移、前端资源或生产数据处理，部署控制面后自动生效。
- **验证：** Node 24.22.1/macOS 账号资料相关 63 项测试通过（新增 refresh-only summary 回归）；diff 检查通过。未使用生产凭证，未部署生产。

## 2026-11-01 修复历史 OAuth 账号订阅资料刷新置灰

- **Bug 修复：** 历史 OAuth 记录可能没有把 scope 镜像到 `vm.json`，账号列表因此错误地将“刷新订阅资料”置灰。对缺少 scope 的普通 Claude OAuth 记录，恢复可刷新能力，让槽内 profile 请求作为最终权限判断；明确的 inference-only Setup Token、官方 Setup Token、Console API Key 和无凭证账号继续禁用。
- **安全边界：** 未扩大明确标记为 inference-only 或 API Key 的权限；只兼容旧记录缺失 scope 的数据契约，真实 profile 请求失败仍保留原快照并提示失败。新增回归覆盖旧 OAuth 记录可刷新路径。
- **上游取舍 / 升级：** 保持当前已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`，只补兼容判断与测试；无需配置、迁移、前端资源或生产数据处理，部署控制面后自动生效。
- **验证：** Node 24.22.1/macOS 相关账号资料、凭证、身份和供应商视图测试 62 项通过；diff 检查通过。未使用生产凭证，未部署生产。

## 2026-11-01 供应商用量与缓存统计统一

- **新增 / 优化：** 供应商 `/vendor/usage` 和运营端 `/suppliers/usage` 的汇总与每日表共用七项展示：请求数、输入 Token、输出 Token、缓存读、缓存写、缓存命中率、消耗。供应商新增按账号明细，运营端账号/模型行补齐相同指标。四项 Token 数字复用现有 K/M/B 步进显示，悬停保留完整值及缺失下限标记，请求数、百分比和费用格式保持；统一显示费用精度。修正供应商默认近 7 天实际请求与日期选择器误显示“全部历史”的不一致。
- **Bug 修复：** 运营端复用供应商请求投影和汇总表达式，纳入失败及未定价请求数；失败不计消耗，未定价成功请求将消耗标为未知。两端沿用已交付 UTC+8 日期口径；同供应商、范围、截止时刻的每日指标一致。缓存读取与写入分别保留已知数据，缺失一个字段不再隐藏另一字段；不完整合计标为 ≥，完全缺失为 —，不制造 0。缓存命中率按整体缓存读 /（输入 + 缓存读 + 缓存写）计算，记录不完整时保持未知。
- **持久化与升级：** 新增迁移 `075_vendor_usage_cache.sql`，为 `vendor_usage_facts` 增加两个可空缓存 Token 字段；仅从尚存 `usage_logs` 回填。以后记录事实时同步保存读写数，详细日志清理后仍可读取。部署匹配的前后端并执行正常启动迁移后生效；已删除且无缓存依据的历史无法恢复。此次未连接或迁移生产数据库，未部署生产。
- **清理与上游取舍：** 删除运营端独立的仅成功已定价统计投影、重复未定价查询以及整块缓存隐藏分支；复用现有供应商统计和共享 UI，账务定价模块与已出具账单保持原契约。沿用官方基线 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`；该基线没有供应商两端统计/权限契约，保留用户要求的最小供应商扩展，待上游提供等价契约后收敛。本次不附带同步上游。
- **接口 / 兼容：** 新 API、配置、依赖、表均为 0；新增 1 项迁移、2 个持久化字段、2 个字段完整性计数及 1 个授权范围内账号聚合读取。既有接口增量返回 `account_usage` 和缓存指标；运营端 `cost_usd` 在未定价时允许 null，请求数从仅可计费成功改为与供应商端一致的全部请求，这是明确的统计语义调整。未修改计费、结算价格或生产数据。
- **验证：** Node 22.23.3/macOS：供应商管理/审计 22 项单测通过（同时修复这两份既有 fixture 缺少授权分组的问题）；真实 HTTP/SQLite 定向回归 1 项通过，覆盖两端七项指标、UTC+8 午夜、当日动态截止、历史结束日和供应商禁止访问运营接口。真实 SQLite 升级、已有值回填、缺失历史、重复迁移及日志清理回归通过；前端定向 19 项测试及 TypeScript 检查通过。浏览器使用隔离示例数据检查布局，不代表生产数据验收。同版本推送不自动发版。

## 2026-11-01 欢迎页真实管理员截图与控制台入口修复

- **Bug 修复：** 已登录的欢迎页按钮原先固定进入 `/overview`；供应商身份没有该视图，权限回退又返回 `/welcome`，形成入口循环。顶部、首屏和底部三个入口统一使用现有 `/` 身份分流：超级管理员进入总览、管理员进入用户管理、用户进入密钥、供应商进入供应商门户；未登录继续进入 `/login`，失效会话沿用既有清理和登录重定向。
- **优化改进：** 按用户要求，以本项目真实管理员登录后的用量统计、使用记录和 API 密钥管理页面生成三组深浅截图，共 6 张 JPEG、521,438 字节。截图来自隔离本地实例、管理员角色和演示数据；保留真实菜单、筛选器、图表及表格，不包含生产账户数据。页签随全站主题选择截图，支持打开原图，图片说明和无障碍名称覆盖四语。
- **清理与上游取舍：** 删除上一轮手绘示例图表、指标、日志表、密钥卡片、专属常量/格式函数和四语各 11 个失效键；三页签改用实际页面名称。保持已交付上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030），直接采用项目现有身份入口、Tabs/Badge 和主题能力，不另建权限或路由方案；保留用户明确要求的欢迎页结构、四语和真实截图差异，上游提供等效展示后收敛。保留交付期间独立的图像 API、代理编辑及 UTC+8 时间调整。
- **新增功能 / 破坏性变更：** 无独立业务新增或破坏性变更；新增 API、配置、依赖、持久化字段、迁移和后端执行路径均为 0。新增 1 个入口回归测试文件，覆盖未登录及四种角色、三个按钮和现有默认页分流；静态图代替示例组件，不读取访客的账务数据。
- **验证：** Node 24.22.1/macOS；入口、会话和国际化 4 文件/34 项测试通过，修改文件 ESLint/Prettier、TypeScript、`vite build --base=/console/` 和 diff 检查通过。Chrome 实测未登录→登录、管理员→用户、供应商→账号池及失效会话→登录；供应商复现使用真实本地账号。截图深浅切换、三页签、原图打开和 390px 无横向溢出通过；入口正常场景未捕获浏览器错误。隔离演示用量不代表生产消费，未执行真实推理。
- **升级与限制：** 部署包含本轮修改的前端后生效，无需配置或数据库迁移。线上只读复现原入口回跳并确认现有 `/console/#/` 可进入当前角色页面；本轮同版本代码交付，不发版、不部署生产。前一节欢迎页历史记录中的手绘示例方案由本节真实截图替代。

## 2026-11-01 统一供应商与运营后台代理编辑

- **Bug 修复 / 优化：** 供应商平台 `/vendor/proxies` 与运营后台供应商平台 `/suppliers/proxies` 共用代理名称、地址与提示字段，统一编辑弹窗宽度、说明和“保存”按钮。编辑地址默认为空，空白更新仅提交名称，保留现有地址与认证；填写完整地址才替换配置。新增代理继续要求地址。
- **清理：** 删除供应商专用地址输入包装、脱敏地址回填及比较分支、重复表单和四语失效文案；共用现有 `proxyEditPayload`。打开新建弹窗时清除旧代理编辑状态，避免取消编辑后新建供应商误用代理 PATCH。账号选择代理的共享输入继续使用。
- **上游取舍：** 保持现有上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030），采用其 Dialog/Input 基础控件；上游尚无供应商平台编辑契约，本轮仅保留两端一致性所需共享字段与现有更新规则，上游覆盖该契约后收敛。
- **新增功能 / 破坏性变更 / 升级：** 无独立新增功能和破坏性变更；新增 API、配置、依赖、持久化字段、迁移、后端执行路径均为 0。部署后自动生效；未发版、未部署、未操作生产数据。
- **验证与限制：** Node 22.23.3/macOS：现有前端代理请求、门户与国际化 22 项测试、后端供应商 11 项测试通过（包含仅改名称保留完整认证地址）；TypeScript、修改文件 ESLint（保留入口既有 Fast Refresh 警告）、Prettier、diff 检查通过。Chrome 通过真实页面和本地模拟 API 检查两端编辑留空、保存文案、仅改名称请求、替换地址请求及新建必填，弹窗截图一致，未捕获浏览器错误；未验证生产保存或外部代理连通性。

## 2026-11-01 系统业务时间统一 UTC+8

- **需求与修复：** 按用户明确纠正，全系统业务日期与时钟采用 UTC+8（Asia/Shanghai），不再依赖浏览器、宿主时区或界面语言。供应商运营统计、供应商门户、统计页、日志概览与筛选、每天用量分桶使用相同日界；“今天”从 UTC+8 当天零点统计至查询时刻，刷新纳入新记录。替换上一轮供应商统计的 UTC 日界实现。
- **展示与输入：** 统一用户账单、套餐、Key、供应商结算、日志、数据库指标、代理到期、账号订阅、额度重置/恢复时刻等绝对时间展示；Key/套餐/代理到期及重新计价的无偏移表单输入按 UTC+8 转换，编辑已保存值保持真实时刻。快捷日期、日历今天标记、禁选未来、默认 7 天和跨月/闰日/跨年边界一致。供应商昨日/本月/上月查询使用服务端支持的自定义范围。面板新建定时测试默认 UTC+8。
- **结算和数据边界：** 新结算日期与供应商日桶统一 UTC+8，移除新建下游账单的自由时区输入；统计 `tz`/供应商 `timezone` 不再切换业务日。带偏移 ISO/epoch 继续表示同一真实时刻，不改历史日志、用量事实、已出具账单和金额，不启动迁移或重算。VM 指纹、代理/上游地域、滚动额度窗口及已有显式时区的定时任务保留原契约，不改宿主/生产机器时区。
- **上游取舍与清理：** 沿用官方基线 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）的日期控件和时区换算基础。上游允许浏览器/请求时区决定业务日，不能满足本轮固定 UTC+8 要求，保留共享业务时间常量/转换及必要调用点差异；上游支持同等固定口径后收敛。删除浏览器时区探测、报表任意时区兜底、供应商重复快捷日期算法和旧 UTC 提示/Key 文案键，保留独立 VM 时区工具。
- **新增 / 行为变化：** 无独立业务功能、新接口、配置开关、依赖、Schema 或迁移；替换现有展示/输入/报表路径。无偏移日期的业务含义及统计分桶改为 UTC+8，是本轮明确要求的行为变化；带时区时间戳、历史冻结账单和权限/金额计算保持。
- **验证：** Node 22.23.3/macOS；后端时间、统计、日志、供应商用量与真实 SQLite 回归 92 项通过，供应商真实 HTTP E2E 5 项通过。前端在 America/Los_Angeles 环境检查全量及受影响补测，覆盖 103 文件/814 项；旧本地时区/DST 固定预期改为明确 UTC+8 时刻后定向验证。TypeScript、修改文件 ESLint（0 错误，保留组件既有 Fast Refresh 警告）、Prettier/Biome、Vite 构建与 diff 检查通过。保留交付期间独立的图片 API 与代理编辑改动后，补验前端 16 项、供应商日期 HTTP 1 项及类型/构建通过。Chrome 使用 TZ=UTC 的隔离服务，确认 UTC 10 月 31 日 16 点后“今天”为 UTC+8 的 11 月 1 日、当日两条/5 USD，昨天一条/1 USD；这些是测试数据，未验收生产消费。
- **升级与限制：** 部署匹配前后端后生效，无需数据库迁移或历史数据处置。仍只统计已入库用量，原时区出具账单继续按冻结周期查询并由既有重叠保护约束新结算。本轮同版本代码交付，不发版、不部署生产。

## 2026-11-01 官方上游白名单与 API Key 图像模型

- **Bug 修复：** Claude 官方的新建/编辑空模型列表自动填入已启用的 Claude 白名单；OpenAI 默认列表同时读取文本与图像模型策略，“获取模型”不再过滤 GPT Image。关闭的模型不会作为默认项补入。自动生成且未编辑的草稿随官方类型切换，手动修改保持。
- **优化：** 两种官方上游提供“加入白名单模型”，按模型名/别名去重补齐，保护现有自定义别名、图像标记和思考参数。既有非空配置由用户点击补齐并保存，打开编辑框不会自动写数据库；自定义上游不自动补入。
- **新增能力：** `/v1/images/generations` 和 `/v1/images/edits` 的 API 分组接入现有 API scheduler/kernel，支持 JSON、现有 multipart→JSON 编辑转换及图像 SSE。只选择当前分组关联的 OpenAI 协议 endpoint，使用上游 Key/代理与模型映射，保留 429 冷却；错误、截断或取消不标记成功，不重试生成请求。复用当前授权、Key 并发/RPM、报价快照、实际用量扣费与幂等结算。
- **上游取舍与清理：** 保持上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030），不附带同步。该基线只有 VM/Codex Images 路径且过滤 GPT Image，无法满足本轮明确 API Key 需求；在上游解析器、multipart 转换、传输与调度之上增加最小 API 图像分支。删除本地 API Images 一律拒绝分支，并将 OpenAI 专用默认函数统一为平台白名单函数；将来上游提供等效能力时收敛该分支。VM 既有路径与有效回归保留。
- **接口/配置/数据：** 新增公共接口 0、配置项 0、后端执行分支 1；复用现有 Images URL 与模型表，无 schema/迁移、依赖或生产数据操作。破坏性变更：无。
- **升级与限制：** 部署匹配前后端后生效；已有 OpenAI 配置在编辑页点击“加入白名单模型”并保存，再确认 API 分组关联和模型白名单。代码交付不等于生产部署或真实付费推理验收；Responses 图像工具仍沿用已有路径，本轮不改变该路径。
- **验证：** 本轮定向 Node 回归、真实 SQLite + 本地模拟 kernel 的 multipart/授权撤销/余额一次扣费集成、前端默认模型与国际化测试、TypeScript、ESLint、格式与浏览器组件交互验证。同步更新 2 条与当前账务契约不符的旧 wallet_ledger 断言：改为验证 billing_charges 唯一、余额仅扣一次，并确认不产生已退役的消费流水；初始失败已在未修改主工作区复现。未调用真实供应商、未发版或部署。

## 2026-10-31 修复供应商用量统计今日范围

本节记录当时的 UTC 实现与验收；该日界方案已由 2026-11-01 的全系统 UTC+8 修订替换，现行行为以“2026-11-01 系统业务时间统一 UTC+8”一节为准。

- **Bug 修复：** `/suppliers/usage` 原先把日历选择的同一天作为接口开始、结束日期，触发半开区间校验错误；多日选择也漏掉结束当天。现在日历范围包含开始和结束日，历史结束日转换为次日 UTC 零点；选到今天时不固定结束时间，复用服务端在每次请求时取当前时间的原有逻辑。手动刷新和既有 15 秒刷新均能纳入新增的已记录用量，未来记录不计入。
- **日期与清理：** 默认近 7 天包含今天和此前 6 天，快捷日期按该报表已有 UTC 日桶计算，避免浏览器本地跨日与 UTC 日期不一致。删除把日历结束日原样用于请求的路径，合并日期选择状态，增加四语言用量专用说明；结算仍使用原来的 UTC 半开周期及原说明，不改变结算或供应商门户接口。
- **上游取舍：** 保持已交付上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030），沿用基于上游日期控件提取的共享选择器，不另建日历。该基线不包含供应商运营用量接口，无法满足已复现的范围转换需求，仅保留页面请求转换与回归；上游提供同等契约时收敛。
- **新增功能 / 破坏性变更：** 无独立业务新增、配置、接口、Schema、迁移或破坏性变更；仅修正既有前端请求路径，不改后端统计、结算、金额或权限计算。
- **验证：** Node 22.23.3/macOS 下相关日期与国际化 12 项前端测试通过，真实 HTTP/SQLite 回归 1 项通过；覆盖当日、昨天最后一毫秒、近 7/30 天、本月/上月、闰日、跨年、UTC 与本地跨日、跨午夜刷新、服务端查询截止、刷新新增记录及未来记录排除。原同日请求在 HTTP 回归中仍能复现 `invalid_period`，明确保持原接口半开语义。TypeScript、修改文件 ESLint/Prettier/Biome 与 diff 检查通过；Chrome 连接隔离真实服务确认默认 3 条/6 USD、今天 2 条/5 USD、昨天 1 条/1 USD，今天不再报错，未捕获浏览器错误。测试金额为本地夹具，不代表真实生产消费。
- **升级指南与限制：** 部署包含本次前端修复的版本后生效，无需配置、数据库迁移或历史数据处置。只能查询已记录入库的用量；本轮同版本代码推送，不发版、不部署生产。

## 2026-10-31 修复用户编辑中的下级供应商设置保存与回显

- **Bug 修复：** 用户编辑的 PATCH 原先忽略 `vendor_create_child`、`vendor_child_limit`，用户列表也没有返回这两个字段，导致提示成功后重新打开仍未勾选。现在写入既有供应商能力与数量上限，并从同一供应商记录回显；0 仍表示不限，关闭能力保留其他供应商权限。多成员绑定按主身份、创建顺序和 ID 确定读写对象，避免列表后续成员覆盖主身份。
- **权限与原子性：** 复用供应商后台 `updateAdminVendor` 的校验、审计与能力写入；用户资料、分组和供应商设置位于同一事务，无效布尔值/上限及二级供应商越级授权均拒绝并回滚。普通管理员仍不能修改供应商，停用登录账号仍可由超管调整供应商设置；没有有效供应商绑定时明确失败，不再假报成功。
- **上游取舍与清理：** 沿用已交付上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）的用户编辑入口；该基线不包含供应商权限契约，保留本轮已复现缺陷所需的最小读写差异，供应商校验继续共用现有实现。上游覆盖同等契约后收敛；没有新增兼容路径或废弃数据处置。
- **新增功能 / 破坏性变更：** 无独立功能或破坏性变更；新增接口、配置、表、迁移均为 0，现有 PATCH 补齐 1 个供应商设置写入分支，列表补齐已有表单字段及类型。
- **验证：** Node 22.23.3/macOS 下，新增两项真实 HTTP/SQLite 回归在修复前分别复现写入丢失与回显缺失；修复后用户、用户管理域、供应商平台相关单测和 HTTP E2E 共 43 项通过，包含启用/禁用、1/3/0 上限、数据库落盘、现有会话即时权限更新、独立字段修改、失败回滚、普通管理员拒绝、二级供应商拒绝和停用账号编辑。TypeScript、修改文件 Biome/Prettier/ESLint 与 diff 检查通过。额外的 `vendor-admin.test.mjs` 为 2 通过、11 失败；在修改前 `603b2548` 源码快照中同样为 2/13，失败均为既有 fixture 缺少授权分组，不作为本轮通过证据。未进行浏览器或生产验收。
- **升级指南与限制：** 部署包含本修复的控制面后生效，无需数据库迁移；此前被忽略的选择无法自动恢复，部署后需重新保存。此次仅同版本代码交付，不发版、不部署、不变更线上账号权限。

## 2026-10-31 欢迎页按原稿与项目规范统一

- **需求与范围：** 以用户提供的 `tapmodels-home/index.html` 为信息规划参考，优化 `/console/#/welcome`。保留首屏、四项优势、模型与费率、调用流程、团队管理、数据风控和 Agent 接入的原稿顺序；延续当前“模型服务”定位、四语、登录入口与按权限显示的首配清单。
- **样式与交互：** 欢迎页直接使用全站青绿主题、字体、圆角、Card/Button/Tabs 和模型厂商图标；统一固定导航、区块宽度/间距、标题断行、代码可读性和价格排版。320px 手机使用简短控制台标签，完整无障碍名称保留。API 示例采用现有 Tabs 的键盘操作，展示与复制共用同一份完整 curl；示例代码可在卡片内横向滚动。首配、用法选择和模块指南同步统一边距及完成状态色。
- **原稿融合与内容：** 补齐三步请求处理和六项风控说明；控制台展示替换为总览、使用记录、API Key 三个可切换的示例预览，展示数字为固定示例，不读取账户或账务接口。依原稿补回用量、费用、筛选、CSV 导出和密钥权限说明并覆盖四语。原稿的 Excel、24 小时停权和未落地条款/咨询链接没有作为新承诺发布；使用现有 CSV、可配置审计与“查看接入方式”区块入口，先前已删除的文档导航不恢复。既有参考模型及费率不变，本轮不作实时价格校验。
- **清理与保留：** 删除欢迎页专属黑白 token 作用域、蓝紫背景/卡片色、滚动收缩状态、手工协议色板及未使用揭示动画。删除三张旧后台截图（合计 1,667,871 字节），以原生示例组件代替，避免继续公开图内原始账户/IP/用量资料。独立登录页的中性主题和仍使用的入场动画保留，主题作用域明确改名 `login-theme`；未改变登录行为。该主题属于独立登录页需求，后续若统一登录页再移除。
- **上游取舍：** 保持已交付上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）；采用其全站主题与共享组件，清除对应欢迎页覆盖。上游欢迎页不包含本轮原稿的营销信息结构、品牌和四语内容，仅保留这些明确需求及接入/首配契约所需差异；上游提供等效结构与契约时继续收敛。不追赶上游，保留交付期间独立的账号订阅资料、运维入口移除等修改。
- **新增功能 / 破坏性变更：** 增加 1 个前端示例组件、3 个预览页签，替换旧截图展示路径；新增接口、配置、依赖、持久化字段、迁移和后端执行路径均为 0。无破坏性业务变更，未新增测试或数据处置。
- **验证：** Node 24.22.1/macOS 下国际化/Key/模型图标相关 105 项现有测试通过；合入独立更新后，国际化、Key 和侧栏相关 31 项通过（包含重叠项）。修改文件 ESLint、Prettier、TypeScript、`vite build --base=/console/` 与 diff 检查通过，保留既有大块体积提示。浏览器检查明暗主题、1440px 桌面、768px 平板、390px 手机、320px 英文、菜单锚点、两组页签、键盘切换、复制反馈及登录入口；最终构建 `/console/#/welcome` 可正常加载，无捕获的浏览器错误。未做生产登录、真实推理或登录后首配写入验收。
- **升级与限制：** 部署包含本次改动的前端后生效，无需配置或数据库迁移。本轮同版本推送只触发普通 CI，不发版、不部署生产；代码交付与线上生效分别报告。

## 2026-10-31 供应商门户样式与响应式统一

- **优化改进：** `/console/#/vendor` 的账号池、代理、供应商、用量和账单沿用控制台现有 Sidebar、Header、Main 与主题 token；统一标题、说明、按钮、边框、间距和表单焦点。账号概览保留实时指标并删除标题旁重复指标串，基础搜索、列表工具与展开筛选分层，表格增加行反馈与固定操作列边界；管理员共用账号工作台同步保持一致。
- **Bug 修复：** 收起侧栏后保留可点击图标、当前页和悬浮提示；移动端切换页面自动关闭菜单，菜单内保留当前供应商名称/层级。小屏操作与分页换行、统计栅格适配宽度，宽表保持区域滚动；代理“协议”表头复用现有四语公共文案，消除原始 protocol 键显示。
- **上游取舍与清理：** 保持上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030），采用其共享侧栏/页头/主内容布局基础，删除供应商自建固定侧栏、独立移动 Sheet、折叠状态和硬编码 teal 选中色，以及不可达的重复添加账号按钮。该基线没有供应商门户与能力过滤，保留本功能需要的页面菜单、供应商身份、品牌、四语、原退出回调和业务组件；上游提供同等供应商契约后可继续收敛。
- **新增功能 / 破坏性变更：** 无独立业务新增或破坏性变更；新增 API、配置、依赖、持久化字段、迁移和后端执行路径均为 0。继续使用共享侧栏既有浏览器折叠偏好，不新增存储键；默认概览/筛选展开、权限、账号调度、代理操作与账单结算契约保持。
- **验证：** 供应商账号组件、身份信息、门户模型、访问状态与国际化现有测试共 55 项通过，TypeScript、修改文件 ESLint/Prettier 与 diff 检查通过（ESLint 保留入口既有 Fast Refresh 警告）。合入交付期间新增的账号订阅信息与运营页面清理，补验受影响组件。Chrome 使用真实组件与隔离模拟数据检查五个页面、深浅主题、1024px 英文和 390px 手机布局、折叠菜单跳转、手机身份与抽屉关闭、搜索/清空/筛选折叠、代理弹窗；未执行真实账号变更、结算或生产验收。
- **升级指南与限制：** 部署匹配前端后生效，无需配置或数据处理。本轮同版本修改仅交付代码和 CI，不自动发版，未部署生产。

## 2026-10-31 账号订阅资料采集与展示

- **新增功能：** Claude 授权完成后通过槽内既有 `kin-worker oauth profile` 和账号绑定出口补采套餐、额度档位和订阅/计费渠道，即使邮箱、账号与组织标识已经完整也会采集；手动刷新 OAuth 后同步更新。账号池操作菜单新增“刷新订阅资料”，供应商与超级管理员共用实现，分别通过 `POST /api/vendor/accounts/:id/profile/refresh` 和 `POST /api/admin/vendors/accounts/:id/profile/refresh` 访问。成功采集存入既有 VM 元数据及数据库镜像，并记录 `subscription_updated_at`；列表轮询和普通模型请求只读缓存，不增加查询。
- **权限与失败边界：** 只有实际持有 `user:profile` 的 Claude OAuth/转换后 Setup Token 才请求资料；官方 inference-only Setup Token、Console API Key、权限未知及 GPT 不调用 Claude profile。手动操作复用供应商管理权限、账号归属和归档检查，成功写入审计；父供应商对仅可查看的子账号不能刷新。查询失败不使有效授权失败，手动刷新失败保留上次快照；响应写入前校验账号、组织及凭证版本，拒绝过期请求覆盖新授权。成功的新快照移除上游本次不再提供的旧字段。
- **界面与清理：** 四语分别展示实际取得的套餐、订阅渠道、授权方式和成功获取时间；已知渠道显示 Apple 内购、Google Play 或 Stripe 订阅，其余保留上游返回值。删除把 `billing_type` 标成“支付方式”的文案、调度默认/额度推断作为真实套餐的展示，以及从任意 JSON 文本猜套餐的路径。缺失字段直接省略，不显示“未获取”占位；订阅周期、银行卡和具体支付工具没有可靠数据来源，不采集、不使用、不展示，也不显示相关提示。不按 Apple 隐藏邮箱推断订阅渠道。修复 camelCase、嵌套 profile 和 organization 计费字段丢失，凭证镜像不再用旧/空套餐覆盖已采集的 profile；重新授权清除旧账号显示资料。调度分档及默认值沿用原实现。
- **上游取舍：** 保持已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）。采用其现有槽内 profile、凭证写入、VM 锁与原子持久化能力；保留 bootstrap 仅补身份的既有路径，不复制 HTTP/刷新令牌链路。当前上游未把完整 profile 保存并展示给供应商，保留本轮明确需求所需的采集、快照与界面差异；上游覆盖相同契约后收敛。
- **接口 / 配置 / 迁移：** 新增 2 个 POST 路径，共用 1 个资料刷新处理；新增 1 个元数据字段 `claude.subscription_updated_at` 和 1 个只读能力标志 `can_refresh_profile`，在既有授权、手动 OAuth 刷新和初装 profile 采集处复用同一保存逻辑。新增配置、依赖、SQL 迁移和 guest/KVM 源码均为 0；无破坏性接口变更，不处理生产数据。
- **限制与升级：** 当前已核实的授权/profile 数据未提供月付/年付、自动续费或具体支付工具，按本轮最终要求不使用或展示这些数据，不新增账单抓取或扩大授权；GPT 套餐继续来自既有 OAuth claims/账号元数据，无渠道信息时省略渠道。部署匹配的 Node 控制面和前端后生效；新授权自动采集，已有且具备权限的 Claude 账号在账号池操作菜单选择“刷新订阅资料”。无需数据库迁移或 guest 镜像重建。本次同版本交付只触发 CI，不自动发版，未部署生产。
- **验证：** Node 相关单测、供应商权限 E2E、前端组件/国际化、TypeScript、修改文件格式和 ESLint 检查通过。本地浏览器用真实组件与模拟响应验证已知/未知/GPT 展示、列表零额外查询、手动成功、失败保留资料及无权限禁用；未使用生产凭证，未做真实订阅账号探测。修正相关初装测试中早已被现行文案替代的“同步遥测”断言为“发布原生遥测策略”，没有改变遥测行为。

## 2026-10-31 移除独立运维监控

- **删除与清理：** 完整移除 /console/#/ops 页面、侧栏和欢迎页入口、路由与视图权限、四语专属资源，以及 GET /api/panel/ops、/api/panel/ops/audit、/api/panel/ops/migration。删除快照聚合、专属告警/时间线查询及唯一被其调用的 ApiScheduler.hasReadySupply；清理失效断言、菜单规划与累计功能说明。
- **上游取舍：** 保持已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）。该基线没有独立 /ops 功能，本轮按用户明确要求移除对应定制，继续采用上游总览、统计、日志与 VM 详情监控路径，不附带同步上游。
- **共享保留与数据：** 调度、API 轮询与冷却、定时任务、通知、请求日志及总览健康指标仍有独立调用方，保持原有行为。operation_audit 仍承载用户/分组/账务等操作记录；relay_migrations 仍用于启动迁移幂等。保留共享表和已应用历史迁移，不增删生产数据；不新增兼容页面、专属重定向或替代接口。
- **新增功能 / 优化 / Bug 修复：** 无新增业务功能或 Bug 修复；减少重复监控入口、十秒快照轮询和专属聚合。新增接口、配置、依赖、持久化字段、迁移和后端执行路径均为 0；移除 1 个前端路由与 3 个 API 路由。
- **破坏性变更 / 升级：** 旧页面书签不再匹配，沿用既有路由回退到角色默认页；超级管理员请求已删除接口返回 404；其他角色仍受既有 ACL 约束。部署匹配前后端后生效；本次同版本代码交付不发版、不部署，监控继续使用总览、统计、使用记录和 VM 详情。
- **验证：** 本轮 Node 24.22.1 下 20 项后端单测、37 项前端测试和 1 项真实 HTTP 集成测试通过，覆盖 API 调度、权限、搜索拒绝的总览 SLA、旧菜单能力及三个旧接口 404；TypeScript、Vite 生产构建、格式、语法、ESLint 与 diff 检查通过。隔离测试实例浏览器确认总览与菜单正常、旧 /ops 书签回退到总览，未捕获浏览器错误；不代表生产或真实推理验收。

## 2026-10-31 侧栏 Logo 显示优化与浏览器网站图标修复

- **优化改进：** 自定义 Logo 铺满 40px 圆角区域，侧栏收起时为 32px；保留原图比例，取消嵌套黑底与青色描边，统一品牌名称间距与省略。版本触发器收敛为 32px 高度和 12px 字号，保留版本详情与更新交互；默认 SVG 图标继续使用可读底色。
- **Bug 修复：** 已保存网站图标优先于 Logo，未设置时回退默认资源。现有 11 个图标路径（包括 `/favicon.ico`）直接读取同一份品牌设置，上传图片按实际 MIME 返回，支持 GET、HEAD、ETag/304 和缓存重新验证。HTML 使用规范网站图标入口，前端以随图片内容变化的同源地址替换原 data URL 更新方式，解决页面品牌与浏览器网站图标资源不一致。
- **清理与保留：** 删除旧侧栏装饰样式、重复静态图标声明和运行时 data URL 替换路径；内置图标作为未配置品牌的有效默认值保留。外部图片仍由浏览器加载，服务端不抓取第三方图片；内置图标引用避免自重定向。保留交付期间远端新增的登录入口等独立修改。
- **上游取舍：** 沿用已交付上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）的静态资源、侧栏与图标基础实现；该基线没有可配置品牌图片及其 favicon 入口，无法满足本轮已确认视觉方案和已复现资源不一致问题，仅保留对应最小差异。后续上游提供相同可配置图标契约时收敛；本轮不追赶上游。
- **新增功能 / 破坏性变更：** 无独立新增产品功能、破坏性接口变更；新增 API、配置、依赖、持久化字段和迁移均为 0。11 个既有图标路径增加同一品牌读取处理，包含上传图片响应、URL 重定向与缓存命中分支；其他请求继续原路由。
- **升级指南与限制：** 部署匹配 Node 与前端后自动生效，无需重传已保存图片。代码推送不等于线上图标已更新；旧浏览器历史建议仍需重新访问后实测。本轮同版本修改只触发 CI，不发版、不部署、不操作生产数据。
- **验证：** 侧栏版本既有测试 10 项、品牌与图标前端测试 7 项、图标/品牌/静态资源后端测试 9 项通过；修改文件格式、语法、ESLint（0 错误，保留 BrandingProvider 既有导出风格警告）、TypeScript 和 Vite 构建通过。真实组件预览核验深浅主题、40/32px 尺寸、长名称、收起与版本弹层；本地 HTTP 图标响应与已保存 34965 字节图片逐字节一致。Chrome 地址栏历史建议持久化未完成验收，不能作为生产已修复证据。合入当前远端后补跑受影响静态资源/图标回归，未重复全项目测试。


## 2026-10-31 日期范围选择采用上游组件

- **优化改进 / 上游取舍：** 保持已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）。抽取该基线日志页的范围选择器，采用原有 Button 变体、横向快捷项、双月 Calendar、选完即关闭和可选范围重置，供供应商/运营用量、两端账号池、日志、结算和账单复用；日志时分秒恢复为上游独立表单布局。
- **清理 / Bug 修复：** 删除范围选择专属侧栏、确认/取消栏、草稿同步、按钮颜色覆盖及页面尺寸差异，删除无调用方的四语日志确认文案；修复账号池清空日期仍保留旧筛选，多个按钮不再由单个 label 标注。独立单日期配置保持原行为。
- **最小必要差异：** 保留现行四语、全部历史、本月/上月、必填账期、日志秒精度和结束时间不含语义；必填账期不显示无效清空。当前 react-day-picker 的首次选择直接返回同日 from/to，上游按 to 关闭会中断跨日选择，因此仅保留起始日期状态，第二次点击提交完整区间，支持同日、反向选择及 Escape 放弃未完成选区。窄屏弹层按可用高度滚动。上游满足相同契约后移除对应适配。
- **新增功能 / 破坏性变更：** 无新增接口、配置、依赖、迁移或后端执行路径。范围选择取消单独确认步骤，筛选和查询仍遵守所在页面的既有应用时机。
- **验证：** 日历四语、日志日期/权限筛选、账号池、用量范围、日志国际化及资源覆盖共 41 项现有测试通过；TypeScript、修改文件 ESLint（0 错误，4 条既有 Fast Refresh 警告）、Prettier 和 diff 检查通过。本地浏览器以真实组件和模拟账号检查五种截图入口配置、明暗主题、窄屏、跨日/同日/反向选择、清空恢复账号、Escape、英文、秒级输入及周期平移；不代表生产验收。
- **升级指南与限制：** 部署包含本次源码的前端后自动生效，无需配置或数据处理。本次同版本代码交付不自动发版，未部署生产；远端 CI 状态另行报告。

## 2026-10-31 用户已选分组展示与换行

- **界面 / 修复：** 新建、编辑用户的分组授权选择框直接显示已选分组名称标签；多个标签超过一行自动换行并撑高选择框，单个超长名称也可换行。未选择时显示原占位文字，搜索、勾选与取消选择继续使用现有路径。
- **清理：** 四种语言及其单复数文案同步删除套餐权益说明；数量与未选择提示仅保留在框下说明中，替换框内的重复说明。没有删除或变更套餐授权、用户授权保存和历史数据处理逻辑。
- **上游取舍：** 保持已交付上游基线 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`（1.4.030）。该基线没有商业分组多选组件，无法满足本轮明确界面需求；复用现有 Button、Badge、Popover，仅保留分组名称和换行所需差异，后续上游提供等效交互时收敛。
- **新增功能 / 破坏性变更 / 升级：** 无新增接口、配置、存储字段、迁移或后端执行路径，无破坏性变更；替换既有选择框的展示分支。部署前端后自动生效，本轮不发版、不部署、不处理生产数据。
- **验证：** 相关组件与国际化既有测试 29 项、TypeScript、修改文件 Prettier、ESLint（0 错误，保留既有组件导出警告）通过；本地 Chromium 使用真实组件与模拟分组检查选择、搜索、取消选择、桌面/360px 窄屏多行与超长名称、明暗主题，无浏览器错误。本地界面检查不代表生产验收。

## 2026-10-31 使用记录紧凑筛选与三级角色规划

- **界面与清理：** 所有角色的使用记录移除活跃 Session 列表和全屏会话数，删除日志专属列表组件、查询/归一化、嵌套筛选卡片、重复快捷条和失效文案/测试。筛选常驻紧凑表单；输入先编辑，点击“查询”应用。统一日期控件保留时分秒，补全本月/上月快捷项；三个角色分别显示其可用条件，未知角色隐藏内部条件。
- **角色与数据：** 超管可筛选全站用户/Key、请求模型、分组、协议、路径、状态和错误，并提供上游账号、槽位、Session、模型不一致、重试和 Debug；管理员只在既有管理范围内筛选用户/Key及公共条件；用户只筛选本人记录和 Key，不显示用户选择/排行或内部条件。前端清理旧 URL 诊断条件，服务端解析对非超管忽略对应参数，Session 候选仅超管可调用。
- **修复与联动：** 修复管理员 Key 候选为空；分组候选改从可见日志快照提供，不再调用其无权访问的分组管理接口。旧日志按 billing_group_id / group_id 统一匹配，显式处理 SQLite 表达式类型。四个页签沿用同一筛选，错误导出保留 errors_only，排行刷新加入日志统一失效链，rank_by 避免覆盖个人 scope；重置和导出均保留个人范围。
- **保留依据 / 上游取舍：** 统计页仍在使用 active-sessions 接口、overview 会话统计和共享类型，故保留这些独立能力；不更改调度会话逻辑。保留原查询、导出、列选择、复制和详情框架；当前上游 8749e65c1c5536c22abb05a6d34f29f91c4da8ca 未满足本次三级角色和紧凑表单契约，补充最小相关差异。旧 scope=user/key 排行参数仍有现行接口调用，待调用方迁移后移除兼容；不追赶上游。
- **功能边界 / 升级：** 新增 0 个接口、0 个配置、0 个持久化字段和迁移。原 filter-options 新增 groups，ranking 新增独立 rank_by；新增角色条件清理和公共候选分支。非超管 Session 候选现在明确返回 403，其他内部筛选参数忽略。部署匹配前后端后生效；本轮未发版、部署或删除生产数据。参考图没有后端契约的计费类型/模式不生成假控件，导出继续 CSV/JSONL。
- **规划与验证：** 三级矩阵、候选边界、交互与验收用例已写入 RELAY_OPERATIONS.md 10.4。72 项日志前端测试、26 项直接相关后端单测、1 项真实 HTTP 集成测试，以及 TypeScript、ESLint、格式、语法和 diff 检查通过。本地浏览器使用真实页面、隔离账号和 HTTP/SQLite 数据验证三级角色、查询/重置、六个日期预设、错误和排行联动及全屏；不代表生产部署或真实推理验收。

## 2026-10-31 账号池配额窗口统一为虚拟机列表样式

- **优化改进：** 供应商平台与运营后台账号池共用虚拟机列表的配额行：5 小时、7 天、Fable 按顺序展示，使用同款细进度条、风险色、满额斜纹、等宽百分比和完整重置倒计时；列宽至少 300px。悬浮倒计时可查看具体重置时刻，过期窗口显示“已过重置”，未知配额保留“—”，未知重置时间留空。
- **共享与清理：** 导出现有配额行供两处复用，删除账号池专属短进度条和 shortReset 日期格式化函数；整页复用既有 30 秒时钟，不为每行启动计时器。账号配额数据列表统一为 5 小时 → 7 天 → Fable，详情侧栏顺序随之统一；仍有调用方的详情重置时间提示和概览统计继续保留。
- **上游取舍：** 保持已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`，采用其虚拟机窗口行与 UsageMeter 展示方案，清理被替代的账号池实现。供应商遥测投影与 VM 数据结构不同，仅保留必要字段映射和账号表格列宽；后续上游提供相同供应商投影组件时可移除此映射。沿用现有四语言和完整倒计时修复。
- **新增功能 / Bug 修复 / 破坏性变更：** 本轮为展示统一，无新增接口、配置、依赖、持久化字段、迁移或后端业务执行路径，无破坏性变更。保留原账号权限、调度、额度统计和费用口径，不增加配额查询或重置操作。
- **升级指南与限制：** 部署对应前端后生效；同版本修改只触发 CI，不自动发版，本轮未部署生产或操作数据。
- **验证：** macOS / Node 24.22.1，账号池、供应商模型、VM 配额窗口和国际化现有测试 25 项通过，TypeScript、修改文件 ESLint/Prettier 与 diff 检查通过。浏览器以真实组件及模拟数据核验供应商/运营入口、明暗主题、正常/满额/零用量/未知值、Fable 和跨日倒计时；进度条实测宽度约 135px，具体重置时刻保留在悬浮提示。未进行生产账号或真实推理验收。


## 2026-10-31 修复直接访问登录地址返回 404

- **Bug 修复：** 浏览器直接访问 `/login`、`/console/login`、`/cc/login`（含末尾 `/`）时，GET/HEAD 以 `307` 和 `Cache-Control: no-store` 跳转到现有 `/console/#/login`；查询参数原样移入 hash 路由，保留登录后的回跳目标。
- **上游取舍与清理：** 沿用上游的 hash 路由、静态资源服务和登录会话机制。当前基线也没有这些路径入口，线上及修改前 HTTP 回归均复现 404，因此只增加一个精确匹配的登录入口分支；不引入第二套登录页、全路径 SPA 回退或新认证机制。上游提供等效入口后删除此定制分支及重复覆盖；现有 `/cc`、`/console` 入口和静态资源检查继续有效。
- **新增功能 / 优化 / 破坏性变更：** 无独立新增功能或破坏性变更；新增 3 个浏览器入口别名（各支持末尾斜线）、1 条跳转执行路径，新增 API、配置、依赖和数据库迁移均为 0。POST、API 鉴权、未知路径和缺失静态资源继续返回各自原有结果。
- **升级指南与限制：** 部署更新后的 Node 控制面后自动生效，无需修改 Nginx 或重建前端。部署前可使用 `/console/#/login`。本轮仅交付代码，未发版、部署生产、操作数据或验证生产账号登录。
- **验证：** macOS / Node 24.22.1，修改前 HTTP 回归复现 `404 != 307`；修改后静态资源单测与 HTTP E2E 共 10/10 通过，覆盖 GET/HEAD、跳转目标、参数与编码保留、HTML/缓存、旧入口、鉴权、POST、未知路径及缺失前端资源；修改文件语法、Biome 格式与 diff 检查通过。远端 CI 状态另行报告。

## 2026-10-31 代理操作统一为五项

- **优化改进：** 运营代理列表、运营端供应商代理管理和供应商门户按顺序展示“测试连接、质量检测、检测地区、编辑、删除”。地区检测直接调用现有单条接口；四语言名称与删除确认同步更新，窄屏操作栏允许换行。
- **Bug 修复：** 运营端供应商代理的单条质量检测原先将 `quality-check` 直接传给只接受 `quality` 的处理函数，返回 `invalid_proxy_action`。与供应商门户一致，在路由边界规范化操作名；HTTP 回归已先复现 400，再验证修复后成功。
- **清理与保留：** 删除运营代理行的更多菜单及专属导入/翻译、供应商代理行的启用/停用按钮与图标；运营代理展开详情中的复制地址、启用/停用、历史质量结果仍有独立用途，继续保留。供应商“删除”沿用归档接口、绑定保护、归属和权限检查，保留历史记录；不删除数据或改写迁移。
- **上游取舍：** 保持已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`。沿用上游代理探测、地区检测与编辑/删除调用链；上游没有供应商权限入口和本轮指定五项顺序，仅保留这部分最小界面定制及既有路由修复。未来上游满足相同交互与供应商契约时可收敛移除。
- **新增功能 / 破坏性变更 / 升级指南：** 无新增接口、配置、依赖、迁移或后端业务执行路径，无破坏性接口变更。部署匹配前后端后自动生效；本轮同版本修改只触发 CI，不发版、不部署生产。
- **验证：** 代理、供应商代理编辑、门户模型及国际化现有测试 52 项通过，TypeScript、修改文件格式/ESLint 和 diff 检查通过；ESLint 仅有供应商入口既有 Fast Refresh 警告。定向供应商代理 HTTP 回归通过，覆盖运营端三项检测、供应商单条/批量检测、编辑、归档和跨供应商拒绝。Chrome 使用真实组件与模拟列表验证三处五项顺序、点击路由、编辑弹窗、删除确认、明暗主题及窄屏；不代表真实公网代理质量或生产验收。

## 2026-10-31 累计上游审计问题修复与上游收敛

- **范围 / 新增功能：** 修复审计 A01–A12 与部署指南 A13；没有新增产品功能、公开接口、持久化字段、依赖或 SQL 迁移。保持已交付上游父提交 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca` 和 `VERSION=1.4.030`，保留供应商恢复/批量操作、响应模型记录、074 迁移及交付期间新增的代理五项操作等并行成果；本轮不追赶上游。
- **状态与调度（A01/A10）：** 清除代理 hold 只清除其拥有的状态，保留操作员同时设置的手动停调。恢复上游的全部合格账号等待集合，任一账号释放容量均可定向唤醒；保留票据防插队、取消/超时释放及商业准入。删除只等待一个账号的 queue 权重分支、参数、前端控件与四语标签；历史配置加载时丢弃该字段，新的保存请求携带它会返回 400。其余五项评分仍用于选号。
- **协议与日志（A03–A06/A11/A12）：** 恢复流式 envelope 及纯文本 413 的不可重试请求错误分类；EOF 无末尾换行的 SSE 终态进入同一观察器；使用上游共享 mergeUsage，空 trailer 不覆盖已知 token。Codex 两个入口透传实际 cfg 超时；Claude VM/API 路径补回首字节和生成耗时，JEV 阻断补回审查 state 日志。继续保留发送事实、完整用量证据、权限和一次结算契约。
- **遥测界面（A02/A08/A09）：** 初装设置保存只发送相对编辑基线的差量，后台刷新不覆盖未提交草稿；读取失败禁止保存，异步保存失败保留草稿。原生 JSON 上传日志显示批次、事件和失败数，过滤非契约字段并移除旧 sidecar/GrowthBook 解析、文案与状态键。区分已保存、已发布和槽内已确认；未确认关闭可单槽或批量重发同值策略，不再把“保存关闭”当成“已停止发送”。四语保持一致；初装表单的拒绝客户端设置/身份标签改为渲染时翻译，切换语言立即更新。
- **运行时密钥（A07）：** wrap-cli 与 fleet 同步脚本共用只读 API key 读取器，按显式环境、持久化 runtime-secrets、源码 .env 的顺序匹配控制面密钥；支持 KIN_DATA_DIR，读取不生成或改写秘密。损坏或非对象的持久化 JSON 失败关闭，错误信息不包含原文件内容。控制面自动生成密钥的安装方式可以完成现有同步流程。
- **采用上游与清理：** OAuth readiness 直接采用上游嵌套/扁平读取、外层错误与原生遥测就绪检查，删除缺少依据的额外内层检查及对应形状测试，保留透明出口代理契约。移除 requestTimeout=0，保留 Node 默认完整请求接收上限及独立无数据超时/408/499。可刷新过期凭证和瞬时代理/超时回到上游恢复路径，展示原因不再决定永久停调；条款拒绝仍需要人工处理。窗口估算恢复上游有效 reset、完整日志覆盖和至少 5% 样本条件，并补齐调用方输入；不增加主动额度探测。删除重复 proxy 地址规范化、首 token 计时及重复缓存测试，复用公共实现。
- **行为变化与历史数据：** 移除 queue 配置；不完整样本的窗口估算显示原因及未知值，不能继续输出看似精确的金额。超过 Node 完整请求接收上限的持续上传会被截止，这不是推理生成上限。历史已持久化的 oauth_expired/proxy_unavailable 停用记录不自动清空，须核实后使用既有恢复/重新授权；不批量启用账号，不清除历史日志或改写已应用迁移。
- **升级指南（A13）：** 必须部署本轮匹配的 Node 与 web/dist 后重启。该同版本推送仅触发代码检查，不自动生成新 Release；旧 v1.4.030 镜像不包含这些后续修复，需等待包含本轮源码的人工修订发布，或由已授权部署流程构建固定源码。payload、ARM64 pin、Go helper 均未改变；已完成当前资产升级的机器无需重复 fetch/sync。跨版本补齐按 [部署验收](DEPLOY.md#当前版本的资产与槽位验收) 分别验证镜像来源/digest、固定 kernel/CLI 和本版 helper 校验值，不能在缺 manifest 的运行镜像执行全 payload 检查或用上游 helper 覆盖定制构建。保留 routing.json、vms/、data/、.env 及全部持久化挂载；控制面重启会中断连接，槽位只在资产变化时同步重启。
- **验证与限制：** Node 22.23.3/macOS：协议定向 242 项通过，状态相关失败经授权夹具修正后补跑通过，日志裁剪覆盖 17 项、运行时原定向 61 项及新增密钥边界 14 项通过；后续共享读取器输入变化补跑相关 29 项通过。前端组件/日志定向 67 项、调度控件 2 项、估算展示 12 项和全局国际化 76 项通过，TypeScript/Vite 构建通过；最后翻译修正后相关前端 48 项通过。Chrome 使用真实 SeedPolicyCard 和隔离模拟数据验证主题差量保存、同值未确认重发、保存失败保留草稿及语言切换。使用本地 socket、隔离数据库与模拟组件数据；未执行真实 OAuth 换票、供应商推理、Docker/KVM/远程节点或生产验收。完整修复映射、修复前失败与修复后命令另存本轮审计整改记录，不以历史或全局 CI 代替边界回归。

## 2026-10-31 超管使用记录显示请求与真实响应模型

- **显示规则：** 超管“使用记录”的“计费模型”主行显示客户端请求模型；仅真实上游响应模型与请求模型不一致时，第二行显示橙色“↳ 上游响应：模型名”和“模型不一致”标签。相同或未记录响应模型时保持单行。普通/全屏列表一致；管理员、用户和未加载角色不显示内部响应模型。
- **数据修复：** Codex 的原 `upstream_model` 实际用于记录出站/计费模型。本轮从原始 Responses SSE 事件或最终响应体捕获 `response_model`，经普通日志持久化后映射至 `actualResponseModel`；保留既有出站模型、计费输入、价格快照和结算金额。非超管的普通、原始日志和导出投影均裁剪新增字段。
- **历史与清理：** 新增 074 迁移仅给 usage_logs 增加可空 response_model，不回填、改写历史或清理消费数据。历史 Codex 行没有真实响应证据时不拿请求/发送模型冒充响应，也不进入响应不一致筛选；非 Codex 既有写入方和存量行仍从原 upstream_model 响应字段读取，待全部写入方和保留期内记录迁移后可移除此回退。替换原无来源标签的差异模型副行，删除未记录提示的中间方案。
- **上游取舍：** 保持原上游 8749e65c1c5536c22abb05a6d34f29f91c4da8ca，沿用原日志表格、模型复制及重定向详情交互。上游未分别记录 Codex 响应 echo、也未提供本轮限定角色/不一致副行契约，因此仅补充对应采集、投影与渲染；未同步上游或修改 guest/KVM。
- **升级指南 / 破坏性变更：** 无破坏性接口变更。新增 0 个接口、0 个配置、1 个可空字段及 1 个增量迁移；新增响应采集与角色条件渲染分支。需部署匹配后端和前端，启动时执行既有迁移流程后，新请求才会记录真实响应。本轮未部署生产或执行生产迁移；历史未采集的响应不能追溯恢复。
- **验证：** macOS / Node 24：181 项相关后端测试通过（Codex 协议/故障/流式及非流式响应、持久化、DTO、计费金额保持、真实 SQLite 升级与幂等），48 项日志前端测试通过，TypeScript、修改文件格式/ESLint 与 diff 检查通过。修正两处既有数据库测试的迁移清单，包含已存在的 073 和新增 074。本地浏览器使用真实表格组件及模拟数据验证明暗主题、普通/全屏、管理员隔离和三种模型状态；不代表生产登录或真实上游推理验收。

## 2026-10-31 修复供应商重新启用异常并核验三个批量操作

- **Bug 修复：** 供应商暂停或停用产生的 `vendor_paused` / `vendor_disabled` 属于供应商状态派生值；四态迁移不再把它们写成永久的 `legacy_unknown`，账号再次启用后恢复真实调度状态。
- **清理与边界：** 现有状态派生和启动迁移只清理 `unschedulable.reason=legacy_unknown` 且 `detail.raw` 精确匹配上述两个原因的误写记录；真实凭证故障、其他未知异常、人工停调、维护和冷却继续保留。供应商仍处于暂停或停用时保持不可调度，数据库中的供应范围与归档限制仍由原运行策略校验。
- **批量暂停 / 恢复：** 删除根据列表旧状态反向切换的执行路径，单条和批量均向原 PATCH 接口明确提交 `paused` / `active`；即使列表状态已变化、目标已经是 active 或账号仍在准备中，也不把“恢复”变成“暂停”或跳过修正。按当前筛选范围内的跨页勾选逐条执行，每条请求仍重新校验供应商身份、权限、归属和归档状态；不宣称整批事务回滚。
- **批量反馈 / 选择：** 执行期间锁定状态操作、选择和筛选；逐条记录成功/失败，失败不阻断后续项目，成功项取消勾选、失败项保留，并展示具体错误。批次结束统一刷新，刷新失败另行提示；切换筛选/供应商或清空筛选会清除勾选，自动更新后已不在当前筛选内的账号不会被操作。父级可查看的子级账号仍不可选，超管可管理其授权范围内的不同供应商账号。
- **导出所选：** 保持当前列表摘要 CSV 契约，只导出 ID、名称、平台、展示状态、分组、当日/累计费用、创建时间；不导出授权凭据或代理认证，也不是可重新导入的账号备份。验证 UTF-8 BOM、逗号/引号/换行转义、跨页选择与未知值；补齐空白/控制字符开头的公式防护。
- **上游取舍：** 沿用当前上游 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca` 的四态模型和迁移入口；该基线没有供应商派生状态或这三个供应商批量操作，无法覆盖本轮已复现回归，因此保留现有供应商契约上的最小修正。后续上游覆盖相同契约时收敛；误写修复分支在全部受影响运行记录确认修复后可移除，不另建永久兼容入口。
- **新增功能 / 优化 / 破坏性变更：** 新增 0 个接口、0 个配置、0 个持久化字段、0 个 SQL 迁移；在原状态派生/迁移链补充原因排除和误写修复，替换前端反向切换和遇错静默中断流程，补充进度、失败汇总及 CSV 转义分支。无破坏性变更，无 guest/KVM 源码变化。
- **升级指南与限制：** 部署匹配控制面和前端并重启后，已有启动迁移会在备份原 VM 记录后修复上述误写；正常启停也会在原写入链修复。正常暂停账号仍需供应商主动启用；“状态更新成功”表示供给状态写入成功，不代表真实凭据/代理/内核已恢复。代码交付不代表生产已恢复；本轮不执行发版、生产部署或生产数据操作。
- **验证：** macOS / Node 24.22.1，修复前两项新增单测与供应商 HTTP 回归均复现；修复后调度状态、供应商权限、调度准入、冷却清除和槽位恢复共 76 项单测、供应商平台 4 项 HTTP E2E、前端操作/组件/模型/国际化 33 项测试通过，TypeScript、修改文件 Biome/Prettier、ESLint（0 错误，保留 vendor/index 原有组件导出警告）、语法和 diff 检查通过。本地 Chromium 对接真实本地 HTTP 接口完成跨页导出、暂停/恢复、筛选清选、执行锁、单项 403 注入后的部分成功、另一客户端改变状态、子级只读和运营跨供应商操作，共 11 项浏览器检查。隔离账号使用 mock 凭据和运行环境，不代表生产账号或真实推理验收。旧交付 `a0944772` 的 CI 已存在 database、oauth-binary、relay-operations 等失败；未把这些基线失败当成本轮通过证据。

## 2026-10-31 使用记录列按登录角色显示

- **显示规则：** 管理员、普通用户及尚未加载身份时隐藏“出站 Session”“供应商”两列表头和行内容，列菜单不提供这两项；超级管理员保留原作者的 Session 复制、供应商决策链及列显隐偏好。
- **全屏与清理：** 普通列表和全屏共用一套角色规则；全屏供应商开关仅超管可见。原有普通用户隐藏用户/IP 列的规则合并到同一处，删除页面重复判定；重置列设置不会解除角色限制，列数只统计当前角色可见项。
- **验证：** 角色渲染与日志相关测试 44/44、TypeScript、修改文件 ESLint/Prettier 通过。本地真实组件配模拟日志完成管理员/用户/超管切换、管理员全屏及列菜单验收。
- **范围与升级：** 无新增接口、配置、数据库变更或数据处置；仅调整列展示，服务端既有权限与数据范围不变。部署对应前端后生效；本轮未发版或部署生产。

## 2026-10-31 兼容 Claude 桌面端固定连接检测

- **Bug 修复：** Claude Desktop 4.4212.0 的自定义 Gateway「Inference」检测缺少 Claude Code 会话指纹，曾在开启“仅允许 Claude Code 家族请求”时被误导性地显示为凭据无效。按本轮用户确认，Anthropic Messages 入口放行仅含 `model`、`max_tokens: 1` 和单条 user `"."` 的精确检测请求。
- **准入与计费：** 这是固定请求形状例外，不是官方身份认证；持有效 Key 的其它客户端同样可触发。额外字段、不同正文、多轮、工具、其它预算和 OpenAI 格式入口不享受例外；普通推理保持原有家族校验。探测仍执行 Key、分组、模型、额度、并发和计费检查，走真实推理，不回放健康缓存，也不被最低输出配置扩大为更多 token。
- **上游取舍：** 沿用当前上游基线的官方家族判定；上游同样缺少这个桌面探测形状，无法满足本轮已复现并确认的需求，因此仅增加精确准入例外及预算保护。既有 count_tokens 入口撤除、商业鉴权和计费契约继续保留，不恢复废弃路径。
- **新增功能 / 优化 / 破坏性变更：** 新增 1 条固定探测准入分支；无新增接口、配置、持久化字段或数据库迁移。同步更新四语言设置提示与协议说明。兼容依据为本机桌面端程序包实际实现；该版本不再使用且官方检测具备原有指纹后可移除此例外。
- **升级指南与限制：** 部署匹配控制面和前端后重新执行桌面端连接测试，无需关闭严格准入或更换 Key。本轮仅交付代码，不执行生产部署、真实付费推理或数据处置；正常桌面会话仍须满足现有官方家族判定。
- **验证：** macOS / Node 24.22.1 下，Claude 准入 17 项、API 后端 33 项、健康探测 30 项、最低输出预算 7 项，共 87 项后端回归通过；设置与国际化 9 项测试、修改文件的 Biome / Prettier 格式和 diff 检查通过。覆盖固定探测放行、变体拒绝、Key/限流/分组限制、真实推理路径与一 token 预算；保留并复核原有 Claude Code、桌面会话和第三方拒绝用例。实际桌面端对生产服务的重测需部署后完成。

## 2026-10-31 同步交付流程改为上游优先

- **流程：** 功能重叠或冲突默认采用官方上游；等效且满足需求时收敛到上游，不因本地已实现、检查更严格或测试通过而保留原实现。必要例外限定为明确需求、已核实契约或可复现回归，保留最小差异并说明依据、范围及移除条件。
- **合并与交付：** 同次清理被替代实现及失效配置/测试；保留有效业务回归。AGENTS、交付规范与预检接续说明统一要求提交/推送前复核本轮累计差异，记录采用上游、必要融合或例外保留。单一定制提交、树一致性、完整备份与精确 lease 不变。
- **技能维护：** 本机 vm2api-sync-upstream 技能及 agents/openai.yaml 默认提示已同步；技能按当前主工作区规则解析 remote 和发版副作用，移除过时的 remote 名称和“非快进一律不发布”说明。本机技能不随 Git 仓库自动分发。
- **范围与验证：** 仅流程文档和技能变更，无业务功能、运行时修复、接口、配置、破坏性变更或部署升级步骤；保持已集成的上游父提交，不启动业务同步、发版、部署或数据操作。技能结构、agent 元数据、引用和 diff 检查通过，不重复业务测试。

## 2026-10-31 同步上游 v1.4.030（#837 / #838 / #840）

- **来源与范围：** 上游从 `7056c1a4477f8ba37ba2aec39f550fa05c9be1ca` 更新至 `8749e65c1c5536c22abb05a6d34f29f91c4da8ca`；以交付远端 `6b314cf074cdb5b8f8ec1c67e469a915f0516c55` 为本地基点，保留其全部定制。根 CHANGELOG 与新上游逐字一致，VERSION 为 `1.4.030`。
- **修复比较与冲突（审计后收敛）：** #837 直接采用上游嵌套/扁平健康读取及外层失败、跳过、遥测就绪判断；真实 wrapper 已传播内层失败，删除无生产依据的额外内层检查及只锁定其形状的测试。#838 的 keep-alive 120 秒、header 125 秒及 socket timeout=0 保持上游值；删除额外 requestTimeout=0，保留独立请求体无数据超时与 408/499 分类。
- **新增功能 / 优化 / 破坏性变更：** 无新增运行时功能、接口、配置、执行路径或数据库迁移。相对本轮旧交付提交，业务行为不变；版本、日志及回归覆盖更新，CI 暴露的既有格式问题一并规范化。
- **资产边界：** 本轮未改变 `deploy/payload.json` 或 ARM64 pin；payload 仍为 `payload-2026.10.29-telemetry-kernel`，cli-node 为 `8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b`。上游日志中的 plain `724a9439…` / UPX `ae120fa0…` 只是本机构建记录，未进入该清单，不能声称 fetch 或新镜像已经提供这份 auto-mode CLI。
- **升级指南：** 已完整部署当前 1.4.029 定制版本的机器，只需发布完成后更新控制面至 v1.4.030 并重启；本轮无 web/dist、Go helper、kernel、CLI 或远程槽位增量，不需专门 fetch、sync 或重建槽位。Docker 在原 Compose 项目目录沿用全部覆盖配置和挂载，执行 `TAPMODELS_IMAGE_TAG=v1.4.030 docker compose pull tapmodels`，再执行 `TAPMODELS_IMAGE_TAG=v1.4.030 docker compose up -d --no-deps --force-recreate tapmodels`。源码部署使用该版本源码和现有 Node 22 运行时重启原服务；无依赖变更，不需重复安装。ARM64 沿用原生构建流程和覆盖配置，不使用 amd64 正式镜像。
- **跨版本补齐：** 若此前未完成 1.4.026–1.4.028 或同版本定制升级，需同时部署匹配 web/dist、Go OAuth helper 和 kernel/CLI；源码目录先 `npm run fetch:payload`，控制面健康后执行 `node scripts/fleet-services.mjs`。Docker 新镜像已打包资产，按 [部署验收](DEPLOY.md#当前版本的资产与槽位验收) 分别核对 Release 来源、镜像 digest、固定 kernel/CLI 与本版 helper 校验值，再按需执行 `node /opt/tapmodels/scripts/fleet-services.mjs`；脚本先检测差异，只有变更才调用 wrap-cli/sync restart:true，再处理遥测及远程槽。核对 kernel_sync.ok、failed_count、各槽 skipped 原因和内核健康，不能只看版本号。保留 routing.json、vms/、data/、.env 与原持久化挂载；控制面重启会短暂中断连接。
- **CI 收口：** 首次全量 CI 在 6 个既有文件的 Biome 格式检查失败；仅规范化 panel-routes、usage-logs-view 及四个测试文件，保留行为。重新检查全部 744 个受管文件通过；Go、web 与商业契约首轮 CI 已通过，纯格式修正不重复本地业务验证。
- **清理与验证：** 不移除现有业务能力或处理生产数据。Node 22.23.3 下 OAuth 登录、真实启动封装、面板 OAuth 上下文、槽位 OAuth、请求体和 SSE 共 56 项回归通过；受影响文件格式、语法和 diff 检查通过。Linux kin-oauth-auth 二进制专项留给已有 Linux CI，本机未下载或运行 Linux payload；前端和 Go 输入未变，不重复构建。生产部署未执行。
- **发布边界：** 上游版本递增，按现行交付规则由 main push 触发 v1.4.030 应用、配套资产和全部 guest/KVM 自动发布；正式 Release 完成前，新镜像部署步骤须等待。发布状态与生产部署分别报告。

## 2026-10-31 修正供应商账号池暂停恢复开关

- **Bug 修复：** 账号池状态开关关闭后，供应商仍可再次打开暂停账号；开关只控制调度状态，不影响授权、VM、账号数据或历史用量。
- **状态边界：** 暂停账号允许恢复为正常；归档账号和上游异常/冷却账号仍按既定限制处理，不通过开关绕过授权或故障状态。
- **验证：** 新增暂停账号开关可恢复的前端回归测试；供应商平台 E2E、TypeScript、ESLint、Prettier 和生产构建按受影响范围复核。

## 2026-10-31 统一供应商暂停与运营 VM 调度开关

- **状态统一：** 供应商账号池关闭账号后，运营账号池同步显示暂停，对应 VM 调度开关显示关闭并锁定，避免出现开关绿色但状态灰色不可用的矛盾。
- **控制边界：** VM 开关悬浮提示引导由供应商账号池恢复；额度、冷却和维护等自动受限仍保持“调度开”但暂时不可用的既有语义。
- **验证：** 新增 `vendor_paused` 的 VM 开关回归测试，并复核供应商 E2E、组件测试、TypeScript、ESLint、Prettier 和生产构建。

## 2026-10-31 修正日志界面多语言检查失败

- **Bug 修复：** 日志全屏和虚拟列表中的新增可见文案统一接入四语资源，恢复语言切换、响应时间单位和日志列/提示的多语言显示。
- **验证：** 国际化覆盖测试 5 项、前端 96 个测试文件 / 738 项测试和 TypeScript 检查通过。

## 2026-10-31 恢复原作者日志展示方案

- **界面恢复：** 使用记录列表恢复“出站 Session”和“供应商”列，供应商列重新使用 `ProviderCell` 与 `ProviderChainPopover` 展示最终服务方、重试次数和决策链；不再用简单“账号”列替代供应商决策链。
- **交互恢复：** 供应商决策链仍可点击进入逻辑追踪，出站 Session 可复制；列显示设置恢复 `sessionId` 与 `provider` 两个原作者列。
- **数据兼容：** 后端继续按最终账号、尝试链账号和 VM 当前账号补齐账号归因；没有关联时才显示空值。
- **验证：** 相关前端 TypeScript、日志展示/查询测试和差异检查通过；未执行生产部署。

## 2026-10-31 供应商代理操作与运营后台统一

- **操作能力：** 供应商代理页的操作列与运营后台统一为测试连接、质量检测、检测地区、编辑和删除五项操作（删除沿用归档语义）；供应商操作仅作用于自己拥有的代理。
- **接口与权限：** 新增供应商代理操作路由，复用统一代理池和现有代理资源更新逻辑；跨供应商资源由后端拒绝，仍绑定账号的代理不能归档。
- **验证：** 供应商平台 E2E 4/4、前端 TypeScript、ESLint、Prettier 和 Vite 生产构建通过；未执行生产部署。

## 2026-10-31 供应商代理批量检测

- **界面与接口：** 供应商代理管理页增加批量测试连接、批量质量检测和批量检测地区，执行范围仅为当前供应商可见且未归档的代理；批量接口复用运营后台的检测逻辑和结果结构。
- **权限与验证：** 批量检测要求供应商具备代理管理权限，后端按供应商资源范围逐条执行并返回汇总结果；新增供应商平台代理批量操作 E2E 覆盖三项批量检测。

## 2026-10-31 修正 Logo 显示并移除网站副标题

- **界面修正：** 侧栏、登录页及其他品牌入口使用固定尺寸、居中且带安全溢出裁切的 Logo 容器，避免自定义 Logo 与品牌名称重叠或被裁切。
- **文案调整：** 网站可见品牌块移除副标题行，浏览器页面标题只保留品牌名称；保留后端品牌字段与设置接口兼容，避免已有配置读取失败。
- **验证：** 前端格式检查、TypeScript、品牌设置回归测试和 Vite 生产构建通过；本地登录页实际复核 Logo 对齐和副标题消失。全量 ESLint 仍有 11 个错误，与本次文件无关；未执行生产部署。

## 2026-10-31 供应商平台刷新移除权限校验中间卡片

- **界面修正：** 供应商平台刷新等待身份接口返回时，复用通用加载状态，不再显示“正在验证访问权限”权限校验卡片。
- **错误边界：** 401、403、网络不可用和身份读取错误仍按原有错误状态显示，不改变供应商权限校验、会话处理或接口调用。
- **验证：** 供应商访问状态组件测试、TypeScript、ESLint、Prettier 和 Vite 生产构建通过；未执行生产部署。

## 2026-10-31 修正账号池平台与状态列展示

- **表格修正：** 供应商账号池 `/#/vendor/accounts` 与运营后台 `/console/#/suppliers/accounts` 统一列顺序为“平台 → 状态 → 分组 …”，修复表头与行数据错位。
- **品牌展示：** 平台列按账号实际平台显示 Anthropic 或 OpenAI，并使用本地打包的品牌图标和对应标准色标签；不改变账号平台字段、调度状态或筛选语义。状态列继续保留调度开关，异常原因继续通过状态标签悬浮提示显示。
- **验证：** 账号池组件测试 18/18、TypeScript、ESLint、Prettier 和 Vite 生产构建通过；已生成本地预览图；未执行生产部署。

## 2026-10-31 供应商账号池增加平台列

- **界面修正：** `/#/vendor/accounts` 和 `/console/#/suppliers/accounts` 共用的账号池表格新增“平台”列，按账号配置显示 Claude 或 OpenAI。
- **交互范围：** 平台列默认显示，也纳入账号池的“列显示”设置；供应商与运营后台使用同一套字段和多语言文案。
- **验证：** 账号池组件、国际化覆盖、TypeScript、ESLint、Prettier 和 Vite 生产构建通过；未执行生产部署。

## 2026-10-31 API Key 分组名称展示统一

- **界面修正：** API Key 创建和编辑弹窗的“服务分组”选择项只显示分组名称，不再把计费倍率拼接到选项文本中；API Key 列表继续只显示分组名称。
- **运行边界：** 不修改分组倍率字段、计费逻辑、路由逻辑或后端接口；倍率仍由后端按原规则生效。
- **验证：** 前端 TypeScript、相关 API Key 国际化测试、Prettier 和生产构建通过；未执行生产部署。

## 2026-10-31 上游 OpenAI key 错误与系统模型默认值修复

- **Bug 修复：** 上游模型获取返回的 OpenAI 401 不再直接作为面板 401 返回，避免前端误清除管理员会话并跳回登录页；上游凭据失败现在显示为模型获取错误。
- **默认模型：** 新建或编辑官方上游且模型列表为空时，自动载入对应平台“模型”页面启用的系统白名单；OpenAI 同时包含启用的 GPT 图像模型，Claude 不依赖 VM 可用目录。已有模型可点“加入白名单模型”补齐，保留用户别名和草稿。
- **认证一致性：** OpenAI 官方上游表单和模型获取请求统一使用 `Authorization: Bearer`，不再提交错误的 `x-api-key` 方案。
- **破坏性变更 / 数据处置：** 无数据库迁移、配置项、权限变化或历史数据清理；已保存的 key、代理和模型仅在用户保存时按现有表单规则更新。
- **升级指南：** 部署控制面与 web 前端后自动生效；无额外迁移或生产数据操作。
- **验证：** 后端上游模型获取 401 回归通过；前端 95 个测试文件、731 项测试、TypeScript 检查、Prettier 检查和 Vite 生产构建通过。真实 OpenAI key、代理出口和生产部署未在本机执行。

## 2026-10-31 修正混合分组与账号分组提示

- **混合分组：** 运营后台平台为“混合”的分组同时支持 Anthropic 和 OpenAI 账号；模型白名单继续负责模型路由范围，不再错误地把混合分组从某个平台的账号分组目录中隐藏。
- **分组规则：** 供应商新建、编辑账号及运营后台代供应商创建账号必须明确选择至少一个授权分组；移除“未选择时使用系统默认分组”文案，后端空分组提交返回 `group_required`。
- **验证：** 更新混合分组平台判定、供应商账号表单提示和开户/编辑校验；未执行生产部署。

## 2026-10-31 修正超管代供应商账号的分组与授权方式

- **分组来源：** 运营后台为供应商代创建账号时，按所选供应商和平台读取后端可用授权分组；不再依赖全局分组目录与前端供应商摘要的重复推导。
- **平台联动：** 供应商分组范围与平台匹配由同一套 `availableAccountGroups` 规则提供，切换 Anthropic/OpenAI 后重新加载分组，后端提交仍执行范围校验。
- **授权方式：** 运营后台与供应商账号创建共用完整的平台授权方式集合，Anthropic 包含 OAuth、Setup Token、Console，OpenAI 包含 OAuth、账号文件。
- **验证：** 增加管理员分组目录接口回归与前端授权方式回归；未执行生产部署。

## 2026-10-31 超管代供应商创建账号的授权规则统一

- **供应商范围：** 超管在账号池创建供应商账号后，分组只显示所选供应商已授权且匹配当前平台的分组；平台变化会重新计算可选分组。
- **授权方式：** Anthropic 和 OpenAI 使用与供应商平台相同的平台授权方式集合，平台切换会同步重置授权方式，避免提交平台与授权方式不一致的数据。
- **兼容边界：** 分组目录缺少预计算平台字段时，前端按分组平台字段兜底判断；后端仍执行最终供应商授权范围校验。
- **验证：** 分组目录、平台匹配和多语言相关前端测试通过；未执行生产部署。

## 2026-10-31 供应商代理管理与运营平台统一

- **名称与内容：** 供应商平台导航统一使用“代理管理”，代理页按运营后台代理池工作台统一统计卡片、筛选卡片、表格容器、列顺序、字段密度和空状态，显示供应商、协议、代理地址、状态、延迟/质量、地区、绑定席位和操作。
- **筛选、分页与权限：** 供应商端固定展示当前供应商自己的代理，不显示供应商筛选和搜索框，仅保留协议/状态筛选；运营后台保留供应商和关键字筛选。两端统一使用分页 footer，支持每页 10/20/50/100 条及上一页/下一页。供应商仍只可操作自己拥有的代理，运营后台的跨供应商范围权限不下放。
- **数据边界：** 后端继续复用已存在的供应商代理池投影，前端不新增代理密钥或敏感认证信息回显。
- **验证：** 供应商与运营代理页 TypeScript、ESLint（无错误）、Prettier、国际化覆盖、相关前端测试和 Vite 生产构建通过；未执行生产部署。

## 2026-10-31 修正异常 VM 的列表分组筛选

- **Bug 修复：** 异常状态卡片统一显示“异常”后，保留吊销与其他失效凭证的内部语义分组；VM 列表、机架和筛选不再把已吊销槽位误归入“在池”。
- **CI 修复：** 同步整理本轮涉及的 6 个前端文件格式，避免 GitHub 在前端测试前因 Prettier 检查直接中止。
- **验证：** 覆盖机架分区、VM 列表筛选、多语言状态回归；前端 94 个测试文件、729 项测试、类型检查、格式检查和生产构建通过；不改变后端状态码、调度行为或凭证处理。

## 2026-10-31 GitHub Release 说明长度保护

- **发版修复：** GitHub Release Note 只展示最近 10 个定制版本条目；完整说明保留在本文件，Release 页面提供固定链接。即使文档继续增长，也不会因说明超过 GitHub 125,000 字符上限导致发布失败。
- **验证：** 最近 10 条筛选和长度边界回归通过；不改变镜像、资产、版本号或发布顺序。

## 2026-10-31 账号池与虚拟机异常状态展示统一

- **状态标签：** 供应商账号池和虚拟机列表把凭证异常、不可调度、代理不可用等异常统一显示为“异常”；正常、冷却、暂停、归档等状态保持原标签。
- **悬浮详情：** 运营后台 VM 列表和供应商账号池都使用悬浮提示显示安全的具体原因；冷却标签显示具体恢复时间；提示只显示原因，不重复添加“异常”等类型前缀；代理错误不回显代理地址、用户名或密码。
- **兼容：** 账号池继续保留后台稳定原因码；VM 吊销/失效继续使用内部 `revoke`/`bad` 分组键，其他不可调度状态继续使用原键，VM 调度和筛选逻辑保持一致。
- **验证：** 前端相关回归 68 项、TypeScript 和 Vite 生产构建通过。

## 2026-10-31 模型服务品牌文案与通俗错误提示

- **产品定位：** 欢迎页营销内容从“网关”改为“模型服务 / 模型服务平台”，统一说明模型接入、路由、计费、调度和隔离能力；同步更新简体中文、繁体中文、英文和日文。静态 HTML 首屏标题改为 `tapmodels · 管理台`，description 改为“tapmodels 模型服务平台管理台”，与运行时标题一致。
- **普通用户可见文案：** 数据库、导入、日志、模型、VM、API 错误和状态提示改为“平台”“服务端”“上游服务”等通俗说法，例如“网关错误”改为“上游服务错误”，“网关超时”改为“上游服务超时”，“Gateway rate limit exceeded”改为“Request rate limit exceeded”；出口网络缺失错误改为 `egress network route missing`。仅超级管理员可见的设置页和运维说明保留原有技术术语。
- **公开品牌入口：** README、npm 包描述、项目横幅和供应商平台产品定位同步改为“模型服务平台/模型平台”；镜像名、容器/二进制命名和部署技术说明保持不变。
- **清理范围：** 没有改动内部协议字段、错误码、网络网关地址、容器/二进制命名、模型目录函数名或设置页专用说明；这些是运行契约或超级管理员技术信息，不属于营销和普通用户提示。
- **验证：** 四语 JSON 解析、欢迎页文案检查、相关模型/错误单测、TypeScript、前端格式检查与生产构建通过；验证确认 settings 资源未修改。无新增接口、配置、依赖、迁移或数据操作。

## 2026-10-31 修正充值记录验收契约

- **CI 修复：** “账务”已按当前产品契约只展示充值/余额调整记录，`relay-operations.e2e.test.mjs` 不再要求账务列表包含 usage 流水，改为通过使用记录和 API Key 用量验证扣费结果。
- **测试环境：** 账务验收使用 mock VM，不需要真实 Docker 出口；测试 harness 对这组场景关闭 kernel watchdog，避免 GitHub runner 非 root 时尝试写 `iptables` 产生无关失败噪声。
- **范围：** 不改变计费、钱包扣款、使用记录或生产运行逻辑；只更新验收断言和测试隔离配置。

## 2026-10-31 集群节点预检按创建内存校验

- **Bug 修复：** 创建 VM 选择集群节点时，预检现在使用创建表单当前选择的单槽内存；修改内存规格会重新请求预检，避免 4G 节点始终按全局默认 `4g` 判断而误报不允许安装。
- **接口一致性：** 集群预检接口和 VM 创建接口使用同一内存规格，节点提示、提交校验和实际落盘配置保持一致；未传内存的旧调用继续回落到全局默认值。
- **范围与验证：** 无数据库迁移、权限变化、依赖或生产数据操作；执行后端语法、前端类型与格式检查。

## 2026-10-31 上游 auto-mode 提醒与槽位 helper payload 同步

- **行为修复：** 吸收上游 Claude Code 2.1.310 auto-mode 提醒收敛。网关把 harness 的 `Auto mode still active`、旧 sparse/六点全文折叠为一次官方完整提醒，删除 assistant 回声，不改官方正文；新增 `auto-mode-reminder.mjs` 并在 Messages 清洗前后调用，保留其它 system reminder。
- **资产：** 同一 payload release `payload-2026.10.29-telemetry-kernel` 新增 `kin-worker`（16455001，`d6b29f1144cd`）、`kin-egress`（9047621，`0bf1eeb0424f`）、`kin-slot-gate`（8120583，`78f78d59e4f6`）三项清单。cli-node 的本机新构建记录为 plain 118306944 / `724a94390a3c`，UPX 后 27932800 / `ae120fa09a61`；它不作为 Git 二进制提交，须通过 payload/镜像发布。
- **验证：** auto-mode-reminder、sanitize 及相关协议定向回归 18/18 通过，`git diff --check` 通过。实际 Linux payload 下载、UPX `--version` 和真实 Claude 请求由 CI/部署验收确认；本轮未执行生产推理或槽位更新。
- **升级：** 这是同一 1.4.029 版本内的 payload/Node 行为更新，不升 VERSION。发布新镜像后，在原 Compose 目录保留 `routing.json`、`vms/`、`data/`、`.env` 和挂载，执行 `TAPMODELS_IMAGE_TAG=v1.4.029 docker compose pull tapmodels`、`TAPMODELS_IMAGE_TAG=v1.4.029 docker compose up -d --no-deps --force-recreate tapmodels`；然后在控制面容器执行 `node /opt/tapmodels/scripts/fleet-services.mjs`，确认 `wrap-cli/sync` 与 fleet 更新成功。源码部署使用容器/项目内 Node，执行 `npm run fetch:payload` 后再执行该同步脚本；不能只更新 Node。payload tag 未变但新增三项 helper，必须重新 fetch/sync。ARM64 沿用现有覆盖配置重建；不执行数据库迁移。
- **边界：** 本轮为同版本修改，按当前规则只触发 CI，不触发新版自动 Release；已发布 v1.4.029 镜像若未包含本轮 payload，需等待带新资产的构建或使用同版本人工构建再部署。旧的 1.4.027 telemetry kernel 补齐要求仍然适用。

## 2026-10-31 供应商与运营平台统一账号故障状态

- **统一归因：** Claude 上游的 OAuth 吊销、组织不允许 OAuth、访问令牌过期、Consumer Terms/Privacy Policy 未接受，以及带代理出口的模型验证超时，统一归入稳定原因码：`oauth_revoked`、`organization_disabled`、`oauth_expired`、`terms_not_accepted`、`proxy_unavailable`。
- **运行行为：** 组织禁用和未接受条款沿各自规则暂停调度；可刷新令牌过期沿上游同账号刷新路径，泛化代理/超时文案不再单独触发永久停调。OAuth 吊销和不可恢复凭证继续使用上游凭证失效路径。状态展示与恢复决策分离；历史已保存停用记录需核实原因后通过既有恢复/重新授权操作解除。
- **安全边界：** 代理不可用只记录安全原因，不把代理 URL、用户名或密码投影到供应商接口；未知错误保留安全代码或通用状态。
- **文案：** 运营 VM 状态和供应商账号池新增“未接受条款”“代理不可用”，并补齐中、英、繁中、日文文案。
- **验证：** 后端上游错误策略、调度状态、供应商状态投影共 65 项通过；前端供应商状态、VM 状态和国际化共 66 项通过。

## 2026-10-31 请求体 300 秒超时拆分与错误归类

- **Bug 修复（审计后收敛）：** 保持 Node 默认 300 秒接收完整请求时限；它不是模型生成响应截止。请求体另外执行连续无数据超时，默认 `KIN_REQUEST_BODY_TIMEOUT_MS=120000`，允许 `0` 关闭这项空闲计时，最大 600000 毫秒；逐块接收会重置空闲计时，不会取消 Node 的总上传上限。模型首字节和流空闲继续使用独立配置。
- **错误归类：** 请求体停滞返回并记录 `408 request_timeout`；客户端主动断开记录 `499 client_cancelled`；非法 JSON、压缩体和其他读取错误保留 `400`。错误日志不再把客户端断开误报成 `400 request_stream_error`。
- **配置与部署：** `.env` / `docs/deploy/env.example` 新增 `KIN_REQUEST_BODY_TIMEOUT_MS`；反代配置示例增加 `client_body_timeout 120s`，应与应用值同步。无数据库迁移、接口权限变化、payload 或前端变更。
- **验证：** Node 22.23.4（线上同版本镜像）定向运行请求体回归 27/27、Responses/SSE 回归 7/7 通过；`git diff --check` 通过。生产容器和宿主 Nginx 尚未替换，代码推送后需在发布/部署窗口应用。
## 2026-10-31 上游预检重复迁移前缀修复

- **Bug 修复：** 上游预检现在保留基线中已经发布、且由迁移器按文件名区分的重复数字前缀；只有本轮合并新引入的迁移前缀碰撞才会阻断候选。现有 `057_runtime_config_revision.sql` 与 `057_supplier_login_role.sql` 不再被误报，历史迁移文件和数据库记录无需改名或重放。
- **验证：** 上游预检 Python 回归 39/39 通过；新增回归覆盖历史重复前缀可继续同步，并保留新引入碰撞的阻断；`git diff --check` 通过。
- **新增功能 / 破坏性变更 / 数据处置：** 无。部署后预检逻辑自动生效，不执行数据库迁移或生产部署。

## 2026-10-31 GitHub 发版流程提速

- **发布范围优化：** 手工定制版默认只构建控制面、helper、payload 和应用 Release，复用已发布的 guest/KVM 槽位镜像；自动上游版本发布、显式补发上游版本、槽位源码变化和手工勾选强制重建时仍完整构建 4 个 guest 与 4 个 KVM 镜像。
- **流程选择：** 新增 `rebuild_guest_images` 手工输入；未勾选时自动比较最近正式 Release 到当前源码的 `docker/kin-os/`、`docker/kin-kvm/` 和槽位工作流路径，只有实际变化才重建。`publish=false` 构建验收不会发布槽位镜像。
- **缓存与可观测性：** guest/KVM BuildKit 缓存从 `mode=max` 调整为 `mode=min`，减少中间层和作业收尾传输；关闭 release 矩阵的 Docker build summary 附件，保留最终镜像与必要校验；prepare、checks、linux、控制面镜像、guest/KVM 和 publish 阶段在 Actions Summary 记录开始、结束和耗时。
- **安全边界：** 只有槽位镜像重建被跳过；控制面镜像、helper、payload、Release 资产校验和版本发布顺序保持不变。需要重建时，任一 guest/KVM 作业失败仍阻止应用 Release 公开。
- **验证：** 新增 guest image policy 回归，覆盖手工复用、槽位路径变化、自动/上游发布强制重建和 `publish=false`；同时执行工作流 YAML 解析、Python release 回归及相关格式检查。

## 2026-10-31 供应商账号状态与运营平台统一

- **状态投影：** 供应商账号接口补齐 VM 的凭证状态、可调度状态、调度关闭状态和不可调度原因，供应商端不再把凭证吊销、调度关闭和平台限制全部压缩成“错误”。
- **界面行为：** 供应商账号池按运营平台的状态优先级显示正常、准备中、冷却、暂停、归档和“不可调度 · 原因”；凭证吊销单独显示“已吊销”，调度开关按照实际可调度结果启用或禁用。
- **兼容与安全：** 只投影状态和脱敏原因，不返回凭据、代理认证信息或请求正文；缺失历史状态仍按准备中/未知处理，不伪造可调度。
- **验证：** 新增后端供应商状态投影回归和前端状态视图回归；供应商与日志相关前端回归、日期范围单元测试、类型检查和生产构建通过。后端完整回归结果在本轮交付记录中列明。

## 2026-10-31 用量日期筛选与使用记录列精简

- **日期筛选：** 供应商用量统计改用双月历范围选择器，提供今天、昨天、近 7 天、近 30 天、本月、上月快捷范围，以及自定义起止日期和清空操作；范围选择已收敛为上游交互，选完起止日期即生效。原有接口的范围值和时区参数保持不变。
- **使用记录：** 管理员和用户的使用记录表格移除“出站 Session”和“供应商”两列，并同步从列显示设置和全屏表格中移除，保留请求详情页、筛选和后端日志字段供既有查询链路使用。

## 2026-10-31 超管供应商代理与代开户表单统一

- **代理管理：** 超管代理管理继续使用供应商代理池的统一公开投影，表格展示名称、供应商、协议、脱敏地址、状态/启用、延迟/质量、地区、绑定席位和操作；新增/编辑/探测/质量检测/地区检测/删除沿用同一接口和权限边界；操作列不再提供启停入口，删除沿用归档语义。
- **代开户：** 超管账号池新增账号改为与供应商端相同的平台、可选名称、代理下拉/粘贴、平台匹配分组和授权方式表单，新增“供应商”选择；提交后按所选供应商创建账号和配对 VM，并直接打开同一授权面板，完成授权后该账号归属和状态由供应商端同步读取。
- **清理：** 删除超管账号池旧的简化账号创建分支，避免绕过分组、代理组合输入和授权面板；代理创建保留独立表单。
- **验证：** 新增超管代供应商开户 HTTP 回归；供应商管理、日志、日期范围和国际化前端回归、类型检查和生产构建以本轮实际结果为准。

## 2026-10-31 在线更新流程提速与阶段可见性

- **更新体验：** 一键更新记录准备、健康快照、镜像拉取/构建、控制面重启、版本验证、资源同步和遥测阶段；管理台显示阶段文案与进度条，失败保留更新状态文件和 helper 日志。
- **性能优化：** 升级前后槽位健康检查改为最多 8 路并行；集群槽位按节点/系统镜像/运行时分组后以默认 2 路受控并发刷新；遥测默认并发从 4 调整为 6，并支持环境变量覆盖。
- **避免无效工作：** 控制面恢复后先执行 `wrap-cli/sync` 只读检查；kernel、CLI 和槽位镜像均未变化时跳过槽位重启，只执行必要遥测同步。只读检查失败时回退完整同步，保持安全边界。
- **新增状态契约：** `GET /api/panel/version` 的 `upgrade` 状态增加 `phase`、`progress`、`message`、`updated_at`；不新增数据库迁移、业务接口或生产数据操作。
- **验证：** 升级脚本 11/11、fleet-services 3/3、发布错误处理与 Release 相关回归通过；fleet/remote-slot 相关回归 34 通过、2 个需要真实 SSH 的用例跳过；前端设置/i18n 20/20、TypeScript 和 Vite 构建通过；Docker 地址池 4/4 通过。
- **升级与限制：** 代码和前端发布后生效；生产宿主机仍需按部署窗口应用 Docker 地址池配置。控制面升级与槽位资源刷新仍是同一更新任务，但不再在无资源变化时重启槽位。

## 2026-10-31 管理员使用记录异步数据渲染修复

- **Bug 修复：** 管理员打开“使用记录”后，页面先显示加载态，收到统计、活跃会话或日志列表数据时可能因历史响应形状、空数组/非数字字段或浏览器存储异常触发全局 500。前端查询层现在统一兼容当前响应、旧 `items` 响应和不完整空响应；列表、统计、排行榜、错误归集、活跃会话及筛选分组均在渲染前做边界归一化。
- **线上根因补修：** 真实管理员页面的控制台堆栈确认部分日志行缺少 `providerChain`，`finalChainItem()` 仍会直接读取 `length`。供应商链展示辅助函数现在把缺失、null 和非数组值统一按空链处理，日志行仍回落显示 VM 或账号名称。
- **后端验证：** 增加管理员角色对请求统计、用量列表、汇总、筛选选项、活跃会话和时区概览的 HTTP 回归覆盖；不改变接口权限、账单口径或日志数据。
- **验证：** 前端日志查询单测 3/3、日志相关前端回归 22/22、管理员与请求日志后端回归 50/50、TypeScript 检查和 Vite 生产构建通过。`pnpm` 自动安装因本机依赖策略拒绝执行 esbuild 安装脚本，改用已存在的锁定依赖直接运行检查和构建。
- **升级与限制：** 需同时更新控制面和 web 前端构建产物；本轮无数据库迁移、配置、依赖或生产部署。真实站点需在更新后清理旧静态资源缓存并重新登录验收。

## 2026-10-31 Docker 槽位地址池扩容

- **部署改进：** `deploy/install.sh` 在新装和升级时保留现有 Docker daemon 配置，幂等加入
  `10.200.0.0/16` 按 `/24` 切分的默认地址池，提供 256 个自定义 bridge 子网，满足当前“一台
  远程代理 VM 一张 `kin-eg-*` 网络”的约 254 槽位扩容目标。
- **安全边界：** 新增 `deploy/configure-docker-address-pools.py`，校验 JSON、拒绝地址池重叠、
  原子写入并在变更前保留带 UTC 时间戳的备份；`dockerd --validate` 失败时恢复原配置。地址池
  或配置路径可用 `TAPMODELS_DOCKER_ADDRESS_POOL_BASE`、`TAPMODELS_DOCKER_ADDRESS_POOL_SIZE`
  和 `TAPMODELS_DOCKER_DAEMON_CONFIG` 覆盖。
- **运行影响：** 仅配置变化时重启 Docker；已有网络和槽位 subnet 不改写，新网络使用扩容后的池。
  Release tag 尚未包含该部署脚本时，raw `main` 安装器会回退补取 `main` 版本；本轮未增加数据库迁移、业务接口或依赖，生产宿主的 daemon 配置需按部署窗口应用。
- **验证：** 地址池脚本 4 项 Python 回归、部署脚本语法和 `git diff --check` 通过；完整部署
  测试中另有 2 项既有 macOS 路径失败，与本改动无关。

## 2026-10-31 撤回 guest OAuth 透明 egress 判定并修复 web 格式检查

- **Bug 修复（撤回）：** `guest-oauth-helper.mjs` 此前新增的 `transparentEgress` 判定会让 `runGuestOAuthAuthService` 在槽位网络名以 `kin-eg-` 开头时把 `proxy_url` 置空。但 `slotNetworkForVm(vm)` 只要 `vm.proxy.id` 存在就返回 `kin-eg-<id>`，该条件对任何已绑定代理的 VM 都为真，`isLocalEgressProxy` / `boundProxyUrl` 两条分支因此成为死代码，实际效果是**所有**绑定代理的槽位都收不到 `proxy_url`，范围远大于注释声明的"已走透明出口的已启动槽位"。本轮把该文件及其配套断言撤回到改动前状态，两个文件与上一个 CI 通过的提交逐字节相同。
- **回归证据：** `test/unit/oauth-binary.test.mjs` 的 fixture VM 带 `proxy: { id: 'px-fixture' }`，命中上述条件后真实 `kin-oauth-auth` 二进制拿不到代理、连不上测试自建的 SOCKS/TLS fixture，CI 上 `cai: provider-exchange-state`、`cai: no state suffix`、`setup_token: session` 三条连续失败。该测试在缺少 openssl 的环境会 `t.skip`，所以本机跑不出来，只有 CI 能暴露。
- **保留：** 同期在 `egress.mjs` 新增的 `reclaimUnusedEgressNetworks()`（docker 地址池耗尽时回收无容器、无 kin-egress 进程的空 `kin-eg-*` 网络，并在 `startProxyEgress` 失败时重试一次）与其 2 项单测**原样保留**——它与本次回归无关，修的是"all predefined address pools have been fully subnetted"这个真实故障。
- **构建修复：** `web/src/features/vm/list-page.tsx` 未经 Prettier 格式化，使 CI 的 web 任务在 `pnpm format:check` 阶段直接失败（后续 `pnpm test`、`pnpm build` 从未执行）。按仓库 Prettier 配置重新格式化，仅一处换行，无语义变化。
- **验证：** `guest-oauth-readiness` 6/6；`egress` 25 通过（含保留的回收用例）、`vm-runtime-replace` 27 通过，失败数与不含本改动的基线完全相同，属本机容器环境限制；`oauth-binary` 本机因缺 openssl 与 payload 二进制而 skip，交由 CI 判定——撤回后的两个文件与 CI 曾通过的提交逐字节一致。`web` 侧 `prettier --check` 全量通过，`vitest` 712 项中 709 通过。`biome format` 737 个文件通过。
- **Bug 修复（账号状态筛选）：** 同期 `vendor-account-filters.mjs` 把健康判定抽成 `accountHealth()` 时，顺手把筛选条件里的 `state === f.status` 分支换成了 `(f.status === 'error' && r.status === 'archived')`。归档归入 `error` 已由 `accountHealth()` 覆盖，新分支是冗余的，而删掉的那支是按 telemetry 状态值筛选的唯一入口，于是按 `available` 等状态筛选不再匹配任何账号。该功能自己的测试同时断言 `accountSummary(rows).available === 1` 与 `filterAccounts(rows,'beta','openai','available') === ['b']`，前者通过后者失败，属实现内部不一致而非预期语义变更，因此恢复 `state === f.status`，归档→error 继续由 `accountHealth()` 提供。
- **验证（该修复）：** Node 侧 `vendor-account-filters.test.mjs` 4/4 通过，该功能本轮更新的 `ids({status:'error'})` → `['archive','error']` 断言不受影响；web 侧 `src/features/vendor` 三个文件 36/36 通过。此前 web 任务被 Prettier 短路，这条失败一直没被执行到。
- **环境差异说明：** 本机 arm64 容器里 `web` 的 `connection-config.test.ts` 有两条失败，但在上一个 CI 通过的提交上同样失败，且 CI 的 web 任务报告 711/712 通过，确认属本机环境差异，非代码问题。
- **新增功能 / 破坏性变更 / 数据处置：** 无。不新增接口、配置、依赖或迁移。
- **升级与限制：** 部署后端与前端构建后生效。撤回后透明出口下的双层代理问题回到改动前状态，需要由对应功能重新实现并补一个不依赖 `vm.proxy.id` 的判定；本轮只负责让 main 恢复可发布状态。

## 2026-10-30 供应商运营后台代理池工作台

- **新增功能：** 超管“供应商平台 → 代理管理”改为供应商范围的代理池工作台，合并展示 `vendor_resources` 与统一 `proxy-pool` 的协议、脱敏地址、认证存在性、启用/探测状态、延迟、地区、质量评分和绑定席位。支持按供应商、协议、状态和关键字筛选，新增代理，以及单条/批量连接测试、质量检测、地区检测、地址/认证编辑和删除（归档）；启停保留共享接口，不再占用操作列。
- **同步与安全：** 代理资源 ID、供应商归属和统一池 ID保持关联；地址变更回写绑定 VM 的出口配置，运行中的 VM 在需要时重新加载。密码不回显；无效状态先校验，不会先关闭统一池；仍绑定账号的代理不能归档。供应商门户继续读取同一资源和池状态。
- **接口：** 新增超管代理操作接口 `/api/admin/vendors/proxies/:id/{probe,quality-check,geo,enable,disable,archive}` 及批量 `POST /api/admin/vendors/proxies/{probe,quality-check,geo}`；扩展代理 PATCH 以支持地址/认证同步。无新增数据库迁移、外部依赖或生产数据操作。
- **验证：** 供应商后台/门户相关 Node 回归 34 项通过；新增代理工作台 HTTP 覆盖创建、脱敏、筛选数据、无效状态保护、地址编辑、启停和归档；前端 i18n 17 项、TypeScript、ESLint、Prettier 和 Vite 生产构建通过。质量/地区检测的真实公网效果仍需在授权网络环境单独验收。
- **已知限制：** 供应商门户侧仍未提供完整代理质量报告和批量导入/导出；真实 Linux guest/KVM、真实代理网络与生产部署未执行。

## 2026-10-30 虚拟机列表增加供应商筛选

- **新增功能：** 超管虚拟机列表增加供应商选择框，支持“全部供应商”、具体供应商和“未分配供应商”筛选；筛选同时作用于列表和 FleetPulse 状态统计，分组、平台、搜索和排序逻辑保持可组合。
- **数据与权限：** 后端从 `vendor_resources` 的 VM 资源记录及 `vendors` 表读取 `vendor_id` / `vendor_name`，按运行时 VM ID 关联；供应商字段只在超管 VM 列表响应中返回，非超管不会获得供应商管理元数据。
- **前端与文案：** 新增供应商查询 `/api/admin/vendors`，仅超管启用；补齐简体中文、繁体中文、英文和日文文案。
- **验证：** VM 列表后端测试 11/11 通过；VM 四语国际化测试 18/18 通过；TypeScript 构建检查、受影响后端 Biome 检查和 diff 空白检查通过。
- **升级与限制：** 需同时部署后端和 web 前端后生效；无数据库迁移、数据处置、新增依赖或破坏性接口变更。

## 2026-10-30 上游 PR #838 HTTP 长连接超时

- **行为变化：** 合并 `dofastted/vm2api` PR #838（提交 `c46d621017a94fde463508005578307e86fecbb0`），控制面 HTTP server 在启动前将 `keepAliveTimeout` 设为 120 秒、`headersTimeout` 设为 125 秒，并关闭 socket inactivity timeout（`timeout = 0`），减少长响应或空闲 keep-alive 被过早中断。
- **范围与清理：** 仅修改 `src/server.mjs` 3 行；无新增接口、配置项、依赖、Schema、迁移、payload、web/dist 或 Go/guest 产物。
- **验证：** 合并树 `git diff --check` 通过；使用 `node:22-bookworm-slim` 执行 `node --check src/server.mjs` 通过。macOS 宿主没有 Node，未在本机执行 Node 单测；相关 CI 负责标准 Node 环境回归。
- **升级与限制：** 部署控制面后生效，保留 `routing.json`、`vms/`、`data/`、`.env` 及现有持久化挂载；无需数据库迁移、payload 同步或前端更新。代码同版本推送不自动发布镜像，生产部署仍需单独执行。

## 2026-10-30 settle() 读取不再带 JSON 大字段；created_at 索引经核对后否决

- **优化改进：** `relay-billing.mjs` 的 `settle()` 每次计费读两次 `billing_charges` 行（幂等检查、写入后回读），原先用 `SELECT *` 连 `usage_json` 一并取出——生产上该列平均 43,732 字节、最大 502,356 字节。两处改为显式列常量 `CHARGE_COLUMNS`，排除 `usage_json` 与 `quote_json`。调用方只有 handle-protocol 一处，读 `status`、`actual_micros`、`group_id`、`subscription_id`、`rate_multiplier`，价格用 context 自己的 `quote_json`，行为不变。
- **实测：** 生产只读 400 次按 `request_id` 点查，`SELECT *` 19.4 ms（0.048 ms/次）对显式列 10.2 ms（0.026 ms/次），约 1.9 倍。绝对值很小（按当前约 1.4 req/s，每请求省约 0.022 ms），意义在于不再为每次计费实例化几十 KB 字符串，减少 GC 压力。
- **已否决（不新增索引）：** 逐条核对三张表的真实查询后，没有一条需要新索引。`billing_charges` 的两类查询分别走 `idx_billing_charges_subscription_created` 和主键；`request_attempts` 的清理 `DELETE WHERE started_at < ?` 走 `idx_request_attempt_account(account_id, started_at DESC)` 的 skip-scan，生产实测 0 ms；`wallet_ledger` 的游标分页有 `(user_id, created_at)` 与 `(wallet_domain_id, created_at)`，无筛选时虽全表扫但该表生产上只有 1 行。`billing_charges` 按 `created_at` 倒序取 50 条在生产上已达 2,880 ms，但**代码中没有任何调用方执行该形状的查询**（`/billing` 面板走 `wallet_ledger`，仪表盘聚合走已有 `idx_reqlog_ts` 的 `usage_logs`），为无调用方的查询在 2.2 GB 表上建索引属于「以后可能用到」，按清理规则不做。该表的真实问题是历史 `usage_json` 体积，解法是清理数据。
- **验证：** `relay-operations` 新增 1 项锁定返回契约（调用方所需五个字段齐全、`usage_json`／`quote_json` 不再出现在返回值、库中行仍保留两个大字段、幂等再次结算与首次完全一致），该文件 24/24。连同 `usage-attribution-trim` 4、`tenant-billing` 2、`admin-wallets` 6、`panel-billing-lookup` 9、`relay-refinements` 7、`relay-rpm` 11、`vm-test-chat-billing` 8、`completed-usage-upgrade` 1、`database` 19、`pool-runtime-repos` 7，共 98 项通过、0 失败（本机 node:22-bookworm-slim 容器）。`biome format` 737 个文件通过。
- **清理与保留：** 无失效实现需删除；未新增索引、迁移、接口、配置或依赖。顺带记录一个可单独处理的清理项：`idx_request_attempt_request(request_id, attempt_no)` 与 `idx_request_attempt_unique(request_id, attempt_no)` 列完全相同，前者被后者完全覆盖，本轮未动。
- **新增功能 / 破坏性变更 / 数据处置：** 无。
- **升级与限制：** 部署后端后生效，无数据库变更。核查发现**线上容器仍是 v1.4.028.7，不含本轮及此前两轮的代码改动**（`usage-persist.mjs` 不存在、`usageForStorage` 与 cache-prefix 复用均未进入镜像），这些收益要到下次发布镜像后才生效；当前真正在线上起作用的只有宿主机 nginx 的静态资源缓存。历史 `usage_json` 未清理，`kin.db` 仍为 3.9 GB，`billing_charges` 已从 51,909 行长到 61,785 行。详细证据见 [加载分析](performance/panel-loading.md)。

## 2026-10-30 VPS 探测失败不再误退出控制台

- **Bug 修复：** VPS 接入/编辑的 SSH 认证失败从 HTTP 401 调整为 403，并保留 `cluster/auth_failed` 错误结构；401 仅表示控制台会话失效，远端 VPS 密码或私钥错误不再被前端误判为控制台登出。
- **验证：** 集群 SSH 认证、集群探测路由共 18 项通过；前端 API 与节点编辑回归 14 项通过；相关 3 个文件的 Biome 检查通过。
- **升级与限制：** 部署后端后生效，无新增接口、配置、依赖、Schema、迁移或数据处置；探测失败会留在当前页面并显示 SSH 原始错误，用户可直接修正凭据后重试。

## 2026-10-30 cache-prefix 按下标复用逐条消息摘要

- **优化改进：** `snapshotBody()` 原本每轮为每条消息重建 `messageRecord`，其中最贵的 `parts`（逐块 stamp 树，自带克隆与多次 digest）只会在真正分歧的那一个下标被读取。现在 `messageRecord(message, cached)` 接收上一轮快照同下标的记录，先算整条去 cache_control 后的 `hash`（原本也要算），命中即整条复用，不再重建 `parts`／`id`／`keys`／`images`。
- **复用判据：** `hash` 覆盖整条消息，其余字段都是同一个值的纯函数——`parts` 读 content、`id` 在其上剥图、`images` 计数、`keys` 列键，cache_control 影响不到任何一个——所以哈希相等即记录相等。未命中走原路径，只多一次字符串比较；快照仍只存摘要，不存提示词或图片字节。
- **实测（生产机 x64 / Node 22.23.4，`prepareCachePrefix` 单次中位数）：** 200 条 0.11 MB 16.1→2.6 ms；600 条 0.29 MB 37.0→7.2 ms；1200 条 0.58 MB 60.3→10.4 ms；1200 条 2.42 MB 116.6→22.2 ms（5.2–6.2 倍）。最坏情况是开头插入一条导致全部下标错位、无一可复用：1200 条时 40.9→38.9 ms，无回退。
- **等价性验证：** 构造 38 步变更序列（追加、改标记、改尾部／中部文本、改 tool_use 入参、删块、换 role、加键、改 system、增删改工具、开头插入、截断、加图、删图、字符串内容、移动标记、计数器文本），在 `preserveMessageCache` 开与关两种模式下逐步比对新旧实现 `prepareCachePrefix` 与 `peekCachePrefix` 的完整返回值（含 break 的 section／index／kind／diff、anchor、checkpoint、image_floor 与发出的 body），0 处不一致。
- **验证：** `cache-prefix` 新增 4 项（历经 30 轮复用后仍精确定位深层历史改动、开头插入导致下标位移时不复用旧记录、截断后以更短历史为新基线、位移下标上的 role 变化仍正确上报），该文件 28/28 通过。本机 macOS/arm64 的 node:22-bookworm-slim 容器跑完整 unit：353 个文件、4,251 项通过、19 项失败，集中在 `cluster-direct-link`、`egress`、`panel-tenant-guards`、`telemetry-status`、`vm-runtime-replace` 五个文件；逐一在不含本改动的基线上复跑，失败数完全相同，属本机容器缺 python3／SSH／端口的环境限制，非本轮回归，Linux 结果以 CI 为准。`biome format` 737 个文件通过。
- **清理与保留：** `snapshotBody()` 增加可选 `previous` 形参，`prepareCachePrefix` 与 `peekCachePrefix` 传入当前会话快照；`firstHistoryDiff` 无前序快照，行为不变。无失效实现需删除，未新增开关或兼容路径。
- **新增功能 / 破坏性变更 / 数据处置：** 无。不新增接口、运行配置、依赖或数据库迁移。
- **升级与限制：** 部署后端后生效，无需前端或数据变更。`retainImages()` 里按 `state.floor` 逐条调 `messageIdentity()` 的循环同样是每轮 O(n)，但仅在客户端触发过图片丢弃、图片地板激活后才非零，本轮未处理。`billing_charges.created_at` 缺索引、`execFileSync` 的 90 秒 timeout 仍未处理；历史 `usage_json` 未清理，`kin.db` 仍为 3.9 GB。详细证据见 [加载分析](performance/panel-loading.md)。

## 1.4.029 上游同步（2026-10-30）

- **范围与来源：** 基于交付远端当前独立提交 `bd53e4c50d39c93422f6952b6892f56934c4bce0`，吸收上游 `285f0d216644b5ee4a96b1630840466e61a2f717`（v1.4.029）。上游增量只有版本号和 CHANGELOG release cut；完整保留同期控制台版本检查、静态资源、供应商、账务、Codex 调度、失败终态和生产审计相关定制。`CHANGELOG.md` 与冻结上游逐字一致。
- **行为变化：** 上游正式收录 #815 强制工具选择 400 拒答及 #832 对齐 #814/#807 的测试契约；实现已在当前定制中存在，本轮不重复移植、不新增兼容分支。交付远端同步保留版本菜单、四语资源和对应测试的独立修订。
- **升级：** 从 v1.4.028 升级，等待 v1.4.029 镜像发布后在原 Compose 目录执行 `TAPMODELS_IMAGE_TAG=v1.4.029 docker compose pull tapmodels`，再执行 `TAPMODELS_IMAGE_TAG=v1.4.029 docker compose up -d --no-deps --force-recreate tapmodels`。本版上游明确不必更新 `web/dist`；保留当前定制前端时使用镜像内打包的完整产物。源码部署更新 Node 后按现有构建/服务管理方式重启，不执行 `npm run fetch:payload` 或 `wrap-cli/sync`。
- **配置与边界：** 不覆盖 `routing.json`、`vms/`、`data/`、`.env` 及现有挂载。本轮无 payload、kernel、cli-node、Go worker、ARM64 overlay、Schema 或迁移变化；未完成的 1.4.027 遥测内核补齐仍按此前跨版指南处理。代码推送触发新版自动 Release/guest/KVM 流程，生产部署仍需单独执行。
- **验证：** 上游仅版本/日志变更，复用当前交付的业务、HTTP、前端、类型、格式和生产线上只读审计证据；补做 CHANGELOG 逐字一致、唯一父提交、提交数、树和 diff 检查。本轮未执行生产重启、迁移、真实推理或数据操作。

## 2026-10-30 usage_json 写入前剥离上游 attribution

- **优化改进：** 新增 `src/lib/core/usage-persist.mjs` 的 `usageForStorage()`，在 `billing_charges`（`relay-billing.mjs` 的 `settle()`）和 `request_attempts`（`request-attempts-repo.mjs` 的 `complete()`）两个持久化点剥掉上游 usage 里的 `attribution`。该键是按会话中每条 assistant 消息累积的 token 归因表，条目随轮数增长且无上限，线上单行平均 43 KB、最大 502 KB。抽样最近 2000 行，它占 `billing_charges` usage_json 的 99.2%、`request_attempts` 的 99.6%，其余各键合计不到 1%。
- **实现取舍：** 只在存在该键时做浅拷贝，不在请求路径上重新遍历对象；传入的 usage 对象保持不变，`recordUsage` 与 `costColumnsFromUsage` 仍读到原值，计费金额不受影响。归因数据直接丢弃而非降采样保留——没有任何读取方，不保留兼容路径或开关。
- **清理与保留：** 核实全仓库（`src`、`web/src`、`test`、`worker`、`api-kernel`）无任何读取 `attribution` 的代码，无失效实现、文案、类型或配置需同步删除。`request_log_debug` 线上为空表（调试抓取未开启），不是同类膨胀源。`billing_reservations` 自迁移 069 起已无写入方，迁移注释明确保留为历史数据，本轮不动。
- **验证：** 新增 `test/unit/usage-attribution-trim.test.mjs` 4 项，覆盖剥离后计数完整、调用方对象不被改动、无该键时原样返回同一引用、null/非对象/数组透传，以及两张表的真实落库字节数与回读。连同 `relay-operations` 23、`pool-runtime-repos` 7、`completed-usage-upgrade` 1、`tenant-billing` 2、`admin-wallets` 6、`panel-billing-lookup` 9、`relay-refinements` 7、`relay-rpm` 11、`vm-test-chat-billing` 8，共 78 项通过、0 失败，在与生产同版本的 Node 22.23.4 隔离容器中执行。本机无 Node，生产镜像已裁剪 devDependencies，`biome format` 未能在本地执行，仅按配置机械核对（无超 120 列、无行尾分号、单引号），由 CI 的 format-check 判定。
- **新增功能 / 破坏性变更 / 数据处置：** 无。不新增接口、运行配置、依赖或数据库迁移。
- **升级与限制：** 部署后对新写入的行生效。**历史数据未处理**，`kin.db` 仍为 3.9 GB，其中 `billing_charges` 2,206 MB、`request_attempts` 1,180 MB、`billing_reservations` 415 MB 的既有 `usage_json` 原样保留；回收空间需要单独授权的 `UPDATE` + `VACUUM`，后者在 3.9 GB 库上会独占锁数分钟。本轮不改变事件循环饱和本身，`cache-prefix` 每请求 63–127 ms 全量摘要、`billing_charges.created_at` 缺索引、`execFileSync` 的 90 秒 timeout 仍未处理。详细证据见 [加载分析](performance/panel-loading.md)。

## 2026-10-30 面板慢的实测归因与静态资源反代缓存

- **根因（文档，非代码修复）：** 面板慢的主因不是前端体积，而是面板与推理网关共用同一个 Node 单线程进程、事件循环被推理流量占满。服务器本机 `/healthz` 采样 100 次为 p50 3 ms、p90 3.3 s、p99 8.1 s、max 20 s，24% 超过 200 ms；另一轮采样出现 14.1 s 和 10.0 s 停顿，期间主线程为 `R` 且无新建子进程，排除同步 docker 调用与外部 IO。公网取面板分片，270 字节的 chunk TTFB 2.65 s，入口页有 22 个 `modulepreload`。
- **优化改进：** [部署](DEPLOY.md) 的反代参考配置增加 `proxy_cache_path` 与五条 `^~` 静态 location 及其 `snippets/tapmodels-static-cache.conf`，把 `web/dist` 产物交给 nginx 长期缓存。产物按内容哈希命名、响应自带 `immutable`，每个文件只在首次穿透到 Node；`/cc` 入口 HTML、面板 API 和推理路径仍走 `location /`，保持 `proxy_buffering off` 与不缓存。
- **已否决项：** 曾计划给 `createDatabase` 增加 `cache_size`/`mmap_size`/`temp_store`。生产库只读实测后撤回：走索引的热路径本来就是 0–19 ms、无可测收益，唯一耗时的无索引全表扫反而从 954 ms 劣化到 1,068–1,246 ms。该查询的真实解法是给 `billing_charges.created_at` 建索引。`src/lib/db/database.mjs` 未改动。
- **验证：** 服务器本机核验缓存命中后同一分片 5 次 TTFB 36–42 ms；gzip 客户端得 345,952 字节且带 `content-encoding`，identity 客户端得 1,233,104 字节且无该头，两种编码为独立缓存条目；`/cc` 仍 `no-store` 且不进缓存，`/api/panel/overview` 不经缓存路径；`nginx -t` 通过。撤回 pragma 前已在与生产同版本的 Node 22.23.4 隔离容器中跑过 `database` 19/19、`database-metrics` 4/4、`db-migration-sub2api` 6/6，并确认 pragma 取值与环境变量回退正确；撤回后这些结果不再作为交付依据。
- **新增功能 / 破坏性变更 / 数据处置：** 无。本轮不新增接口、配置、依赖、迁移或业务代码。
- **升级与限制：** 线上 nginx 已按上述配置修改并 `systemctl reload`，原配置备份在服务器 `/root/nginx-backup-20261030T120408Z`。该修改在宿主机，不随容器部署下发，新机器需按 [部署](DEPLOY.md) 手工配置。本项只保证静态资源不再排在推理后面，不改变事件循环饱和本身；复测 `/healthz` 的 p90 1.18 ms 同期请求量已从 5,246 次/小时降到 2,422 次、容器 CPU 降到 14%，反映的是负载回落而非本项效果。剩余的 `usage_json` 膨胀（`kin.db` 3.9 GB，`attribution.items` 单行最大 502 KB）、`cache-prefix` 每请求 63–127 ms 全量摘要、缺失索引和同步 `execFileSync` 均未处理。详细证据见 [加载分析](performance/panel-loading.md)。

## 2026-10-30 Responses WebSocket 工具历史完整性

- **Bug 修复：** SSE 转 WS 桥接记录完整的 `response.output_item.done`；完成终帧省略或返回空 `output` 时，按输出索引恢复本次响应项，避免下一轮 `previous_response_id` 拼接只带工具结果而缺失调用。非空终帧输出继续作为权威结果，不重复拼接；不回放 added 占位项、失败或未完成响应。
- **故障边界：** 已复现并修复上述终帧边界。实际客户端报错样本中本机存在调用/结果对、同一 VM 仍可能返回 400；切换 HTTP SSE 后成功，但历史错误没有保留完整出站结构，小型真实 WS 双轮请求也成功，因此不能把本边界断言为所有线上 `No tool call found` 的已确认根因。
- **验证与清理：** 新增两轮真实 WebSocket 回归覆盖终帧省略/空输出及完整输出不重复，相关协议与转换共 44 项通过（macOS 与当前生产基底的 Linux Node 22）。取消测试改为核对既有 `final_state=cancelled`、空 error_code 契约，不修改取消运行行为。移除仅依赖终帧数组的历史采集分支；无新增接口、配置、依赖、迁移或破坏性变更。
- **CI 补验：** 修正既有 VM 默认值断言为 4g/4 核；用户会话测试显式打开并关闭全局数据库；071 迁移回归只比较该迁移之前的历史，允许后续已存在迁移。三个受影响测试文件 32/32 通过，未更改生产实现。
- **升级与限制：** 部署后自动生效。生产使用当前 v1.4.028.7 镜像加单模块修复层，保留原镜像与环境回滚；后续升级须使用包含本修改的版本。现有客户端 HTTP SSE 配置继续有效，本轮不重新启用其 WebSocket。无额外发版或业务数据处置。

## 2026-10-30 移除历史升级失败提示

- **行为调整：** 按用户要求，查询更新后不再展示“上次升级未完成”、上次升级折叠项或其 Docker 日志命令；失败目标是否等于最新版本均不再影响界面。删除此前区分同目标/旧目标的展示实现。
- **清理与保留：** 删除历史提示组件、判断分支及四语专用文案，更新原有相关测试；保留当前任务进度和 useVersionUpdate 对主动升级失败的一次即时 toast。后台终态仍用于结束轮询、防止重复启动与真实成功判定，Docker 助手日志未删除；没有将失败伪造为成功。
- **验证：** macOS / Node 24.22.1，版本显示/查询与国际化 20 项通过，覆盖同版本、不同版本、GitHub 不可达、升级中旧失败缓存；相关 ESLint、Prettier 和 diff 检查通过。静态渲染确认无历史失败信息或折叠入口，并保留正常检查与进度；未执行真实容器升级。
- **升级与限制：** 无新增功能、接口、运行配置、依赖、迁移或破坏性变更；部署前端后生效。本次仅源码交付，不发版或部署，不处置线上数据和容器。

## 2026-10-30 升级状态与 GitHub 检查解耦

- **Bug 修复与优化：** 升级进度轮询和助手的后端版本验证使用现有版本接口的 `status=1` 本地状态读取；升级助手正在运行时，旧客户端的普通版本读取也跳过 GitHub。终态读取同样无需联网，避免控制面重启清空缓存后 GitHub 超时拖慢验证并叠加“检查失败”。新增 `check_status=not_checked` 表示本次没有检查发布源，不冒充检查成功或已是最新。
- **界面与清理：** 升级过程中只显示升级进度，删除同屏叠加的发布检查失败及 GitHub 超时提示；手动检查继续保留真实联网错误，升级失败仍以助手退出状态为准。当前版本达到目标不等于槽位刷新和全部验证成功，不以版本号绕过完成条件。
- **验证：** macOS / Node 24.22.1 下 release、release-errors、panel-upgrade-script 共 47 项通过；版本显示与查询 11 项通过，TypeScript、相关 ESLint、Biome、Prettier 和 diff 检查通过。未读取到生产升级日志，本机 Docker daemon 不可用，未执行真实容器升级。
- **升级与限制：** 无新增接口路径、运行配置、依赖、迁移、数据处置或破坏性变更；现有版本接口增加一个查询模式和状态枚举值。需部署前后端及升级脚本后生效，当前运行中的旧助手脚本不会被本次源码修改替换。本轮保持原上游基线，仅交付代码，不发版或生产部署。

## 2026-10-30 供应商账号创建分组范围修正

- **Bug 修复：** 用户管理创建供应商时，将表单 `groups` 授权映射为供应商资源分组，修复原先只读取未由表单提交的 `vendor_groups`、导致供应商进入默认全范围的问题。用户编辑与独立分组授权接口在同一事务内同步供应商范围；供应商后台编辑分组也同步成员的用户授权，保留已有专属倍率/RPM。
- **权限与缓存：** 创建、编辑和运行时继续使用现有供应商/父级范围校验。供应商分组目录独立缓存，不复用超管的面板目录。删除本轮草稿中重复的前端过滤和新增目录 API，保留当前主线已有的账号专用编辑目录。无新增接口、配置、依赖、Schema 或迁移；未改变根供应商空范围采用默认范围、子级空范围继承父级的既有契约。
- **升级与限制：** 需部署前后端；已有受影响供应商请在用户管理中重新保存一次正确分组，以同步此前错存的供应商范围。不自动重写线上历史授权或账号分组，不发版或生产部署。
- **验证：** 供应商相关后端 26 项通过；在合入同期账号展示变更后，重新验证三个 HTTP 场景，涵盖两平台目录、越权拒绝、两种用户授权保存入口、反向同步和父子范围冲突回滚。前端相关 36 项、`tsc -b`、格式和 diff 检查通过。

## 2026-10-30 控制台加载优化与手工版本检查

- **根因与优化：** 公网实测控制台入口 JS 为 1,219,219 字节、下载 3.69 秒，即使请求 gzip 也返回原文；应用静态文件服务没有压缩协商，线上 nginx 未配置 JS/CSS 的 gzip 类型。Vite 现在构建时预压缩 JS/CSS/HTML 等文本资源，静态服务按 Accept-Encoding 返回 gzip，保留 MIME、HTML no-store、哈希资源 immutable、HEAD 和无压缩客户端/旧构建回退。
- **手工检查：** 版本菜单不再在挂载、页面切换、窗口聚焦、断网恢复或普通缓存失效时自动检查；删除每五分钟后台检查和自动重试，只有点击“检查更新”才检查新版。已明确发起或检查发现正在进行的升级保留两秒状态轮询，成功后刷新。当前版本仍来自登录身份接口；未新增新版推送服务。原检查是独立后台请求，不能将其八秒超时视作所有页面必然阻塞八秒。
- **验证：** 静态资源 6 项、版本查询/显示 10 项回归通过，TypeScript、相关 ESLint/格式和生产构建通过。90 个压缩文件逐一解压与原件一致，4,726,418 → 1,363,199 字节（减少 71.16%）；两个公共 JS 合计约 2.52 MB → 0.77 MB。浏览器核验总览/设置切换、弹层开启零版本请求、手工检查一次请求、模拟升级轮询与成功刷新。详细证据见 [加载分析](performance/panel-loading.md)。
- **范围与升级：** 同时部署后端及完整新 web/dist（含 .gz）后生效，无新增业务 API、配置、依赖、迁移或破坏性变更；新增一条构建预压缩路径和一条静态响应压缩选择路径，保留已有升级和权限规则。未部署生产或修改线上 nginx；总览槽位观测约 1.6 秒的独立等待仍存在，不能以传输量下降比例承诺所有页面耗时同比下降。
- **CI 收口：** 首次交付 `644aa090` 的 web、contracts、ARM CLI 检查通过，unit 在业务测试前被既有供应商代码格式阻断；仅格式化 CI 点名的 14 个文件，Babel 语法树逐一等价，根 Biome 734 文件检查通过。保留随后已交付 `2da0911f` 的独立 Codex 失败终态与 VM 资源默认值修复；不重复测试输入未变的加载逻辑。

## 2026-10-30 Fable 自身周窗口上限与 VM 平台筛选

- **行为：** 保留现有 `quota.weekly_split.enabled`、`fable_share` 和单 VM 启用覆盖，比例改为每个 Claude 账号 Fable 独立周窗口的直接上限；例如 50% 在使用率达到 0.5 后停止向该账号分配新的 Fable 请求。其他模型不受该项限制，仍遵守各自模型资格、官方额度、5H/总周额度、并发与 RPM 门禁。默认仍关闭、默认比例仍为 50%；0% 停用 Fable，100% 允许完整窗口。
- **实时与恢复：** 候选资格和最终准入都读取当前用量/配置，固定账号的诊断请求也不能绕过此项上限；有效重置时间已到时清除旧读数；缺失或非正重置时间不会自动解除限制。已发出的请求不强制中断，比例依据最新收到的用量读数，不能承诺并发在途请求绝不越线。缺失读数保持未知，不伪造为总周消耗。
- **清理：** 删除 Fable/总周额度的乘法换算、普通模型份额上限、半仓进度条、普通模型受限状态和专属旧文案；Fable 限制不再映射为整槽受限。面板 `weekly_split` 快照只返回启用、比例、自身使用率/剩余及 Fable 是否受限，移除旧 `mode` 和两类周份额估算字段。设置、单 VM 覆盖及 Fable 列表/详情说明同步简中、繁中、英文和日文。
- **平台选择 UX：** VM 列表的 Claude / GPT 筛选改为一组按钮，移除按钮内的彩色平台标签，名称继承按钮文字色；数量使用独立弱化标记，亮暗主题共享正确的选中配色。保留点击已选平台取消筛选及原统计/筛选语义。
- **版本窗口：** 弹层展开时读取侧栏标题卡片的实际宽度并对齐左边界，采用稳定的版本按钮定位；当前版本和新版提示改为紧凑单行，缩小间距和按钮高度。保留更新确认、进度和命令入口，并验证反复开合正常。
- **验证：** Fable 阈值边界、0/100、全局/单槽启用、读数缺失与重置、面板一致性、异步健康检查后的准入（含固定账号）及真实 HTTP 启停回归通过。已有 5H/总周额度和官方 Fable 限额继续生效；前端类型、四语、用量展示及版本窗口回归通过。浏览器核验 Claude/GPT 切换、亮暗配色、版本弹层恢复展开与实际等宽（本地标题和弹层均约 224px）。
- **升级与边界：** 现有已保存比例在部署后直接按新上限解释，需一起更新前后端；无新增 API 路径、配置字段、依赖或数据库迁移，无线上配置修改、数据操作、真实供应商请求或生产部署。

## 2026-10-30 Codex 失败终态与新建 VM 资源默认值

- **失败修复：** 解析 `response.failed.response.error` 并保留无 code/error 时的明确失败；失败终态优先于 usage 和 completed，避免误记空的 HTTP 200 或 verified。非流式请求在缓冲输出后失败返回语义状态码与结构化错误；已产生业务输出的请求不重放。断流缺失终帧时补一次错误；原生失败终帧、完成帧或转换错误不重复追加，Chat/Anthropic 转换路径输出对应错误。
- **错误可见性与结算：** 最终失败补全限长、脱敏的摘要、final_state 和最终 VM/账号；保留实际 usage 证据，Codex 商业计量仍只在 verified 时执行。客户端取消与 `response.incomplete/max_output_tokens` 保持原契约；不调整 Claude 容量排队或取消处理，不绕过已禁用模型、独立搜索拒绝或供应商过载。
- **默认资源：** 新安装及缺省 VM 配置为 4 vCPU、4 GiB；Docker 新建时将所选 vCPU（或全局 `routing.vm.vcpus`）持久写入 `machine.docker_cpus`，普通创建、供应商配对与新建导入共用规格解析。默认页面与创建表单同步 CPU/内存含义，Docker 也可选择 CPU；本地 `--cpus` 和集群 `NanoCpus` 使用已保存配额。
- **兼容与升级：** Docker 显式 `docker_cpus=0` 继续表示不限，分数配额仍可通过既有 API 设置；KVM 不写 Docker 配额。已保存规格及无配额的历史槽位保持原运行策略，配置默认值不会隐式重建旧容器。新建默认内存从 512 MiB/2 vCPU 改为 4 GiB/4 vCPU，部署时应核对宿主资源；CPU 为共享时间上限，非独占核。无新增公开接口、配置字段、依赖、数据库迁移或后台任务。
- **清理：** 移除新建 Docker 忽略 CPU 默认值、仅 KVM 显示/提交 CPU 的旧分支与四语旧说明；保留仍供历史记录和显式 API 调用使用的零配额语义。服务器资源修复另行在线执行，没有删除账号或历史日志。
- **验证：** 真实 Unix socket 覆盖原生/转换失败、失败与 usage/完成冲突、多行 SSE、非流式缓冲、取消、断流和脱敏；Linux/Node 22 候选回归覆盖两条协议链以及新建/导入/本地与集群 CPU 配额。前端默认值/请求载荷及四语 21 项通过，TypeScript 和生产构建通过。测试进程补充运行中的 HTTP 服务所提供的事件循环存活条件；创建测试复用既有身份生成器 fixture。

## 2026-10-30 槽位监护误判与独立搜索拒绝日志

- **Bug 修复：** Rust 槽位短健康探测失败且容器仍运行时，先用现有 `kernel_watchdog.timeout_ms` 独立复核；恢复健康不消耗恢复预算，也不误隔离槽位。持续故障、真实停止/丢失容器仍使用原有退避和有界恢复，保留维护 hold、暂停容器及远程中继不可达的保护。
- **恢复计数：** `ensure` 发现内核已经运行、忙碌或明确跳过时不记录恢复动作；Docker/KVM 在启动命令前等待到健康统一返回 `already_up`，真正执行启动及失败命令后的恢复仍计数。移除先记“已重启”再发现无需操作的路径，日志和诊断改为准确的恢复尝试表述。
- **错误可见性：** 商业 Key 的独立搜索继续返回原有 `403 commercial_search_unpriced`，补齐错误原因、拒绝终态和错误计数；日志按客户端请求限制分类，总览 SLA 不将这类既定拒绝算作服务故障。默认静音、授权、计费边界和历史记录不变。
- **验证：** 本地定向回归以及 Linux/Node 22 候选镜像的 132 项相关测试通过，覆盖瞬时/持续故障、真实 Unix socket、Docker/KVM 等待与启动、维护竞态、暂停/未知容器、真实 SQLite 日志和总览 SLA。Linux 首轮发现旧属组测试只覆盖非 root；按现行 root 使用槽位属组、非 root 保留控制面属组的契约修正测试，50 项关联回归补跑通过，未修改生产权限规则。
- **升级与限制：** 无新增公开接口、配置、依赖、Schema、迁移或破坏性变更；部署后端后生效。服务器修复使用原运行镜像加本轮六个后端文件的可回滚派生镜像，不附带其他主线变更或上游升级。未绕过上游额度、模型禁用和客户端取消，不能保证消除所有供应商过载。

## 2026-10-30 GPT/Codex 调度正确性与可配置策略

- **新增功能：** 设置 → OpenAI 增加账号调度区，提供 Smart、重置优先、轮询、最近使用四种策略与严格/优先/宽松三种亲和模式；五项系数可配置，默认仍为 1/0.8/1/0.5/0；审计后删除会收窄等待集合的 queue 系数，历史配置加载时丢弃，新保存携带该字段返回 400。复用现有 routing API 与 revision 校验，不新增公共路由。
- **重试修复：** 合并 GPT 外层同账号重试与 helper 隐式重试，每次实际 Node→kernel 调用统一计数并写 attempt ledger；修复调用同样计入上限、消耗 RPM。取消与派发截止后不再发送；已开始的长输出继续使用原有超时规则。发送不明、外部副作用和未证明可重放的普通 5xx 不再仅凭“尚未输出”自动重放。
- **准入与反馈：** 排队票据在唤醒和实际占用之间仍持有优先权，修复新请求抢位及多余提前唤醒；取消/超时/退出释放票据。未知/null/过期额度保持未知，不再获得满额评分。容量拒绝、账号失败、请求错误、取消和传输不确定性分开反馈。
- **续写与账号保护：** 新增前向迁移 `071_codex_response_owners.sql`，以 Key 范围和 response ID 哈希保存 24 小时响应归属及出站会话；跨 Key、未知、过期或更换账号身份的增量续写返回 409。GPT 接入现有 SQLite CAS 账号错误保护、冻结状态和手动清除；保护默认关闭。迟到结果不能恢复已被管理员修改的代次。诊断写入失败不会替换已成功的响应。
- **破坏性变化与升级：** 升级前没有 owner 记录的旧增量续写必须改用完整上下文重新发起；不迁移/补造历史 response owner。普通完整历史请求不受此限制。部署代码时应用自动执行新增迁移；本轮只交付源码，不操作生产数据库。回滚需同时评估新策略字段及续写契约。
- **清理与限制：** 删除双层重试及重复计数/健康反馈路径；修正现有账号保护热加载对 compiled policy 的重复编译入参和凭据代次 fallback 的提前引用。保留 VM、节点、代理、商业优先级、权限复核和 request 级一次结算。Images/Search 复用选号与公平准入，其原生 HTTP 不虚报为 kernel attempt；自动恢复探测、诊断 ZIP、多控制面共享租约未纳入，无新增运行依赖。
- **验证：** macOS / Node 24.22.1，17 个受影响 Node 测试文件 289/289 通过，包含真实 SQLite 旧库升级、续写归属、重放边界、预算、排队与 GPT 冻结；前端设置控件和四语 6/6、TypeScript 通过；浏览器检查策略切换、严格亲和、权重编辑与布局。未执行真实供应商推理、Docker 验收、发版或部署。完整行为与验证范围见 [GPT/Codex 调度契约](cpr/05-codex-scheduling.md)。

## 2026-10-30 邮箱作为用户登录名

- 新建用户与供应商登录账号支持完整邮箱作为用户名（总长最多 254 位，本地部分最多 64 位），原有 2–32 位用户名规则继续有效；邮箱沿用现有密码登录、大小写不敏感的查询与重名保护。
- 删除用户表单只允许传统用户名的重复校验和 HTML pattern，放宽输入长度；后端统一校验普通账号与供应商账号，四语提示同步说明邮箱支持。编辑邮箱用户名的账号不再被旧校验拦截。
- 无新增公开注册入口、邮件验证、接口、配置、依赖、迁移或破坏性变更；邮箱是登录名，个人资料中的联系邮箱仍单独维护。部署后端与前端后生效，本轮不发版或生产部署。
- 验证：用户/供应商相关单测 27 项、HTTP 集成 14 项、四语检查 10 项通过；TypeScript、ESLint、格式与 diff 检查通过。浏览器在隔离测试库完成长邮箱（含数字开头与 +）创建和编辑保存；未向真实邮箱发送邮件。

## 2026-10-30 侧栏版本更新弹层与登录焦点

- 超管侧栏版本号改为更新弹层：显示当前运行版本、新版提示、手动检查、发布链接、确认升级、运行/失败反馈及宿主机命令。沿用现有版本与升级 API；连接短暂中断时继续核验，升级成功且版本匹配后刷新页面。关闭弹层不卸载更新状态控制器。
- `/settings/about` 移除版本卡与一键更新区域、升级状态和重复版本查询，只保留完整更新日志与读取错误提示。更新日志入口位于版本弹层内，继续使用项目自有上游 CHANGELOG.md。
- 路由负责注入更新控件，基础布局不依赖业务 feature；普通管理员与用户仍不显示版本入口或发起版本查询。清理旧 VersionChip、密码聚焦 Effect/ref、失效 UI 文案，补齐四语宿主机命令和日志空态。
- 保留同期主线手工发版从 `.1` 起步的独立修改。无新增后端接口、配置、依赖、迁移或破坏性变更；现有宿主机升级权限与确认保持，不执行真实升级、发版或生产部署。
- 验证：相关显示/查询/导航/四语 20 项通过；TypeScript、Prettier、ESLint 检查通过（认证路由保留既有 Fast Refresh 警告）。浏览器验证登录初始聚焦用户名、Tab 到密码；使用隔离模拟升级接口验证新版弹层、确认、运行禁用、成功自动刷新、已是最新状态和关于页纯日志。

## 2026-10-30 登录页默认焦点修正

- 打开登录页时自动聚焦用户名，Tab 按表单顺序进入密码；删除密码框的自动聚焦和重复挂载聚焦 Effect/ref。
- 保留浏览器正常的用户名/密码自动填充和登录验证。无新增接口、配置、依赖、迁移或破坏性变更。
- 变更文件 Prettier、ESLint 通过；浏览器检查默认活动元素为 login-username。部署前端后生效，本轮仅交付代码，未部署或发版。


## 2026-10-30 手工发版修订号从 1 开始

- 三段基线与 `.0` 比较等价，手工发版首次生成 `X.Y.Z.1`，后续按同前缀已占用最大修订号加 1；新上游基线重新从 `.1` 起步，保留三段版本的前导零。例如 `v1.4.028` → `v1.4.028.1` → `v1.4.028.2`。
- 已存在 `.0` tag/Release 和旧计划继续识别，避免破坏历史资产与构建重试；新规划不再生成 `.0`。草稿和孤立 tag 继续占号，纯构建验证不占号。自动上游新版发布仍使用三段原版号。
- 同步修正版本规划、现有发布回归、工作流输入说明和文档；发布工具 57 项测试全部通过。不更改业务 API、数据结构或服务器配置。

## 2026-10-30 撤销额外资金预留与待对账机制

- **来源与恢复：** 基于已交付 `97b878970078c4af3f8df7e8080097346d6773a7`，保持官方父提交 `8cb05ff261dd6d8a7e90479463b33bc6e1585730`（1.4.028）；对照该上游 `attachPricing`、`billCodexKey` 和 Key 事后计量条件恢复行为，不同步上游。
- **移除：** 删除资金/套餐预留估算、按请求体字节和最大输出预扣、为预扣补写输出上限、在途账单落库、重启待用量恢复、人工释放/重计价 API、待对账运维卡与告警、日志榜单待对账列以及对应四语和需求。角色变更及备份恢复不再读取历史预留；真实在途请求仍阻止备份覆盖。
- **保留的独立功能：** 管理域共享钱包、同域转账、充值/冲正、分组授权、套餐、Key 金额/窗口/RPM/并发和超管免钱包规则继续使用。准入按当前余额及已消费额度检查；请求结束按上游链路的计量条件一次记账，不产生待处理任务。已放行并发请求可能透支，耗尽后的请求被拒绝。
- **历史与迁移：** 新增 069，仅把历史已完成消费复制到 `billing_charges`，用于原有的扣费幂等和套餐实际消费统计；新表只写请求结束后的事实，无预留字段、待处理状态或恢复队列。历史 `billing_reservations` 表和已应用迁移校验和保留，无运行读取方；旧未知记录不再占用资金，不自动补扣，不重算已扣金额。档案物理删除需单独的数据处置授权，代码部署后即可停止受旧预留影响。
- **破坏性变化：** 移除 `/billing/requests/:id`；钱包响应不再返回 `reserved`，可用余额等于实际余额；独立运维响应随后已整体移除，排行移除 `pending`。无新增外部接口、配置、依赖或定时任务。不同执行链的失败/部分用量计量遵循上游，不能将所有失败统一视为免费。
- **升级和验证边界：** 需部署前后端，启动时应用前向迁移；本轮不执行生产部署或数据操作。真实 SQLite 升级与幂等、HTTP VM/API/WS、钱包/套餐/Key 回归通过；前端四语/日志相关 47 项与 TypeScript 通过。浏览器用旧记录预留 9 USD、实际余额 10 USD 的隔离账号验证：可用余额为 10 USD，页面无预留卡。历史迁移测试补齐此前遗漏的 067/068 和新增 069；异常响应测试等待实际完成日志后再检查扣费，避免读取上一请求结果。未访问真实供应商。

## 2026-10-30 Codex 缺失窗口与零长度窗口修正

- **根因与修复：** WHAM 完整额度响应中的空窗口现在明确覆盖此前缓存的对应 primary/secondary 字段，避免接口已返回 5H 不可用，列表仍从旧推理响应头恢复 0% 和过期重置时间。推理响应明确给出窗口长度 0 时，该窗口不再被当作有效 5H；真实有效窗口的 0% 仍正常展示。
- **被动更新契约：** 真实用户请求返回的 5H、7D、7D F 额度按窗口更新并持久化；缺少某窗口的新数据时保留其缓存。完整手动查询与部分推理响应分开处理，不增加自动探测、额外模型请求或定时清零；历史请求、费用和 Token 保留。窗口到期的既有有效性判断保持。
- **验证与范围：** Node 24.22.1/macOS 下 Codex 额度、被动响应、列表费用、调度与槽位回归 107/107，Claude 逐窗口响应缓存与旧快照覆盖保护 8/8 通过。保留同期管理域、充值和供应商界面交付，相关调用方重新检查 33/33 通过。无新增接口、配置、依赖、持久化字段、Schema 或迁移。
- **升级与限制：** 部署后生效，同版本推送不发版。上游未提供 5H 时额度为未知，费用沿用既有最近 5 小时统计，不能把未知额度或更新缓存当作删除真实费用。没有消费重置券或删除历史账务，本轮代码未部署到生产。

## 2026-10-30 管理域授权、充值与供应商账号展示修正

- **来源与范围：** 普通需求基于已交付 `6a978833763d855372c3f8231327092c92c10e98`，保留上游唯一父提交 `8cb05ff261dd6d8a7e90479463b33bc6e1585730`（1.4.028）及全部既有定制；不附带同步上游。以下规则取代较早记录中的逐人分组授权、管理员仅可给直接创建用户充值、旧“服务提供商”页面保留等说明。
- **授权修复：** 超管保存任一域管理员的分组授权后，事务内同步同域所有管理员及用户的分组集合；管理员倍率/RPM 一致，用户原有专属值保留，新增用户组使用默认值。新建下级成员自动继承，根管理员删除后仍按固定域归属处理。用户独立授权可调整，下一次保存域授权重新同步。Key 弹窗打开时刷新实际可用组，刷新中或失败时不使用旧选项。撤权对已有 Key 即时生效；管理员不能自行扩大域授权，也不能创建或保留无分组平台 Key 的调用能力，超管自用无分组路径保持。
- **充值修复：** 同域任一管理员可以给域内任意普通用户充值，原子扣共享钱包并写入双边流水；跨域、余额不足和重复幂等保护保持。充值原因选填，操作者和审计继续记录；超管给普通用户充值仍须为直接创建者，给管理员注资仍进入域钱包。
- **页面与本地化：** 超管充值页移除顶部汇总卡和待对账操作区；按金额正负显示“余额增加 / 余额扣减”，提供四语文案。删掉失效的待对账字段、全站统计查询、前端操作状态和专属文案。资金流水和实际扣费保留；后续撤销预留、人工核算 API 和待对账告警，不删除历史账务档案。
- **供应商统一：** 超管“供应商平台 → 账号池”与供应商门户复用账号展示，展示相同的账号身份、平台/授权、状态、额度重置、并发、今日/累计费用、缓存命中率和创建时间；超管保留供应商筛选、维护及 VM 入口。两个接口继续共用原有脱敏投影。删除重复“服务提供商”导航、页面、路由、查询、专用投影接口及四语资源，不保留另一套账号展示。
- **破坏性变化与升级：** 无新增公开接口、配置、依赖或 Schema 迁移，移除一个已无调用方的 `/api/panel/providers` 接口及其页面。旧域存在分组差异时，部署后由超管按期望内容保存任一管理员一次即可同步；不擅自合并历史授权。旧管理员 Key 若未授权或未绑定分组，需配置域授权并绑定分组后再使用。全站 `/billing` 不再返回汇总余额与 pending 请求列表，用户详情和域余额接口保留。代码推送不代表生产部署或改动线上数据；同版本不自动发版。
- **验证：** 真实 SQLite 和 HTTP 覆盖同域同步/继承、跨域拒绝、撤权、保存中途失败回滚、专属倍率/RPM 保留、根管理员删除、角色切换、共享钱包余额守恒、空原因和幂等；超管平台 Key 计费与 VM/API 商业链继续通过。前端类型、多语、相关格式检查通过；本地浏览器验证 Key 弹窗重新打开读取最新分组、超管充值页精简和增减流水。供应商管理/门户 HTTP 回归通过；浏览器使用同一批隔离测试账号对照两端字段、数值、未知状态和入口，确认一致。路由生成及生产前端构建通过；保留已有的大包提示和供应商门户 Fast Refresh 警告（无错误）。验证仅使用本地测试数据，没有调用真实模型或操作生产。

## 1.4.028 上游同步（2026-10-30）

- **来源与范围：** 基于当前交付 `2060c3da4bcdea6765f9243e6b75150f08754434`，吸收上游 `0e373204` 至 `8cb05ff261dd6d8a7e90479463b33bc6e1585730`，包含 1.4.028 release cut 及之后的 #815/#832。保留供应商表单/平台价格/备注、067/068 迁移、供应商平台修复与 Codex 重置窗口统计等全部后续定制。根 CHANGELOG.md 与冻结上游逐字一致。
- **优化与修复：** 采用 #665 Codex 按账号定向唤醒、重入队保序与原始记录额度同步，减少无关等待者重复选池；保留实时分组授权、供应商停用、分组优先级、同账号重试及单次结算规则。采用 #807 不再读取无人维护的 accounts.schedulable，仍尊重 VM 开关和账号 active 状态；#818 按最近写入顺序删除过期缓存快照；#814 在 CLI 组装最终阶段补 eager_input_streaming，工具 cache_control 清理不再误删该字段；#819 保留数组 system 与缓存标记；#817 初装 hello 和 /usage 附加官方 CLI 身份。
- **前端与冲突：** 账号列表、机架大卡和紧凑卡提示增加凭证订阅到期；仅 GPT 的 chatgpt_subscription_active_until 是依据，缺失或 Claude 显示未知，不用 token 到期/额度重置推算。保留分组列、分组标签、请求配置快照和四语资源；新增订阅文案同步简中、繁中、英文和日文。清理机架组件重复翻译导入，无重复订阅推断路径。
- **破坏性变化：** #815 取消将强制工具选择静默改成 auto 并注入 strict 的逻辑；不兼容模型/思考设置明确返回 HTTP 400 tool_choice_incompatible，无效工具选择返回 invalid_tool_choice。兼容请求保留调用方 tool_choice 与 strict。本地 Haiku 5.5 的 adaptive-only 契约同样适用，正例测试改用允许关闭思考的 Haiku 4.5；Responses 继续遵循本地已授权的协议入口规则。
- **验证与清理：** Node 24.22.1/macOS 定向 403 项、商业授权/结算/原生目录 HTTP 6 项通过；前端现有 49 项加订阅凭证/日期边界/语言回归 3 项通过，TypeScript、Biome、Prettier、ESLint 与 diff 检查通过（机架组件保留 3 条既有 fast-refresh 警告）。初装旧测试改为验证保留身份/settings/credentials、按保存策略写 native kernel 配置且不创建 Go sidecar、不自动开启遥测；无真实 Docker/OAuth/付费请求。浏览器使用临时合成数据渲染实际账号列表，核对到期、过期、未知与分组同屏。Linux/ARM64/远程客体由对应 CI/部署验收确认。
- **从已完成 1.4.027 升级：** 本轮 payload、CLI、kernel、Go worker/helper、ARM64 overlay 和依赖锁定均未变化。等待本仓库 v1.4.028 系统 Release 与镜像成功后，在部署机原 Compose 目录沿用全部覆盖配置，执行 `TAPMODELS_IMAGE_TAG=v1.4.028 docker compose pull tapmodels`，再执行 `TAPMODELS_IMAGE_TAG=v1.4.028 docker compose up -d --no-deps --force-recreate tapmodels`。镜像同时更新 Node 和 web/dist，重启控制面；不必仅为本版重复 fetch:payload 或槽内重启。源码部署需更新源码、安装匹配依赖、重新生成 web/dist，再按原服务管理方式重启。ARM64 沿用既有覆盖配置重建控制镜像；本仓库正式应用镜像仍为 amd64。
- **跨版补齐与完成判据：** 若仍为 1.4.026 或更早、未完成 1.4.027 内核升级，Docker 新镜像入口已打包更新 payload；随后在控制面容器执行 `node /opt/tapmodels/scripts/fleet-services.mjs` 完成本机/远程 wrap-cli/sync（restart:true）及遥测确认。源码方式需先执行 `npm run fetch:payload`，再执行上述槽同步。目标 payload 为 payload-2026.10.29-telemetry-kernel，kernel f57d4e71081b…、cli-node 8484c4c58f4b…；同步与遥测 failed_count 均须为 0，逐槽健康 vm_telemetry/telemetry_ready 为 true，停机/跳过/远程离线项须单列。更早版本还需累计执行对应 Go OAuth worker/ARM64 升级要求。确认控制面 1.4.028、浏览器刷新加载新版前端，且原健康槽仍健康。
- **升级与边界：** 上游本轮无新 SQL/Schema/配置/依赖或公开 HTTP 路径；新增内部工具校验与订阅展示辅助函数，不新增并行服务。相对旧部署未应用的本地 067/068 等迁移会在应用启动时执行，部署前备份 data 并核对待迁移列表，不改写历史迁移。保留 routing.json、vms/、data/、.env 及全部挂载；控制面重启和跨版槽重启应安排空闲窗口。代码推送触发已授权的新版应用及全部 guest/KVM 自动发布；本轮未执行生产部署、生产迁移、真实遥测上传或数据删除。

## 2026-10-30 Codex 重置券后的窗口费用归零

- **Bug 修复：** Codex 兑换成功且上游确认实际重置窗口后，先持久化 `codex.cleared_windows`，再查询最新额度。列表、详情、概览及用量统计复用现有窗口费用裁剪与缓存键，5H/7D 金额、Token 和请求数只累计重置后的记录；解决额度已为 0%，右侧仍显示重置前 5H 消耗的问题。
- **失败与清理：** 后续额度查询失败仍保留已确认的统计边界并沿用现有警告；兑换失败或 `windows_reset=0` 不移动边界。移除 Codex 统计误读 Claude 清零边界的分支，普通查询和推理写入保留 Codex 边界。不删除历史请求、累计费用或账务数据，不新增并行聚合逻辑。
- **验证：** Node 24.22.1/macOS 相关 81 项回归通过，覆盖真实 SQLite 聚合、列表/详情/用量读取、重置时间未变/缺失/已过期、重置后新请求、刷新失败与兑换失败/无重置；相关格式和 diff 检查通过。没有消费真实重置券或执行真实推理。
- **升级与限制：** 部署后对新执行的重置生效；旧版本未记录的兑换时间无法可靠补算，本次不修改既有服务器数据。无新增 HTTP 路径、配置、依赖、Schema 或迁移，无破坏性变更；新增内部持久化边界及现有 `codex_usage.quota` 的对应只读字段。本轮同版本代码交付不发版、不部署。

## 2026-10-30 供应商表单、分平台采购价格与备注

- **表单与清理：** 超管供应商新增/编辑移除名称、邮箱、供应商编码、联系人及结算邮箱输入与表单状态，币安 ID 去掉“文本”后缀。新增登录时内部名称、编码采用登录账号，必需的内部邮箱自动生成；不伪造联系人或结算邮箱。旧记录的身份/联系方式不清空，供应商列表与独立开户接口仍读取这些字段，故保留底层字段与历史迁移。
- **平台与分组：** 供给平台、分组分别有标题，采用等宽可点击选项网格、选中高亮、长名称换行；分组列表限制高度并可独立滚动。资源限额与原有权限开关保留，供应商归档只读保护继续有效。币安 ID 旁新增可选备注，最多 1000 字，超管列表/详情/编辑可回读；备注不进入普通供应商主体或结算档案投影。
- **采购价格：** 选择 Anthropic 显示 Claude 单价，选择 OpenAI 显示 Codex 单价；同时选择则分别填写。复用 group_prices.anthropic/openai，按供应账号真实平台汇总官方价费用后分别换算 USDT；供应商端档案、结算预览及合同展示同步区分平台。校验平台和正数价格，未知用量平台不能猜价结算；保留最新预览摘要校验、付款边权限和金额安全精度保护。
- **历史与升级：** 新增 067_vendor_contract_platform_prices.sql 为合同冻结平台价格；新增 068_vendor_admin_remark.sql 保存超管备注。历史合同空价格映射继续使用其原统一价格与原舍入口径，历史账单不重算；显式保存原先仅存在档案中的平台价格时生成新合同版本。统一价格字段仍服务历史合同及现有用户开户/下级开户接口，未撤销这些独立入口。无数据删除、无新增依赖；需部署代码并由应用启动迁移后生效。本轮未生产部署、生产迁移或发版。
- **验证：** 合并远端供应商系统修复后，供应商/权限/结算单元与 HTTP 回归 38/38；覆盖真实 SQLite 旧库升级与重复迁移、单价校验、混合平台金额、合同版本/历史账单及备注保存/清空/权限投影。前端 TypeScript、相关格式与 ESLint（既有门户 Fast Refresh 警告保留）、国际化与门户模型 8/8 通过。浏览器在隔离测试服务核对删项、平台单价切换、分组选择、实际保存/编辑回填及手机无横向溢出。

## 2026-10-30 供应商系统完整复核与缺口修复

- **需求与资料：** 对照供应商产品、角色、领域、API、安全、状态机、实施/验收和 sub2api 来源，更新 01–09 规划，保留 10 号历史交付，新增 [11-完整需求复核](supplier-platform/11-system-review-20261030.md)。逐项记录已实现、本轮修复与仍未实现，纠正旧角色、迁移编号、假设表名/接口和“无条件加密”描述。
- **身份与范围：** 下级开户只新建独立登录账号，禁止绑定无关已有用户；成员绑定校验角色/状态/唯一有效主体；子级能力和空范围受父级限制。开户和配额检查置于事务，幂等键重试返回原子级，参数冲突拒绝；写入前重读成员/能力，失去下级能力后汇总/审计只读自己。
- **资源与授权：** 账号/配对 VM 同步暂停、恢复和归档；独立供应商暂停保护不覆盖操作员停调。Claude/Codex 选号和展示读取当前供应商/父级范围，磁盘或凭据刷新不能复活已撤销供给。开户重放不再绑定新代理或启动，缺失配对显式报错；无效代理状态不再先改变池。VM start/stop 调用真实运行时。供应商终端限定为固定 `auth login`，票据和会话复核身份，导入/换码提交前重查归属。
- **结算闭环：** 预览摘要覆盖合同和账号用量明细并保存冻结快照；旧预览、超安全精度金额拒绝。同周期重试返回旧单、确认幂等，归档主体只读。超管显式开启 `settlement_pay` 后，一级供应商在自己付款边预览/生成/确认/登记/作废；超管与供应商复用同一状态机和操作组件，不给二级或其他付款方越权。
- **清理与准确性：** 删除累计 Token 冒充 TPM 和原始上游错误投影，时间支持秒/毫秒/ISO 并遵循当前语言；移除超管重复的付款弹窗代码。修正旧测试把新建已有用户绑定、供应商暂停覆盖手动开关等行为当作正确结果的问题；macOS 系统信息允许设计中的 unknown，Linux 仍要求实际数值。
- **验证：** 新增 S01–S12 单元/真实 HTTP 缺陷场景和授权终端撤权回归，相关供应商、权限、两种账号池、调度与终端 231 项通过；追加归档子级历史聚合后供应商/HTTP 定向 38 项通过；前端相关 20 项、TypeScript、格式/lint 及生产打包检查通过，浏览器核对下游账单操作和预览。真实 Linux 客体、真实供应商 OAuth、生产与实际付款未执行。
- **边界与升级：** 无新增 Schema/依赖/运行配置，不修改历史迁移或生产数据。新增下游预览与确认/付款/作废共 4 个 HTTP 路径；新增 1 个超管业务能力开关，默认关闭。批量导入导出、代理诊断/完整编辑、分组计价、独立消费事件、冲正/争议/补单、MFA/step-up、跨进程 claim 和部署验收仍未全部实现。部署前后端后生效，本轮代码推送不发版、不部署。

## 1.4.027 上游同步（2026-10-30）

- **范围与修复：** 在交付 `e32b93d0` 的全部定制上合并 `0e373204`，并保留远端 `3a1c95dd` 恢复重试弹窗原界面及修复滚动的后续交付；上游仅修改版本、CHANGELOG、kernel payload 和一处遥测文案。新的公开 Rust kernel 补齐 #822 所需的顶层 `vm_telemetry`、`telemetry_ready`、`telemetry` 以及 `/internal/v1/telemetry/events`，解决 1.4.026 配套内核缺失接口引起的遥测发布验收失败。
- **冲突与清理：** 仅有遥测状态文案冲突；采用上游“待发送”语义，保留本地四语和状态确认逻辑，将旧 `pendingBatch` 键替换为 `pendingSend`，同步清理四语旧键。无重复遥测实现、旁路或跳过验收。保留管理员/供应商、账务、授权、请求重试与日志等既有定制。
- **资产：** 清单更新为 `payload-2026.10.29-telemetry-kernel`；`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 均锁定 13228472 字节、SHA256 `f57d4e71081bbca0b5bc2ba15886a7149c3e34c256a890ec51e084a9fcd14288`。cli-node 保持 27933052 字节、`8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b`；OAuth helper、Go helper 源码、ARM64 CLI 源码与工具锁定不变。
- **验证：** 实际下载新 kernel 并核对大小/SHA256，全部 12 个清单条目与 Release 元数据一致。复用已授权的本机官方 1.4.026 Docker 隔离环境，仅在临时夹具中换入 1.4.027 kernel，CLI 保持相同：健康 HTTP 200，vm_telemetry/telemetry_ready 为 true，telemetry 为 disabled/pending_events=0；合法事件 POST 200、非法事件 POST 400、GET 405、未知路径 404，延迟复查仍正常。网络关闭、合成凭据，无生产账号、付费推理或遥测上传。Node 24.22.1/macOS 遥测/舰队/同步/内核健康 25/25，前端遥测/国际化 19/19，native CLI 清单工具 7/7，相关格式与 diff 检查通过。
- **从 1.4.026 升级：** 等待本仓库 v1.4.027 镜像正式发布后，在部署机原 Compose 项目中更新控制面，保持全部配置文件和挂载。新镜像同时交付 Node、web/dist 与新 kernel，入口更新 bin/share；之后在控制面容器运行 `node /opt/tapmodels/scripts/fleet-services.mjs`，完成本机/远程槽的 wrap-cli/sync（restart:true）及遥测确认。源码部署先更新 Node/web/dist、执行 `npm run fetch:payload`、重启控制面后再运行该脚本。ARM64 使用原覆盖配置重建或取得相应新版镜像；CLI overlay 源码锁定无变化，不代表控制面镜像无需更新。
- **完成判据与限制：** 控制面显示 1.4.027、控制面及 Claude 槽内 kernel 哈希为 f57d4e71…、逐槽同步/发布 failed_count=0，原健康槽内核仍健康，关闭遥测的 VM 确认 disabled/pending=0。不要仅以版本号判断成功；重启内核可能中断在途请求，安排空闲窗口。保留 routing.json、vms/、data/、.env 及全部现有挂载；无新增公开业务接口、运行配置、依赖、SQL 迁移或数据删除。内部遥测接口的补齐不改变现存业务契约。本次代码推送触发当前规则的新版自动发布；生产部署、真实 OAuth/上传、KVM 与远程生产节点升级验收未执行。

## 2026-10-30 重试弹窗恢复原界面并修复滚动

- 撤回上一轮误扩大的界面调整：移除设置分组和交付模式卡片，恢复原有控件顺序、按钮、间距及四语完整文案；删除新增的分组/交付说明文案键和单选卡片接入。
- 仅修复下方内容无法滚动到达的问题：用普通容器承担弹窗正文滚动，fieldset 保留禁用表单的职责；标题和操作栏禁止收缩，恢复后的界面可滚动到最后的“签名修复”。配置字段、取值与应用草稿行为保持原样。
- 验证：本机浏览器复现原 fieldset 滚轮后 scrollTop 仍为 0；修复后相同滚轮操作到达底部（桌面约 547px、窄屏短窗口约 1041px），末项完整可见且底栏在视口内。ESLint、Prettier、diff 检查及相关国际化检查 9/9 通过；四语资源与改版前逐字一致。
- 无新增接口、配置、依赖、迁移、数据处置或破坏性变更。部署前端后生效；本轮未发版或生产部署。

## 2026-10-29 超管供应商平台与供应商门户联通

- **新增：** 超管侧栏增加“供应商平台”，提供供应商管理、账号池、代理管理、用量统计、结算对账五个入口。参考 `holeenlu/sub2api@0276190e775b369319acc18bc1c120a4469a71ae` 的超管供应商工作台，按本项目 React/Node/SQLite 实现；来源、取舍和接口见 [移植记录](supplier-platform/10-super-admin-platform.md)。
- **主体与资源：** 原子创建供应商登录和主体，编辑平台/分组、上限、下级能力、联系人和结算参数；两端共用账号/配对 VM 与统一代理池，支持新增、重命名、暂停/恢复和归档，授权继续使用现有 VM 详情。超管管理权限不授予普通管理员或供应商。
- **用量与结算：** 成功已定价请求与日志同事务记录供应商事实，以请求 ID 去重；结合留存旧日志形成两端统一的期间统计。合同版本、结算预览/生成/确认/作废、幂等分次付款登记及详情均使用现有表，供应商账单显示同一快照、状态和已付金额。平台一级账单含直属下级用量，下游账单在超管侧只读。未定价、重叠周期、过期预览、超付和重复付款冲突拒绝。
- **清理与修复：** 删除供应商日期统计回退无日期累计快照的旧路径，合并下游结算生成实现；修复二级供应商上游账单缺失、归档账号未经过调度暂停、代理暂停未同步统一池的问题。供应商停用独立阻断 VM 调度，恢复不清除其他保护；有限父级额度下未指定的子级上限继承父级，实际资源总占用包含直属下级；代理入池失败回滚资源。四语导航、页面与账单状态同步。
- **升级与边界：** 新增 14 个后台路径模板、22 个方法/路径组合；无新增配置、依赖、Schema 迁移或生产数据操作。需部署 Node 与前端后生效，本轮不发版或部署。付款登记不转账；不包含自动付款、退款/冲正、额外分组供给/审计页面或全套分组阶梯计价。历史已删日志、关闭日志期间和网关外用量无法重建，事实与结算保留记录时价格。
- **验证：** 相关后端 115 项通过，最终追加资源/结算边界后供应商平台/管理/HTTP 21 项通过；前端相关 19 项及后续账单/国际化 12 项通过，类型、格式、ESLint 和生产构建通过。浏览器验证五个管理页、超管编辑与供应商端共享账单；本轮只使用隔离测试数据。

## 2026-10-29 欢迎页导航移除文档入口

- 移除欢迎页桌面导航和手机菜单中的“文档”链接，并清理本组件不再使用的文档地址导入。页面区块导航、语言、主题及登录入口保留。
- 首配清单仍使用共享文档文案与地址，故保留其资源。无新增接口、配置、依赖或数据变更；部署对应前端后生效，本轮不发版或部署。
- 验证：修改组件的 Prettier、ESLint 及 diff 检查通过；本机浏览器核对桌面导航和 390px 手机菜单，均无文档链接。

## 1.4.026 上游同步（2026-10-29）

- **来源与优化：** 从已交付 `d5193a66`（上游父提交 `bc9d1873`）合并上游 `2f6b45c2`，并保留推送前远端 `ab98f247` 的欢迎页导航清理。吸收 #824 实际出站思考强度日志、#825 Usage Policy 拒答归类与用户正文近似匹配、三题决策模型，以及 #826 ARM64 CLI 清单和 smoke 修复。根 CHANGELOG.md 完整保持上游原文。
- **冲突与定制：** 6 个冲突文件逐段融合；保留日志与风险页四语文案、tapmodels 路径、商业 Key/分组授权、请求快照、钱包结算、管理员域、供应商和额度功能。拒答指纹预览增加多行显示与原始错误提示。日志优先记录调用方 effort，否则采用模型默认值，off 留空；派发前失败仍保留入站值。
- **Bug 修复：** 修复上游旧题库迁移可能覆盖用户仅编辑过的 NSFW 问句；存在该编辑时保留整套题库、说明与启停值。新增回归在修复前失败、修复后通过。未编辑的旧内置题仍迁为 usage_policy / nsfw / abuse 三题，历史 ID 仅用于已有配置迁移和自定义题，不恢复六题默认执行路径。
- **行为变化：** 上游拒答近似匹配排除环境、提醒与工具回传，短于 512 字仅做精确指纹。NSFW 低于阈值不再享受近失放行；拒答保护启用时，NSFW 命中不受普通 device_block_enabled 开关限制。自定义问题仍保留；不删除既有拒答记录或执行 SQL 迁移。
- **资产与升级：** payload 更新为 `payload-2026.10.29-telemetry-slot-start`，cli-node 为 27933052 字节、SHA256 `8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b`，ARM64 嵌入源码锁定 `ced77bcd9639314e6f277c23d91c98f5e178add7eb1eb93538d51ad1cb500830`。遥测改为每次 slot 开始伴生一条事件；关闭策略保持。Node 与 web/dist 同步升级，执行 `npm run fetch:payload`、`wrap-cli/sync`（restart:true），并按上游说明更新 Go OAuth worker；ARM64 控制面需重建 overlay。配置和业务数据不得被覆盖，定制 Go helpers 继续从源码构建。
- **验证：** Node 24.22.1/macOS 定向单测 118/118；日志、授权撤销与商业 HTTP 回归 12/12；前端日志、风险与国际化 43/43，TypeScript 通过；native CLI 工具 7/7、自动发布保护 8/8 通过。真实下载 CLI 已核对大小与 SHA256，Release 资产元数据与清单一致。UPX 压缩内容的解包、嵌入源码哈希及 ARM64 运行验收交 Linux CI，不在 macOS 直接执行 Linux 二进制。
- **新增与限制：** 无新增公开 API、运行配置、依赖或 SQL 迁移。本次新增版本推送按现行规则触发应用及 guest/KVM 自动发布，最终结果以 Actions 为准；未执行本机或生产部署、槽位在线升级、数据处置或真实付费请求。

## 2026-10-29 运营管理菜单顺序优化

- 将“运营管理”菜单调整为：总览 → 统计 → 使用记录 → 用户 → API 密钥 → 充值记录 → 服务提供商。按用户指定顺序集中展示总览、统计和记录，其后排列用户、密钥、充值与供应商。
- 直接调整现有导航定义，不增加排序配置、重复菜单或新入口；角色裁剪、个人账户分组、路由、默认登录页和权限规则保持。无新增功能、Bug 修复、破坏性变更、接口、配置、迁移或数据操作。
- 前端更新后生效；本轮不发布或部署。验证采用现有导航回归、相关格式检查及本机浏览器菜单核对。

## 2026-10-29 服务提供商账号范围与展示修正

- **功能与优化：** 超级管理员的“服务提供商”以未归档的供应商账号资源为列表来源；未绑定 VM 或尚无用量的账号仍显示，平台自建 VM 不进入列表和汇总。表头明确为“账号 / 供应商”，供应商显示该主体下账号创建者的有效登录名称；创建者未绑定时按主成员、创建时间和成员 ID 稳定选择有效成员，无有效成员时显示“—”，不冒充平台资源或主体名称。
- **界面：** 保留搜索、活跃/总数、接近 7D 限额和累计消耗，展示状态、5H/7D 额度进度与恢复时间、累计消耗/请求、Token、独立调度配置（当前并发/上限与 RPM）及查看 VM。搜索支持供应商登录名。未授权和停调账号不计入活跃数。
- **Bug 修复与清理：** 删除从全部用量账号生成供应商列表及按 VM 追加补齐的两条旧路径，统一按供应商账号资源生成列表；删除“平台资源”兜底、旧表头和旧恢复时间文案。恢复时间接受 Unix 秒、毫秒和 ISO 时间，不再裸显时间戳。四语文案同步更新。
- **接口与升级：** 无新增 API、运行配置、数据库迁移或生产数据操作；现有 `/api/panel/providers` 的 items/totals 范围收窄为供应商账号，行 id 使用供应商账号资源 ID，vendor_name 表示登录名。仅本页面消费此接口；超级管理员权限保持。部署对应版本后生效，本轮未发版或部署。
- **验证：** Node 24.22.1/macOS 下供应商 HTTP 回归 2/2（包含平台 VM 排除、供应商无权访问、无用量账号保留、登录名与主体名不同）；前端展示及国际化 12/12，TypeScript 检查通过。浏览器使用隔离测试服务确认账号/供应商列、仅一条供应商账号、供应商名称搜索和调度列；未调用真实供应商推理。相关格式与 diff 检查通过。
- **限制：** 未采样到额度显示“—”；供应商账号归档或主体软删除后不再展示，不删除历史账务数据。继续复用既有用量聚合与 VM 详情，不增加第二套调度或凭据管理入口。

## 2026-10-29 本轮 CI 阻塞修复

- 第二轮 ARM 镜像构建成功后，修正 smoke_native_cli.py 的镜像品牌根路径为 /opt/tapmodels；清理 CI 点名的 5 个 Node 文件格式，并更新当时的 VM 统计测试；后续审计已恢复上游 5% 样本门槛及完整窗口覆盖条件。
- 恢复 ARM64 Dockerfile 中已被 COPY 引用但遗漏的 native-cli 构建阶段，沿用冻结上游的构建方式。将 ARM64 CLI overlay 锁定到当前 payload 的 cli-node：27933000 字节，SHA256 `0e64c401d657d51356011ff4dfd19085f1de41194f0da6173e18bdd41557d740`；下载核对后用已校验 UPX 解包，嵌入源码 SHA256 为 `c03b331e5f96f980ce0a4957d7c47bad1532bf735963e7062bdb8ca7007dff5b`，保留工具和源码双重校验。
- 用户权限 E2E 按现行管理域/余额转账契约更新：管理员能查看本域日志和用户，给用户充值受自身余额约束；继续验证不能管理 VM/系统、跨域或超级管理员。只修正过时断言，未放宽权限实现。
- 格式化 CI 点名的 9 个既有前端文件，不改变业务行为。前端全量 Prettier 检查通过，面板用户 HTTP 与 native CLI 15/15、Python native CLI 7/7 通过。
- 初次提交 CI 的 web、unit 和 ARM 构建失败由以上原因触发；商业契约检查成功。修复后远端 CI 状态另行报告，不能据此宣称 Linux ARM 镜像已构建或已部署。本轮仅使用一次无网络临时容器执行 UPX 解包，没有替换正在运行的服务。

## 2026-10-29 人工发布定制更新

- 当时调整额度估算测试夹具以匹配零用量门槛；后续审计已将实时估算及测试恢复到上游 5% 样本门槛。该次仅调整测试，前端 87 文件、656 测试及 TypeScript/Vite 生产构建通过。

- 人工修订版基于当前 main 已集成的唯一上游父提交和 VERSION 自动递增 X.Y.Z.N；上游继续前进不再阻止发布本地定制更新。
- 保留官方基线归属、唯一父提交、源码版本一致性、版本占号及全部构建/测试门禁。移除人工发版读取实时上游 main 作为强制同步目标的分支；自动新版发布规则保持原有行为。
- 验证：发布工具测试 57 项全部通过（包括实际资产打包/校验回归）；发布工具回归覆盖上游已发布更高版本而当前源码仍发布原基线修订版、非官方父提交和多父提交拒绝、版本不一致及来源查询失败。无业务接口、配置、数据库迁移或生产数据变化。

## 2026-10-29 7D 总量估算与额度操作后的持久化刷新

- **需求与算法：** VM 成本栏“总计”固定表示当前 7D 窗口预计总量。金额 = 当前 7D 官方价消耗 ÷ 已用额度比例；Token = 同一窗口 Token ÷ 同一比例。审计后采用上游估算条件：未来有效 reset、日志覆盖完整窗口、已用比例至少 5%，并排除未定价请求；删除缺少充分需求依据的宽松门槛。例：550.18 / 0.69 = 797.362319，198200000 / 0.69 ≈ 287246377。
- **边界与清理：** 比例未知、低于 5%、缺少有效 reset、日志覆盖不完整、金额非正或存在未定价请求时不输出估算。列表、卡片与机架汇总的未知估算显示“—”，删除把累计消耗或累计 Token 回填到预计总量的旧逻辑；有估算时显示“≈”。原累计统计和历史窗口余量统计继续保留各自语义。
- **持久化刷新：** Claude 限额查询、重置复用同次响应的用量窗口，缺少窗口时立即经该 VM 的 worker 查询 usage；完成 SQLite 写入后返回，失效旧缓存并触发前端 VM、列表、概览和用量重取。确定重置成功时持久化 cleared_windows 时间边界，按边界裁剪窗口费用，刷新失败不会恢复旧的满额读数；重复兑换保持原幂等结果。Codex 继续使用既有刷新/重置后立即保存 codex_usage 的路径。
- **失败反馈：** 重置成功但读取最新用量失败，返回 usage_refreshed=false 并显示四语提示，不误报最新数据已经读取；历史费用不清零、不删除。
- **验证：** Node 24.22.1/macOS：供应商、代理隔离、窗口估算、Claude/Codex 额度、真实 SQLite 用量、seed 与供应商 E2E 合计 164/164；前端估算显示、机架汇总、供应商模型、语言切换与国际化完整性 51/51。TypeScript、Vite production build 通过（保留已有大块体积提示）。
- **升级/限制：** 本项不增加 API 路径、运行配置或 SQL 迁移；供应商代理归属的迁移 065 随同交付。部署对应代码后生效；本轮未部署本机或生产容器、未消费真实重置券、未发起真实推理。预计量依赖本网关已记录费用，网关外消耗会使估算偏低。
- **撤回：** 已于 2026-11-03 撤回，用量窗口与成本两列整列采用上游实现，见同日“用量窗口与成本列恢复上游”。

## 2026-10-29 发布后请求入口与槽位升级修复

- 修复 `v1.4.025.11` 协议入口缺失 `groupScopeDenial` 导入导致 HTTP/WebSocket 请求失败；通过三方对照恢复同步时遗漏的分组授权、模型白名单、请求快照及钱包实际扣费，保留最新上游仅 debug 模式记录正文与原生遥测退役逻辑。此处是恢复已有商业契约，不是新增计费方案。
- 退役旧遥测进程使用槽位用户身份，适配 `cap_drop: ALL` 的现有容器；混合舰队刷新跳过不支持 Claude 原生遥测的 GPT/native 槽，单 VM 原生遥测能力检查继续拒绝不支持的环境。
- 发布门禁增加现有真实 HTTP 商业链路测试，覆盖分组授权、钱包、请求结算、隔离及撤权，避免仅目录接口和进程探活通过却无法推理。
- 本地相关协议/钱包/HTTP 回归 68 项通过，舰队更新/遥测回归 15 项通过；新增 2 项回归覆盖容器信号权限与混合舰队跳过。无新增 SQL 迁移、数据删除或付费推理请求。GitHub 编译发布及服务器结果以实际运行记录为准。

## 2026-10-29 Codex Responses 上游过载故障转移

- **Bug 修复：** OpenAI/Codex Responses 上游返回 `503 server_is_overloaded`，或网关返回包含“servers are currently overloaded”的 `502` 时，之前不会命中 GPT 槽位故障转移，容易在同一账号重试后把过载错误直接返回用户。现在统一识别 502/503/529 的过载结果，在未向客户端提交 SSE 内容前允许同账号短重试，并继续切换到其他可用 GPT 槽位。
- **运行语义：** 已提交的流、请求格式错误和普通 `server_error` 不改变原有处理；仅对明确的过载代码/消息启用该路径，避免把一般 503 误判为过载。
- **验证：** `test/unit/codex-slot-pool.test.mjs` 与 `test/unit/handle-codex.test.mjs` 共 63 项通过，`git diff --check` 通过。部署代码后自动生效；本轮未执行生产部署、真实供应商请求或数据库操作。

## 2026-10-29 发布构建兼容性修复
- 为 native telemetry 状态映射补充未知状态兜底返回，完成 TypeScript 严格返回检查。

- 将 VM native telemetry 观测字段标为可选，兼容历史面板响应和旧测试夹具；完整新响应仍按现有字段返回。

- 补回上游兼容的 `VmTelemetryState.running` 和 OpenAI quota action 的 `now` 参数类型，完成前端 TypeScript 构建收口。

- 修复最新上游类型切换后的前端构建错误：账务用户状态初始化顺序、遥测状态类型、VM 状态板导入和未使用变量。

- 补齐 native telemetry 状态和种子策略字段的四语文案，消除最后的前端 i18n 门禁错误。

- 纳入最新上游 payload cli-node、事件回放和大事件体限制修复；继续保留 tapmodels 的多语言管理界面。


- 同步清理上游 scope helper 改名后遗留的 `vmPoolDenial` 调用，统一使用现有 `groupScopeDenial` 契约。

- 清理 native telemetry 上游切换后遗留的旧 `syncWorkerTelemetry` 与 `fillMissingCacheTtl` 导入，恢复发布契约测试和控制面模块加载。
- 无业务接口、数据结构或运行配置变化；部署后随控制面镜像生效。
- 验证：相关 Node 发布契约测试与语法检查通过，`git diff --check` 通过。

更新日期：2026-10-30。本文说明相对 `dofastted/vm2api/main` 冻结提交 `285f0d216644b5ee4a96b1630840466e61a2f717` 的全部有效定制，基线应用版本为 `1.4.029`。按累计代码差异整理，上游本身已有的功能不重复算作本地新增；实际发布版本、源码及产物以对应 GitHub Release 为准。

主线结构：完整保留上游历史，之后只有一个 tapmodels 定制提交。所有功能、修复、品牌、测试、文档与交付流程共同归入该提交；完整说明同时写入提交正文。按需求、规划、实现、代码路径、迁移、清理和验证汇总的统一记录见 `docs/CUSTOMIZATION_IMPLEMENTATION_RECORD.md`，逐文件范围见 `docs/CUSTOMIZATION_FILE_INDEX.md`。

## 2026-10-29 上游 native telemetry/seed 同步

- 上游从 `75a18df27b9d77b3d95029c58f24301120fb70b2` 前进到 `0e1a0bc65c247830658c3fae3c25a8f103268e3f`，吸收 native telemetry/seed pipeline、JEV 决策误报收窄及相关文档、测试和 CI 变更。
- 采用上游 Rust kernel/常驻 cli-node 原生遥测状态、`applyNativeTelemetry` 发布确认和旧 Go worker telemetry 退役；保留 tapmodels 的管理员层级/账务、供应商、品牌与四语界面。冲突文件按调用链合并，删除旧 sidecar 写入和 `touchTelemetrySession` 路径，CHANGELOG 使用冻结上游原文。
- 迁移无新增本地 SQL；部署需同步上游要求的 Node、Go OAuth worker、kernel 与 cli-node 产物后重启，payload/槽内升级不在本次 Git 推送中执行。
- 验证：`git diff --check`、唯一父提交/提交数、CHANGELOG 与上游一致性检查通过；本机无 Node 运行时，Node/前端/业务测试交由 CI，未执行生产部署、Release、数据库迁移或真实遥测上传。

## 2026-10-29 重置券到期时间显示简化

- 重置券到期时间统一显示为月/日和 24 小时制时分，例如 `到期 10/30 03:11`，去掉年份、秒数和倒计时；普通配额重置时间和冷却时间保持原有显示。
- 验证：前端格式检查、Vite production build 与 `git diff --check`。
- **撤回：** 已于 2026-11-03 撤回，用量窗口与成本两列整列采用上游实现，见同日“用量窗口与成本列恢复上游”。

## 2026-10-29 供应商账号授权、自动启动与代理池隔离

- **创建入口收敛：** 供应商先选择 Anthropic/OpenAI，再填可选名称、代理、分组及对应授权；VM 类型由平台确定，运行环境、区域和语言采用系统默认值。
- **授权衔接：** 创建账号后直接打开与运营后台 VM 共用的 Claude/Codex 授权面板。Claude 支持 OAuth、Setup Token、Console API Key，Codex 支持 OAuth、账号文件；授权方式决定授权面板的初始模式。
- **VM 生命周期：** 后端创建账号、配对 VM 和运行时 VM 后，绑定所选代理与分组，并尝试自动开机。授权完成后仍由现有凭据提交流程恢复可调度状态；自动开机失败会返回 `runtime_boot` 结果，不能伪装成已启动。
- **供应商代理：** 供应商代理创建后同步到统一代理池，保留 `vendor_id`、供应商资源 ID 和适用平台；供应商只能绑定自己的代理，运营后台超级管理员可查看平台全量代理。
- **运营筛选：** `/api/panel/proxies` 支持 `vendor_id` 与 `platform` 查询参数，运营代理池增加供应商和平台筛选；平台既读取代理声明，也从已绑定 VM 的 Claude/Codex 类型补齐。
- **迁移与验证：** 新增 `065_vendor_proxy_pool_metadata.sql`，不删除历史代理数据。供应商 E2E 2/2、供应商与代理池定向单测 33/33、前端 TypeScript 和四语 JSON 解析通过；测试主机缺少 `iptables/kin-egress` 时自动开机返回预期运行时错误并保持 VM 停止。
- **兼容与清理：** 保留远端已完成的 native telemetry 类型修复，删除草稿中重复/未使用的遥测投影；macOS seed 写入使用本地目录路径并检查目录不得为符号链接，Linux 继续使用目录句柄路径。

## 2026-10-29 管理员余额转账与移除兑换充值

- 普通用户不再显示“兑换充值”，超级管理员也不再显示或调用“生成充值码”；移除面板兑换码接口、前端入口、兑换码仓储和相关死代码。历史 `redeem_codes` 表及已有数据保留，不执行数据库数据删除。
- 普通用户侧栏移除“资源管理 → 分组”，API 密钥移动到运营菜单顶部；管理员同时获得自己的 API 密钥入口，Key 请求按 Key 所属管理员余额计费。
- 管理员为普通用户充值时，在一个 SQLite 事务内从管理员可用余额扣款、向用户余额入账，并分别写入转出/转入流水；余额不足、给自己充值和幂等冲突会被拒绝，重复请求复用原结果。用户管理继续显示用户余额、余额流水和充值操作。
- 验证：余额转账与权限核心回归通过；最新上游用户管理端到端用例有 1 项既有 `usage-logs` 角色列错误，基线复现，未归因于本次改动；前端 88 个测试文件、667 项通过，TypeScript、Prettier 与 Vite production build 通过，未执行生产部署、数据库数据删除或发布。

## 2026-10-29 登录页默认值与 API 地址输入清理

- 登录页用户名默认保持为空，页面打开后将焦点稳定放在密码输入框，避免预填 `admin` 并方便直接输入密码。
- 移除登录页的“API 基础地址”输入框及四种语言中对应的废弃文案；跨源面板所需的既有 API 基础地址读取能力保留，继续服务于不同源部署。
- 移除登录页标题下的安装文档/欢迎页链接和登录按钮下的供应商入口提示，同时清理四种语言中仅供这两处使用的文案。
- 验证：前端 TypeScript、登录相关 i18n 资源一致性、Prettier 与 `git diff --check`。

## 2026-10-29 账务菜单改为充值记录

- 将运营侧栏和账务页面标题统一改为“充值记录”，并同步更新英文、简体中文、繁体中文和日文显示文案。
- 保留余额、账本流水和冲正功能；兑换码入口随后已由管理员余额转账替代。
- 验证：前端 i18n 覆盖测试、TypeScript、完整前端测试、Vite production build、Prettier 与 `git diff --check`。

## 2026-10-29 分组模型白名单列表滚动修复

- 修复新建/编辑分组时模型白名单列表的鼠标滚轮事件冒泡到外层弹窗，导致列表无法滚动的问题；列表继续使用自身滚动容器，并隔离滚轮事件。
- 无接口、数据、权限或模型筛选逻辑变化。验证前端 TypeScript、相关前端测试、Vite production build 与 `git diff --check`。

## 2026-10-29 管理员层级与数据隔离

- 管理员可以创建普通用户或同级管理员；子管理员沿用管理员的用户管理、日志、统计和账务权限，但不能创建或提权为超级管理员，也不能读取其他管理员分支。
- `users.parent_user_id` 记录管理员层级。管理员用户列表只返回自己分支内的普通用户和子管理员；修改、删除及账务目标均执行同一归属校验。子管理员创建的数据归入子管理员自己的分支，父管理员可继续管理自己的分支，其他管理员不可见。
- 使用日志、统计、筛选项、账务余额、流水和套餐查询均按管理员分支收窄，`user_id` 查询参数不能绕过范围。超级管理员和 master API key 保留全量管理视图。
- 新增 `063_admin_data_scope.sql` 前向迁移；历史用户的父级为空，继续由超级管理员全量可见，普通管理员不会自动获得未归属的历史数据。
- 验证：`test/unit/panel-users.test.mjs` 11/11 通过；`test/unit/db-migration-sub2api.test.mjs` 6/6 通过；新增管理员分支隔离端到端回归已加入 `test/e2e/panel-users.e2e.test.mjs`，本机网关端到端运行受缺少 Node 运行依赖限制，未能启动网关执行。未执行生产数据库迁移、部署或发版。

## 2026-10-29 管理员 API 密钥入口

- 管理员侧栏新增“API 密钥”入口，管理员可创建、查看、编辑、轮换、停用、重置和撤销自己管理范围内用户的 API 密钥。
- 后端 ACL 放行管理员的 API Key 页面和分组读取；Key 列表、Key 详情、明文恢复和所有写操作均按管理员层级范围校验，不能读取或操作其他管理员分支的 Key。创建 Key 必须指定范围内的用户。
- 管理员可继续通过用户页维护所属用户的分组授权；账务调整、平台级 Key 和基础设施权限仍保持原有超级管理员边界。
- 验证：管理员分支端到端回归 11/11 通过；Node 语法检查和 `git diff --check` 通过。前端格式检查受当前工作区 Prettier 插件解析环境限制，未执行生产部署、数据库迁移或发版。

## 2026-10-29 管理员运营与个人账户菜单拆分

- 管理员侧栏拆成“运营管理”和“我的账户”：运营管理的使用记录覆盖当前管理员树下由管理员、子管理员及其用户 Key 产生的记录；我的账户中的 API 密钥和使用记录只显示当前管理员签发的 Key。
- 新增 `scope=mine` 查询范围，前端侧栏链接、Key 查询和日志筛选都会携带该范围；后端按 `api_keys.created_by_user_id` 强制收窄个人视图，伪造 `user_id` 或 URL 参数不能扩大范围。
- API Key 新增签发者字段和 `064_api_key_creator_scope.sql` 迁移；运营 Key 列表仍按管理员管理树展示，超级管理员保留全量视图。
- 验证：管理员用户与 Key 隔离端到端回归 11/11、ACL 回归通过；前端 TypeScript、Node 语法和 `git diff --check` 通过。未执行生产迁移、部署或发版。

## 2026-10-29 新用户流程移除 GitHub 引导

- 删除登录后控制台中的 GitHub Star 弹窗及其挂载；当前欢迎页和登录页保留登录、控制台、文档与本地导航入口。
- 删除 `StarHint` 组件及四种语言中不再使用的提示文案；设置页版本/Release 信息和运维页面的 GitHub 资源入口继续保留。
- 验证：静态扫描、四种语言 JSON 解析、前端 TypeScript、受影响前端源文件 Prettier、相关 i18n 测试 41/41 与 `git diff --check` 通过。未执行生产部署、发版或数据库操作。

## 2026-10-29 首页主题控件与本地化修订

- 首页恢复原站欢迎页的中性主题变量、蓝紫主视觉、滚动收缩悬浮导航、卡片层级和 API 示例布局；首页不再写死深色背景与青色配色，亮色、深色和系统主题都会跟随全站主题。
- 全站语言切换统一使用通用地球图标；主题菜单保留亮色、深色和系统三种选择，应用默认主题改为系统模式，首页也直接提供语言与主题入口。
- 繁体中文营销原稿按 `tapmodels-home` 提供的在地化版本保留，仅补齐模型价格/缓存读取等原稿中已有的信息；简体中文和日文按同一产品语境补充专业本地化，不把繁体原稿机械直译。
- 首页模型示例改为参考页中的 Claude/OpenAI 模型、输入/输出/快取读取价格；新增缺失的四语 `welcome` 文案键，并保留 Agent 工具、控制台预览和首配流程。
- 验证：前端 TypeScript、Vite production build 与 `git diff --check` 通过；`features/keys/i18n.test.tsx` 23 项通过。全量 `i18n/coverage.test.ts` 仍受当前工作区供应商平台、登录页和用户页既有硬编码文案检查失败影响，本轮首页文件未出现在失败项中；未执行部署、发版、迁移或真实供应商请求。

## 2026-10-29 下级供应商数量上限支持 0 = 不限制

- **Bug 修复：** 超级管理员创建供应商时，“下级供应商数量上限”允许填写 `0`，并在界面明确提示 `0 = 不限制下级供应商数量`。
- **运行语义：** `child_limit=0` 在供应商平台后端表示直属下级供应商数量不设上限；正数仍按原有数量上限校验。创建供应商时后端保留显式传入的 `0`，不再把它误转成默认值 `1`。
- **验证：** 供应商平台单元测试 8/8、前端 TypeScript、Prettier 和 Node 语法检查通过。

## 2026-10-29 供应商门户参考 sub2api 调整

- **来源：** 只读参考定制 sub2api 本地 HEAD `0276190e775b369319acc18bc1c120a4469a71ae` 的 R13、VendorLayout、AccountWorkbench、AccountForm 和 API 合同；未修改或发布 sub2api。
- **UI：** 删除旧单页表单和把所有菜单回落到开户表单的分支。门户按“资源 / 统计”组织，独立 `/vendor/:page` 路径支持刷新、返回和无权限处理；提供账号概览、名称/平台/状态筛选、分页、自动刷新、账号详情、代理资料、下级只读账号与代理、审计记录、手机导航和主题切换。
- **真实数据：** 账号列表复用现有 VM、额度和计费用量快照，字段显式投影。等待授权不计为可用；缺少快照显示未知，取消伪造的零消耗和配额占位。统计限定当前供应商或直属下级范围。
- **权限及写入：** 下级菜单与 API 同时要求一级身份和创建下级能力；GET 不执行状态变更，资源类型不可串用，禁止客户端改写内部 VM 关联。账号暂停同步关闭供给，恢复只撤销供应商暂停，不清除凭据失败或平台限制。账号/VM 数据写入事务；代理绑定校验当前归属和状态，列表隐藏代理认证信息，新代理密码随数据库密钥加密保存。
- **接口：** 新增账号池/IP 代理 vendor_id 筛选及上游应收/下游应付列表查询；结算查询按合同边和能力隔离，仅支持已存在结算单的读取，不包含账单生成或付款。
- **边界：** 本轮并未实现 sub2api 的全套授权向导、批量导入导出、代理质量检测、财务结算写入和全站 RPM/TPM 汇总发布；不提供尚未实现的 BPS 选择项，不把预配成功描述为完成授权或推理验收。
- **升级及清理：** 无新增迁移、依赖或历史数据删除。保留供应商实体和既有资源，新增子页面取代旧局部切页状态；本机需重新构建镜像。公开资源 PATCH 收紧为名称/状态，不允许提交内部 config 映射。
- **验证：** 后端 13 项单测、前端 2 项模型测试及隔离容器 HTTP 2 项通过；TypeScript、前端构建、相关格式与语法检查通过。真实上游授权、收费推理与生产部署未执行。

## 2026-10-29 供应商账号池、用量统计与统一账单

- **账号池：** 对齐定制 sub2api 的账号池口径，补充 RPM、TPM、实时并发、5 小时/7 天窗口消耗、Token、错误分类、接近限额和授权状态字段；未知数据继续显示 `—`，不把无快照账号伪造为已用量。
- **用量统计：** 新增供应商周期统计接口，支持当前供应商、直属下游或全部可见范围，按日期、账号、模型聚合请求数、输入/输出 Token 和金额；读取实际请求日志；详细日志裁剪后按请求 ID 去重补充持久化供应商事实，缺失指标不使用累计快照填充。
- **结算档案：** 超级管理员新建供应商和供应商创建下级供应商时可保存联系人、结算邮箱、币安 ID、默认采购单价、OpenAI/Claude 分组单价、结算汇率、倍率和合同版本，并自动建立对应合同默认值。
- **统一账单：** 将上游账单与一级供应商向直属下游的结算合并为“账单”菜单；一级供应商可按周期新增下游结算，二级供应商只查看上游账单。原有独立 `settlements/payables` 页面入口不再出现在门户菜单。
- **迁移与验证：** 新增 `062_vendor_billing_profile.sql`；后端迁移/供应商回归 32 项、前端模型测试、TypeScript、E2E 2 项和本机 Docker 健康检查通过。未执行生产迁移、真实收费结算或生产部署。
## 2026-10-29 营销首页重构与多语言文案

- 将 `/welcome` 重构为 TapModels.ai 营销首页：导航、Hero/API 示例、核心能力、模型与价格、请求链路、团队访问控制、数据与风控、Agent 接入、控制台预览和 CTA；继续保留登录态、首配清单、用法选择和导航行为。
- 使用现有 React/Tailwind、Button、Badge、Card、Logo、API 示例和主题变量实现视觉与组件；参考页截图加入 `web/public/welcome/` 作为控制台预览素材。
- 新增首页文案到 `welcome` 命名空间，覆盖英文、简体中文、繁体中文和日文；清理被替代的首页专属组件，保留首配和 API 示例共享能力。
- 验证：`tsc -b web/tsconfig.json`、Vite production build 与 `git diff --check` 通过；pnpm 入口因当前忽略 `cpu-features`、`ssh2` 构建脚本而阻断。未执行部署、发版、数据库迁移或真实供应商请求。

## 2026-10-29 控制台用户、导航、版本与品牌界面调整

- 用户创建表单改用统一下拉组件，角色菜单在弹窗中正常定位；创建用户的并发上限默认改为 `0`，前后端保持一致。用户名在提交前按后端 2–32 位规则校验，密码明确限制为 8–128 位，避免把用户名错误误认为密码不符合规则。
- 版本卡片沿用现有 `/api/panel/version` 与 5 分钟检查规则，发现新版本时显示新版并进入关于/更新页面执行现有一键更新流程；套餐侧栏入口和个人菜单中的设置、关于/更新、用户入口隐藏，页面与功能代码保留。
- 总览页每 5 秒刷新宿主 CPU、内存和进程数据，保留现有 dashboard 采样口径；Claude 重置券的每张到期时间单独一行显示（已于 2026-11-03 撤回，用量窗口与成本两列整列采用上游实现，见同日“用量窗口与成本列恢复上游”）。
- 品牌副标题新增四语字段，按当前网站语言显示并可在品牌设置中分别编辑；旧单字符串副标题继续作为兼容回退。无新增数据库迁移，保存到现有 `site_branding` 设置记录。
- 验证：前端 TypeScript、品牌设置/版本查询相关测试与 Vite 生产构建通过；侧栏权限测试存在工作区既有的运营组标题断言不一致，未由本轮入口隐藏改动引入。

## 2026-10-29 CPR P0 运行事实与账号保护

- **请求快照：** 新增 `runtime_config` 单例 revision 与原子 CAS；请求入口为 Messages、Chat、Responses、Images、Search 获取深冻结 routing snapshot，并将 `config_revision` 写入请求日志。routing 管理写入支持过期 revision 返回 409，成功更新发布新 snapshot；旧客户端缺失 revision 仍兼容。
- **发送事实：** `request_attempts` 新增 `send_state`：`not_sent`、`ambiguous`、`sent`。Go worker、Rust/Codex kernel、kernel router、协议入口和 FailoverRunner 全链路传递发送观察；状态和 `downstream_committed` 单调写入，迟到结果不能降级事实。
- **账号错误保护：** 新增默认关闭的规则策略、fingerprint、credential/policy revision 计数和 SQLite CAS 冻结状态。未提交的账号级错误达到阈值后复用现有 cooldown/release 机制，保持 provider circuit 独立；SA 可通过 `/api/panel/account-error-protection` 配置，并以 generation CAS 手动解除账号保护。
- **迁移与验证：** 新增迁移 057–060；定向 P0 测试、数据库迁移回归、FailoverRunner 68/68、worker 47/47、kernel router 50/50 通过。完整 Node 单测仍有 9 个与本机缺少 guest/cluster/OAuth 测试资产或预存环境依赖相关的失败，未归因于本轮 P0 代码；未执行生产数据库迁移、真实供应商推理或部署。

## 2026-10-29 VM 额度解除时间与 7D 预计用量

- **界面优化：** 受限 VM 卡片在“5h 限制”“7d 限制”“冷却”等状态旁显示解除倒计时，并保留悬浮可查看的绝对解除时间；详情页继续显示完整解除时间。
- **持久化与刷新：** 沿用 sub2api 风格的持久化分层：`accounts.unified` 保存额度与重置快照，`account_allocations` 保存窗口变化，`usage_logs` 保存请求费用和 Token。VM 页面继续定时读取 `/api/panel/vms` 与 `/api/panel/usage`；额度查询、重置和官方用量操作成功后立即失效并刷新用量查询缓存。
- **总计口径：** 成本账的“总计”优先使用有效的 7D 窗口估算：官方 7D 已用比例与同一窗口内已记录费用/Token 反推预计完整 7D 总量，显示 `≈` 标记；缺少重置时间、日志覆盖不足、用量过低、存在未定价请求或其他估算无效状态时回退到累计费用和累计 Token，不编造预计值。
- **验证：** VM 用量、机架模型和窗口组件相关测试 20/20 通过；前端 TypeScript、Vite production build 和 Prettier 通过。无数据库结构变化、无新增依赖、无数据删除。
- **撤回：** 已于 2026-11-03 撤回，用量窗口与成本两列整列采用上游实现，见同日“用量窗口与成本列恢复上游”。

## 2026-10-29 供应商平台首版落地

- **新增功能：** 新增供应商、成员、能力、资源、授权、用量事实、结算预留、付款流水和审计事件的数据模型及 `056_supplier_platform.sql` 迁移；新增 V1/V2 身份、父子范围、额度、能力和审计服务。
- **供应商开户：** 供应商前端填写可选名称、授权方式、分组和代理，`POST /api/vendor/accounts` 在供应商服务内一次完成账号资源、配对 VM 资源和运行时 `vms/<id>.json` 的预配，并以 `runtime_vm_id` 关联；重复 `idempotency_key` 返回同一对资源。预配 VM 初始为 `stopped`，无凭据时标记 `no_credential`，待授权后进入运行生命周期。
- **权限边界：** `POST /api/vendor/vms` 固定返回 `account_creation_required`，供应商不调用运营后台 `/api/panel/vms/create`；运营后台和供应商平台保持不同服务入口。缺少 `vendor.create_child` 时，后端 `/api/vendor/me` 不返回 `vendors` 视图，供应商门户也不渲染“下级供应商”菜单；即使手工调用接口仍由后端返回 403。
- **接口与门户：** 注册 `/api/vendor/*` 和超级管理员 `/api/admin/vendors/*`；新增 `/vendor` 前端路由、账号开户表单、账号与 VM 列表和能力感知菜单。
- **破坏性变更：** 供应商不能再通过独立 VM 创建入口开户；已有供应商账号必须通过账号开户流程生成配对 VM。普通面板 SA/AD/U 行为不变。
- **升级指南：** 部署代码后由应用启动执行迁移 056；使用供应商门户前，为供应商成员绑定有效的普通用户账号并由超级管理员授予能力。已有供应商数据不会被自动删除。运行时 VM 预配后绑定代理与分组并自动尝试启动，授权完成前保持 no_credential；不自动产生可计费推理。
- **清理与保留：** 清理了供应商 VM 直接创建路径在新入口中的语义，保留运营后台 SA 专用 VM 创建路径；保留资源归档和审计事实，不物理删除历史记录。无额外依赖或生产数据处置。
- **验证：** 迁移 056 隔离数据库检查通过；供应商单元与端到端测试 7/7 通过；真实登录、能力感知菜单、禁止直接 VM、账号/VM 配对、运行时 VM 文件、幂等重试均通过；Biome、Prettier 和前端 TypeScript/Vite 构建通过。未执行本机 Docker 重建、生产部署或数据库迁移。

## 2026-10-29 反代在前时控制面可收回环回口

- **Bug 修复：** `docker-compose.yml` 此前把 `HOST: 0.0.0.0` 写死在 `environment:`，它优先于 `env_file`，因此 `.env` 里的 `HOST` 完全不生效——而 `.env.example` 一直把 `HOST` 当作可配置的监听地址。现在改为 `HOST: ${HOST:-0.0.0.0}`：默认行为与原来完全一致，`.env` 设 `HOST=127.0.0.1` 时控制面只在环回口监听，`PORT` 不再随公网 IP 暴露。
- 影响：nginx 等反代在前的部署，此前即使按 `.env.example` 配置也无法把 `:8787` 收回环回口，控制面始终可被公网直连，绕过反代的 TLS、鉴权边界和访问日志。槽位与控制面之间走 unix socket（`run/worker.sock`、`run/kernel.sock`），集群为控制面主动外连远端 Docker，两者都不依赖该端口的公网监听，因此收回环回口不影响槽位调度和集群。
- 文档：`docs/DEPLOY.md` 的「反代」改用 `map $http_upgrade` 决定 `Connection` 的单 `location` 配置，一段同时覆盖普通 HTTP、SSE 和 WebSocket，不再需要为 shell / responses 另写 location；原先示例里的 `Connection ""` 会剥掉 `Upgrade`，而写死 `Connection "upgrade"` 又会给普通请求带上无效 Upgrade 头。同时补上 `HOST=127.0.0.1` 的说明、certbot 续期命令，以及给未知 SNI 配 `ssl_reject_handshake on` 默认 server 的做法。`docs/nginx-shell.md` 指向新配置，并说明其中的 location 顺序要求只适用于沿用 `Connection ""` 的旧配置。
- 无新增接口、配置项、迁移或数据处置。破坏性变更：无（`HOST` 默认值不变）。升级指南：需要把控制面收回环回口时，在 `.env` 设 `HOST=127.0.0.1` 并重建控制面容器，反代指向 `127.0.0.1:8787`；不改 `.env` 则行为不变。
- 验证：macOS。`docker compose config` 实测默认解析为 `HOST: 0.0.0.0`、`.env` 设 `HOST=127.0.0.1` 时解析为 `127.0.0.1`，确认修复生效且默认未变。本机无 node 运行时，`release`、`panel-upgrade-script` 两项读取 compose 的单测由 CI 执行（compose/`.env.example` 变更按 `ci_plan.py` 归入全量范围）。文档改动不跑业务构建。

## 2026-10-29 调度资格快照过期后不再空等

- **Bug 修复：** `selectDirect` 在构建候选快照后、真正排队前，不再对一个已经到期的等待窗口空等。`eligibleCandidates` 要做 worker 健康探测和额度读取，本身消耗真实时间；快照里记录的 `availableAt` 恒为记录当时的将来时刻，若等到准备排队时它已经过去，说明快照在构建期间就过期了。现在这种情况直接重读资格，而不是按原计划睡到请求截止时间。
- 影响：RPM 窗口或账号/模型冷却恰好在资格检查期间到期时，请求此前会白白等满 `fallback_wait_timeout_ms` / `sticky_wait_timeout_ms` 再返回，现在立即改用已恢复的账号。只在快照确实过期且未到循环截止时间时重读；刷新后的快照不可能再报同一个到期时刻，因此不会自旋。并发忙（`slot_busy`）等其他等待原因不受影响。
- 无新增接口、配置、迁移或数据处置，部署后自动生效。破坏性变更：无。升级指南：无需操作。
- 验证：macOS / Node 22.20.0。`rpm` / `cooldown expiry during eligibility inspection` 两项在修复前失败、修复后通过；pool-scheduler、fastpath、seat-planner、预留竞态、资格/状态、api-scheduler、sticky、failover 等相关单测 309/309 通过；biome 检查 2 个变更文件通过。

## 2026-10-29 分组内 VM 优先级在 GPT 与 Claude 两条链生效

- **Bug 修复：** 控制台 `#/groups` 分组资源中 VM 的组内优先级（`group_resources.priority`，默认 50，数值越小越优先）此前只随 Key 范围读出，GPT/Codex 调度从未使用。现在 OpenAI 号池按“可用 VM 中权重最高档 → 组内优先级最小 → smart 评分”选号，故障切换顺序也先走完高优先级 VM。会话粘性仍优先于权重和组内优先级，同一对话继续留在原 VM；无分组 Key（Master Key、超级管理员自用 Key）不受影响。
- **Bug 修复（Claude 回归恢复）：** Claude 号池的同一能力在 1.3.224 之后的上游同步中丢失：`4a62cd68` 时 `pool-scheduler` 仍按“调度等级 → 组内优先级 → 负载 → 均衡”选号，到 `7d8fb757`（v1.4.025 同步）该档被整段删除，并非有意移除。现按原语义恢复候选对象的 `groupPriority` 与 `pick` / `peekRank` 两处分档，粘性、家族与设备亲和仍先于分档；无分组 Key 的候选全部取默认值 50，该档为空操作。等待计划沿用同一排序。
- **清理：** 删除 `pickCodexCandidates` 中依赖已退出 `vm_pool_id` 的空池分支。分组范围从不携带该字段，该分支不可达；空分组仍返回 `no_codex_vm`，不回落全局号池。
- 无新增接口、配置、迁移或数据处置，部署后自动生效。破坏性变更：无。升级指南：无需操作，已保存的组内优先级在部署后开始同时影响 GPT 与 Claude 选号。
- 验证：macOS / Node 22.20.0。GPT 侧 codex、openai、key-scope、relay、review-five、vm-test-chat、api-keys 相关 Node 单测 382/382 通过；Claude 侧 pool-scheduler、fastpath、seat-planner、预留竞态、资格/状态、api-scheduler、sticky 等 267 项中 265 项通过。新增 5 项回归（选择器分档、粘性优先、真实数据库分组 Key 选号、Claude 同级平手按组内优先级、Claude 粘性与设备亲和仍优先于组内优先级）均在修复前失败或覆盖新语义，修复后通过；biome 检查 7 个变更文件通过。当时余下 2 项 `rpm/cooldown expiry during eligibility inspection` 失败在未改动的交付前 main（`dc62b1ab`）同环境同样复现，属既有问题，非该轮引入；已在上文 2026-10-29「调度资格快照过期后不再空等」修复。同版本修改，推送只跑 CI，不发版、不部署。

## 2026-10-28 补齐 VM 离线通知四语资源

- GitHub `1.4.025` 首次构建被国际化完整性检查阻止，补齐 `notify.vmOffline` / `notify.vmOfflineHelp` 的四语资源，并移除组件中被取代的中文回退值。无通知行为、接口或配置变更。
- 本地国际化覆盖 5/5、TypeScript 与生产构建通过；GitHub 上一次运行的其余 661 项前端测试、Go 测试、原生构建及 payload 校验通过，修改未影响的证据继续有效。清理仅本任务创建的未发布草稿/tag 后，用修复源码重新构建发布 `1.4.025`，不覆盖既有正式版本。

## 2026-10-28 上游新版整套自动发布

- 同步上游新版本后推送 main，按上游原始 `X.Y.Z` 自动发布应用、控制面镜像、配套 helper/payload 与全部 4 个 guest、4 个 KVM 镜像；保留前导零，例如 `v1.4.025`，tag 直接指向交付源码。同版本本地修改、仅镜像目录变化和历史归并只跑 CI，不自动发布。
- 以实际 before/after 版本递增及唯一上游父提交判断，允许精确 lease 历史重写；核验冻结父提交属于官方 main 历史、源码与该版本一致。无法读取旧提交、来源不一致或版本回退时不发布。已发布版本跳过；失败草稿只允许原源码重试，不覆盖其他源码 tag。
- guest-images 改为系统发布调用的复用工作流，全部镜像使用同一冻结源码，任一失败都阻止最终应用 Release 公开及应用 latest 提升；移除旧的 forced/非快进一律拒绝 guest 发布守卫与独立路径发布。显式人工 `X.Y.Z.N` 修订版及仅构建验收仍保留。
- 修复上游 `1.4.025` 被版本解析/发布校验拒绝的问题，自动版与人工修订版均保留三段上游数字拼写；人工修订号仍禁止前导零。无新增业务接口、运行配置、数据库变更或数据处置；生产部署仍单独授权。
- 本轮保持当前 `1.4.025` 上游父提交，未附带同步；推送本修复不会自动发版。提供显式人工 `upstream_version=true` 入口补发尚未发布的当前上游版号，用户本轮已授权在 GitHub 补发 `1.4.025`。后续上游新版本同步交付自动生效。验证覆盖真实 Git 历史重写、新版/同版/回退、版本解析、占号、写入、草稿重试、tag 冲突及发布门禁；未调用真实发布操作。本地发布回归 55/55、上游预检/契约回归 49/49 通过，3 个变更工作流通过 actionlint；使用现有 Node 运行时完成资产打包回归，无跳过项。

## 1.4.025 上游版本切换（2026-10-29，75a18df2）

- 上游仅切换 VERSION/CHANGELOG 至 v1.4.025，功能内容延续 v1.4.024；保留本地 VM/节点离线通知、远端角色规范化和全部商业/品牌定制。
- 无新增 API、迁移、依赖或 payload 资产；升级仅需部署 Node 与 web/dist 并重启，未执行 Release、生产部署或数据操作。
- CHANGELOG 使用上游原文；本轮未增加业务代码，通知回归证据继续复用同输入的 26/26。

## 1.4.024 上游同步（2026-10-29，fc3f0032）

- 上游从 `35f62b61` 前进到 `fc3f0032`，包含 v1.4.024 版本切换及 #812 VM/节点离线通知。保留 tapmodels 的四语言设置页、既有 Telegram/企业微信/邮件通道、人工停调/维护语义和商业监控边界。
- 采用 `snapshotVmConnectivity` 读取调度器使用的节点链路与终止内核故障：节点失联、watchdog 恢复预算耗尽，或运行中 VM 进入 stopped/dead/error 时触发 `vm_down`；人工停调、维护、额度冷却和未知状态不告警。
- `vm_down` 默认开启，通知监控统一处理告警，按 VM 去重；部分通道失败只在下一轮重试失败通道，恢复、删除或停调会取消待发告警。保留前端本地化文案，并为新增事件提供翻译回退值。
- 采用上游版本 `1.4.024` 和根 `CHANGELOG.md` 原文；无新增 SQL 迁移、依赖或 payload 资产变更。升级需同时部署 Node 与 web/dist 后重启；payload、`wrap-cli/sync` 和槽内 CLI 不需因本批次重复替换。
- 本地验证：通知与 VM 离线通知回归 26/26，变更 JS 语法检查和 `git diff --check` 通过。web 类型检查、Go 与完整 CI 交由远端环境；未执行 Release、生产部署或数据操作。

## 2026-10-28 VM 语言选项显示

- VM 创建表单将重复的「C C」改为「通用 `C.UTF-8`」完整显示；语言选择区占满可用宽度并按整项换行，保留其他语言名称及区域代码。仅优化展示，不改变写入 VM 的 LANG 值。

## 2026-10-28 移除工作台

- 删除自行新增的工作台页面、路由与导航、品牌跳转、后端页面权限以及四语专属资源。恢复现有业务页面作为默认入口，保留角色感知的无权限保护、已授权回跳和原有安装引导。
- 无新增接口、配置、数据库变更或迁移；角色编码、VM 权限、商业功能和品牌定制不受影响。旧工作台地址不再注册。

## 2026-10-28 角色显示名称统一

- 简体中文统一为「超级管理员 / 管理员 / 用户」，繁体中文为「超級管理員 / 管理員 / 使用者」；同步账号菜单、用户列表、角色选项、Key 提示、使用指南及服务端提示。
- 更新现行角色设计、权限矩阵及接口文档名称；历史交付记录和服务端已有的角色输入别名不属于显示名称，继续保留。角色编码、权限、数据库及迁移不变，无新增接口、配置或业务执行路径。
- 本轮仅调整文案；验证资源键与插值一致性、现有国际化及相关回归。部署对应前端及服务端后生效。

## 2026-10-28 角色规划与本机定制版恢复

本次普通需求保持上游父提交 `631b228e`，以已交付 tapmodels 定制提交 `9e308223` 为实施基线，未追赶新上游。保留既有品牌配置、四语言、唯一右上角账号入口、个人资料、分组授权、Key 连接指南、钱包/套餐和 VM/API 双链结算。

- 登录默认进入现有业务页面：SA `/overview`、AD `/users`、U `/keys`；书签和登录回跳地址无权限时回到允许入口。按用户要求移除工作台页面、路由、导航、页面权限和专属四语文案。
- 规范角色为 `super_admin`（SA）、`admin`（AD）、`user`（U）。SA 独占平台 VM、集群、代理和系统配置；AD 只能创建、启停、改密和删除普通 U，并查看 U 的请求、统计和账务，不能提升角色、改分组授权、改资金或管理资源；U 保留获授权分组、个人 Key、连接配置、套餐与本人消费。
- 侧栏重新分类为运营中心、资源中心、接入管理、平台设置；分组、套餐继续保留。顶部沿用站点品牌和版本说明，继续移除上游 GitHub/文档按钮及左下角重复账号入口。
- 修复旧会话角色缓存：每次恢复会话查询数据库当前角色，已停用或已删除账号失效，数据库认证失败也不会回退到环境密码。AD 请求、导出、统计、会话与账务使用普通 U 消费范围，伪造用户 ID 不能读取 SA/AD 数据；原始正文、上游凭据和供应资源细节继续按字段投影隐藏。
- 新增前向迁移 `054_panel_role_names.sql`：旧 `admin` → `super_admin`、旧 `super` → `admin`，既有 001–053 迁移和商业数据保持。角色编码变化属于破坏性变更；回退须同时恢复对应数据库备份和代码，不能只回滚镜像。
- 补齐供应商角色、权限、领域、接口、流程、安全、资料索引和验收设计文档。V1/V2 门户、账号/VM 业务和供应商结算仍待后续实施；本次不宣称已实现。
- 本机修复误从官方 `vm2api_main` 构建导致定制模块遗漏的问题；私有部署覆盖层保留原六个挂载及密钥，并在备份副本验证迁移谱系后再更新 8787。该恢复步骤仅针对本次已确认的本机测试库，不提供通用旧品牌原地升级，也未操作生产环境。

## 历史同步基线：1.4.021

该轮基线为上游 1.4.021（`631b228e`）。本轮从 1.4.010 同步调度快照/健康单航班与排队时序、请求体上限与 Codex 非流式/超时边界、JEV 用量记录、遥测 2.1.303 对齐、工具名唯一化、zero 缓存断点、托管 Codex Key 门禁、API 内核 SSE flush、ARM64 Node 22.23.4 和 cli-node 宿主凭证基线；保留四态调度、session 席位、303 出站/提示词结构、模型策略和集群同步。保留商业分组授权与一次结算、四语言、固定资产与源码 helper、选择性 CI、Actions 全仓最新 10 条及人工发版保护。完整上游历史和 CHANGELOG.md 原文保持。Git 推送不改线上服务或数据。

## 新增功能

### 商业分组、用户授权与供给管理

- 新增 `/groups` 商业分组管理：Claude、OpenAI 和混合平台，公开/专属分组、模型白名单、计费倍率、余额/套餐计费、状态、分组 RPM、复制和资源管理。新建分组默认不勾选专属。
- 一个用户可获多个分组授权，每个客户 API Key 绑定一个获授权分组；授权和资源在请求时、异步资格检查后、队列授予及实际派发前重新读取；停用 Key、撤销授权或模型后，尚未派发的请求被拒绝。
- `group_resources` 统一关联 VM 或 API endpoint。同一 VM 可加入多个分组并共享真实容量；同一组只使用一种执行后端。支持从 VM、API 地址和分组三侧维护关联，以及 VM 批量分组和版本冲突检查。
- 分组显示容量及今日、昨日、累计消费；按请求发生时的归属统计，日界采用 Asia/Shanghai。API 资源容量显示由上游决定，不虚构 VM 并发。
- 用户/分组专属倍率与专属 RPM 可独立添加、编辑和恢复默认；不会因设置专属价格或 RPM 自动授予访问权限。倍率 `0` 表示免费，`null` 表示继承。

### 三层 RPM 与并发约束

- 用户 RPM 是全部 Key、全部分组共享的总上限。
- 分组 RPM 是每个用户在该分组内的上限，同用户的多个 Key 共用；不是全组所有用户的合计。
- 用户在分组内的专属 RPM 替代分组默认值；Key 自身 RPM 继续保留。Key、用户总量、用户在当前组的额度同时校验，任何一层达到上限均拒绝。
- 各层 `0` 仅取消该层限制，专属 RPM 的 `null` 才是继承。最近 60 秒准入计数，增加 Key 或跨组调用不能绕开用户上限。
- 用户并发由其所有 Key 共享；Key 并发、RPM、金额与套餐约束各自生效。用户并发 `0` 表示不限制；在途请求不会因为删除 Key 而释放出额外并发名额。

### 资金、套餐、消费归属与运营

- 新增钱包流水、充值/调整、幂等记账、实际 usage 扣费、退款审计和完成消费回执。金额以整数微美元存储，避免浮点累积；保留请求开始时的倍率/报价快照。
- 请求后计量条件跟随原版：Claude VM 使用已获得账号用量，API 供给使用成功结果，原生 Codex 仅 verified 终态；没有资金预留或待处理队列。未知价格保持未计费，已完成消费幂等，Key 轮换/删除不会返还历史扣款。
- 新增分组套餐权益及有效期，按 24 小时、7 天、30 天滚动金额窗口计算；限制重叠套餐，支持停用和撤销。
- 使用记录、统计和账务按用户所有 Key 聚合，并保留历史用户、Key 名称及计费分组归属；Key 后续变化不把历史记录转给其他用户。
- 服务健康由总览、统计、使用记录与 VM 详情承担，普通用户只看本人数据；独立运维监控功能已于 2026-10-31 撤销。

### API Key 管理和客户端接入

- 增加行内复制、查看、使用指南、所有权校验和审计；列表保持掩码，取回接口按 Key 所属用户/超级管理员权限返回明文。
- 支持按用户和获授权分组创建/编辑 Key、自定义 Key、总消费额度、5 小时/1 天/7 天 USD 消费限额、有效期和 IP 白/黑名单。金额窗口不是请求次数。已有启停、轮换、撤销及用量功能继续使用同一存储。
- “使用 API Key”根据 Claude、OpenAI、混合分组显示客户端、默认页和可选模型；支持 Claude Code、Codex、适用的 Codex WebSocket、OpenCode 与 API 示例。
- Codex/WS 只生成 API Key Mode 完整 `config.toml`，Provider 名称为 `tapmodels`，含认证、Responses 协议、模型和适用功能开关；不生成旧环境变量/auth.json 配置路径。
- 模型目录支持自动获取、刷新、下载及远程/本地文件切换。配置文件可复制/下载，终端命令仅复制；系统选择按客户端区分 macOS/Linux、Windows、PowerShell、CMD，并明确选中状态。

### Codex 原生模型目录

- 通用 `/v1/models` 继续遵守当前 Key、用户分组资格、白名单与关联资源；Codex 原生目录在同一授权范围内只保留后端可识别的 OpenAI GPT 对话模型，排除 Claude、图像及不受支持的模型。
- 远程目录、下载的 `codex-models.json` 和模型选择器共用同一范围；无 OpenAI 资源时不编造配置或回退到 Claude。OpenAI 兼容接口不代表其中所有模型都属于 OpenAI。
- 按 Codex `rust-v0.160.0` 官方数据和类型统一 52 个顶层字段、13 个 `model_messages` 字段，保留各模型自己的指令和能力，校验类型并补齐缺省值；来源、哈希、LICENSE、NOTICE 一并保留。
- 历史上 Astra/Sol 系列曾固定为 `500000`；现行实现改由 OpenAI 模型配置中的 `context_window_override` 控制，未设置时跟随上游目录。原生 `max_context_window` 保留，其他系列上下文不被强行改写。
- 配置中使用 `/v1/models`；实际协议按 Codex 客户端版本协商原生格式。远程目录超过 1 MiB 时改用本地文件，支持取消和超时；URL/目录 JSON 不包含密钥、上游地址或认证头。
- Codex WebSocket 只在已有 VM 执行路径支持时提供，不给上游 API 分组虚构 WS 能力；商业 Key 不声明尚无计价契约的独立搜索，模型内搜索不受此限制。

### 代理及槽位环境

- 代理只支持 SOCKS5（`socks5://`、`socks5h://` 及无协议头的 `host:port` 等写法），出站统一 `socks5h://`，目标域名交给代理解析，失败不隐式改走直连。HTTP、HTTPS 多协议支持已于 2026-11-04 撤销。
- 代理标准/快捷添加、密码显隐、留空保留认证、真实连接测试和质量报告；支持有效期快捷天数、指定日期、永不过期，以及明确配置的备用代理或本地出口回退。
- 回退检查目标可用性、席位容量和循环关系；到期停止新请求调度，切换后重载槽位。手动停用不被健康检测重新启用，续期不自动切回。
- 质量检测使用匿名网络探针，展示出口信息、服务可达性、延迟、HTTP、评分和故障；连接配置变化后旧报告失效，不发送真实推理或供应商认证。
- 创建、编辑槽位沿用上游功能、交互及文案，在 `en_US.UTF-8`、`zh_CN.UTF-8`、`ja_JP.UTF-8`、`C.UTF-8` 之外增加台湾繁体 `zh_TW.UTF-8`，写入原系统环境/种子链。语言与时区独立，沿用出口跟随及显式手动时区规则；需要台北时区时可独立手动选择 `Asia/Taipei`。

### 控制台身份、品牌和发布

- 默认品牌为 tapmodels，支持站点名称、说明与 Logo 配置；登录前可读取公开品牌。更新默认镜像、部署目录、Compose/systemd/节点标识和文档；仓库及原作者许可、署名与固定 payload 来源保留真实名称。
- Theme Settings 替换为 English、简体中文、繁體中文、日本語菜单，保存语言偏好；采用 i18next / react-i18next 与标准 BCP 47 locale，按模块维护四语资源，覆盖业务页面、弹窗、提示、表单和公共组件，并校验缺失键、插值与硬编码文案。切换即时生效，日期数字跟随界面语言，未保存表单保持；台湾繁体与日文维护本地化技术术语约定，区分授权码、认证资讯、会话及 LLM Token 等语境。明暗主题独立，语言菜单不展示内部 locale 代码，也不修改 VM 系统语言。
- 用户入口只保留右上角，按能力显示个人资料、本人 Key 或管理项；个人资料和改密由后端验证本人身份，不能借请求修改角色/余额/授权，改密撤销其他会话。
- 一键更新、版本发布说明与发版来源为 `holeenlu/vm2api`；应用镜像为 `ghcr.io/holeenlu/tapmodels-gateway`，与 sub2api 的镜像分开。
- 同步上游新版本推送后按原始 X.Y.Z 自动发布整套系统，同版本修改不发布；显式人工运行保留 X.Y.Z.N 修订号与 publish=false 仅构建验证。正式产物仅 linux/amd64，发布前检查源码版本、架构、payload 哈希、必需资产及校验和，全部 guest/KVM 成功后公开 Release。正式 Release 复用本完整说明。
- 上游每小时第 17/47 分钟做只读预检，冻结输入、检查迁移与定制契约、保留候选 bundle 和报告并复用 CI；不自动推 main、发版、部署或替人决定业务冲突。

## 优化改进

- Actions 的 All workflows 列表跨工作流合计只保留按创建时间最新的 10 条记录。现有工作流结束后自动清理，每小时补查，并可手动运行 Actions retention；运行中的旧记录暂留，完成后参与清理。删除旧 run 及关联日志/产物，不动 Release、标签、镜像或代码；上游预检产物的 14 天是最长保留时间，受最新 10 条策略约束。

- 用户已持续授权：本项目功能修改完成且相关验证通过后，自动归入单一定制提交并推送 `holeenlu/vm2api/main`，无需逐次下达提交指令。仅审查/暂不推送等明确限制优先；仍核验上游、独立远端修改、备份、精确 lease 和本地收口，上游新版交付持续授权整套发布，同版本不自动发布；部署仍另行授权。
- 保留适用的槽位登录、真实硬件与缺失容器修复、输出前故障转移。当前协议及官方客户端处理以 1.4.009 为基线，不保留已撤回的 Codex 官方透传设置；现有 Claude 开关按当前上游路径执行。
- 上游租户修复按本项目商业契约适配：客户继续不能管理或删除槽位，资源维护仅由超级管理员 SA 执行；商业 API 分组继续可用，旧 category 不成为绕过商业授权的入口；无组平台诊断排除历史私人 GPT 资源。商业 `/v1/usage` 继续返回本人 USD 权益，无组平台 Key 才读取上游 Claude/Codex 窗口。保留已删除的旧 Key 范围编辑器和自建配额代码的删除状态。

- 整套发版将前端/Node 验证与 Go 验证和原生构建并行，两组成功后才组装镜像；同次运行的前端、Go 程序和已校验 payload 直接复用，保留源码 Docker 构建入口。启用 npm/pnpm 缓存及同工具链 Go 依赖缓存回退，Docker 仅导出最终镜像缓存；保留版本预留、全局发布锁、镜像启动验收及完整产物校验。
- 网站根路径 `GET/HEAD /` 以 `307` 和 `Cache-Control: no-store` 跳转 `/console/`，沿用管理台现有欢迎、登录和会话流程；其他入口、健康接口与 API 不变。
- 网站 /settings/about 的 Changelog 使用随应用交付的上游 CHANGELOG.md 原文。同步时完整恢复冻结上游日志并校验候选一致性，包含历史修订；定制说明仅存于本文。日志冲突不阻挡该文件同步，其他业务冲突仍须审查；部署对应源码或镜像后网站才更新。
- 分组编辑模型白名单只显示一个搜索选择列表，已选置顶，不重复铺开标签；列表移除冗长模型与售卖价格摘要。
- 用户新建/编辑统一分组授权和专属设置，移除重复操作入口；专属设置窗口不默认聚焦搜索框，数值输入有标签，选中用户后回填。
- 共用可搜索选择器，已用于用户、分组、VM、套餐、账务及日志等动态筛选；输入查询与已选值分离，处理异步数据、清空、焦点和键盘交互。固定枚举仍使用普通选择器。
- 创建槽位的节点、出口恢复上游原生选择器；语言保留短代码展示。分段选项内部不拆行，窄屏允许整项换行。
- API 资源复用上游地址卡片和原生编辑侧栏，显示类型、地址、prefix、Key/模型数量及状态；在组内直接添加/编辑，移除重复跳转和冗长说明。API 在授权地址内按上游轮询；VM 的组内优先级在 GPT 与 Claude 两条调度链生效（2026-10-29 修复）。
- 代理行操作顺序与添加/编辑布局统一；本地出口保留其真实只读协议和可编辑名称/状态。
- 运行密钥持久化到数据目录 `runtime-secrets.json`，权限 0600；容器重建沿用已有加密/哈希基础，环境中显式配置仍优先。
- payload 下载支持单文件固定 release，继续验证大小与 SHA256，避免同名上游资产被重发后静默使用错误文件。
- 后续同步和修改只更新最新上游之上的一个定制提交；临时合并树与正式历史分开，累计说明与提交内容一致。预检恢复同时验证候选 SHA、唯一父提交、来源和基点。

## Bug 修复

- 修复调度资格快照在构建期间过期后仍空等的问题：RPM 或冷却窗口在资格检查期间到期时，直接重读资格并改用已恢复的账号，不再睡到请求截止时间。

- 修复 GPT/Codex 与 Claude 两条调度链忽略分组内 VM 优先级：GPT 在最高权重档内先选组内优先级最小的 VM 再按 smart 评分，Claude 在最高调度等级内先按组内优先级分档再比负载；两侧会话粘性仍优先。

- 修复欢迎页「进入控制台」被首配向导反复重定向的问题：顶部、主视觉与底部按钮直接进入概览，管理页不再以 guide_used=false 强制返回欢迎页；首次根入口引导、登录与角色权限仍保留，进入控制台不更改首配状态。

- 修复控制面更新后 GPT 槽位容器仍运行、独立 Codex kernel 却随旧控制面退出而未恢复的问题。启动恢复改为同时恢复运行中 GPT 槽位的推理进程，复用现有配置和就绪检查，不重建槽位容器、不改手动调度开关；停止槽位不自动开机。单槽恢复失败会记录错误并继续其他槽位，升级助手仍严格检查更新前健康的 kernel。沿用现有 watchdog 与 eager_start 开关，无新增接口、配置或迁移。

- 修复 VM 账号授权“复制链接”在 Clipboard API 缺失时静默无效：GPT、Claude OAuth 与官方登录终端复用现有 copyText，支持选区复制兜底，成功和失败均有明确反馈。不改变授权链接、令牌、回调或凭证写入流程。
- 合并 Responses 故障转移时保留终态用量证据：失败可重试与真实 usage 是否完整分别判断，原始用量证据保留，实际是否计量按上游对应执行链路判断，不产生待对账记录。

- 修复总览健康环数字与状态标签重叠；槽位详情的凭证状态与到期时间按完整内容换行，避免秒数末位被拆到下一行。仅调整显示布局，不改变健康评分、凭证到期时间或状态判断。

- 修复 `HEAD /` 跟随跳转后控制台返回 404：控制台入口与静态资源支持 HEAD，沿用 GET 的状态、内容类型和缓存策略，不读取或发送文件正文；缺失文件仍返回 404。同步修正健康测试中已过时的 Go worker 转发文案断言，核对当前 Rust kernel/slot egress 行为。

- 补齐写入 .0 后的 VERSION 唯一来源断言；发布检查覆盖真正写入四段版本后的检出。修复 RPM/冷却在异步资格检查期间到期时仍睡到请求截止的问题：已过期的候选快照立即重新检查，不扩大准入权限、不延长等待上限。

- 历史 `.0` 发布计划和资产保持可读；2026-10-30 起新手工修订从 `.1` 开始。草稿/tag 保留占号以避免覆盖，纯构建验证不占号。

- 适配当前上游请求体回退，恢复现有调用需要的入站 TTL 解析及会话固定；清除已撤回的 OMP 图片尾置实现/测试、不可达的第二次 persona 重写分支及专属 marker 补齐函数。补齐官方模板、5m/1h TTL、真实出站 envelope 与商业计量交界回归。

- 修复控制台语言切换后业务页面、表格、弹窗、校验和无障碍文案未同步的问题；清除旧稀疏词典，补齐四语资源与缺失翻译守卫。修复日语短状态标签折行、原生上传控件语言不一致及命令菜单不稳定快照警告。官方初装的跨层回归与遥测验证脚本改为核对资源键和语义，支持显式开启或关闭；翻译守卫按命名空间索引键族，避免全量检查重复扫描。

- 修复旧“分组覆盖用户 RPM”兜底逻辑，多 Key/多组绕过上限、删除在途 Key 释放额外用户并发，以及专属 `0` 被当成未设置的问题。
- 修复商业调用在 VM/API 两条执行链的授权、撤销、重试与结算一致性；消费归属不再混同 VM 所有者，用户请求不能伪造全局资源范围或他人统计。
- 修复运行 secret 每次启动变化导致新建 Key 无法再次解密；区分只有哈希与密文解密失败，认证成功后可补存合法原始 Key。不能凭哈希还原从未保存的明文。
- 修复 VM 分组框不能显示/搜索/选择、套餐选择列表闪退、Key 创建时误展开所属用户列表及重复用户授权界面。
- 移除选择繁体语言时强制台北时区、切换离开繁体时强制跟随出口的特殊分支；恢复 C 语言选项，并修正语言选项内部折行。
- 修复 Codex 目录混入 Claude、字段和嵌套数据裁剪、下载与选择范围不一致、配置不完整及命令误带下载按钮。
- 修复代理测试固定报成功、SOCKS5H 被静默改写、备用绑定先解绑导致容量失败后失去旧出口、过期探测覆盖停用状态等问题。
- 更新现有 Claude/GPT 种子、模型能力与计价映射；保留真实同步目录、手工策略和仍受支持的历史 ID，不将“目录可见”误当账号已获权限。
- 定制默认开启自定义工具的 eager input streaming，缓解大工具参数等待导致的流式空闲超时；明确的调用方布尔值及配置 `false` 继续生效，服务端工具不改写。
- 以实际上游版本递增防止同版本修改或历史归并误发布；上游新版历史重写允许整套发布。读取或来源核验失败时拒绝发布，CI 保留。

- 修复 Anthropic API 流式请求丢失 usage：Messages、Chat、Completions、Responses 在转换前保留原始用量；API/VM/Codex 共用终态计量证据，初始或部分计量不再按输出零结算，已知零输出可正常结算。
- 上游连接接口现仅 SA 可用；端点 PATCH 核对 Key 所属关系并原子更新，省略字段保留原值，不写回脱敏值。
- 修复慢速上传期间 Key 停用、删除、轮换、过期、IP/额度/分组变化失效不及时；请求体读取后和准入时重新核验，排队调度、健康检查后和实际派发均复查当前范围，GPT/API 重选同步核对模型白名单。
- 修复分组资源并发编辑使用旧版本快照的问题：写事务内读取当前版本，冲突返回 409，保留先完成的变更。
- 新增前向迁移 048，仅为套餐预留记录添加 `(subscription_id, created_at)` 索引，避免每次准入扫描全部账单；不改写历史迁移或资金数据。
- 发布规划校验冻结上游提交确已进入源码历史且版本一致，未同步时停止；自动 `.0` 起号、已有序号递增规则不变。
- 删除公共初始密码：一键安装随机生成并写入 `.env`；直接容器启动随机生成并写入 `data/runtime-secrets.json`（0600），已有配置/数据库密码保留，日志不显示密码。

## 破坏性变更

- 工作台入口已撤销，旧地址不再注册；请从控制台根入口或现有业务页面进入。

- 根路径不再返回状态 JSON。通过 `/` 读取服务状态的程序应改用现有 `/health`；仅检查存活可使用 `/healthz`。此入口调整部署后自动生效，无需新增配置或数据迁移。

1. **主线历史重写。** main 相对冻结上游只保留一个定制提交，旧自定义 SHA 与本地 merge 不再是新主线祖先。现有 tag/Release 不移动；不要用普通 merge/pull 把旧定制历史重新合回来。
2. **全新品牌部署。** 默认 `/opt/tapmodels`、`tapmodels` 服务/容器、`TAPMODELS_*` 部署参数及新的浏览器/导出标识；不提供旧 vm2api 品牌的目录、参数、包格式和偏好自动迁移。`KIN_*` 仍属于现有内核运行时契约，不是旧品牌兼容层。
3. **商业授权来源更换。** 独立 VM pool 管理及 Key 的旧资源范围编辑链已移除；分组关联、用户资格和白名单成为统一来源。普通客户 Key 必须关联获授权分组；无组的超级管理员自用 Key 与商业扣款区分。
4. **RPM 语义改变。** 用户全局上限始终生效，组和 Key 是同时适用的额外约束；仅有一个 `0` 不代表整体无限。旧“用户仅兜底”的提示和实现不再适用。
5. **API 组内优先级退出。** 额外的“只挑最低组内优先级”筛选已移除，原值不再参与 API 调度；共享存储列因 VM 仍使用而保留，不删除历史数据。
6. **Codex 配置与目录更新。** 生成方式收敛为 API Key Mode，目录采用完整统一的 OpenAI 原生结构，Astra/Sol 为 500k；旧下载文件应重新获取，本地模式需重启 Codex。
7. **数据库谱系不可混用。** 本地 039–044 是运营、代理、专属设置和资料迁移；上游后续的节点直连、平台和 inbound device 迁移在本谱系为 045–047。不能把已按上游同号不同内容升级的数据库直接当作本分支数据库使用。
8. **发布和默认行为调整。** 正式应用产物只构建 linux/amd64；已有 ARM64 手动控制面部署路径保留，不代表新增正式 ARM64 镜像。历史重写不再自动发布 guest/KVM；需要更新时单独授权人工运行。自定义工具 eager streaming 默认值由关闭改为开启，可显式关闭。
9. **槽位语言与时区解耦。** 台湾繁体不再强制台北时区；已有手动固定值保持，不自动迁移。需要跟随出口时，在槽位时区设置中显式选择跟随代理。

10. **上游协议路径调整。** 按 1.3.218 更新 cli-hop 内容规范化与身份处理，撤回上版专属官方透传实现和无效设置文案。请求 TTL、缓存用量证据与本地一次结算仍按有效调用链保留；不将过期路径作为兼容实现继续并存。

## 升级指南

### 代码维护与协作

- 先把当前仓库、未提交改动和运行配置分别备份；本次完整 Git 历史已保存在仓库外 bundle。上游保持只读，交付远端固定为 `holeenlu/vm2api`。
- 已使用旧定制历史的协作者，推荐在新目录检出交付仓库 main，再逐项移植未发布工作。不要直接 pull 后合并旧 main；其他任务、worktree 和现有标签应保留。
- 以后每次冻结最新上游和远端旧 SHA，完成三方语义审查、清理及相关测试，刷新本文，再用组合树创建唯一父提交为上游的定制提交。验证上游到 main 提交数为 1，以固定旧 SHA 的精确 lease 发布；远端变化时先审查，不自动覆盖。

### 部署与数据

- 新装管理员密码从受保护的 `.env` 或 `data/runtime-secrets.json` 读取，或显式设置 `TAPMODELS_ADMIN_PASSWORD`；无公共默认密码。已配置弱密码不自动更改，需管理员自行改密，现有弱密码引导检查保留。
- 部署后自动应用前向索引迁移 048。历史 `pending_usage` 保留为档案，不补造账单或冻结资金；该流程已撤销；本轮未执行生产数据操作。
- 上游连接、模型、优先级、启停和资源分组维护均由 SA 处理；AD 不再承担资源运维。

- 1.3.218 基线组件升级须更新 Node、前端及所需运行组件，并使用 deploy/payload.json 锁定的 payload-2026.10.22-computer-linux（新的 kin-computer SHA256 a6497083…，cli-node 仍为 b5054cb8…）。从 1.3.209 升级不需要重建已有槽位或重算计算机身份；从更早版本升级仍需按跨版本变更同步 CLI/worker，worker 会过滤旧配置中的硬件遥测键。只推代码不会执行这些部署操作，不覆盖 routing.json、vms、data 或 .env。

- 本定制面向新的 tapmodels 环境。按 `docs/BRANDING_AND_RELEASE.md`、`docs/DEPLOY.md` 配置服务、目录、域名和持久卷；应用镜像须先经授权人工发布，代码推送不等于镜像或生产已经更新。
- 原 vm2api 环境继续独立保留；不要直接替换其容器、挂载旧库到新品牌目录或宣称可原地升级。迁移真实用户、余额、凭据与槽位需另行确认数据来源、迁移谱系、备份和回滚方案。
- 同一已确认的 tapmodels 迁移谱系升级时，先备份 SQLite、data、vms 和 runtime secrets，在隔离副本验证前向迁移。不得重新生成 DB secret；仅保存哈希的 Key 需持有原明文认证补存或明确轮换，不能逆推出明文。
- 建立供给 → 配置分组 → 授予用户资格/套餐 → 充值或设置权益 → 创建绑定分组的 Key，再检查模型目录、试调用、账务与日志。VM/API 组不得混用后端。
- 审核用户/组/Key 三层 RPM、用户并发、金额窗口及专属 0/null；代理到期回退必须明确选择且目标可用。繁体槽位使用 `zh_TW.UTF-8`，时区独立沿用出口或手动设置。
- 从“密钥 → 使用”重新生成对应客户端配置；下载新目录覆盖旧文件，选择本地目录时重启 Codex。已有原生客户端认证文件不由服务端自动删除。

### 验证与回滚

- 更新后检查健康、角色隔离、分组授权/撤销、VM/API 请求与一次结算、三层限流、目录和复制配置；真实供应商推理与数据迁移应按单独授权执行。
- 源码回退使用已备份的准确树/commit，数据库使用对应备份并核实版本；不能只换旧镜像继续写已升级数据库。发布 tag 不因整理 main 而改写。

## 清理、保留与已知限制

- 本轮工作台撤销与语言选项修订：后端权限 7 项、前端相关 53 项通过，类型和生产构建通过。广域国际化扫描中通知设置缺失 `notify.vmOffline` / `notify.vmOfflineHelp` 的 1 项失败已在交付前源码快照复现，尚未修复；不作为本轮通过结果。

- 2026-10-22 发布加速通过发布回归、真实产物归档/恢复与损坏校验场景、相关 Node 单测及 YAML/Shell 检查；未触发新 GitHub 构建或发版，未执行本地完整镜像验收。新 Go 缓存键首次运行需预热，实际耗时以之后获授权的运行记录为准。
- 删除旧 VM pool 页面/仓库/路由、旧 Key 范围编辑、重复用户授权、重复左下账号菜单、Theme Settings 及独占图标、旧 SOCKS 地址实现、旧动态目录字段拼接、旧认证生成和失效文案。
- 保留原作者许可/署名、上游提交和固定二进制来源、仍有真实调用者的历史模型/locale、VM 共用优先级列、历史迁移及审计；代码删除不等于清空数据库旧行。
- 控制台四语覆盖业务页面与共享控件，共 29 个命名空间、每语言 4,787 条资源值；用户内容、代码标识及后端原始诊断保留原文。台湾繁中与日文已完成术语专项复核并校订 63 条，尚未宣称全量独立母语审稿；范围见 docs/I18N_TERMINOLOGY.md。统一搜索已落到上述页面，后续全站规划不能当作已经全部实施。
- 不新增 sub2api 的全部平台能力，不把官方 ChatGPT/Claude 桌面应用当作支持任意自定义 API 的客户端。单组 VM/API 混合供给、跨谱系原地升级及真实生产迁移不在本次实现内。
- 此前多语言交付在主工作区通过前端全部 75 文件、592 项测试及类型、格式、ESLint 和生产构建检查；本地浏览器覆盖四语、模型页与弹窗、VM 创建和种子编辑、品牌设置、登录、窄屏布局及草稿保留。最终应用壳四语切换／刷新 8/8，通过后术语资源另做专项复核并重新运行完整前端测试与构建。记录见 docs/I18N_DELIVERY.md、docs/I18N_TERMINOLOGY.md。该次另通过官方初装后端 27 项测试与遥测本地夹具 11 项检查；这些多语言、槽位后端 43 项及 Node/macOS 验收均为历史证据，不作为本次协议同步重新执行；本轮未执行生产部署、真实客体开机、供应商推理或收费请求。

- 此前 1.3.208 协议同步的本机验收覆盖 CLI 请求体、billing/CCH、缓存、persona、失败调度和隔离商业 HTTP 契约；本机为 macOS/Node 24，完整 Node 单测中的 Linux payload、egress 和宿主差异不能在此环境直接验收。当前源码的 Linux/Node 22、Go、前端与完整契约结果以对应提交的自动 CI 为准；未执行生产部署、真实供应商推理、收费请求或真实槽位升级。

此前自动版本修复只调整工作流输入、规划/校验、对应测试与说明；保留其余累计定制差异，未执行应用发版或生产部署。版本 .0 的规划、发布、安装与更新链路以本轮定向回归和当前提交 CI 结果为准。

此前根入口交付将 GET/HEAD / 跳转至 /console/，沿用当前欢迎、登录与会话流程。当时专项 HTTP 与静态入口 5 项通过；完整本地 Node 单测 3,295 项通过、15 项失败、27 项跳过，存在缺少 Linux 产物、macOS 套接字及宿主假设等限制；旧健康 E2E 文案断言当时在修改前后均失败。这些是历史验证记录，不作为后续修改的验收结果。

此前补齐控制台与静态资源的 HEAD 响应，并更新旧健康文案断言；macOS / Node 22.20.0 下静态文件单测与健康 E2E 共 9 项通过，覆盖完整跳转、四个控制台入口、空响应体、缓存头及缺失文件。语法、格式和 diff 检查通过，未重新运行全量 Node 单测或浏览器登录验收；未发版或部署。

此前交付已纳入 Changelog 上游原文恢复、同步预检一致性校验及 37 项集成/契约测试，并保留 docs/ADVANCED_FEATURES_AUDIT.md 指定旧基点的评审记录。本次交付在此基础上归并 R1–R9 修复、首装密码加固、HEAD 响应修复及上游 1.3.209；不发版或部署。


### 2026-10-22 全量审查问题修复验证

本轮修复审查 R1–R9 及首装公共密码风险，保留原有 HEAD 工作区修复。计费/Key/协议专项 244 项、Key 准入补充 59 项、端点凭据 23 项均通过（这些集合有重叠，不合并计数）；商业、资料、模型目录与健康 E2E 13 项通过。前端 75 文件/592 项测试、类型检查与生产构建通过；发布 36 项、部署 34 项测试通过，部署测试在 macOS 使用 `/private/tmp` 避免 `/var` 符号链接影响路径安全夹具。

全量 Node 初跑为 3,351 项：3,311 通过、13 失败、27 跳过。其中一项旧 count_tokens 测试仅伪造分组而未创建真实 Key，已改为真实存储并通过最终专项；其余 12 项与审查阶段已在冻结上游复现的 Linux 产物缺失/macOS 环境失败一致。后续修改只重跑受影响专项，不将全量初跑记为全绿。现有前端大块警告仍在；未运行真实供应商推理、Docker 镜像验收、生产迁移或远端 CI。上述为修复阶段验证；随后按用户授权归并到当前最新上游并交付代码。未发版或部署。完整记录见本机 `.local/review-fixes-20261022/REPORT.md`；历史未知账单不补造；原资金待对账入口已撤销。


### 1.3.209 归并交付验证

本次冻结上游 `f65fb98ed37368aa1076d79afe952f0a68a93d16`，与交付前 `cdbf1937c68b9cdd0b35e9f0ffbc0fb51c505246` 对比审查了新增上游变化及全部工作区修复。4 处文本冲突逐项处理，保留四语文案与商业权限；移除随上游撤回的 OMP 专属测试和不可达重写路径。累计差异和本轮差异均列于 `docs/CUSTOMIZATION_FILE_INDEX.md`。

新组合树通过协议/遥测专项 163 项、最终协议与商业回归 83 项、清理回归 63 项；商业/资料/目录/健康 E2E 的 13 项通过。前端 75 文件 / 592 项测试、TypeScript 与 Vite 构建、修改文件格式检查通过；worker `go test -race ./...` 与 `go vet ./...` 通过；发布 36 项、同步预检 37 项通过。集合有重叠，不合并计数。安装逻辑与修复阶段已验证源码相同，复用 34 项部署测试结果。

全量 Node 在归并过程中执行 3352 项：3311 通过、14 失败、27 跳过。其中两项为撤回功能留下的缓存形状/图片尾置断言，分别修正或随失效功能删除后通过 63 项补测；另外 12 项与前述已确认的上游/macOS 环境失败一致。额外尝试的 5 项真实 kernel/CLI E2E 因本机缺少 Linux kin-kernel 未执行成功，不与模拟 HTTP E2E 混称通过。未执行 Docker、真实供应商推理、生产迁移或部署。

上游原始 CLI TTL 测试中的六项不一致在独立原始源码检出中复现；保留显式 5m/1h 实现并修正过时断言。更新后的 cli-node 从清单指定的上游 Release 下载，大小 27174928 字节、SHA256 `b5054cb8494670354e61f3e0a0f7b2c3b768832c841140a4e22407fec24ab009`、ELF 文件头均核验一致。此检查不代表已在本机运行 Linux 二进制。

按用户授权将全部当前有效定制归入一个父提交为冻结上游的提交，并使用精确 lease 交付至 `holeenlu/vm2api/main`。本次不推送标签、不启动人工应用发版；guest 守卫对历史重写拒绝镜像发布，普通 CI 保持启用。远端状态及本地收口证据保存在本机 `.local/upstream-sync/review-fixes-delivery-20261022/`。


### 1.3.216 自动交付及 UI 修复验证（2026-10-22）

本轮保留上游原有账号授权/单槽包导入导出，修复健康环文字重叠、详情时间拆字、三处授权链接复制入口，并记录持续自动代码交付授权。独立检出整合 f65fb98e→d810f47c 的协议、权限及槽位变更，再合入仅 VERSION/CHANGELOG 变化的 7184a056；不覆盖另一任务的同步检出。

前端全量 76 文件/599 项通过，最终复制改动后补跑相关 34 项、类型检查/生产构建及修改文件格式与 lint；浏览器使用实际组件及虚构数据验证健康环、桌面/375px 详情和中英文布局，授权复制验证标准 API、API 缺失、权限拒绝和复制失败反馈。标准路径读回链接逐字一致；兼容路径触发真实 copy 事件、选区为完整链接，内置浏览器的虚拟剪贴板不支持读取该传统路径，不把它描述为操作系统剪贴板全覆盖。

后端首轮专项 354 项（348 通过、4 失败、2 跳过），其中两项合并测试问题修复后最终 API/usage 专项 49 项通过；其余两项 Linux 系统信息测试在原始 d810f47c 复现。商业权限/计费专项 54 项与 HTTP E2E 4 项通过。全量 Node 3390 项：3350 通过、13 失败、27 跳过；其中一项本次测试数据库夹具错误修正后 API 专项 33 项通过，另外 12 项均在相同上游原始检出复现为 Linux 二进制缺失或 macOS 系统接口限制；没有修改断言掩盖环境失败。发布规划/守卫测试通过（详见本轮交付证据），没有执行真实供应商请求、Docker/生产验收或数据处置。

kin-computer 从清单指定上游 Release 下载，5531864 字节、SHA256 a64970838469da0e3b86831212e8f6b0806e3433a65dd062f6556252403c2bb9、ELF x86_64 均校验通过；未在 macOS 执行该 Linux 程序。CI 由代码推送触发，独立于应用发版和 guest 发布；远端真实状态以交付报告为准。


## 2026-10-23 同步与验证流程优化

- 保留 GitHub CI，普通 push/PR 按实际交付前后树选择检查；兼容单一定制提交的非快进更新。文档、前端、Node 与 Go 采用对应检查范围，工作流、依赖、payload、未知路径和基点缺失回退全量。手动及预检候选保持全量，新增 result 汇总门禁。
- 本地采用受影响验证，输入相同复用成功证据；恢复时识别已交付同步，避免旧草稿覆盖新修复。服务层优先吸收适用上游修复，保护明确商业契约。
- 修复上一交付 api-backend 测试的 Biome 格式错误，无业务行为变化。保留原 CI、半小时预检去重及 forced guest 发布保护；没有停用检查或弱化权限/计费断言。
- 无新增业务功能、数据迁移或破坏性变更；升级无需额外配置。使用分支保护且要求各独立 CI 任务的仓库，应将必需检查调整为 result，以兼容有意跳过；本轮未修改远端分支保护设置。
- 本轮本地验证：上游预检及选择器 40 项通过（含非快进树比较、缺失基点、删除路径、PR/手动/预检分流）；格式及工作流结构另记交付报告。未重新执行未变的业务、前端或 Go 全量，不将旧结果冒充本轮全量通过。


### 同步流程收口补充（2026-10-23）

- 将人工同步明确为现状核验、增量定位、冲突处理、相关验证、单次交付、清理收口六阶段；已有等效交付和有效证据直接复用，最新上游追加只处理新增批次。
- 累计说明采用完整差异核对与增量修订，不重复审查无变化源码；本任务被替代草稿必须完整归档校验后移除临时检出/分支，不再遗留到任务完成之后。
- 本次仅修改流程文档和本机技能，无业务/测试代码、工作流运行逻辑、迁移及部署变化。现有 CI 路径选择和预检去重继续使用；实际执行效果需以后续同步耗时验证，不宣称已达到固定耗时。


## 2026-10-23 模块审查与失效实现清理

完整结果见 [模块审查](CUSTOMIZATION_REVIEW_2026-10-23.md)。审查输入 e17b6a6a / 上游 7184a056（1.3.216）。发现 R1–R5 五项待修复问题：异步调度撤销、GPT/API 模型白名单重选、Key 清空组、HTTP 控制台幂等标识、API 供给告警。本轮只清理确认失效的实现，未将上述功能缺陷标为已修复。

清理无调用方的 UsersRepo.addBalance、update 内不可达余额分支、attachPricing 废弃参数与无效查询、WebSocket 旧租户配额透传及两个无用导入。保留实际参与当前结算、备份恢复和私人资源隔离的共享实现；不改历史迁移或真实数据。业务 +5/−27，净 −22 行；测试无增删，无新接口/配置/迁移/执行路径。

清理后相关单测 147/147、商业契约 E2E 6/6、语法/格式检查通过；清理前 176 项审查回归也通过，两组有重叠不累计。另有隔离复现证明现有测试未覆盖上述动态场景。无需新增部署配置；代码推送不执行应用/guest 发布或生产部署。详细验证与限制见模块审查及本轮交付报告。

交付前保留独立任务 3906ceb9 的 Codex kernel 启动恢复。补测恢复与商业契约 26 项，25 通过、1 个既存 macOS stale-socket 断言失败，已在未含本轮清理的远端源码中复现；未弱化断言，Linux CI 状态另报。


## 2026-10-23 五项审查问题修复

R1–R5 已完成修复，具体边界与回归见 CUSTOMIZATION_REVIEW_2026-10-23.md 的后续修复验收。覆盖异步调度/队列撤销及释放、GPT/API 最新模型授权、管理员清空 Key 分组、HTTP 页面账务幂等标识、API 供给告警。旧实现直接替换，没有保留并行旧入口；无新增 HTTP 接口、配置、数据库迁移或数据处置，部署后自动生效。

本次用户明确指定仍以 7184a056（1.3.216）为唯一父提交；上游 d5fa63e2（1.3.218）的生图、计费和迁移另行处理，不混入本轮。相关 Node 单测 207 项、商业 E2E 6 项、HTTP 场景 Vitest、ESLint 和前端生产构建通过；构建包含 TypeScript 检查。没有执行应用/guest 发布或生产部署。前述“仍待修复”描述是上一轮审查时的历史状态，以本节为当前状态。


## 1.3.218 同步及商业生图适配（2026-10-23）

- 吸收上游 `/v1/images/generations`、`/v1/images/edits`（含无 v1 前缀别名），编辑支持 multipart；模型页增加生图开关、图像价格、模型映射和同步目录信息。新增前端文案按现有四语言接入。
- Images 通过本地授权分组选择 VM、检查模型白名单、Key 并发/RPM、余额检查及请求后一次扣费；API 后端分组通过关联的 OpenAI endpoint 转发 Images 请求，沿用模型白名单、密钥准入和实际用量结算；不回退到 VM 或未授权 endpoint。Free-plan GPT 槽位按上游规则拒绝生图。
- Responses 的 image_generation 工具同样检查模型授权；图像成本加入商业账单，价格按请求开始时的报价固定，重复结算不会重复扣款。图像模态拆分不完整不补造费用，不建立待计价或资金冻结；原生 Codex 仅 verified 终态计量。
- 上游新增迁移 042 与本地既有编号冲突，映射为新增 **049_usage_logs_image_generation.sql**；历史 001–048 未改写。增加图像模型、原始用量、输入/输出计数和成本列；现有日志/资金不变。部署对应源码后由原有机制应用迁移，本轮未操作生产数据库。
- 保留本轮期间另一任务交付的 39747ca2 全部 R1–R5 修复，不覆盖并发授权撤销保护、模型重新检查、Key 清空组、HTTP 幂等标识和 API 供给告警。
- 本地相关后端 356 项通过；整合远端修复后受影响回归 185 项通过；HTTP 商业/原生目录 6 项通过。前端类型检查、构建、35 项相关测试及修改文件 ESLint/Prettier 通过；6 项发布守卫测试通过。未运行真实供应商收费推理、容器部署或生产迁移。

本轮补入上游多轮缓存锚点修复：长对话保留最近两次用户回合的缓存标记，沿用本地所选 TTL 与调用契约。前端 609 项及缓存回归 30 项通过，类型、格式与构建通过；浏览器以本地生产构建和模拟 API 验证入口，未部署生产。


## 最小充分验证与需求交付分流（2026-10-23）

- 普通新增/修改/修复/撤销保持已同步上游基线，只更新一个定制提交；明确同步上游时才追到实时最新。避免小修改隐含升级其他系统功能。
- 验证按实际风险选择最小组合：文档/格式不跑业务，前端类型检查不与已含 tsc 的构建重复，构建和跨层 E2E 仅在对应风险出现时扩大；已有测试覆盖则不新增重复断言。
- CI 纯后端变化只选 unit/contracts，仅 unit 测试变化只选 unit；前后端同时变化取并集，工作流/未知路径/缺失基点及手动/预检仍全量。保留 result 门禁、单提交树验证、备份、精确 lease 与临时资源清理。
- 无业务接口、迁移、运行配置或部署行为变更。检查选择器的真实 Git 历史重写、删除路径和事件分流回归通过；不因流程维护重跑业务构建。


### CI 任务内部定向验证（2026-10-23）

- Node 单测文件变化只执行对应文件，保持逐文件进程隔离；已审查的生图 multipart 解析边界执行解析和 Images 入口测试，调用方变化或边界无法限定则回退。普通后端不附带运行工作流/部署/发布 Python 回归，去除 panel-users/onboarding 在全量 suite 外的重复单测。
- Go 测试文件单独变化只测该包，不带 Node/HTTP 集成或额外构建；源码按实际变动模块与生产/测试依赖闭包选择包及调用方，定向 race；依赖、资源、删除包或解析失败回退模块全量。去除额外全量 vet，保留默认 vet 及不同 CGO 条件的命令构建。未更改 Go 业务源码或依赖。
- 本地前端仅类型契约受影响才补类型检查；SQL/迁移明确使用隔离真实数据库。全量检查须有具体影响范围或无法限定的原因。未知输入、手动/预检及汇总门禁保护保留。
- 46 项流程回归通过，最终受影响选择器 9 项补测通过，工作流 YAML/输入输出接线已核验；Go 命令编排由模拟工具回归覆盖，本机无 Go 工具链，真实 Linux Go 检查由自动 CI 执行。无新增业务接口、迁移或部署。


## 1.3.219 上游同步（2026-10-23）

- 采用上游 kin-guest-exec 修复：成功返回 0；来宾非零退出原样传播；ssh 255 或 timeout 124 返回 1 并报告 guest ssh unavailable，不再因 POSIX 的条件取反而误报成功。
- 无新增本地业务功能、迁移或配置。非零状态现在按真实失败返回，依赖旧误报成功行为的调用方将看到正确错误；控制面既有退出码处理路径保持。
- **线上生效条件：** 必须重建并部署 kin-kvm 运行器镜像，或等价更新其中脚本，再按上游说明重启相关服务；只更新 Node/web 不足。本轮仅推代码，历史重写发布守卫继续阻止自动 guest/KVM 镜像发布，未发版、部署或修改运行数据。
- 相关退出码/交互/参数回归 10 项通过，sh -n 语法检查通过。未安装依赖、未跑无关业务/前端/Go 全量或真实 KVM/Docker 验收。CHANGELOG 采用上游原文；此前验证不重复宣称为本轮新执行。


### 同类能力比较规则（2026-10-23）

同步/合并发现已有实现时，仍比较两边算法、适用条件、开销和异常处理，再决定保留、采用或局部借鉴；确认等效才标为已覆盖，避免重复移植。仅性能证据不足且影响选择时进行定向基准，未变输入复用既有结论。zstd 与 SSE 拼帧作为规则示例，本次未审查或修改其代码，也未执行性能测试。无业务、接口、配置或迁移变化。


## 1.3.220 上游同步（2026-10-23）

- 采用上游 CCH 修复：从全局/多行匹配收窄到首个规范 system 计费块，消息历史、后续示例及嵌入行保持原样；Node 预处理与原生 CLI 最终封签保持分工。本地此前没有独立更优实现，本轮不是重复移植；双缓存锚点无需重写。JSON 解析/序列化新增开销仅作源码判断，未做性能基准、未宣称性能提升。
- payload 的 cli-node 更新为锁定的 cli-node-cch-system-only-b5054cb8，大小 27174984 字节，SHA256 为 5d6b33b68d5461bb810befc45d49f0734aa808e722dffd1a1d31bdc2a2c3e6ed。保留上游历史版本修复工具及其拒绝未知文件、校验、备份和幂等保护，本轮未执行真实安装修复。
- 工作流冲突按实际构建链解决：保留手动发版、共享构建产物与选择性 CI；发布阶段从已校验 payload 复制稳定 cli-node 资产名，避免上游热修复资产名称变化破坏下载契约。已有产物往返测试同时验证资产别名内容和损坏拒绝。Linux 原生历史回归在已准备 payload 的 unit 任务运行；不恢复上游临时 oneshot 发版工作流。
- 无新增本地业务接口、配置、迁移或产品功能。修复会停止误改用户历史文字；升级代码后仍需按部署方式更新 CLI 模板并刷新 Anthropic 槽位才能影响在线原生调用，详见上游 docs/cli-cch-hotfix.md。本次只提交推送，未发版、更新在线槽位、部署或处置数据。
- 本轮本地 Node v24.22.1/macOS：CCH、CLI 调用链、缓存锚点、worker 传输 118 项及热修复工具 6 项通过；release 36 项、同步/CI 46 项通过，相关 5 个 JS 文件格式通过；真实 CLI 下载大小与 SHA256 校验通过。Linux 原生 CLI 链路交现有 GitHub CI 执行，本地未执行 ELF、前端构建或全量业务测试。历史验证记录不充当本轮证据。


## 1.3.221 上游同步（2026-10-23）

- 采用上游 official_303 模型档及单一组装器：lean 模型将调用方 system 移入首个 user reminder，Environment 按模型能力置于尾部 system 或主提示词，缓存点保留最后/上一 user 两点并受四点预算及面板 TTL 约束；full 模型继续已有结构，仅使用 2.1.303 版本。与现有双缓存锚点目标一致，采用其按模型分工而非再加一套重复缓存实现。未做性能基准，不宣称算法性能优于旧档。
- Node → CLI 调用链接入档案版本，保留本地真实 5m/1h 用量结算，不恢复已废弃的 panelRewrite 分支。billing 的 cc_entrypoint 和 UA 改为 cli，普通提示词与零注入的内置身份句按上游更新；已保存模板保持。相关变化可能使会话首轮重新建立缓存。
- 系统提示词和槽位覆盖支持手动选择“官方 2.1.303（按模型）”；设置 → 协议新增只读出站参照（GET /api/panel/outbound-profile），按已保存全局档显示。沿用管理员权限；四语言标题、选项、说明、状态和模板变量文案齐全。该卡片不是实际网络抓包，也不代表槽位覆盖值。
- 自带 routing.json 的请求日志默认模式为 normal；已有部署文件不覆盖，debug 仍须手动启用。新增上游出站结构检查/真实链路 replay 工具，未向在线供应商发起回放。
- payload 锁定 cli-node-303-944f6457，27175272 字节，SHA256 944f645772f02ed5ca032d4b80151d00184a7c91a3ca3cb4e9e3746cf40025d8，已实下载校验。它包含 CCH 修复及 303 档支持，不将新构建误登记成旧版热修复资产；旧修复工具的适用范围保持。上游未发布条目的 Accept/Content-Length/timeout 修复尚未进入本 payload，不宣称已经交付该二进制能力。
- 升级需要更新 Node、前端及 CLI 模板，并按部署方式同步槽内 CLI；旧 CLI 上线前不要启用 303 档。无需迁移或数据处置，勿覆盖现有配置/凭证。具体上游升级条件以根 CHANGELOG.md 为准；本次未发版、部署、同步在线槽位或执行修复脚本。
- 本轮 macOS / Node v24.22.1：15 个相关协议/身份/缓存/权限测试文件 301 项通过；运行器及热修复工具 16 项通过、1 项因锁定 payload 已非旧 hotfix 而跳过。前端相关模板/档位测试 26 项通过，国际化 10 项通过，类型检查、相关 ESLint/Prettier 与 31 个 JS 文件格式检查通过。发布与同步工作流检查另见交付证据；未重跑无关前端构建、Go 全量或浏览器验收。
- Linux 原生 CCH 与 official_303 真实本地模拟链路接入现有 CI；原生旧 CLI 字节对比需要独立 base CLI 输入，不冒充已执行。上次 1.3.220 交付 CI 已确认全部成功，不能充当本次新代码验证。


### 1.3.221 CI 发现的问题与修正

- 设置命名空间遵守现有扁平字符串资源约定，出站参照翻译改为扁平键，不改变测试约束；补跑设置专属国际化回归。
- 原生 CI 证明锁定的 944f6457 实际 UA 仍为 sdk-cli；上游 Node 档案宣称的 cli UA 与尚未发布的 Accept/encoding/timeout 断言不能当作此二进制已具备。出站参照描述明确 Node 参照与实际原生 UA 的差异，保留严格请求头断言，只对实际 SHA256 为已知旧构建的输入单独跳过该子测试；新 CLI 字节仍必须通过。303 骨架、版本、billing、CCH、缓存/历史及热切换断言继续执行，不跳过整个原生测试。
- 初次本轮 CI 的 web 与 unit 失败如实保留在交付记录；修正后 CI 状态单独记录，不能用本地通过替代 Linux 验证。未擅自修改二进制、解锁未知资产或宣称上游未发布功能已经修复。


### 交付前最新上游增量与原生夹具适配

- 继续合入 98d2357f：具有 description 与 schema 的调用方 web_search 族 function 保持客户端工具，不再误改成原生服务端搜索；原生 web_search 类型及非搜索工具行为保持。使用现有入口/转换/清理测试验证，不重跑未变的 303 或 UI 本地检查。
- 原生 replay/E2E 夹具为 master-key 日志提供隔离内存 SQLite，满足本项目事务提交契约并在清理时关闭；不修改业务结算/日志逻辑。前一轮 Linux 已通过真实 303 结构、历史缓存及 CCH，但日志断言因夹具缺少数据库失败，此处补齐依赖，继续验证原断言。

## 1.3.222 上游同步（2026-10-23）

- 基线从 `98d2357f` 更新到 `1c3541f7`；上游增量仅为 VERSION 与 CHANGELOG.md，web_search 修复已在原定制主线中。全部业务代码、测试、依赖、payload 与发布工作流保持不变。
- 解决发布准备阶段因上游推进到 1.3.222 而拒绝旧源码的问题；保留最新上游必须已合入的发布保护，不绕过检查或在旧源码上单独修改版本标签。
- 本轮无新增接口、配置、执行路径、迁移或破坏性变更。仅同步并推送代码；应用及 guest 镜像发版、部署均未执行。后续发版需从更新后的 main 新建手动运行，重新运行旧任务仍使用旧源码；上游若再次前进仍需先同步。

## 1.3.222 后续上游同步（2026-10-23，66a95307）

- 基线从 `1c3541f7` 更新到 `66a95307`，上游 VERSION 仍为 1.3.222；完整保留上游 CHANGELOG.md。同步后发布准备步骤可校验此上游祖先；现行规则继续冻结运行时最新上游，上游若再次前进仍需同步，未放宽发布限制。
- 槽内 payload 来源更新为 `payload-2026.10.23-v1.3.221`，CLI 资产恢复为 `cli-node`，其大小和 SHA256 保持 27175272 字节与 `944f6457…`；原有内核、CLI 与 glibc 的大小/哈希全部不变，不冒充新增上游尚未发布的请求头能力。
- 不采用上游预编译 `kin-worker`、`kin-egress`、`kin-slot-gate`：本项目 worker 含 HTTP/HTTPS/SOCKS 拨号与配置校验定制，上游二进制不能替代（2026-11-04 起 HTTP/HTTPS 拨号已删除，其余本地 Go 差异仍使预编译二进制不能替代）。三者继续由当前源码构建，且不加入 payload 清单；Docker 与发布产物链保持一致，无重复下载后再覆盖。
- 不采用上游单 job CI：保留既有真实前后树范围选择、预检候选恢复、Go race、商业契约和汇总门禁。删除已废弃的 CCH 热修复脚本、两份文档与两份测试，并移除工作流对已删除测试的引用；已有 official_303 真实链路仍校验 CCH、历史消息和缓存行为。以上取代此前章节关于保留旧热修工具的说明。
- 构建文档按实际源码编译路径更新，同时纠正旧的手填版本、publish 默认值和 package 元数据描述。本轮无新增业务接口、配置项或迁移；不发版、不部署、不修改生产数据。后续需从最新 main 新建手动发布运行。

## Codex 压缩请求入口修复（2026-10-24）

- 修复 Codex 向 Responses 入口发送 zstd 压缩 JSON 时，服务端直接解析压缩字节而返回 `Unexpected token '('` 的问题。共享 JSON 入口先按 `Content-Encoding` 解压，再解析 JSON，支持 zstd、gzip、deflate、br，以及按逆序解码多层编码；普通和 identity 请求行为保持。
- 线上的编码字节与每层解压结果均受原有请求体上限约束，解压超限返回 413；不支持的编码返回 415，损坏或截断的压缩数据返回结构化 400。图片等多模态 JSON 内容完整保留；multipart 原始读取路径不做解压。
- 无新增 API、配置项、依赖、迁移或破坏性数据操作；新增共享 JSON 入口解码路径。运行时需具备 Node 原生 zstd 支持（Node 22.15.0 及以上的 22.x 或相应新版本），缺少该能力时明确返回 415。部署包含本修复的服务后自动生效；本轮仅提交推送，未发布应用版本或部署生产。
- 最终定制组合使用 Node v24.22.1 / macOS arm64 验证：`node --test test/unit/request-body.test.mjs test/unit/respond-sse.test.mjs test/unit/cors.test.mjs` 共 35 项通过；相关语法、Biome 格式与 diff 检查通过。Node 22 未在本机实跑；Linux 检查由推送后的现有 CI 执行，状态单独报告。
- 保持现有上游父提交 `66a95307`，不附带同步上游；手动检查更新修复已于同日后续交付，见下节。旧 JSON 直接解析步骤改为解压后解析，不新增并行兼容入口。

## 手动检查更新实时刷新修复（2026-10-24）

- 修复 GitHub 已发布新版但侧栏版本弹层中的“检查更新”（原入口为设置 → 关于）仍命中后端 5 分钟旧缓存的问题。手动检查调用 `/api/panel/version?force=1`，跳过应用缓存，并以独立查询参数和禁止缓存请求头向 GitHub 取最新 Release；自动后台查询保留既有缓存。
- 前端取消旧版本查询并更新同一查询缓存，后端用查询序号阻止慢旧请求覆盖较新结果；检查失败后可立即再次手动重试。升级目标解析也主动刷新，避免使用过期的“已是最新”结果；不会因检查版本自动执行升级。
- 保留 `holeenlu/vm2api` Release 来源、四段定制版本比较、tapmodels 品牌与四语言界面；无新增接口路径、持久化配置、依赖、迁移或破坏性变更，仅增加既有版本接口的可选 `force=1` 参数和强制刷新路径。部署包含此次前后端修改的版本后生效。
- 本次接续工作区全部 7 个未提交文件，连同先前 zstd 修复归入同一完整定制提交，保持上游父提交 `66a95307`。旧按钮的普通 refetch 改为强制检查，不保留重复按钮或平行查询缓存。
- 最终定制组合在 Node v24.22.1 / macOS arm64 上验证：后端 release-errors、panel-update、release 三组共 36 项通过；前端 queries、about-pane、settings i18n 三组共 10 项通过；TypeScript `tsc -b`、相关 Biome/Prettier 和 diff 检查通过。807 个前端依赖包全部复用缓存、无下载，锁文件不变。未重复运行无关构建、Go 测试或生产升级；远端 CI 状态单独记录。
- 本轮交付仅提交推送全部待提交修复，未发布应用版本、guest/KVM 镜像或部署生产。清理本次临时工作区和依赖，保留仓库外恢复备份；主工作区最终切回已交付 main 并核验干净。

## 1.3.223 上游同步与 Node 22 解压边界修复（2026-10-24）

- 上游基线由 `66a95307` 更新至 `2433866e`。采用上游 #667：原生 Anthropic Messages → Anthropic API endpoint 转发调用方的 anthropic-*、x-claude-code-*、x-stainless-* 等协议头，含未知 beta；大小写不敏感地覆盖 endpoint 同名默认值，保留 safeguards 请求和结果。OpenAI 兼容路径保持原行为，调用方 Authorization/x-api-key 不覆盖 endpoint 凭据。
- 保留商业分组模型/endpoint 授权、分类器模型约束、真实 usage 证据及一次结算调用链。新增头部规则只作用于原生 Anthropic 边界，不引入第二套认证或计费路径；无文本冲突。
- 同基点预检发现 Node 22.23.3 会接受截断或空 zstd 字节，Node 24.22.1 则拒绝。共享 JSON 入口补充完整帧边界校验，覆盖帧头、数据块、校验和、拼接帧及 skippable 帧；块解压和校验和验证仍由原生 zlib 负责。非法压缩数据返回既有 400，合法空帧保持原行为。该守卫服务于仍在 Docker/CI 使用的 Node 22，所有受支持运行时原生拒绝截断后可移除。
- 本轮无新增 API、持久化配置、依赖、迁移或破坏性变更；增加原生协议头透传与 zstd 帧校验两个内部步骤。升级需部署本轮源码后重启 Node 服务，无需变更 payload 或重建槽；本次仅代码交付，未发版或部署。
- 本地 Node 22.23.3/macOS arm64：auto-mode-api、api-backend、usage-evidence 共 39 项通过；request-body、respond-sse、cors 共 37 项通过。Node 24.22.1 的 request-body 24 项通过。新增测试覆盖所有截断前缀、缺失校验和、追加截断帧，以及合法空帧、拼接帧和 skippable 帧。
- 复用预检 39993298334 的同输入前端、Go、payload 与商业契约成功结果；该预检整体因原有 zstd 回归失败，不能标为整体通过。修复后的 Linux Node 检查由交付 CI 执行，状态单独记录；不重跑无变化的本地前端/Go 构建。

## 1.3.224 上游同步（2026-10-24）

- 基线从 `2433866e` 更新为 `15528812`（上游 #700）。根 CHANGELOG.md 与上游逐字一致，VERSION 为 1.3.224；原始上游历史保留。
- 采用上游 API 直连头部修复：原生 Anthropic Messages → Anthropic endpoint 的显式配置头按大小写不敏感名称优先于调用方；`anthropic-beta` 取端点与调用方的去重并集，继续传递未知 beta 和 safeguards。此规则替代前节 1.3.223 的调用方覆盖端点默认值规则，不保留双重合并入口。
- 调用方的 `context-1m-2025-08-07` 使用现有模型页 `betas.pass_context_1m`、默认白名单及 `strip_context_1m` 策略判断，按请求规范模型处理；端点管理员显式配置的 1M beta 保留。其他 beta、OpenAI 兼容路径及端点凭据行为保持。
- 冲突仅为导入区：引入上游 beta 常量和模型策略函数，继续使用本地真实 usage 证据实现，未恢复已废弃的 `usageFromSseLine`。商业模型/endpoint 授权、分类器约束、真实用量结算及 Node 22 zstd 完整性修复保持。
- 无新增 API、配置项、依赖、迁移或破坏性数据变更；替换既有头部合并规则，新增调用方 beta 策略过滤步骤。部署本轮 Node 控制面并重启后生效，无需更新 payload、web 或重建槽；本次仅提交推送，未发版或部署。
- 本轮验证：Node 22.23.3/macOS arm64 执行 auto-mode-api、api-backend、usage-evidence、context-1m 定向回归，49/49 通过；覆盖端点大小写优先、beta 去重、1M 放行/剥离、管理员显式 1M、safeguards 流式/非流式、权限与用量失败路径。相关 Biome、Node 语法和 diff 检查通过。未变化的前端、Go、zstd 实现不重复本地构建或测试，Linux 结果按本轮 CI 实际状态报告。

## 1.3.225 与最终出站头日志同步（2026-10-24）

- 基线从 `15528812` 更新至上游 `3c45c685`，包括 #701 与 CLI 出站头日志修复；VERSION 为 1.3.225，根 CHANGELOG.md 与冻结上游逐字一致。
- 采用 `kin_outbound_headers` 内部事件：CLI 最终 fetch 调用边界回传的脱敏头写入 `outbound_headers`，来源标记为 `outbound_headers_source=cli_final`；Node → worker 的中间头单独写入 `worker_envelope_headers`。未获得回传时为 `unavailable`/null，旧记录不追认为最终值；`outbound_body` 继续表示 worker envelope body，不是最终 HTTP body 字节，也不把采样值称为网络抓包。
- 内部事件不流向客户端、不提交下游输出、不计 TTFT 或触发上游 idle 计时；每次实际发送的 envelope 清除此前最终头快照，随后仅由同次 CLI 回传更新。流式、非流式与上游错误路径均有回归覆盖。日志仍只在超级管理员配置 debug 时保存出站数据；用户与运维投影同步隐藏新增字段，真实用量证据和付费日志结算契约保持。
- 请求日志 → 原始数据增加最终出站头、中间头及缺失/历史值说明，接入简中、繁中、英文和日文，不保留硬编码中文分支。API 增加两个可选诊断字段，无新增路由、持久化配置项或迁移；历史日志无需改写。
- 采用上游 PR 重跑目标，融入现有多任务选择性 CI：计划阶段冻结最新 base SHA，五个所选任务合入同一 SHA，选择器比较实际 base→组合树。保留 preview 候选校验、只读 checkout、真实 before/after 范围、商业 contracts、Go race 和 result 门禁；main push 不相互取消，PR 可取消旧运行；main CI 从失败恢复后按上游规则重跑开放、非草稿且无冲突 PR 的失败 CI。不发布应用或镜像。
- 固定 payload CLI `944f6457` 尚未包含最终头回传和未发布的传输头补齐。本次不替换该未知新资产；真实链路在此精确旧 SHA 下检查 unavailable，传入更新 CLI 时仍强制检查采样与实际线头一致。获得最终头需另行发布/部署包含回传能力的 CLI，并升级 Node/web；当前服务部署本轮源码后会正确区分不可用与历史数据，无数据库变更。
- 本轮无破坏性数据变更、新增依赖或生产操作；五处文本冲突按 CI 架构、四语言、商业权限及固定 CLI 能力融合，移除旧 envelope 即最终头的展示含义，没有永久双重路径。
- 本地 Node 22.23.3/macOS：日志/传输/用量/重试定向测试 161 项通过；补充权限投影后重跑 request-log 52 项通过。前端原始数据与四语言测试 17 项、TypeScript `tsc -b`、相关 Biome/Prettier、Node 语法与 diff 检查通过；Chrome 本地组件检查确认最终头、中间头切换及不可用状态显示正常，无页面错误。同步/CI Python 48 项通过，含真实 Git 基线推进、冻结复用、冲突拒绝；发布保护 36 项中 35 通过、1 个既有跳过。
- Linux ELF 真实链路与标准矩阵交本轮 CI；本地不冒充运行 ELF。未改 Go 源码或 payload，不重复本地 Go/完整应用构建；Node 与 web 依赖从既有缓存离线安装，无下载。代码推送与远端 CI 状态分别记录，未手动发版、部署或迁移数据。

## 1.3.226 上游同步（2026-10-24）

- 基线由 `3c45c685` 更新为 `8f3b6bab`，含 #698、#710、2.1.303 出站身份与 CLI payload 更新。VERSION 为 1.3.226，CHANGELOG.md 逐字保存上游，包括历史修订。
- 采用上游单一身份方案：明确的 `official`、`official_full`、`official_303` 及 303 别名使用 2.1.303；空/旧档案查询及 zero/custom 等非官方档案保持其定义的 2.1.296，默认运行档 official_full 则为 2.1.303。Node 中间 UA 与 OAuth bootstrap UA 对齐 2.1.303 sdk-cli，worker 允许六种已抓取的 x-claude-code 身份头，Authorization/Cookie/X-Api-Key 等凭据仍不透传。
- 网关生成 billing 使用 `cc_entrypoint=sdk-cli` 并补齐轮次来源/索引；调用方自带 billing 保留其 entrypoint。最终 CCH 密封仍在既定发送边界，不改成 UA 字段；真实 usage 结算与商业权限保持。
- official_full 默认模板改为 billing、identity、2.1.303 稳定主提示词、Environment 和调用方 system；完整提示词首句通过上游 303 来源替换，复用现有提示词主体，移除被替代的默认 reporting/dynamic_boundary 块。已保存的自定义模板及仍被其使用的占位符保持有效。前后端模板 note 同源对齐，预览测试通过；缓存前缀/billing 字节改变可能让首轮重新建立缓存。
- payload 来源更新为 `payload-2026.10.24-cli-303-sdk`，cli-node 27784880 字节，SHA256 `cb2f8fb99bf2c191e5a32bd39e6489c2d02e72f3591ba7c3ba7a4e07229ba9fc`；已实下载校验，清单中全部资产的 GitHub 大小/摘要匹配，其他二进制字节保持。本地定制 kin-worker/kin-egress/kin-slot-gate 继续源码构建，不被上游预编译 helper 替代。
- 新 CLI 具备最终出站头回传，本轮删除旧 SHA 特判及传输头测试跳过，保留严格日志来源和实际线头比较。删除已不适用的“296 各档与旧 CLI 字节不变”可选测试；新版本主动改变身份/billing 字节，旧等价断言不能代表现行契约。真实原生链路继续覆盖 303 骨架、CCH、缓存、历史消息和热切换；旧 CLI 的 unavailable 业务提示仍用于未升级槽位。
- 排除三份一次性 oneshot 工作流：它们由 push 触发、硬编码 dofastted 仓库并写入 tag/Release/资产，不符合本项目只读上游与人工发版规则。保留上游原始提交历史和版本说明文件；本地应用/guest 发布保护、PR CI 重跑及选择性验证不变。
- 无新增接口路径、持久化配置、依赖、迁移或破坏性数据操作。升级需人工部署新 Node/web、更新固定 CLI 并按项目方式同步槽位 CLI 后重启；仅更新 Node 不足以启用二进制能力。不要覆盖 routing.json、vms、data、.env。当前仅交付源码，未运行发布、生产部署、槽位同步或数据库变更。
- 本地 Node 22.23.3/macOS：身份/提示词/billing/CCH/CLI 入口九组首次 206 项中 205 通过，唯一旧版本断言修正后 official-303 15/15 通过。调用方八组首次185项中175通过、6跳过、4失败；其中1个本地zero档断言已修正并重跑 routing-runtime-load 17/17，余3项为本机缺Linux OAuth ELF或Linux CPU信息，留交付CI验证。
- 前端模板/协议/i18n三组25/25，更新参照文案后settings i18n 4/4；相关格式、语法和diff检查通过。Go 1.27/macOS三个受影响包的race测试通过，kin-worker在CGO_ENABLED=0条件下构建通过；Linux Go 1.25由CI验证。发布保护36项（35通过、1既有跳过）。无UI布局和导入接口变化，不重复浏览器或完整前端构建；仅数据模板预览使用现有测试。
- 上游预检40093138358因冲突失败且validation跳过，没有复用为通过证据。所有依赖离线复用现有缓存；最终Linux矩阵与新CLI真实链路以交付CI实际结果为准。

- 交付 CI 首轮已通过 web、Go、payload、商业契约、面板 HTTP、同步/发布保护、格式与语法；原生 303 第一条失败于把底层补入的 Accept-Encoding 要求成 fetch 前快照必含字段。网络值为 `gzip, deflate, br, zstd`，实际采集值缺省；修正断言与文档，继续校验网络编码值、全部实际采集头及显式必要头的一致性，不放宽来源、脱敏、CCH 和身份断言。其余两条原生 303 回归已通过；修正后以最终交付 CI 为准。

## 1.3.226 后续上游同步（2026-10-25，6f188e94）

- 来源从 `8f3b6bab` 前进到 `6f188e94`，新增 14 个原始提交，VERSION 仍为 1.3.226。无新增依赖、数据库迁移或生产数据处理。完整保留上游日志；不吸收三份已排除的一次性自动发版工作流。
- 采用上游缓存前缀方案：从已确认且未过期的缓存写入位置选择读取锚点，历史改变后在旧图片前预写断点；原来只记录前缀的调用改为发送准备后的请求体，覆盖 CLI 和 HTTP 两条路径。图片水位按客户 Key + 会话隔离，跨账号故障转移保持；仅观察到客户端丢图片后启用，不改从未丢图的客户端。无 TTL 的写入按 5 分钟过期，最多四个断点，不把未确认/过期写入当热缓存。
- 采用缓存创建量余桶补算：message_delta 的总量超过 message_start 的 5m/1h 分拆时，余量按明确 TTL 归桶，否则按 5m；日志、成本模型与商业实际结算共用正确用量，保留报价快照、图像定价与幂等结算。原生出站继续保留混合 TTL，不恢复已删除的全局强制补 1h 逻辑。
- 未声明原生 web_search 工具时，重放的服务端搜索历史展平成文本，避免上游拒绝；真实搜索工具和计量沿现有路径。
- 「协议 → system提示词」的官方完整档支持按块关闭；关闭完整环境块且环境总开关开启时只追加时区。按模型附加句使用 `compatibility.model_env_extra`（模型 id 到文本，最多 64 项、每项最多 4000 字符）和 `model_env_extra_presets`（按档开关，默认关闭），没有配置的模型不追加；块选择使用 `persona_block_presets`（未设置全部保留）。环境块不再自动带固定模型句，`{{model_sentence}}` 从当前草稿配置取值。保留已保存模板，不强制重置。新界面与变量说明提供四语，并对齐关闭环境块后的预览与实际出站。
- 破坏性变更：随上游关闭 `POST /v1/messages/count_tokens`、`POST /messages/count_tokens` 和面板 `/api/panel/vms/:id/count-tokens`，返回 404。同步清除专属 Node handler、解析/拦截/识别旁路、worker 操作和上游客户端方法、错误码、测试及失效文案；usage 模块/测试更名为 user-usage。商业 `/v1/usage` 的本人 USD 权益与无组平台诊断授权保持，历史日志中的非计费端点识别仅供旧记录展示保留，无推理执行能力，旧日志不再展示时可移除。
- 修正上轮 CI 中 4 条旧 296 提示词断言：官方完整档现为 303 billing/SDK 身份/agent/environment 四块及可选调用方附加块，不恢复已被替代的 reporting 块；断言同时检查新版身份、完整 agent 内容和调用方内容。
- 升级指南：部署新 Node 和 web/dist；本轮 payload 仍为 `payload-2026.10.24-cli-303-sdk`（cli-node SHA256 `cb2f8fb99bf2c191e5a32bd39e6489c2d02e72f3591ba7c3ba7a4e07229ba9fc`），已安装相同字节无需再次换包。仍用旧 CLI 的槽位按上一节 fetch、wrap-cli/sync、重启流程升级。独立计数调用方须改用正式推理响应的 usage；不删除 routing.json、vms、data 或 .env。代码推送不等于应用发版或部署。
- 本地验证：Node 22.23.3/macOS 缓存/TTL/搜索整形/提示词/费用日志 225 项通过；相关协议调用方 174 项通过；修正的 API/模板/usage/客户端识别/槽内操作/凭证测试 99 项通过；商业授权/结算/调度等相关检查有效结果见本轮私有记录。前端模板/草稿/四语/历史日志格式 35 项及 TypeScript 检查通过；Go 1.27/macOS upstream/oauthcmd/kin-worker 相关包 race 测试通过。HTTP 契约首次 23 项中 21 通过，2 项因 macOS 无法执行 Linux kin-computer ELF（ENOEXEC）留标准 Linux CI，不冒充通过。Linux 原生 303 链路和最终矩阵以交付 CI 实际状态为准。
- 隔离 mock 网关 HTTP 实测三个计数入口均返回 404；浏览器确认模型附加句默认关闭，添加模型句并开启后草稿预览立即更新，关闭完整 Environment 块后仅保留一次时区段。未保存测试草稿，未发起真实供应商请求。
- 交付 CI 40142525030 的前端 622 项中 621 通过，唯一失败是上游前后端新增 env_extra 块的 note 字节不同；按后端原文对齐前端两处 note，未改变出站模板内容，src/lib/i18n.test.ts 22 项契约回归通过。相同输入的商业 contracts、Go worker 与其他本地验证继续复用。

## Actions 全仓保留最新 10 条（2026-10-26）

- 普通功能交付保持当前上游父提交 `6f188e94`，未附带同步上游。新增独立 `Actions retention` 工作流及 `scripts/release/prune_action_runs.py`，固定仅作用于 `holeenlu/vm2api`。它在现有 ci、guest-images、pr-rerun、Manual versioned release、Upstream sync preview 完成后运行，另于每小时第 31 分钟补查，支持 workflow_dispatch。
- 全量分页读取仓库所有工作流、所有分支和结果，按创建时间/run id 排序，保留最新 10 条（包含清理自身），只删除其余已完成记录；执行删除前复查状态，重新运行或尚运行的记录暂留。不以成功/失败筛选，不按每个工作流分别保留。读取失败立即失败，不误判为空仓；默认脚本仅预览，显式 `--apply` 执行删除。
- 使用 actions:write、contents:read；只检出默认 main，关闭持久 Git 凭证，不读取触发运行的源码或产物。完成触发名单排除清理自身，避免递归生成记录；新工作流加入时同步名单，定时补查仍覆盖全仓记录。
- 清理范围包含旧 run 的日志和关联 artifacts，可能缩短预检/构建产物的实际可用时间；Release、标签、镜像、源码及已部署数据保留。无业务接口、运行时配置、依赖或数据库迁移新增，无生产部署或应用/guest 发版。
- 验证覆盖跨工作流及分页排序、总数不超限、运行/重跑保护、只读预览、仓库边界、API 失败和触发链无递归；release 工具测试 42 项通过（含新增保留策略 6 项），新工作流 YAML 语法通过；脚本只读预览精确保留 10 条并选中 1 条旧记录，首次实际清理已将全仓 11 条降为 10 条。远端自动运行结果保留在本轮交付记录。完整说明随单一定制提交交付。

## 1.4.009 上游同步（2026-10-27）

- 基线由 `6f188e94` 前进到 `3d0224b3`；先审查 1.4.008 的 171 个路径，再吸收交付前新增的 1.4.009 十文件批次。按实际增量复用验证，保留全部商业、品牌和交付定制，CHANGELOG 与最终上游逐字一致。
- 采用上游四态调度：开、关、不可调度、受限。操作员关闭与确定性故障独立于维护/代理临时 hold；自动恢复只解除其所属 hold，不重新打开手动关闭的槽。移除旧 manual_schedule_wins 界面开关，已保存的旧值不再改变此规则。启动时调度 JSON 字段转换沿上游流程备份原记录，不改写已应用 SQL 迁移；本轮未执行生产转换。
- 采用 session 席位算法：同 client session 的在飞/排队请求共用席位，对话完成释放，sticky TTL 仅记住 VM；machine 粘性行负责同设备 VM 亲和，重启交接短时间保留 held 席位。商业 Key 的会话隔离、异步资格检查/授予/派发前授权重读继续保留；分组优先级当时记为保留，实际在其后的同步中丢失，已于 2026-10-29 恢复。租户私有 VM 池及分配个人所有权界面不复活，资源继续经商业 groups 维护；删除上游这次重新带入的旧池仓库、卡片、辅助选择器与专属测试。
- Claude 出站采用上游 303 协议。`cc_entrypoint` 可选 sdk-cli / cli，billing 与 UA 同步投影 kernel.json，保留 caller billing；原生 cli-node 负责模型策略和缺省 effort，Node 不再提前改写显式采样、thinking 或强制工具参数，HTTP 后端保留自身策略。中途 system 已 GA，不再声明旧 beta。
- 官方与官方完整档采用 billing、身份、harness 与动态边界；行为指引默认关闭，可显式开启。环境放入消息层 role=system，官方完整档的调用方 system 放入首条 user reminder；零注入只保留 billing 中的身份，不追加旧环境/standing/调用方段。旧 official_303 不再作为第五个界面选择，已保存模板及开关经现有 canonical 规则映射 official_full，保留用户编辑；custom 的旧 profile 定义继续按上游保留。
- 新 PromptFields 替换旧 InjectCard 和独立模型附加句编辑器，保留自定义详情编辑及模板无损往返。前端同步服务端四档模板、变量、role 元数据、guidance 与可选环境字段默认值，清除旧的隐式时区回退和 standing 插入。前端预览明确区分顶层 system、消息环境、首条 user 提醒；可选长环境、时区和语言默认不加载。补齐新控件、状态与提示词字段的四语文本，语言切换保留草稿。预览接口提供原始 guidance 供草稿开关选择，不开启实际请求的默认 guidance。
- 模型目录支持 Anthropic auto，并把模型 params.default_effort 投影到运行中的 Claude kernel.json；支持 off/low/medium/high/xhigh/max，内置目录各模型缺省以目录为准（常见为 medium），调用方显式设置仍由原生链路处理。Codex 原生目录和商业 Key 授权过滤继续保留；Astra/Sol 上下文覆盖现由 OpenAI 模型配置控制。
- 采用运行目录/文件属主及权限修复，保留控制面组读取运行密钥；Codex 槽重新加载会恢复宿主 kernel。针对本机 SOCKS5 槽采用 Docker restart=no，控制面先建立阻断/代理规则再恢复原运行槽，避免 Docker 重启时抢先直连；暂停槽不自动开机。代理到期切换沿本地备用代理策略，改用所属维护 hold，保护操作员关闭状态。
- 1.4.009 刷新通过持有集群 SSH 链接的控制面执行：等待相关节点、同步本机与集群 kernel/cli-node，再刷新 worker/egress；同一 payload 镜像上的运行中远程槽不重复重建，内核同步串行化避免升级助手和自动同步同时重建。保留 /opt/tapmodels 与 TAPMODELS_API_KEY，不引入 VM2API 部署路径。
- VM 详情增加上个 5H/7D 窗口与剩余估算；活跃槽徽章、设为活跃、删除前切换已有候选沿用上游接口和防误删规则。保留商业分组筛选/批量分组及资源维护权限，客户不能借新增入口管理槽位或越权读取。
- payload 更新为 `payload-2026.10.26-cli-effort`：cli-node 27789508 字节，SHA256 `f29bbfa45b68308367f4091699cbeb3a0baba860d327d349d6d55cc11408fb68`，已实下载校验。其他锁定资产按清单保留，定制 Go helper 仍从源码构建。升级须同时部署 Node 与 web/dist，并更新固定 payload、执行 wrap-cli/sync 后重启；新升级助手会经控制面完成本机/集群刷新。本轮只交付源码，未执行发版、容器替换、槽位刷新或生产迁移。
- 修复只读预检在 git diff --cc 含非 UTF-8 内容时异常：冲突补丁按原始字节保存，其他 SHA/路径读取继续严格校验；新增真实冲突回归，预检流程 49 项通过。保留全仓 Actions 最新 10 条及非快进拒绝 guest 发布保护。
- 清理过时 281/296 身份、第五 system 段、旧零注入和提前模型改写断言，以当前 303 role/reminder/零注入/profile 归属、原生与 HTTP 策略边界回归替换；保留账务、授权、拒绝、重试、流与有效兼容测试。具体退役案例及实际增删统计保留交付记录，未移除仍用于官方透传的历史 fixture。
- 验证采用 Node 22.23.3/macOS、现有 pnpm10 缓存和 Go1.27 helper；调度/商业单测369项、受影响Node回归及新增角色契约按记录核验；商业HTTP三组6项通过，1.4.009增量45项通过。前端84文件647项及TypeScript检查通过，真实浏览器核验提示词开关、英文切换保留草稿、活跃槽与分组列表。发布保护42项、预检49项通过。安装/ARM工具41项中39通过，2项受macOS GNU sed及/var符号链接差异限制；egress三项受Linux /proc进程识别限制，交标准Linux CI。其他最终检查以本轮记录和实际CI为准，不把平台失败算通过。
- 无新增 SQL 迁移、业务依赖或破坏性数据库处置；接口沿既有路径扩展字段。上游调度 JSON 启动转换与 Docker restart 策略变化仅在人工部署/启动时生效，操作员应核对服务启动与逐槽刷新报告；不能仅看版本号认定槽内 CLI 已更新。
- Linux CI 首轮 web、worker、kernel、contracts、面板HTTP、格式/语法、发布/预检流程已通过；原生303回归中3条仍约束退役的固定4块/3标记及默认guidance。改为真实链路验证当前official_full默认关闭guidance、显式打开guidance的两轮缓存前缀、CCH与最终采集头逐项一致、调用方提醒和热切换；不恢复旧模板来满足过时断言，最终Linux状态见交付记录。
- Linux原生复验发现上游 personaTemplateSettingsFromRouting 漏投影 persona_guidance_presets，导致保存后实际出站仍不加载guidance。已补齐字段，并新增通过真实routing文件执行请求渲染的开/关回归；保持默认关闭、调用方提醒及CCH契约。


## 1.4.010 上游同步（2026-10-27）

- 基线由 `3d0224b3` 更新为 `165b4991`；采用上游默认官方 CLI 身份句。`{{identity}}`、`{{identity_cli}}` 现均输出 `You are Claude Code, Anthropic's official CLI for Claude.`，零注入的 billing `prompt_version` 同步更新。`cc_entrypoint` 与 UA 仍由实际入口决定，调用方 billing 保留规则不变；历史字面量自定义模板不会被重写，使用 identity 变量的已保存模板随新定义生效。身份字节变化可能使升级后的首轮重新建立缓存。
- 前后端默认模板统一显式使用 `identity_cli`，四语言变量说明及身份详情同步更新。保留本地多语言接入、当前 role/reminder 结构、guidance 默认关闭、档位迁移和已保存编辑，不恢复已退役的第五档位及旧模板骨架。
- 采用上游 SOCKS5 严格探测：仅 TCP 建连、立即关闭、静默超时或收到 HTTP 横幅均不算 SOCKS 健康；分片方法选择响应继续正确拼接。保留本地明确选择的 HTTP/HTTPS/SOCKS5H 协议；HTTP 沿用 TCP 可达性，HTTPS 仍须通过证书验证的 TLS 连接，完整出口检查继续走既有连接/质量检测。方法选择不等于完整账号认证或供应商可用性，沿用上游 0xff 判定边界。
- 更新实际调用链中已过时的 SDK 身份断言，包括配置热读、自定义变量渲染、转换/CCH、零注入与 Linux 原生链路；保留旧 SDK 常量和历史请求 fixture，因为它们仍用于官方来流识别及 legacy 非模板路径，不把历史输入误改成新默认。
- 本轮无新增公开接口、配置键、依赖、迁移、payload 或发版入口；部署新源码/前端后生效，未执行生产部署、应用/guest 发布或数据操作。Node 与前端模板须一起更新；本轮 payload 锁定不变，不重复下载或重建未变 helper。
- 本地 Node 22.23.3/macOS：相关首组 187 项中 185 项通过，2 条旧身份断言修正后模板及出站参考 37/37；沿共享调用方补查，修正 SDK/零注入旧预期后 80/80，其余已通过的调用方结果复用（各组有重叠，不累加总数）。前端模板、提示词、四语及前后端契约 6 文件 61/61；显式 HTTP 可达与 HTTPS 拒绝错误 TLS 的探针通过，相关格式/语法及 diff 检查通过。源码输入未变的其他模块不重复全量验证；本机不能执行 Linux ELF，原生 CLI/CCH 链路由交付 CI 核验，状态见本轮交付记录。上轮 CI 40385762307 后续被取消，不作为本轮通过证据。


## 1.4.011–1.4.021 上游同步（2026-10-28）

- **调度与时序：** 采用上游联合调度快照、健康检查单航班、延迟写回和维护清理；保留本地 Key/分组/模型/VM 权限在候选、预留、排队授予和派发前重读。`wait_ms` 继续表示总等待，并新增 `queue_wait_ms` 与 `scheduling_ms`；历史记录保持 NULL，不臆测补写。
- **协议与可靠性：** 吸收 API 内核小体积 SSE flush、Codex 非流式 JSON 形态、首事件与流空闲超时、槽内 envelope 请求体上限、busy/no-capacity 换槽、重复工具名出站唯一化和 zero 档消息缓存断点。保留本地 Anthropic/Claude 账务、拒答审计、商业授权、请求幂等和四态 failover；旧路径不会绕过 Key/group 门禁。
- **账务与风控：** 吸收 JEV 使用明细/日汇总/累计汇总及迁移 051（上游编号 044）/045，审计只送用户正文并记录决策 state；托管 Codex/GPT 路径保留本地 acquire/release、额度、RPM、分组倍率和实际用量记账，不以未完整 usage 伪造成功扣费。
- **身份、遥测与资产：** 采用 Claude Code 2.1.303 构建时间、请求模型遥测和 cpuWindowMs；采用 ARM64 控制面 Node 22.23.4 与上游 `payload-2026.10.28-cli-host-cred` 的资产/版本基线，并保留本地 `wrap-cli/sync`、集群凭证链、四语言和 tapmodels 路径。payload 需按上游清单重新校验后再升级运行槽。
- **迁移编号与数据安全：** 上游 043–046 与本地已应用的 043–046 文件名发生编号碰撞；保留本地历史迁移不改写，将新增流时序、JEV 状态、JEV 明细和调度时序迁移顺延为 `050_usage_logs_stream_timing.sql`、`051_usage_logs_jev_state.sql`、`052_jev_usage.sql`、`053_request_attempt_scheduler_timing.sql`，同步更新测试和文档引用。现有数据库不会因重复版本号启动失败。
- **文档与发布保护：** 根 `CHANGELOG.md` 原文取自 1.4.021。保留 tapmodels 的 `AGENTS.md`、`CHANGE_DELIVERY.md`、完整定制说明、四语、Actions 全仓最新 10 条、人工 Release 和 guest forced/non-fast-forward guard；上游删除的品牌/交付文档未覆盖本地契约。未执行应用 Release、guest/KVM 发布、生产部署或数据操作。
- **本轮验证与限制：** 已完成冲突清理、全部变更 JS 语法检查和 `git diff --check`；调度新增 snapshot/health/timing、JEV、payload、API kernel 与前端风险页需在依赖恢复后运行受影响 Node/web/Go 检查。macOS 不能执行 Linux ELF 的限制继续交由 CI。上一轮 CI 不作为本轮验证凭据。

## 1.4.023 后续上游同步（2026-10-28，35f62b61）

- 上游在交付期间新增 `#805` 与 `#809`，最终基线由 `dd258dec` 前进到 `35f62b61`；本轮继续保留上一候选的全部定制，再吸收本批次。
- 采用 #805 的 Accept 协商：省略 `stream` 时仅在 `text/event-stream` 的 q 值严格高于 `application/json` 才发送 SSE，同值或 JSON 优先按非流式返回；显式 `stream` 行为不变。补齐转换、Codex Responses 和协议回归。
- 采用 #809 的 ARM64 本机 Claude CLI overlay：从锁定 cli-node 源码构建 Bun/glibc ARM64 bundle，源/工具/成员/ELF/manifest 全部校验，写入 `/opt/tapmodels/image-native-cli` 并只对本机 Linux ARM Docker 槽启用；远程 amd64 槽、凭证和便携 x86 payload 保持原路径。新增 ARM64 CI 构建与离线大体请求/并发/取消验收，保留 tapmodels 路径和现有选择性 CI/result 门禁。
- 本批次无新增 SQL 迁移、公开 API 或生产数据操作；payload bytes 未更换。ARM64 镜像构建会在部署/发版时执行，源码推送不等于镜像发布；本机未运行 Docker ARM64 构建。
- 本地验证：原生 CLI Python 7 项通过；Accept/Responses/Codex/native CLI Node 32 项通过。Linux ARM64 Docker、web、Go 与完整 CI 交由远端环境；之前 macOS egress/guest `/proc` 限制仍分别记录。

## 1.4.022–1.4.023 上游同步（2026-10-28）

- 上游基线由 `631b228e` 前进到 `dd258dec`（v1.4.023，含 #804），本轮在已交付 `02fbab5d` 上合并新增提交；最终主线仍保持“一个上游父提交 + 一个 tapmodels 定制提交”。
- 采用上游 agent summary 会话隔离：摘要请求继承父会话亲和但使用独立席位，不迁移父别名、不加入父序列化队列；保留本地商业 Key/group 隔离和授权重读。采用上游官方 caller system/cache policy 保留、请求体修复重渲染时按账号恢复 thinking ownership，并保留 303 billing、四语言、商业账务和重试边界。
- 采用上游 Codex service tier 记录和 #800 的发出/回显档位语义，保留 tapmodels 的实际 usage 扣费、倍率和幂等；采用 #804 在准入钩子释放期间按实时 inflight 递增的修复，避免释放的占位被旧快照复活。采用 v1.4.022/023 的发布版本与 CHANGELOG 原文，不改写上游历史。
- 上游新增 `047_usage_logs_upstream_service_tier.sql` 与本地已保留的 047–054 迁移编号冲突。按“已应用迁移不可改写”规则顺延为 `055_usage_logs_upstream_service_tier.sql`，并同步更新数据库回归；既有数据库不重放、不改写历史迁移。
- 冲突处理：`handle-protocol.mjs` 融合摘要席位与商业 Key 隔离；zero Persona 保留 caller system；前端系统预览保留 tapmodels 四语标签并只对模板中真实存在的 caller_system 标记首条 user。上游新增测试夹具补齐本地 `canAccept` 和事务桩，不改变生产门禁。
- 本轮无新增公开接口、依赖或生产数据操作；部署代码和前端后需重启服务，迁移 055 在启动时按现有迁移器前向应用。payload、Node/web/dist 的在线替换、`wrap-cli/sync`、应用 Release、guest/KVM 发布与生产部署均未执行。
- 本地验证：受影响 Node 单测、全量 Node unit 中除 macOS 无 `/bin/true`/Linux kin-egress 与 guest `/proc` 硬件探针限制的用例外均通过；Node 定向协议/Persona/缓存/迁移/账务回归通过。web 类型检查、Go race、Linux helper 与最终 CI 需在对应环境补验，不能把 macOS 限制记为通过。

### 2026-10-28 角色与定制恢复验收

本轮前端 85 文件、654 测试通过；类型检查和 Vite 生产构建通过。后端 23 文件、177 项定向回归及追加 20 文件、223 项回归通过，覆盖角色/会话、用户、Key、分组、钱包/套餐、日志/统计、上游凭据和迁移；真实 HTTP 集成 17 项通过。SQLite 副本升级到 054，重复迁移为空且完整性正常；本机 HTTP 验收 105 项通过，浏览器确认 tapmodels 品牌、原有商业菜单、唯一右上角账号入口，未捕获浏览器错误；该次浏览器记录早于本轮工作台移除，不作为本轮验收。具体命令与当前本机镜像记在 `docs/PANEL_ROLE_DELIVERY_20261028.md`。本次没有应用发版、生产部署或真实收费推理。

全量 CI 额外发现：JEV 旧角色断言已修正并单独通过 6 项；另有四项调度/思考回放/socket 用例失败。前三项在旧 `9e308223` 与当前树同环境复现，socket 仅 Linux 出现、尚需专项复核；相关源码和测试均未被本轮修改，不宣称全量 CI 全绿。详见 `docs/PANEL_ROLE_DELIVERY_20261028.md`。
## 2026-10-29 供应商单一角色与服务提供商运营视图

- 用户角色统一为 `super_admin`、`admin`、`user`、`vendor`。供应商不再拆成一级/二级登录角色；`vendors.tier`、`parent_id`、`root_id` 负责表达组织层级。
- 超级管理员在用户管理中新建“供应商”时，可勾选“允许创建下级供应商”。该能力映射为 `vendor.create_child`，并在同一流程中创建供应商主体和成员绑定。
- 供应商使用统一登录页，认证后默认进入 `/vendor`；拥有创建下级能力的一级供应商才显示下级供应商菜单，并可创建带登录账号的二级供应商。
- 新增 `/api/panel/providers` 与“服务提供商”运营页面，仅聚合供应商添加的账号、所属供应商登录账号名、授权状态、VM、5H/7D 额度窗口、恢复时间、Token、消耗和调度状态；不包含平台自建资源。
- 侧栏归并为“运营管理 / 资源管理 / 系统管理”，新增“服务提供商”入口；供应商门户仍保持独立，不暴露普通运营后台 VM 创建接口。
- 新增迁移 `057_supplier_login_role.sql`，将已有有效供应商成员的登录角色统一为 `vendor`；不删除供应商层级、资源或审计数据。

## 2026-10-29 CPR 研究与落地资料

- **新增研究资料：** 新增 `docs/cpr/README.md`、`01-research.md`、`02-target-architecture.md`、`03-roadmap-and-acceptance.md` 和 `04-evidence-index.md`，整理 CPR `main@958e13c3` 与 tapmodels `main@51955eb3` 的架构、请求生命周期、快照/revision、准入排队、账号错误保护、观测诊断、结算、目录、插件、备份和更新方案。
- **工程计划：** 以 VM/API 两条现有数据面为范围，定义 RequestPlanSnapshot、Attempt/SendState/DeliveryCommit、独立结算账本、账号错误保护策略、诊断 evidence、Provider/Resource typed port 和分阶段验收矩阵；明确不整体迁移单副本拓扑、PostgreSQL/Redis/S3 或完整插件 Runtime。
- **文档索引：** `docs/README.md` 增加 CPR 资料入口，并修正抄本服务文件链接为现行 `docs/deploy/tapmodels.service`。
- **运行影响：** 本轮只有文档和资料整理，无新增接口、配置、迁移、依赖、运行路径或数据处置；研究结论不代表相关功能已经实现。
- **验证：** CPR 资料 5 份 Markdown 与文档索引的本地链接检查通过；Markdown 无尾随空白，`git diff --check` 通过。未执行业务构建、Docker、供应商推理、数据库迁移或生产部署。

## 2026-10-29 前端界面国际化完整性修复

- **问题：** GitHub 前端国际化完整性检查在定制版 `main` 中发现 189 处仍直接写入界面的文案，集中在登录页、服务提供商页、用户管理页和供应商门户。
- **修复：** 将这些界面标题、按钮、筛选项、表头、状态、错误提示、分页、账号开户/下级供应商/代理表单和结算账单文案迁移到 `vendor` 命名空间或现有命名空间；补齐英文、简体中文、繁体中文和日文资源，并保留 `C.UTF-8` 的通用大小写显示。
- **范围：** `login-page.tsx`、`providers/index.tsx`、`users/index.tsx`、`vendor/index.tsx`、`vendor/portal-model.ts`，以及四套 `auth`、`providers`、`users`、`vendor` 资源。
- **兼容与清理：** 不改变接口、权限、业务字段或数据格式；删除本次涉及页面中的直接可见硬编码文案，产品名、协议值和运行时数据仍按既有语义显示。
- **验证：** 国际化完整性测试 5/5、供应商模型测试 2/2、TypeScript 检查通过；Prettier 检查通过；Vite production build 通过。`pnpm build` 在依赖安装阶段因当前 pnpm 禁止 `esbuild` 构建脚本而中止，已使用现有依赖直接执行 Vite 构建验证。

## 2026-10-29 Git 远端职责归整

- **上游 remote：** `upstream` 固定指向 `https://github.com/dofastted/vm2api.git`，只用于读取、同步和合并上游 `main`，不作为定制代码推送目标。
- **定制 remote：** `origin` 固定指向 `https://github.com/holeenlu/vm2api.git`，用于个人定制 `main` 的提交、推送和发布交付。
- **本地跟踪：** `main` 跟踪 `origin/main`；`vm2api_main` 跟踪 `upstream/main`。已清理旧的 `vm2api_kdan` remote 命名，避免把远端名称误认为分支或同步来源。
- **验证：** 已核对两个 remote 的 fetch/push URL、分支跟踪关系和本地 `main` 与 `origin/main` 的提交状态。

## 2026-10-29 管理员根域平级管理修正

- 管理员可继续创建下级管理员；创建关系保留在 `users.parent_user_id`，权限范围改为按超级管理员直属根管理员划分。
- 同一根管理员及其全部下级管理员、普通用户属于同一管理域，管理员之间可以互相查看、修改、删除账号、Key、日志、统计和账务；不同根管理员域之间完全隔离。
- 保留 API Key 创建者记录与“管理域 / 我的 Key 使用记录”视图，超级管理员仍拥有全局权限；管理员不能管理超级管理员或供应商账号，也不能访问平台基础设施资源。
- 本轮只调整权限范围和回归断言，不新增数据库迁移；现有管理员层级与 API Key 创建者迁移继续使用。

## 2026-10-29 管理员查询与角色导航修复

- 修复管理员使用记录、统计及充值记录出现 `no such column: role`：统一递归域查询的 `id/role` 投影，资金流水和套餐只按用户归属过滤，不再引用日志专用的 `api_key_id`；指定用户时同时校验管理域并精确筛选该用户。缺少域信息时拒绝返回全局数据。
- 删除重复生成“我的账户”的菜单路径；管理员顶部直接显示用户、统计、使用记录、充值记录，不显示“运营管理”标题，下方只保留一组“我的账户”（API 密钥、本人 Key 使用记录）。使用记录按 `scope` 区分选中状态，应用筛选时保持个人范围。
- 普通用户的统计、充值记录、API 密钥、使用记录在同一组连续同级排列，不显示分组标题。普通管理员和用户的侧栏品牌区不显示网站副标题、版本号卡片，也不发送版本检查请求；超级管理员保持现有显示。
- 修复个人 Key 使用记录筛选项将范围对象当作用户 ID 的问题；筛选用户继续限定在当前管理域。保留 A 域内平级互管、A/B 跨域隔离与个人 Key 创建者范围，无新增接口、配置、依赖、迁移或生产数据处理。
- 验证：Node 24.22.1/macOS 下 60 项定向回归通过（包含真实 SQLite 日志/统计/资金流水/套餐及账务路由的同域、跨域和单用户查询）；前端菜单、选中范围、日志筛选与导出 30 项通过，TypeScript 与格式检查通过。浏览器实测管理员充值/使用记录无 SQL 错误、同名导航只有一个选中；普通用户四菜单同级显示，管理员和用户品牌区均无版本卡片或副标题。
- 升级：部署新后端和前端后生效，无需数据迁移。本轮仅交付源码，未部署生产或发版。


## 2026-10-29 管理员域共享余额、定向充值与超管 Key 免钱包计费

- **功能与优化：** 每个根管理员域共用一个钱包，超管从任意域内管理员行充值均进入该钱包。管理员给自己创建的普通用户充值时原子扣减域余额、增加用户余额；5000 → 转出 500 → 4500 → 再转出 1000 → 3500，其他同域管理员实时看到同一余额。管理员自用 Key 扣域钱包，用户 Key 扣个人钱包；代用户创建 Key 不改变 Key 的所属账号和资金来源。
- **超管 Key：** 绑定分组的超管自用 Key 免个人钱包检查和扣款，保留分组实际用量计价、Key USD 额度及其他 Key 门禁；免扣决定和钱包归属写入请求快照。无分组自用 Key 恢复上游平台请求路径，不调用分组钱包扣费或改写请求体，真实用量继续扣减 Key USD 额度，耗尽后停止使用。
- **权限与界面：** 超管可给管理员域注资；超管和管理员仅能给自己直接创建的普通用户充值。域内平级管理、全部用户用量可见和跨域隔离保持。用户管理中管理员增加“余额与流水”，同域余额标注“共享余额”；没有充值权的用户仅显示流水。新增说明完成简中、繁中、英文、日文翻译。
- **迁移与清理：** 新增 `066_admin_domain_wallets.sql`，保留已交付的 065 供应商迁移。把同域原管理员余额汇入单一域钱包并清零旧个人管理员余额，保留普通用户余额和历史流水金额。固定域归属替换每次沿父链重新推断的查询，根管理员删除后域及钱包仍保留。该历史迁移曾补充预留归属；旧预留现仅保留档案，不参与当前余额和计费。
- **边界与升级：** 无新增公开路由、运行配置或依赖。部署后启动时前向迁移，需同时更新 Node 与前端；本轮未执行生产迁移、部署或发版。历史普通用户若没有创建关系，不推断为任意超管所有；master-key 原始记录保留其维护边界。个人资金未结清时禁止直接提升为管理员；转账禁止单边冲正，避免生成无来源资金。
- **验证：** 真实 SQLite 新装/旧库升级、重复迁移、余额守恒、并发预留、幂等、删除根管理员、角色变化后结算及 Key USD 上限回归通过；HTTP 覆盖零余额超管无分组 Key 成功调用后额度耗尽、管理员域充值/转账、非创建者拒绝、VM/API 与 OpenAI 商业路径。前端类型和四语检查通过，浏览器确认两位同域管理员均显示 3500，用户分别显示 500 和 1000，管理员充值入口和非创建者只读流水正确。


## 2026-10-29 普通管理员用户操作与 Key 创建修正

- 普通管理员登录后的用户列表，不再显示其他管理员行的“余额与流水”；普通用户行和超管管理入口沿用各自权限。移除余额旁“共享余额”标签及其四语专用文案，资金共享规则保持。
- 普通管理员创建 API Key 移除“所属用户”控件，不再显示错误的“当前超级管理员”选项，也不从用户筛选条件预填归属。请求省略所属账号，服务端固定为本人；伪造同域或跨域账号 ID 均拒绝，Key 创建者字段由登录身份记录。超管保留既有代建能力，普通用户保持本人归属。
- 自定义密钥改为普通文本输入，关闭浏览器自动填充、拼写检查、自动更正和大写转换，并添加密码管理器忽略标记，清除原密码字段触发登录凭据建议的路径。
- 无新增接口、迁移、配置或依赖；历史 Key 归属、额度和实际用量不改写。需部署后端和前端后生效，本轮未部署生产或操作生产数据。
- 验证：12 项面板/超管 Key HTTP 回归、32 项多语回归、TypeScript、相关格式和 diff 检查通过；浏览器确认普通管理员列表按钮、无共享标签、无所属用户控件，自定义 Key 字段为关闭自动填充的文本输入。


## 2026-10-29 服务分组搜索关闭自动填充

- 创建 Key 的“服务分组”使用共享 SearchSelect 搜索输入。显式设为搜索字段、使用实体搜索名称，并在实际聚焦的输入上关闭自动填充、拼写检查、自动更正及大写转换，添加密码管理器忽略标记。共享实体搜索选择器均使用这一设置，避免被识别为账号密码输入。
- 下拉选项、即时搜索、键盘选择和分组授权保持；无新增接口、配置、迁移或依赖。需部署前端后生效，本轮未部署生产。


## 2026-10-29 VM 用量窗口与成本自动更新

- 修复实时席位 SSE 写入 React Query 缓存时不断重建 5 秒计时器、导致 VM 列表 HTTP 更新被延后的问题。VM 页面采用独立生命周期的 5 秒刷新，隐藏页面暂停、恢复可见立即取数；请求重叠时复用在途请求，保留实时席位事件与原用量轮询。
- 正常 Claude 请求仍优先采集真实响应头；无完整额度头或页面可见时缺少新样本，由既有 monitor 异步读取官方 usage。自动路径保留每账号成功缓存 3 分钟、失败缓存、并发/队列上限和 429 退避，不阻塞客户端或列表响应，也不发 Fable 权益推理。手工强制探测及原显式启用的周期探测保持各自契约。
- 5H、7D 和 Fable 窗口持久化实际采样时间；Fable 只有 reset 头时也能更新，旧查询缓存不能覆盖新响应头或解除更新的硬限制。列表不再让旧 official rejected 强行压住时间明确更新的 allowed 样本；历史没有采样时间时保持原规则。
- 新请求用量写入后失效成本聚合缓存，后续读取包含最新 Token 与成本；相同数据仍复用缓存，保留历史补价限频。官方额度百分比继续来自官方窗口，费用来自真实请求记录，不用费用或 Token 推算百分比。
- 对照本地干净 sub2api `main@0276190e` 的响应头采样、官方 usage 与本地窗口成本分离方式；没有同步或修改 sub2api，也不把该源码快照声称为线上状态。无新公开接口、依赖、数据库迁移或运行配置；部署后端与前端后生效，本轮未执行生产部署或真实供应商推理。

- 窗口与限流展示：5H/7D/Fable 重置倒计时按内容分配宽度，完整显示不省略（已于 2026-11-03 撤回，恢复上游定宽截断）；状态列与用量列设置必要最小宽度，宽屏弹性分配、窄屏横向滚动。限流徽标旁显示剩余时间，提示包含完整原因及年月日时分秒的预计恢复时间；区分对应窗口 reset、实际 cooldown 与未知时间，不借用无关窗口猜测恢复。新增说明提供简中、繁中、英文和日文。
- 验证：额度/探测/窗口/成本定向回归及新 HTTP 自动刷新集成通过；前端窗口状态、表格、四语与 TypeScript 检查通过。浏览器在宽屏与窄屏核验完整 `4d10h22m`，状态提示包含完整恢复日期；服务分组搜索可输入过滤并用 Enter 选择，原生输入 autocomplete 为 off。扩大检查中的两条旧 messages 协议断言与现有 Haiku thinking/system 模板结构不符，已按未改动的调用链核验，未为本次修复改写协议行为。
- 最终组合树验证：160 项后端定向回归通过（含供应商写账组合路径）；自动刷新、商业 VM/API 和供应商 HTTP 集成通过；相关前端 68 项和 TypeScript 检查通过。保留并审查期间已交付的供应商写账事务、上游协议与品牌改动，仅补入本次增量。


## 2026-10-30 供应商账号池操作与结算补齐

- **新增功能：** 完整账号详情侧栏（基本信息、吞吐、成功率、冷却、模型限制和配额重置）、账号用量详情（时间范围、7项指标、5H/7D/30D固定窗口、趋势和模型分布）、完整账号编辑与删除归档；补齐 sub2api 账号池结构和筛选。
- **优化改进：** 代理粘贴与选择合为一个可编辑下拉框；平台、模型分组、授权方式、Claude/Codex VM 严格联动。供应商开户只保留一次置顶登录账号/密码，移除无用身份/联系字段，保留结算设置。
- **Bug 修复：** 修复有消耗却请求数为0、生命周期按钮缺失、无法新增结算、二级上游账单遗漏、日期窗口/未知指标误显示、跨平台授权覆盖平台及重复表单；保留独立任务的运行时隔离和付款授权。
- **结算：** 统一上下游账单；新增多下游自然日/时区预览、合同价格与汇率来源、调整原因、15分钟令牌和逐请求分配，支持迟到事实补单；确认/付款登记/作废需显式付款能力。金额使用十位十进制计算、六位 USDT 舍入，快照保存完整计算依据。
- **破坏性变更：** 供应商生成账单改为先预览再提交 preview_token + idempotency_key；退役门户 audit-logs、usage/summary 和分离的 settlements/payables GET。运营平台接口不随之替换，旧账单和付款仍可读。
- **升级指南：** 控制面启动应用新迁移070，保留现有067/068。070保留账单、付款和外键，新增预览/分配结构；先备份数据库并在目标运行环境验证。前后端应一并更新。此代码交付没有部署生产。
- **清理与限制：** 删除简化详情/用量/编辑弹窗、旧结算表单、重复身份字段和供应商操作记录读取；后台审计写入、历史身份列/事实/账单快照继续按现行契约保留。无付款冲正/争议/结算导出或跨合同自动拆单。
- **验证：** 本机定向接口/仓储测试、四语完整性、前端类型与构建、浏览器模拟验收；真实 OAuth 交换和 Linux guest 自动启动成功仍待目标服务器验收。完整需求映射和边界见 `CUSTOMIZATION_IMPLEMENTATION_RECORD.md` 2026-10-30章节。

- **自动命名统一：** 供应商账号与运营后台共用 newVmNaming；留空自动生成 vm-NN，跳过现有编号及历史账号占用。账号/配对 VM/运行 VM 同名，编辑不再追加 VM 后缀；既有已保存名称不改写。

- **同一 VM 与编辑权限：** 供应商“添加账号”与超管创建 VM 共用构造配置与默认调度参数；供应商界面只是带归属与权限限制的入口。供应商创建拒绝隐藏的 VM 参数，后续仅能改授权、分组、账号名称、备注及自有代理，其他运行参数只允许超管修改。

新建供应商 VM 的内部 ID 也统一使用标准 vm-NN 分配；保留旧 vendor-vm-* 记录及其关联，不迁移或改写现有资源。供应商对配对 VM 资源的直接 PATCH/DELETE 被拒绝，统一由账号操作驱动关联状态。

- **双端账号池统一：** 超管与供应商复用完整 AccountWorkbench 及详情/用量/编辑组件，概览、筛选、配额、费用和样式保持一致；按角色控制数据范围和写权限，超管额外保留供应商列与 VM 配置入口。删除过渡简化表格。选定供应商按实际归属筛选，两端同账号的分组/VM ID/统计一致；列差异由角色显式控制，供应商端不显示冗余供应商列。保留同期 main 97b87897 的管理域、充值、Codex窗口和旧服务提供商移除修订。

- **同期交付保护：** 保留 main 53d50ec5 的已完成用量计费及069迁移；供应商结算预览/分配新迁移使用070。上游仍为8cb05ff，应用仍为1.4.028，本次仅代码修改及本机验收。


## 2026-10-30 CI收口与超级管理员种子配置修复

- **Bug修复：** 恢复已选定上游8cb05ff的种子设置读写实现，清除旧控制面镜像读取及原样日志回显。读取真实节点文件并拒绝不安全链接，日志脱敏；保存后分别报告发布/生效结果，并避免异步地理查询覆盖新凭据或运行配置。仅超级管理员可操作，供应商权限保持收紧。
- **验证修订：** 修正品牌标签、迁移编号、异步revision、当前zero/system与eager_input_streaming契约的旧测试；陈旧socket使用真实socket建模，停机遥测测试隔离真实Docker。133项相关测试通过；没有修改缓存/消息/权限生产策略来迁就旧断言，没有禁用CI。
- **升级及限制：** 无新Schema或配置项；既有种子配置保存但尚未发布成功时返回502及saved/published/applied状态，客户端应据此识别未生效。对应实现来自当前基线，没有额外同步上游；前端与供应商已验收功能保持。


## 2026-10-30 供应商全局结算设置（当前定制）

- 所有供应商共用一套 OpenAI 单价、Claude 单价、结算汇率和生效日期，由超级管理员“供应商平台 → 结算设置”追加版本。
- 新建/编辑供应商、用户和账单预览移除旧的供应商独立价格、倍率、币安 ID 与弹窗汇率覆盖；旧合同仅为首个全局版本前的历史只读兼容。
- 价格按请求发生时间和北京时间生效日计算，跨版本账期按平台拆分；已生成账单保存价格与付款边快照。
- 实现：`src/lib/vendor/vendor-pricing.mjs`、`src/lib/vendor/vendor-settlements.mjs`、`src/lib/vendor/vendor-admin.mjs`、`src/lib/admin/panel-routes.mjs`、`web/src/features/supplier-admin/pricing.tsx`、`src/lib/db/migrations/072_global_supplier_pricing.sql`。
- 验证：供应商/结算单元回归、HTTP 回归、前端 22 项测试、TypeScript、Vite 和四语 JSON 通过；真实 OAuth、Linux KVM 和生产部署另行验收。

## 2026-10-30 账号列表身份、筛选与授权修复

- **优化改进：** 参考 ccmax 实际 DOM/Network 的两行名称布局：账号邮箱（无邮箱用保存名称）+ ID，下行套餐/订阅渠道/实际授权标签（仅实际取得的值）；完整名称、套餐档位和脱敏代理收进悬浮详情。超管和供应商共用组件，保留 vm-NN 自动命名。
- **Bug 修复：** 合并重复授权筛选，按实际凭据模式过滤；前后端共用筛选定义，新增冷却/调度/归档及消耗升降序，选择立即生效。重新授权仅对异常或等待授权账号显示，正常供应商账号更多菜单仅删除。
- **访问体验：** 无供应商权限显示明确403说明，区分加载、登录失效和网络异常；切换账号清理旧会话及缓存，15秒超时和失败停止轮询。
- **Claude 授权：** 修复链接换票与Cookie授权漏传目标VM执行上下文；复用绑定VM、项目目录和routing，保持账号归属校验。套餐/支付元数据随真实身份保存，换账号清除旧值。
- **破坏性变更/清理：** 移除旧“授权模式”筛选和待应用双份筛选状态；账号列表GET默认排除归档，完整列表使用`archived=all`。不删除历史账号或配额数据，不虚构支付类型及Max倍数。
- **升级指南：** 前后端需要一起更新；Docker前端阶段包含共享筛选模块。本次没有新迁移或payload变更，不必重建已有VM；同版本代码推送不自动发布、未部署生产。
- **验证与限制：** 后端61项、HTTP2项、前端46项、TypeScript/Vite及Chrome定向UI验收通过；Linux OAuth helper 二进制本机缺失，真实授权换票仍待目标服务器验收。详细字段来源、测试和清理见`CUSTOMIZATION_IMPLEMENTATION_RECORD.md`对应章节。


## 2026-10-30 Claude 授权运行环境误判修复

- **问题与根因：** 已传入目标 VM 后仍报 `Target VM native CLI is not ready`。`startSlotReady` 返回 `rust` 推理准备结果，内层 `rust` 才是内核 supervisor 的健康结果；原 OAuth 准备函数读取 `boot.rust.health`，会将正常返回的 `boot.rust.rust.health` 误判为未就绪。
- **实现与清理：** `prepareSlotOAuth` 按实际返回契约检查两层成功状态和内层遥测就绪，不增加旧结构兼容、不绕过启动检查。修正两个历史测试的扁平 mock；新增回归调用真实 `startSlotReady → ensureSlotInferenceRuntime` 封装，仅替换容器启动和内核探测。Claude 启动沿用 Codex 已有的 `ops.startSlot` 测试注入点，默认生产实现保持不变。四语授权弹窗改为账号已创建、授权时准备运行环境，不再无条件宣称 VM 已就绪。
- **验证：** 授权/启动相关 Node 测试49项通过，包含 Docker/KVM 成功进入助手、容器失败、内核超时、遥测缺失/未就绪及调度不开启；前端国际化10项通过，格式及 diff 检查通过。Docker/KVM 用例是隔离的调用链回归，不代表真实 guest 启动和外部 Claude 换票验收；Linux OAuth 二进制专项本机缺失，留给标准运行环境验证。
- **升级与边界：** 前后端一起部署后生效，无新增接口、配置、依赖、迁移或破坏性变更，无需删除已创建账号或重建 VM。本次没有部署生产、使用用户截图授权码或变更代理；部署后重新生成授权链接进行真实换票验收。

## 2026-10-30 Claude OAuth 透明出口代理修复

- **Bug 修复：** 供应商 Claude OAuth 换票把绑定代理池的 `http://` 地址重复传入已启用 `kin-eg-*` 透明出口的槽位，导致换票器按 SOCKS 解析时报 `A "socks" protocol must be specified! Got: http`，或在重复代理链路中出现 token endpoint socket closed。
- **实现：** OAuth guest helper 根据目标 VM 的 `slotNetworkForVm` 判断透明出口；槽位运行在 `kin-eg-*` 网络时向换票助手传空 `proxy_url`，由容器网络直接使用绑定出口；仅无透明网络的执行路径保留代理 URL。没有把 HTTP 地址伪装成 SOCKS，也没有放开直连回退。
- **验证：** 新增 Docker/KVM 透明出口回归；相关 OAuth、启动、会话、凭据和 HTTP 上下文共64项通过。Linux `kin-oauth-auth` 二进制专项在当前 macOS 检出缺失，未冒充通过；服务器实测错误与 vm-27 的 `kin-eg-px-b7d80d0e` / 空内核 proxy 配置相符。
- **升级与边界：** 只需更新控制面代码并重启/重建控制面容器，已有 VM 不需要删除或重建；真实换票需部署后重新生成授权链接。未执行生产部署、代理修改或凭据处理。

## 2026-10-30 供应商账号代理切换、VM删除与归档保留

- **供应商编辑账号：** 账号编辑继续允许名称、备注、分组和代理；切换到新代理时解除旧代理与 VM 的绑定，停止不再使用的旧 `kin-eg-*` 出口，并让新代理重新绑定、重建出口和刷新运行槽位。超管可继续使用完整 VM 配置入口。
- **供应商删除账号：** 删除被定义为归档操作；先停止调度和运行槽位，归档账号及配对 VM 资源，解绑代理并停止不再共享的出口，然后删除对应运行 VM 容器、`vms/<vm-id>.json` 和槽位目录。用量日志、账单、审计和账号资源历史保留。
- **归档查询：** 账号列表继续支持 `archived=only`，供应商和运营后台均可在“归档”筛选中看到账号；默认列表隐藏归档，归档账号不能编辑、重新授权或恢复开户。
- **网络耗尽修复：** 创建代理出口遇到 Docker 默认地址池耗尽时，只回收没有容器且没有受控 `kin-egress` 进程的空闲 `kin-eg-*` 网络后重试；不删除有容器或仍有助手进程的网络。删除账号/解绑最后一个 VM 时同步停止出口并释放网络。
- **验证与限制：** 供应商 HTTP/E2E 账号、代理切换、配对 VM 删除、归档筛选和历史用量回归通过；网络回收纯单元回归通过。当前 macOS 缺少 Linux `kin-egress`/OAuth payload，相关真实 helper 测试保留为环境限制，服务器需更新控制面后复验。

## 2026-10-30 供应商账号池复制、列布局、详情侧栏与状态筛选

- **账号操作：** 账号名称改为独立复制按钮，复用安全上下文与非 HTTPS 兼容的剪贴板兜底；复制成功显示“已复制”，点击名称不再误打开详情，详情统一由操作列“信息”入口打开。
- **角色布局：** 供应商自有账号池隐藏供应商列并降低表格最小宽度，账号名称、状态和统计列重新分配空间；超管保留供应商列用于跨供应商筛选和对照，其他账号数据与权限边界保持不变。
- **状态口径：** “停用账号”只匹配正常账号暂停调度的 `paused` 资源；“异常账号”匹配 OAuth 授权撤销（包括 `OAuth access token has been revoked.`）和已删除/归档账号，归档仍可用独立条件查看。
- **详情侧栏：** 账号详情标题优先显示真实账号邮箱；侧栏保持 CCMax 风格的基本信息、代理地区、账号来源、授权方式、权重、请求/Token、运行指标、当前状态、冷却、平台配额、模型限制、数据快照和清除冷却操作。
- **验证：** 供应商/超管账号池列差异、名称复制入口、状态分类单测、四语翻译覆盖、TypeScript、账号池定向测试和 Vite 生产构建通过；未执行真实供应商推理或生产部署。
## 2026-10-31 供应商开户授权草稿与 VM 延后创建

- **开户流程：** 供应商填写平台、账号名称、代理、分组和授权方式后，先创建短期授权草稿；草稿只保存会话范围内的表单数据，不写入 `vendor_resources`，不生成账号池行，也不创建 `vms/<id>.json`。
- **授权完成：** OAuth、Claude Setup Token/Console Key、Codex 账号文件等凭证验证成功后，系统才创建账号资源和配对 VM，写入已验证凭证，绑定代理和分组，并启动 VM。启动成功且凭证可调度时，账号状态转为正常并开启调度；启动失败则保留账号为“准备中”，保持不可调度，等待后台处理。
- **安全与生命周期：** 草稿按供应商用户隔离并在 30 分钟后失效；授权会话支持草稿 ID 绑定，不能跨草稿或跨 VM 换票。供应商原有编辑、归档、历史用量和账单规则继续生效，归档账号不能通过开户幂等键重新恢复。
- **清理：** 删除旧的“先创建隐藏账号/VM、授权后再显示”的过渡实现；账号列表不再依赖待授权资源过滤来隐藏未完成开户。
- **验证：** 新增草稿所有权/状态单元测试和 HTTP E2E：授权前账号列表为空且 VM 文件不变，授权后才出现账号和 VM；供应商、管理员、归档、代理和权限回归共 18 项通过，前端 TypeScript 检查通过。真实外部 OAuth 换票和 Linux guest helper 仍需目标服务器验收。

## 2026-10-31 供应商退出回跳与授权分组过滤

- **退出登录：** 供应商门户退出登录继续清理服务端 session、认证状态和 React Query 缓存，完成后直接返回 `/welcome`，在 `/console/` 部署下对应浏览器地址 `/console/#/welcome`，不再跳转到 `/login?redirect=/vendor`。
- **开户分组：** 添加账号弹窗同时按当前平台和供应商已授权的分组 ID/名称过滤分组列表；供应商只授权一个分组时只显示该分组。后端既有 `accountGroupIds` 授权校验保持，前端隐藏不等于放宽接口权限。
- **验证：** 供应商访问状态与账号池相关前端 33 项、TypeScript、格式、ESLint 和 Vite 构建通过；ESLint 仅保留既有 Fast Refresh 导出警告，未执行生产部署或真实授权。

## 2026-10-31 用户分组授权选择样式简化

- **界面：** 新建/编辑用户的“分组授权”改为可搜索多选弹层，选中分组高亮并显示勾选状态，分组按名称和公开/专属、启用/停用状态展示。
- **清理：** 移除“专属倍率”“专属 RPM”输入和分组默认倍率 `1x` 展示；用户授权保存统一跟随分组默认权限与限制，历史用户级覆盖在保存用户时清除。
- **验证：** 用户管理相关前端测试 5 项、国际化覆盖、TypeScript、Prettier 和 Vite 构建通过；未执行生产部署或数据迁移。

## 2026-10-31 日期范围组件统一与充值记录收敛

- **日期选择：** 日志、供应商用量、供应商结算、供应商账单、账号池和单日期配置统一使用系统风格的日期组件，范围选择采用上游横向快捷按钮、日期范围按钮和双月日历，选完起止日期即生效；日志采用上游独立开始/结束时间输入。必填账期不显示清空，账号池与可选范围支持清空；单日期配置保持原行为。
- **充值记录：** API 使用扣费继续真实扣减用户余额并保留在用量/账务核算事实中，但不再写入充值记录；历史 `kind='usage'` 钱包流水由 `073_remove_usage_wallet_ledger.sql` 一次清理，充值、转账、冲正和开账流水保留。
- **清理与限制：** 充值记录不再允许冲正消费流水；没有删除 `billing_charges`、`usage_logs` 或其他用量明细，消费详情仍从使用记录查看。
- **验证：** 补充日期范围组件、消费流水不落账和历史清理回归；未执行生产部署，生产数据库清理需随对应版本启动迁移并先完成备份。

## 2026-10-31 充值记录范围名称简化

- 将管理员及其他用户充值记录下拉选项“本域资金流水”统一改为“资金流水”，避免用户误解“本域”含义；同步更新英文、繁体中文和日文文案。

## 2026-10-31 供应商账号分组范围收紧

- **创建与编辑：** 供应商创建、编辑账号时，分组列表只显示运营后台已授权且与当前平台匹配的分组；没有任何授权分组时不再把全部分组当作可选项。
- **后端校验：** 账号创建和编辑继续通过供应商有效授权范围校验，未授权分组无法通过接口写入；现有已撤权分组只作为不可用历史选择保留显示。
- **验证：** 供应商平台后端 25 项、前端分组目录 2 项、TypeScript 和差异检查通过；未执行生产部署。

## 2026-10-31 供应商代理编辑地址留空语义

- **编辑行为：** 运营后台供应商管理中的代理编辑地址默认为空（供应商门户于 2026-11-01 同步统一）；留空表示不修改现有代理，填写地址时支持 `socks5://user:password@host:1080` 等带协议格式。
- **创建行为：** 新增代理仍要求填写地址；列表继续显示脱敏后的协议和地址格式。
- **验证：** 代理更新保留原地址、空值请求构造和格式化地址回归通过；未执行生产部署。

## 2026-10-31 修复代理异常遗留调度关闭

- **问题：** 代理冷却既可能保存为旧的 `schedule_off`，也可能保存为新模型的 `schedule_hold.reason = "proxy_cooldown"`；诊断界面统一显示为“调度关闭”，导致出口和内核均正常时恢复服务仍不能重新入池。
- **修复：** 代理探测恢复、清除冷却和“恢复服务”同时清理旧字段、派生旧字段以及代理专属 schedule hold；真正的人工关闭（如 `operator`、`stopped`）继续保留，并在迁移前先清理代理状态，避免被转换成泛化故障。
- **验证：** 调度状态、清除冷却和恢复服务写盘回归共 37 项通过；未执行生产部署。

## 2026-10-31 消除 VM 详情页重复状态标签

- **界面：** VM 详情顶部和“现状”面板对账号状态、调度状态、代理健康状态去重；相同展示文案只保留一个标签，现状面板的综合状态优先作为标题标签。
- **范围：** 保留不同层级的真实状态信息；仅合并重复文案，不改变 `accountStatus`、`poolStatus` 或 `proxyHealth` 的判定和筛选语义。
- **验证：** 补充状态标签去重单元测试，前端类型检查、格式和相关测试覆盖；未执行生产部署。


## 2026-11-01 Gateway Worker 规划契约

- **产品决策：** 账号增加 execution_kind=vm|gateway_worker。通常一台服务器部署一个 Gateway Worker 进程，一个进程可服务多个供应商账号；账号不绑定 Worker Server、Fleet 或旧称 Worker Pool。
- **供应商与 Key：** 账号创建时由供应商/超管按平台策略选择 VM 或 Gateway Worker；策略区分 allow_create 与 allow_runtime。API Key 只绑定分组，同一个 Key 可按模型和平台分别进入 VM/Worker；终端用户不选择 Server。
- **控制面/执行面：** vm2api 保留账号选择、分组、权限、容量租约、使用记录、客户扣费和供应商结算。NewAPI 只作为独立 Gateway Worker composition root，负责指定账号的协议转发、取消、能力/心跳、Drain 和 Receipt。
- **UI：** 账号池、供应商门户、使用记录、统计、结算和权限沿 vm2api 现有布局；Gateway Worker 运维入口放在资源管理组，Fleet/Server 不进入供应商门户。完整 UI、协议、数据模型和验收见 docs/supplier-platform/15-gateway-worker-final-plan-20261101.md。
- **状态：** 本条仅更新规划和交付基线，Gateway Worker 当前未实现、未迁移、未发布、未部署；现有 VM 账号和历史账务保持不变。

## 2026-11-01 重构方案复核与 facade 收口

- **重构收口：** 按 `CUSTOMIZATION_REFACTOR_OPTIMIZATION_PLAN.md` 逐项复核 3.1–3.10 与 P0–P7，补齐商业分组/Key 纯策略、账务和 admission facts、供应商账号 projection、seed/backup/notification 运维 query/command facade，以及前端 query-options 共享入口。
- **最小改动：** 每个新模块只承担纯投影、纯策略或既有 service/route adapter；panel、vendor、scheduler、usage projection 和两组前端 query 保持原 API、状态码、DTO、缓存 key、权限、结算和运行时构造签名。
- **清理边界：** 数据库 schema、历史迁移、账单/价格快照、credential JSON、Docker/KVM/egress 和生产数据均未重写；未实现的 Gateway Worker、真实 Linux/KVM/OAuth/收费推理仍按规划保持排除。
- **验证：** 最后一组定向 Node 复核 121 项通过，新增 facade 专项 7 项通过，Web TypeScript 和 query invalidation 4 项通过；已有 Web 109 文件/831 项及发布/运行事实证据继续有效。Deploy 的 `/var` 符号链接失败属于 macOS 文件系统差异，未修改业务逻辑迁就。
