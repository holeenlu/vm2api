# 最终审计与处置：统一控制面重构（main `f8af8a37`）

审计对象：上游 v1.4.041（`d6ad7a6c`）加一个定制提交的 main `f8af8a37`。三个独立审计智能体在冻结检出上只读审计：设计符合度（编号 F）、正确性与安全（C）、升级与可运维（U）。同时在该提交上跑完整验证：Go 全量与 gofmt、Node 单测（只有 4 个已知基线失败）、biome、前端构建与 904 个前端测试、真实 Worker e2e（off/shadow/primary）、双 Worker、Redis e2e、开启 Redis 的全套 e2e 全部通过；面板 e2e 只有 2 个已知 `computer_service_missing` 失败。

结论：没有 P0；四个开关的默认值与文档一致；默认全关、shadow、primary 三种模式下重构的不变量没有被后续交付破坏。

## 第一批：已修复（交付见 PROGRESS 交付记录）

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| C1 | P1 | BPS 上游在终态前断开、转换器补出 `response.completed` 时，回执记为 completed，对账只对 incomplete/cancelled 做下限结算：无中途用量时 10 次重试后进死信、不计费，比对工具报差异；有中途 `in_progress` 用量时被记成 `complete`。另发现流式路径的响应体被 `peekStream` 包了一层，`resp.Body.(*bpsBody)` 断言从未成立，中断流的回执从未带上转换累计的用量 | Worker：`bpsBodyOf` 拆开包装；终态不是上游报告的（补完成或转换中断）时用量一律 `partial`；补完成的回执带 `error_code=bps_cutoff_completed`。控制面：下限结算扩展到 completed、ambiguous；补完成且无用量时记 `unmetered`（`bps_cutoff_no_usage`），不进死信。测试：Go `TestBPSCutoffCompletionReceiptIsPartialAndMarked`、`TestBPSInterruptedStreamReceiptCarriesPartialUsage`、`TestBPSCompletedStreamIsNotMarkedAsCutoff`；Node 对账用例扩展 |
| C1 复核 | P1 | 修复审查（V1–V5）：补完成时用转换累计覆盖了交付终态里的图片压缩窗口用量（V1）；实时路径把上游截断的 BPS 流记为 incomplete、不写对账任务，下限结算对它从未生效（V2）；演练不做代次跳变检查（V3）；实时账本的可信度标签（V4）；回滚文档漏了租约表（V5） | V1：取逐项较大值（`maxUsage`）；V2：`awaitsGatewayReceipt` 对 BPS incomplete 也等回执，复制中断无用量时记不计量；V3：`inspect` 做同样的跳变检查；V4：写入发布说明已知限制；V5：回滚第 4 步一并删除 `credential_refresh_leases` 的 BPS 行。测试：`TestMaxUsageKeepsTheLargerCountersAcrossNumberTypes`、`awaitsGatewayReceipt` 与对账用例扩展、迁移演练跳变用例 |
| C1 复核 2 | P0 | 修复复核（W1）：V2 的条件只看 incomplete + BPS，控制面协议转换失败（上游流完整、调用方收到错误）也会按回执全额计费；W2：逐项取大后 total 可能小于输入加输出 | W1：只在 `error_code=gateway_stream_incomplete`（上游截断）时等回执；W2：`withConsistentTotal` 补正总量。复核通过 |
| C2 | P2 | shadow 下旧版 Worker 带 attribution 的事件早于回执到达，复查时对裁剪后的载荷重算摘要，必然误报 `diff` | 收到时先自检原文摘要（不必等回执）；复查只比较事件声明的摘要与回执摘要。测试：`shadow recheck of an attribution-bearing event that arrived before its receipt matches` |
| C3 | P2 | Redis 里解不开（换密钥或篡改）的 BPS 状态条目返回版本 0，CAS 永远失败，读取又不断续期 | 解不开时返回空内容和 Redis 中的真实版本，下一次保存覆盖。测试：`TestSharedBPSStateUndecryptableEntryIsOverwritten` |
| F2 | P2 | `request_attempts` 插入语句 26 个占位符只传 25 个参数 | 补齐 |
| U2 | P1 | 凭据迁移脚本只读 `process.env`，默认托管部署读不到自动生成的内部令牌与凭据包密钥，全部 `export_failed` 且原因被吞；演练不解包，演练零错误不代表 `--apply` 能成功；健康检查脚本同样读不到令牌 | 新增 `loadRuntimeSecretsReadOnly`（只读，不生成密钥）供两个脚本使用；导出失败保留各实例状态码与错误码；演练按 capture 口径解开凭据包；报告给出主密钥文件路径。测试：`executor-ops-scripts.test.mjs` |
| U3 | P2 | 迁移脚本的只读演练会执行数据库迁移；主密钥轮换脚本不带参数就轮换 | 新增 `openScriptDatabase`：脚本不执行迁移，库结构落后时报 `schema_outdated`，演练与 `--status` 只读打开；轮换必须显式 `--rotate`。测试同上 |
| U5 | P2 | events 从 primary 切回 off 后，未补齐的尝试永远补不上，收件箱不再清理 | off 模式不拉取，但照常补齐与清理。测试：`switching from primary back to off still completes pending attempts and prunes the inbox` |
| U9 | P2 | `KIN_REDIS_URL` 格式错误时 Worker 启动失败，整个 Gateway 停止接单 | 退回本地状态照常接单，健康与心跳报告降级（`last_error` 不含地址与密码）。测试：`TestInvalidRedisURLDegradesInsteadOfFailingStartup` |
| F1 | P1（文档） | ACCEPTANCE 第 1 条记为“满足”，但单 Worker 数据目录丢失时无法从凭据库重建投影 | 改为“部分满足”，写明情形与退出条件 |
| F9 | DOC | ACCEPTANCE 第 5 条证据不足以支撑“满足” | 改为“部分满足”，修正引用说明 |
| U12 | DOC | 台账写“未部署到生产”，但 `v1.4.038.20` 起的发布版本已包含本重构代码 | 改为“代码随发布版本进入镜像，生产开关未开启” |
| U4 | P1（文档） | control 托管下回滚到旧 Worker 再升级，BPS 代次被旧 Worker 丢弃，凭据库里过期的 BPS 令牌可能被投影出去（代码推导） | 运维文档第 12 节新增“版本回滚”：control 下先切回 worker 再换版本；再次切 control 前删除凭据库 BPS 记录并重跑迁移；列出不可逆项（U14） |

