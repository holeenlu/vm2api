# 控制台加载分析与修复（2026-10-30）

本轮为普通修复，基于交付 main `550c83e3e52830b5e0ab40f9499b0b45da3edaa2`，保持唯一上游父提交 `8cb05ff261dd6d8a7e90479463b33bc6e1585730`（1.4.028）。交付时先保留远端 `167886bd7f5128c8ec230f010147e200655ec9e6` 的独立供应商/授权展示修改，再合入本轮八个文件；前端输入发生变化后补做最终构建及压缩一致性验证。不附带同步上游、发版或生产部署。

## 观测与归因

只读检查 tapmodels 运行镜像 v1.4.028.3 的本机接口及公网静态资源；未调用推理、变更运行配置或执行升级。单次观测值用于定位，不是压测百分位或长期 SLA：

| 服务器本机请求 | 状态 | 耗时 ms | 响应字节 |
| --- | --- | ---: | ---: |
| /healthz | 200 | 112 | 15 |
| /api/panel/me | 200 | 167 | 714 |
| /api/panel/api-keys | 200 | 30 | 57,419 |
| /api/panel/groups | 200 | 94 | 5,527 |
| /api/panel/usage-logs?limit=50 | 200 | 24 | 116,088 |
| /api/panel/dashboard | 200 | 1,639 | 329,413 |
| /api/panel/routing | 200 | 202 | 296,034 |
| /api/panel/version | 200 | 624 | 205,976 |

公网入口脚本 index-BIVcWD7v.js：HTTP 200，TTFB 1.0322 秒、完整下载 3.6885 秒、1,219,219 字节。请求 Accept-Encoding: gzip，返回无 Content-Encoding。另一个公共 utils 脚本为 1,280,457 字节；生产前端会在初次加载和首次进入新路由时下载公共/页面代码。

源码的 tryServeWebDist 直接读取并返回原文件；线上 nginx 虽开启 gzip，但 gzip_types 行仍为注释，未为 JS/CSS 配置压缩。因此公共脚本和路由包存在可确认的额外传输开销。入口下载耗时还包含网络时延，不能把全部耗时归为服务端执行。

版本查询为异步后台请求，失败最多等待 GitHub 八秒，但没有作为路由或页面数据加载的前置依赖。原先“所有页面必然被版本检查阻塞”的推断不成立；仍按用户明确要求改为手工检查。总览还等待 collectLivePanelCredentials；该接口观测的 1.6 秒是独立限制，本轮未改变凭据及健康状态的新鲜度语义。

## 实现与清理

- 构建时为大于等于 1 KiB 且压缩后更小的 JS/CSS/HTML/SVG/JSON 产物生成 .gz；无运行时压缩、无新增依赖。现有 Docker COPY web/dist 会包含这些产物。
- 静态响应按 gzip、通配符及 q=0 禁用规则选择文件，返回 Vary: Accept-Encoding，MIME 沿用原文件。原件回退服务不支持 gzip 的客户端以及未包含压缩文件的旧构建；不是额外业务兼容路径。
- 移除空闲控制台每五分钟、窗口聚焦、重连和挂载时的版本查询；手工强制检查沿用原接口和缓存键。检查失败允许立即手动重试，不自动重试。升级期间保留两秒状态轮询，无新增版本推送机制。
- 没有新增业务接口、运行配置、数据库迁移或数据清理；需要一起部署服务端和完整前端构建产物。原文件与 gzip 文件必须来自同一次构建。

## 当前验证

环境：macOS，Node 24.22.1，项目已安装的 web 工具。pnpm 封装尝试安装依赖时被既有 ignored-builds 检查拦住；实际使用已安装的 .bin 执行以下检查，没有放开安装脚本策略。

- `node --test test/unit/web-dist.test.mjs`：6/6，包含压缩内容、编码协商/显式禁用、无压缩回退、MIME/cache/Vary、HEAD 和路径拒绝。
- web `vitest run src/features/settings/queries.test.ts src/features/settings/about-pane.test.ts`：10/10，覆盖实际 QueryObserver 挂载/重挂载/失效不请求、手工检查、升级状态开关、旧请求取消、失败重试和显示。
- web `tsc -b && vite build --outDir ../.local/panel-loading-20261030/dist`：通过；保留既有大包提示。相关 Prettier、ESLint、Node 文件 Biome 与 diff 检查通过。
- 90 个 .gz 均解压后逐字等于构建原件：4,726,418 → 1,363,199 字节，减少 71.16%。本地真实 HTTP 返回入口脚本 345,953 字节 gzip，对比 identity 的 1,233,057 字节。
- 本地生产构建 + 隔离模拟接口浏览器验收：总览/设置均正常；打开菜单及切换页面后检查数/轮询数均 0；手工点击后检查数 1；模拟升级经两次状态读取成功刷新为目标版本，随后停止版本查询。未执行真实宿主机升级。