## 第二批：已修复

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| F1 | P1 | 投影只能从在线来源实例导出，单 Worker 数据目录丢失或来源全部离线时 control 托管也无法用凭据库令牌恢复（A9） | `GatewayWorkerService.projectFromVault` 与 `credentialCustody.vaultImport`：没有可导出的来源、目标实例确实没有该账号时，用凭据库令牌加控制面账号资料导入（托管公钥封装或共享凭据包，代理在凭据包内，先停用后 PATCH 启用）；凭据库原生落后于绑定或刷新租约不重建、BPS 落后只重建原生，在线来源导出失败不重建（修复审查 G1–G6 已处置）。测试：单测 `a single Worker that lost its data is re-projected from the vault under control custody`；多 Worker e2e 增加“来源全部离线再清空”场景（去掉实现后失败） |

## 第二批（续）：已修复

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| U1 | P1 | 回滚到旧版本期间在旧版本改的 Codex 本地设置，再次升级时被静默忽略（数据库已有设置） | `migrateRoutingFile` 逐键保守合并：参照值为合并基线（上一次导入或合并后的数据库设置，`codex:routing-baseline`）、最近的时间戳备份、默认值；等于任一参照视为未改，与三者都不同且数据库仍等于合并基线时导入，数据库也改过视为冲突保留数据库；出错不清理文件、备份改名 `.failed`；面板恢复不合并。修复审查 J1–J8：初版以最近备份为唯一基线，旧版本补默认值会把设置重置（J1，P0）、新版本修改会被覆盖（J2，P0），均已用真实旧代码复现并修复；复审 K1（导入出错后同一次启动的上游写回删掉本地键，重启不重试）改为下次启动从 `.failed` 备份重试，K4 跨字段校验失败逐键重试，K5 设置读不出按出错处理，K2/K3 写入运维文档；复审 L1（恢复更早的备份会把新版本修改改回旧值，P0）改为所有时间戳备份都作“未改”参照，L2 面板恢复不重试启动失败、出错用 `.restore-failed`，L3 被取代的失败备份改名 `.superseded`；N2 备份先写 `.pending`、导入成功后改名，进程在提交前被杀不丢修改。测试：`settings changed while an older version ran are merged back on the next upgrade`、`rollback merges never reset settings to defaults, keep new-version edits and survive failures`、`restoring an earlier backup keeps new-version edits; restores never retry boot failures` |