体积减少不等于页面耗时同比减少。线上应用尚未更新，部署后的实际加载耗时、复杂页面渲染及高负载数据库查询不在本轮本地结果的保证范围内。

## 第二轮观测：事件循环饱和（2026-10-30 下午）

压缩上线后面板仍然很慢。只读排查线上实例，主因不是传输体积，而是面板与推理网关共用同一个 Node 单线程进程，该进程的事件循环被推理流量占满：

- `top -H` 下主线程常驻 `R`、99.9% CPU，容器 108–122%。
- 服务器本机对最轻的 `/healthz` 采样 100 次：p50 3 ms、p90 3.3 s、p99 8.1 s、max 20 s，24% 超过 200 ms。另一轮 60 次采样出现 14.1 s 和 10.0 s 的停顿；停顿期间主线程状态为 `R` 且没有新建子进程，说明是纯 JS/CPU 排队，不是外部 IO 或同步 docker 调用。
- 公网取面板分片：270 字节的 `ClientOnly` chunk TTFB 2.65 s、1.4 KB 的 `invariant` 6.44 s、13 KB 的 `button` 7.14 s。入口页有 22 个 `modulepreload`，切路由还会再拉，所以每个页面都慢而不只是首屏。
- 当时 nginx 的 `location /` 把静态资源也转发给这个进程，`proxy_buffering off`、`proxy_cache off`。

perf 采样（self）：`JsonStringifier::SerializeString` 6.2%、`sha256_block_data_order_avx` 5.7%、`sqlite3VdbeExec` 系列约 4.9%、V8 GC 约 4%、JSON 解析与 UTF8 编解码约 4%，其余为无符号 JS 帧。对应负载：近 8 小时 4,000–5,500 请求/小时、平均时长约 30 秒的流式请求，平均输入 1.2–2.1 万 token、平均 cache_read 约 20 万 token，单请求最大输入 91 万 token，约 40 条并发流共用一个线程。`prepareCachePrefix` 在容器内实测 1200 条消息 / 2.37 MB 请求体为 127 ms，0.54 MB 为 63 ms。

数据库侧：`kin.db` 3.9 GB，`dbstat` 显示 `billing_charges` 2,206 MB（51,909 行）、`request_attempts` 1,180 MB（40,370 行）、`billing_reservations` 415 MB，`usage_logs` 仅 91 MB。膨胀来自 `usage_json` 里的 `attribution.items`——按会话中每条 assistant 消息堆积、无上限，单行平均 43 KB、最大 502 KB。仓库检索未发现任何读取 `attribution` 的代码。

## 已落地：nginx 承担静态资源

`proxy_cache` 缓存 `web/dist` 产物，配置见 [部署](../DEPLOY.md) 的反代一节。产物按内容哈希命名、响应自带 `immutable`，每个文件只在首次穿透到 Node。`/cc` 入口 HTML（`no-store`）、面板 API 和推理路径仍走 `location /`，不进缓存。

服务器本机核验：缓存命中后同一分片 5 次 TTFB 36–42 ms；`Accept-Encoding: gzip` 返回 345,952 字节且带 `content-encoding: gzip`，不带该头的客户端返回 1,233,104 字节且无该头，两种编码分别成为独立缓存条目；`/cc` 仍为 `cache-control: no-store` 且不带 `X-Cache-Status`；`/api/panel/overview` 不经过缓存路径。

本项只保证静态资源不再排在推理后面，不改变事件循环本身的饱和。复测 `/healthz` 得到 p50 0.99 ms、p90 1.18 ms，但同期请求量已从 09:00 的 5,246 次/小时降到 11:00 的 2,422 次、容器 CPU 降到 14%，因此这组数字反映的是负载回落，不能当作本项的效果。

## 已落地：写库前剥离 usage.attribution

上游在 usage 里回传 `attribution.items`——按会话中每条 assistant 消息累积、条目数随轮数增长且无上限。抽样线上最近 2000 行确认它就是膨胀本身：占 `billing_charges` usage_json 的 99.2%、`request_attempts` 的 99.6%、`billing_reservations` 的 96.9%，其余各键（`image_generation`、`output_tokens_details`、各类 token 计数）合计不到 1%。

`src/lib/core/usage-persist.mjs` 的 `usageForStorage()` 在两个持久化点剥掉该键：`relay-billing.mjs` 的 `settle()` 写 `billing_charges`，`request-attempts-repo.mjs` 的 `complete()` 写 `request_attempts`。只做浅拷贝且只在存在该键时拷贝，不在请求路径上重新遍历对象；传入的 usage 对象本身不变，`recordUsage` 与 `costColumnsFromUsage` 仍读到原值。

范围核实：全仓库（`src`、`web/src`、`test`、`worker`、`api-kernel`）没有任何读取 `attribution` 的代码；`recordUsage` 只取标量计数，不整体持久化 usage；`request_log_debug` 线上为空表，调试抓取未开启；`billing_reservations` 自迁移 069 起已无写入方，迁移注释明确保留为历史数据，本轮不动。

只影响新写入的行。历史数据未处理，`kin.db` 仍是 3.9 GB——回收空间需要单独授权的 `UPDATE` + `VACUUM`。

## 已落地：cache-prefix 按下标复用逐条摘要

`snapshotBody()` 每轮为每条消息重建一份 `messageRecord`，其中 `parts`（逐块的 stamp 树，自带克隆和多次 digest）是最贵的一半，而它只在真正发生分歧的那一个下标被读取。对话在首个变化点之前是追加式的，所以绝大多数消息逐轮逐字节相同。

`messageRecord(message, cached)` 现在接收上一轮快照里同下标的记录：先算 `hash`（整条去 cache_control 后的摘要，原本也要算），命中则整条复用，不再重建 `parts`／`id`／`keys`／`images`。复用的判据是充分的——`hash` 覆盖整条消息，其余字段都是同一个值的纯函数（`parts` 读 content、`id` 在其上剥图、`images` 计数、`keys` 列键，cache_control 都影响不到），所以哈希相等即记录相等。不命中时走原路径，只多一次字符串比较。

生产机（x64、Node 22.23.4）实测 `prepareCachePrefix` 单次耗时中位数：

| 消息数 | 请求体 | 改前 | 改后 | 倍数 |
| ---: | ---: | ---: | ---: | ---: |
| 200 | 0.11 MB | 16.1 ms | 2.6 ms | 6.2× |
| 600 | 0.29 MB | 37.0 ms | 7.2 ms | 5.1× |
| 1200 | 0.58 MB | 60.3 ms | 10.4 ms | 5.8× |
| 1200 | 2.42 MB | 116.6 ms | 22.2 ms | 5.2× |

真正的最坏情况是历史被整体位移（在开头插入一条，所有下标错位、无一可复用）：1200 条时改前 40.9 ms、改后 38.9 ms，没有回退。

等价性用差分验证：同一组构造好的变更序列（追加、改标记、改尾部／中部文本、改 tool_use 入参、删块、换 role、加键、改 system、增删改工具、开头插入、截断、加图、删图、字符串内容、移动标记、计数器文本变化）共 38 步，在 `preserveMessageCache` 开与关两种模式下逐步比对新旧实现的 `prepareCachePrefix` 与 `peekCachePrefix` 完整返回值（含 break 的 section／index／kind／diff、anchor、checkpoint、image_floor 和发出的 body），0 处不一致。

未处理：`retainImages()` 里按 `state.floor` 逐条调 `messageIdentity()` 的循环同样是每轮 O(n)，但只在客户端触发过图片丢弃、图片地板被激活后才非零，不是通用路径。

## 已否决：SQLite 连接级 pragma

曾考虑给 `createDatabase` 增加 `cache_size`/`mmap_size`/`temp_store` 以缓解 3.9 GB 库的读放大。在生产库上只读实测四种组合后否决：