## 第二批（续）：运行状态可见

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| U8 | P2 | 租约冲突、收件箱失败计数、当前开关值没有面板或接口；开关值拼错静默回到默认，启动日志也不打印生效值 | `src/lib/executor/control-plane-status.mjs`：开关生效值与非法值（启动时打印一次并告警）、事件收件箱近 24 小时统计、刷新租约状态与结果不明列表、进程内租约冲突计数；`GET /api/panel/gateway-workers` 新增 `control_plane`；「Gateway Worker」页新增“控制面状态”卡片（四种语言）。测试：`test/unit/control-plane-status.test.mjs`、`web/src/features/gateway-worker/control-plane-status.test.tsx`；浏览器点验拼错开关标红；修复审查 O1–O8（汇总缓存 60 秒、Redis 口径说明、过期租约单独计、未拉取口径、已处理含仅记录、冲突明细带持有者、原值脱敏、测试补齐）已处置。剩余：收件箱统计在缓存过期后仍需一次扫描（可另加覆盖索引） |

## 第二批（续）：真实 Worker e2e 进 CI

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| U10 | P2 | 降级演练依赖的真实 Worker e2e 不在 CI，缺 Go 时静默跳过 | 新增 `.github/workflows/worker-e2e.yml`（main push、PR、手动）：编译 Go Worker 跑 `gateway-worker-{real,multi,redis}`，再在共享 Redis 下重跑前两组；`KIN_E2E_REQUIRE_GO=1` 时三个用例缺 Go 直接失败，另检查 TAP `# skipped 0` 与 `# fail 0`；`actions-retention.yml` 完成触发名单同步加入。本地按工作流步骤演练两步均通过，去掉 Go 后两道检查都使步骤失败。修复审查 Q1（默认 shell 不带 pipefail、超时用例计为 cancelled，会误报通过）改为显式 bash 并检查 `# cancelled 0`；Q2（Worker 连不上 Redis 时退回本地状态，重跑照样通过）改为 miniredis 未就绪即失败、双 Worker 用例在 `KIN_E2E_REQUIRE_REDIS=1` 时断言两个实例共享运行态为 Redis 且可用（指向无服务端口时失败）；Q3 redis 用例跳过条件含 miniredis 构建 |

## 第二批（续）：真实 Worker e2e 封闭环境

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| U10a | P2 | 真实 Worker e2e 不是封闭环境：Worker 后台从 OpenAI 官方 appcast、npm 与安装包核验客户端版本（首次 CI 运行即遇到预发布版本），控制面查价时在测试模式下仍会后台刷新 models.dev | Worker 新增 `KIN_CODEX_GATEWAY_RELEASE_CHECK`（默认开启，`off` 关闭发布检查）；控制面 `KIN_CRS_MOCK=1` 时查价不刷新 models.dev（上游文件 `price-catalog.mjs` +2 −1，与上游 server.mjs 已有的“测试环境不访问外网”承诺一致，上游补上后移除）；三个真实 Worker e2e 关闭发布检查；`worker-e2e.yml` 预下载 Go 依赖并预编译，用 strace 记录 connect，`test/e2e/no-external-egress.sh` 发现连向环回以外地址的 connect 即失败（外层 15 分钟超时），先做一次故意外联的正对照并断言检出该地址；修复审查 R1–R6 已处置。本地按进程采样与控制面进程内记录：改动前数百次外联，改动后为 0。测试：`TestReleaseCheckSwitch` |

## 第二批（续）：心跳时间口径

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| I1 | P2 | 在线判定用 Worker 上报的心跳时间，受 Worker 时钟偏差影响（签名时间窗已把偏差限制在 30 秒内） | 心跳与注册路由写入控制面收到的时刻，Worker 自报的 `last_heartbeat_at` 不再使用；面板手动登记也不接受请求里带的时间。测试：`heartbeats are stamped with the control-plane clock, not the Worker clock`（Worker 自报 2020 年或 2999 年，存下的都是当前时间） |
| I2 | P2 | 面板健康探测返回非 2xx 时也刷新心跳时间，实例在 45 秒内仍按在线处理 | 探测失败保留原有心跳时间；成功时记控制面时间。复核 S6：健康探测与排空/恢复改为按白名单取 Worker 返回的字段，实例 id、准入状态与心跳时间由控制面决定；Worker 心跳不再上报 `last_heartbeat_at`。测试：`a failed health probe does not refresh the heartbeat; a successful one uses the control-plane clock` |

## 第二批（续）：回滚合并识别起点备份

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| N1 | P2 | 回滚设置合并以所有时间戳备份为“未改”参照：两值键（BPS 开关、点数超额）一旦在某份历史备份里出现过非默认值，之后的回滚修改都不再导入 | 只靠比较值无法区分“恢复较早备份、没改”与“恢复最近备份、改回旧值”。核对 `v1.4.038.14`：旧版本改写 `routing.json`（启动规范化、面板保存）保留顶层未知字段。备份改为写入顶层标记 `_tapmodels_backup`（自身时间戳），再次升级时文件带有效标记就只与那一份备份比较；没有标记或备份已删时维持保守规则；标记读出后立即从 routing.json 去掉、起点另存进备份供失败重试（复核 T1，P0：导入出错后标记残留会让下一次不复制备份的回滚用默认值覆盖设置）；标记只认存在的有效时间戳备份（T3）。测试：`the backup marker never lingers after a failed import and only points at valid backups`、`backup markers let rollback edits of two-valued settings be imported across cycles`（去掉读标记后失败）；审查者用旧版本真实代码写的复现脚本全部回放：N1 与“改回默认值”（R2）、“改回升级前原值”（R4）现在导入，L1、R5、R6、J1 等保守场景不变 |