| 查询 | 默认 | cache | cache+temp | cache+temp+mmap |
| --- | ---: | ---: | ---: | ---: |
| `billing_charges` 按 request_id 点查 ×300（每请求热路径） | 19 ms | 16 ms | 18 ms | 19 ms |
| `usage_logs` 按时间取 50 条（走索引） | 1 ms | 1 ms | 1 ms | 1 ms |
| 订阅用量求和（走索引） | 0 ms | 0 ms | 0 ms | 0 ms |
| `billing_charges` 按 `created_at` 取 50 条（无索引全表扫） | 954 ms | 1,246 ms | 1,169 ms | 1,068 ms |

走索引的热路径本来就是毫秒级，加大页缓存没有可测收益；唯一耗时的是无索引全表扫，而它在加大页缓存后反而更慢——一次性扫描的页没有复用价值，mmap 还额外增加缺页开销。改动已撤回，`src/lib/db/database.mjs` 未改。

当时推断那条全表扫的解法是给 `billing_charges.created_at` 建索引。后来逐条核对调用方，这个推断不成立，见下节。

## 已落地：settle() 不再 SELECT *

`settle()` 每次计费读两次 `billing_charges` 行（幂等检查一次、写入后回读一次），`SELECT *` 把 `usage_json` 一并取出：生产上该列平均 43,732 字节、最大 502,356 字节，而调用方只取 `status`、`actual_micros`、`group_id`、`subscription_id`、`rate_multiplier`，价格用的是 context 自己的 `quote_json`。两处改为显式列，排除 `usage_json` 与 `quote_json`。

生产只读实测 400 次按 `request_id` 的点查：`SELECT *` 19.4 ms（0.048 ms/次），显式列 10.2 ms（0.026 ms/次），约 1.9 倍。绝对值很小（按当前约 1.4 req/s 计，每请求省约 0.022 ms），真正的意义是不再为每次计费实例化一个几十 KB 的字符串，少一份 GC 压力。

## 已否决：补 created_at 索引

把三张表的实际查询全部列出来核对后，没有一条需要新索引：

| 表 | 代码里的真实查询 | 现状 |
| --- | --- | --- |
| `billing_charges` | `SUM(actual_micros) WHERE subscription_id=? AND created_at>?` | 走 `idx_billing_charges_subscription_created` |
| `billing_charges` | `SELECT … WHERE request_id=?`（`settle()` 两处） | 走主键 |
| `request_attempts` | `DELETE WHERE started_at < ?`（定期清理） | 走 `idx_request_attempt_account(account_id, started_at DESC)` 的 skip-scan，生产实测 0 ms |
| `request_attempts` | 按 `request_id` 查 / 列 | 走 `idx_request_attempt_request` |
| `wallet_ledger` | `ORDER BY created_at DESC,id DESC LIMIT ?`，可带 user/domain/游标 | 有 `(user_id, created_at)` 与 `(wallet_domain_id, created_at)`；无筛选时确实全表扫，但该表生产上只有 1 行，实测 0 ms |

`billing_charges` 按 `created_at` 倒序取 50 条在生产上已涨到 2,880 ms（表从 51,909 行长到 61,785 行），但**代码里没有任何地方执行这个形状的查询**——`/billing` 面板走的是 `wallet_ledger`，仪表盘聚合走 `usage_logs`（已有 `idx_reqlog_ts`）。为一个没有调用方的查询在 2.2 GB 表上建索引，属于「以后可能用到」，按本项目的清理规则不做。该表真正的问题是历史 `usage_json` 的体积，解法是清理数据而不是加索引。

顺带发现 `idx_request_attempt_request(request_id, attempt_no)` 与 `idx_request_attempt_unique(request_id, attempt_no)` 列完全相同，前者被后者完全覆盖，每次写入白维护一棵 B 树。本轮未动，属于可单独处理的清理项。

## 交付后 CI 收口

加载修复首次交付 `644aa0909946026c82d04acf469128001da0e48b`（上述构建、压缩和浏览器证据对应这一轮实现）。CI run 41025664126 的 web、contracts、arm64-native-cli 通过；unit 因既有供应商代码 14 个文件未格式化而停止，业务单测尚未执行。对 CI 指定文件仅运行 Biome formatter；Babel AST 忽略位置/注释后逐一等价，根格式检查 734 个文件通过。随后基于已包含加载修复的 `2da0911f217662a95b5fb1a2909cb8ebc0e4b801` 交付格式收口，保留其独立 Codex/VM 资源变更，不改动本轮性能实现。