## 第二批（续）：文档类余项

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| F3/F4 | DOC | 运维文档写“三个开关保持默认，行为与升级前一致”，没有列出与开关无关的变化（启动后收到首份策略前不定时刷新、删除 `oauth-sessions.json` 等） | 运维文档第 12 节新增“与开关无关、升级即生效的变化”清单：`routing.json` 改写与备份、设置读数据库并缓存 1 秒、删除 `oauth-sessions.json`、导出需要凭据包密钥、`events/` 总会写与 fsync 时机、托管密钥对待确认、首份策略前不定时刷新（全新数据目录且控制面不可达时请求内刷新失败）、`/v1/models` 只读缓存、心跳按控制面时刻、`bps_state/` 目录 |
| F5 | DOC | 设计 5.1–5.4 把没有实现的接口写成契约 v1，没有“当前实现”说明 | 设计 5.1（mTLS 可选且两侧都不强制证书与实例 ID 绑定、共用 HMAC 令牌、时间窗 30 秒、无契约头与协商）、5.2（能力描述 `custody` 为布尔值、心跳策略内容）、5.3（按账号导出、导入、PATCH 投影，对账依据心跳 `account_revisions`；无 `projection/batch`、`projection/state`、`config/publish`、`refresh_owner`）、5.3.1（只有本机密钥文件、Worker 落盘明文令牌加凭据包密钥加密、共享凭据包保留）、5.4（无 `caller`、`deadline_ms`）、6.3（无 `credentials/validate`）与附录 A 补“当前实现”；状态行说明正文是目标、以“当前实现”为准 |
| F6 | DOC | 文档与注释写 BPS 写回“按轮换前令牌指纹 CAS”，实际按代次；Worker 上报的 `previous_token_fingerprint` 控制面不读 | 设计 6.2 改为按代次 CAS（BPS 为令牌代次 + 1），指纹只用于申请时的过时判断；`refresh-lease.mjs`、`credential-custody.mjs` 头注释同步修正；Worker 删除不再使用的 `previous_token_fingerprint` 字段（`leaseRotation` 结构改为只传轮换前代次） |
| F7 | DOC | 设计第 2、4、9、13 节停留在实施前 | 第 2 节注明为开工前盘点，2.3 差距表加“当前实现”列；第 4 节表的备注改为当前实现；第 9 节节首写明不建 `model_requests`；第 13 节补投影缺失（503 `gateway_worker_no_account`、未发出换实例）、Redis 不可用（各实例本地计数，不是只投影到主实例）、数据库不可用；状态行补生产切换已执行 |
| F10（文档） | DOC | 设计第 14 节写“刷新租约冲突都写审计”，实际只有结果不明写审计 | 设计第 14 节列出实际写审计与不写审计的动作：其他租约冲突只计入进程内计数（「Gateway Worker」页可见）。是否改为写审计留在待处理 |
| F11 | DOC | `KIN_REDIS_URL` 列在“开关（控制面）”下；ACCEPTANCE 第 6 条 go.mod 行数口径不清 | 运维文档第 12 节表头改为“开关”，写明前三个由控制面读取、`KIN_REDIS_URL` 只由 Worker 读取；ACCEPTANCE 第 6 条注明 +5/+18 是 P5 增量，相对上游累计 `go.mod` +19/−3、`go.sum` +42 |
| F12 | DOC | 上游迁移在本地改了编号，与 15.1(2) 不符，下一次上游新增迁移会撞号 | 核实上游 039–048 在本地为 045–055 与 116，SQL 语句逐字一致，只改了文件名与部分开头注释。设计 15.1 第 2 条与第 15 节表、ACCEPTANCE 第 6 条写明现状与撞号预案：改为本地最大编号 + 1（现为 120）、SQL 不改、注释写上游原编号；自动同步遇重号或编号不大于最大号会阻断 |
| U6（文档） | DOC | `--retire` 后轮换前的备份无法解密；备份不含主密钥、`runtime-secrets.json` 与 Worker 数据目录，文档没写 | 运维文档第 10 节写明 `--retire` 只看当前数据库、旧密钥只留在 `.bak-<时间>`、恢复轮换前备份时把旧密钥合并回主密钥文件的步骤，以及面板备份的范围；ACCEPTANCE 第 1 条、DEPLOY 同步提示。退役时归档旧密钥与备份页提示仍在待处理 |
| U13 | DOC | `.env.example`、DEPLOY、docker-compose 缺新开关与流程 | `.env.example` 在已有 Gateway Worker 段补 6 个键与说明；DEPLOY “上线后”加一小节指向运维文档（备份范围、Redis、回滚恢复 `routing.json`）；docker-compose 加主密钥单独挂卷的注释示例。三个都是上游文件，只在已有定制段落内追加 |

## 待处理（需要用户决定方向或后续批次）

| 编号 | 级别 | 问题 |
| --- | --- | --- |
| N1b | P2 | 回滚合并：去掉 routing.json 里的标记之后、导入提交之前进程被杀时，下一次启动文件已无标记，回到保守规则（只会少导入、不会覆盖）；可在文件有本地键且无标记时，借用更新的 `.pending`/`.failed` 里存的起点（内容须与文件一致） |
| N4 | P2 | 面板恢复中途进程被杀留下 `.pending`、之后又有人手工删掉 `routing.json` 里的本地键时，下一次启动会按合并规则重试恢复时的备份（与“恢复不合并”相反）；需两个前提同时成立，概率很低 |
| F10（代码） | P2 | `lease_held`、`stale_revision`、`stale_token`、`outcome_unknown` 拒绝只计入进程内计数，不写审计；是否改为写审计（需要限频，避免多 Worker 争用时刷屏）待决定 |
| U6（代码）、U7、U11 | P2 | 退役主密钥时归档而不是删除、备份页提示备份范围；主密钥丢失诊断与重置工具；测试中的 sleep 同步 |
