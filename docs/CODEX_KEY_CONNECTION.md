# Codex 使用 API Key：来源、配置与验收

## 核对的代码

当前官方基准为 Codex `rust-v0.160.0`，完整来源见 `src/lib/protocol/codex-assets/PROVENANCE.txt`；下列 Sub2API 与早期 Codex 链接属于首次实现的参考记录。

首次实现于 2026-10-20 只读核对 holeenlu/sub2api GitHub `main` 的 `160e6c90dc06b04174231efa69e16fb03dab8ef5`。本地 sub2api 停在 `821b89e0b`，没有对该仓库执行修改或同步。

- [最新 UseKeyModal](https://github.com/holeenlu/sub2api/blob/160e6c90dc06b04174231efa69e16fb03dab8ef5/frontend/src/components/keys/UseKeyModal.vue)：API Key Mode、Codex/WS 两套完整文件、远程/本地目录、自动获取与下载、根据目录选择模型及推理档位。
- [目录请求](https://github.com/holeenlu/sub2api/blob/160e6c90dc06b04174231efa69e16fb03dab8ef5/frontend/src/api/codex.ts)：同一 API Key 的 Bearer 认证，访问 `/v1/models?client_version=…`；下载原生 `{ models: [...] }`，不拿通用 `{ data: [...] }` 当 Codex 目录。
- [服务端分流](https://github.com/holeenlu/sub2api/blob/160e6c90dc06b04174231efa69e16fb03dab8ef5/backend/internal/server/routes/gateway.go)：`client_version` 非空走 Codex 模型目录，普通请求走标准模型列表。目录受分组、模型映射与白名单限制。
- [Codex 0.156 实际目录请求实现](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/codex-api/src/endpoint/models.rs)：`catalog_request_url` 给完整 URL 追加客户端版本，并使用 Provider 的认证。远程配置中不需要把版本或密钥硬编码到 URL。
- [Codex 0.156 ModelInfo/ModelsResponse](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/protocol/src/openai_models.rs)：目录需要原生模型描述与指令模板，仅改字段名 `id → slug` 不够。
- [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：Provider 的 `model_catalog_url`、`experimental_bearer_token`、`requires_openai_auth`、`supports_websockets`，以及顶层本地目录路径。

## 本项目的数据来源

`keyModelCatalog()` 提供使用密钥弹窗、普通 `/v1/models` 和 Codex 目录共有的授权范围；`codexModelCatalog()` 在此基础上只保留后端识别的 OpenAI GPT 对话模型。共有授权不代表三者应展示相同模型。执行后端保持原有选择规则，分组原本就禁止混用 VM 与上游 API 资源。

| 分组执行后端 | 模型来源 | 限制 |
| --- | --- | --- |
| VM / OAuth | 模型页的 Claude `model_policy` 与 GPT `gpt_model_policy`；已有同步任务更新这些本地目录 | 当前 Key 所属分组、用户分组资格、分组白名单、关联 VM 的模型门禁 |
| 上游 API | 当前分组关联的启用 endpoint 的公开模型映射与别名 | 当前 Key 所属分组、用户分组资格、分组白名单、endpoint 关联范围 |

不把全站模型列表、所有用户资源或 OpenAI 全量公开模型直接暴露给当前 Key。目录请求不触发上游推理，也不在用户点击弹窗时刷新 OAuth。撤销分组授权、修改白名单后的下一次服务端读取立即生效。目录响应标记 `private, no-store`。

普通请求保持 `{ object: "list", data: [...] }`，混合组可以同时包含 Claude 和 OpenAI。带 `client_version` 的 Codex 专用请求返回 `{ models: [...] }`，仅包含上述已授权范围内的 OpenAI GPT 对话模型，排除 Claude、图片模型和后端不能识别的模型。OpenAI 兼容 endpoint 中的模型也按模型 ID 判断，不能因接口兼容就全部当作 OpenAI 模型。

Codex 与 Codex WebSocket 的选择器、远程目录和下载的 `codex-models.json` 使用这一个 OpenAI 目录。前端读取目录时也执行相同的模型类别过滤，下载内容与选择器保持一致；配置生成拒绝非 OpenAI 模型。只授权 Claude 或失去 OpenAI 资源时目录为空，不生成 Codex 配置，不回退到 Claude。

目录按 [OpenAI 官方网关部署说明](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway) 使用与项目内核匹配的 Codex `rust-v0.160.0` 原生目录及 `ModelInfo` / `ModelMessages` 类型。所有模型统一为 **52 个顶层字段、13 个 `model_messages` 字段**，字段顺序、类型和缺省表示一致；保留每个模型自己的指令、推理档位与工具能力。可空项使用 null，集合使用数组，布尔项使用官方契约缺省值。`shell_command` 等官方兼容拼写归一为 `unified_exec`；错误类型退回有效原生描述，凭据、端点和请求头不进入目录。

离线元数据改用官方版本对应的 7 个现有种子模型，旧 Sub2API 三模型导出副本已替换。元数据只补描述，不增加授权模型。按用户要求，Astra/Sol 系列的 `context_window` 在种子、历史设置读取、编辑、同步和导出路径均为 **500000**；这是本部署覆盖值，并非官方 tag 的默认值。官方 `max_context_window=872000` 保留，Luna 等其他模型的上下文保持其原生值。历史数据库不执行破坏性迁移；读取立即应用该规则，下一次正常保存或同步会持久化。

缺少原生指令时使用同版本官方默认模板。来源、SHA256、LICENSE、NOTICE 位于 `src/lib/protocol/codex-assets`。身份、显示名、排序和可见性由本服务控制；`use_responses_lite` 仍为 false，与现有传输能力一致。

## 生成行为

- Codex 与 Codex WebSocket **只提供 API Key Mode**：`requires_openai_auth=false`、`experimental_bearer_token`，不再生成 Codex 环境变量片段，不生成 `auth.json`。Claude/OpenCode/API 示例保持原有认证方式。
- 完整 `config.toml` 使用 `tapmodels` Provider，首行仅为 `# API Key Mode`，包含 Provider、`model`、`review_model`、有元数据依据时的推理档位、Responses 协议与功能配置。未成功获取目录或目录为空时不编造默认模型配置。
- 远程模式：Provider 表内放完整 `/v1/models` URL；`[features]` 启用 `api_key_model_discovery`。弹窗自动用当前 Key 获取目录，下载按钮仍可用。
- 本地模式：顶层放 `model_catalog_json="~/.codex/codex-models.json"`，下载 JSON 后保存到该路径；Windows 也保留 Codex 支持的 `~/` 写法。设置自定义 CODEX_HOME 时需同步调整路径。
- WebSocket 配置同时设置 Provider 的 `supports_websockets=true` 和 `[features].responses_websockets_v2=true`。只有原本支持该连接方式的 VM 分组提供 WS 标签。独立搜索仅在现有 GPT VM 搜索路径支持时声明。
- 目录超过 1 MiB 时自动采用本地文件模式；请求可取消，有 15 秒超时。API Key 仅在认证头和用户选择的配置文件中，不写入模型目录 URL 或下载的目录 JSON。
- 页面仅说明从 `/v1/models` 读取目录；实际协议请求仍使用 Codex 的 `client_version` 协商原生格式，配置中的目录 URL 不含版本号。命令块仅复制；只有 `settings.json`、`config.toml`、`opencode.json` 和模型目录支持下载。
- 语言菜单仅显示 English、简体中文、繁體中文、日本語；`en_US/zh_CN/zh_TW/ja_JP` 继续用于内部偏好，界面不展示代码。

## 当前分组与界面行为

本次只读对照 `/Users/luhonglin/Git/sub2api` 的 `ba7e21178ad58d2a1acbd06ea3cc5943204204ba`，重点为 `UseKeyModal.vue` 的默认客户端、平台入口、OS/Shell 和 `downloadName`，以及 `openai_codex_models_service.go` 的完整 ModelInfo 与嵌套消息保留。未修改 Sub2API 仓库，也未引入其其他平台或 legacy 认证模式。

| Key 所属分组 | 默认客户端 | 可见入口 |
| --- | --- | --- |
| Claude | Claude Code | Claude Code、OpenCode、API 示例 |
| OpenAI | Codex | Codex、支持原生 WS 时的 Codex WebSocket、OpenCode、API 示例 |
| 混合 | Claude Code | Claude Code、Codex、支持原生 WS 时的 Codex WebSocket、OpenCode、API 示例 |

Claude 与 API 示例提供 macOS/Linux、PowerShell、Windows CMD；Codex 两种连接提供 macOS/Linux 和 Windows；OpenCode 不显示无意义的系统选择。客户端与系统选中项都有实色背景、勾选和 `aria-pressed`。移除多余认证说明与配置头警告，配置中的 Provider 名称统一为 `tapmodels`。

## 官方结构统一与 500k 验收（2026-10-21）

- 只读核对官方文档与本地 OpenAI Codex tag `rust-v0.160.0`，固定提交 `a956835d020762cb2b570053af06f643a11c0ecc`；来源及哈希保存在 `codex-assets/PROVENANCE.txt`。
- 33 项后端检查通过（含出厂目录回归）：500k 在种子、历史设置、保存/同步及别名导出中生效；每个模型使用同一组字段与类型；无关模型上下文、权限与映射保持既有约束；混合 API/VM 分组的协议目录通过 HTTP 验证。18 项前端测试通过，包含目录下载和配置生成。
- 本机真实 `codex-cli 0.159.3` 在隔离配置目录中分别测试本地文件与远程目录：本地加载全部 7 个模型；远程使用测试 Key 访问混合分组的 `/v1/models`，返回该组 3 个 OpenAI 模型。两次 `initialize` / `model/list` 均成功，无结构解析错误，未启动推理。结果记录在 `.local/codex-schema/native-client-proof.json` 与 `native-remote-proof.json`。
- 规范化后的 7 模型目录约 359 KB，低于远程目录 1 MiB 限制。每项均为 52 个顶层字段、13 个消息模板字段；Astra/Sol 为 500000，最大窗口为 872000。
- 本机 linux/amd64 更新与实际 HTTP 目录证据记录在 `.local/codex-schema/`。已下载的旧文件需重新下载覆盖，使用本地目录的 Codex 需重启后读取。

本次清理：移除按 Sub2API 导出条目动态拼出字段集合的旧实现，替换为官方固定契约，并移除旧 `base_instructions` 字段转译；旧参考数据副本已替换，未增加接口、配置开关或数据库迁移。业务代码 +164/−30，净 +134；原生元数据 +970/−221，净 +749；测试 +108/−7，净 +101；文档另计。原有 `AGENTS.md` 空白修改未纳入。

## 历史：完整结构与界面修正验收（2026-10-20）

- 相关后端 20 项检查通过：目录同步、数据库保存/重载、完整描述导出、历史稀疏记录补齐、混合 API/VM 分组过滤与 Key 所有权。前端 18 项通过，包含 12 种 TOML 组合解析、按分组选择客户端，以及命令/文件下载区分。
- 修改文件 ESLint、TypeScript、Vite 构建通过。隔离浏览器验证三类分组默认项、客户端入口、深色选中态、Shell 切换、命令复制、仅文件下载、目录自动加载及实际下载文件；未调用付费推理。
- 将实际下载的三个模型逐字段对比用户提供的 Sub2API 目录：Astra/Luna 各 43 个字段和 9 个 `model_messages` 字段，Sol 51 个字段和 12 个 `model_messages` 字段。除本服务控制的显示名、排序和 Responses Lite 开关外，结构及数据一致。实际下载的 HTTP 远程和 WebSocket 本地 TOML 均验证 `tapmodels`、认证、URL、路径和开关。
- 本机 `18787` 以 `tapmodels:codex-full-metadata`（linux/amd64）更新，保留原数据和 VM 挂载。构建、备份、健康状态、更新前后数据数量及截图记录在 `.local/codex-full-metadata/`。旧本地目录需要重新获取、下载覆盖。

变更量：业务代码 +187/−135，净 +52；完整原生参考数据新增 348 行（115 KB，来源与哈希另记）；测试 +114/−12，净 +102；文档另计。已清理裁剪嵌套消息的旧逻辑、API 示例固定默认项、重复客户端列表、无条件下载按钮及旧 Provider/提示文案。无新增接口、数据库字段或配置开关。未纳入原有 `AGENTS.md` 空白修改。

以下为历史交付记录，不能替代本次验收。

## OpenAI 专用目录修正验收（2026-10-20）

本次纠正首次实现将通用模型列表全部转换为 Codex 目录的问题。服务端复用协议入口的模型类别判断，仅转换已授权的 OpenAI GPT 对话模型；前端的模型选择、下载 JSON 与配置生成同步限制。删除 Codex 的 Claude 元数据兜底和 WebSocket 单独的旧筛选分支，更新“通用目录与 Codex 目录完全相同”的错误测试预期。

- 后端 2 项 HTTP 集成测试通过：混合上游 API 与混合 VM 分组均保持通用列表包含两家模型，而 Codex 目录仅包含关联资源允许的 OpenAI；覆盖白名单修改、移除 GPT 资源、撤销授权及未授权/凭据不泄露。仅剩 Claude 时 Codex 目录为空。
- 前端 2 个文件、13 项测试通过；Codex/WS × Unix/CMD/PowerShell × 远程/本地的 12 种 TOML 组合通过 Python `tomllib` 解析。覆盖过滤后的 JSON 与选择器一致、原生元数据保留和拒绝为 Claude/非对话模型生成 Codex 配置。
- 修改文件 ESLint、TypeScript、Vite 构建、`git diff --check` 通过。
- 隔离浏览器验收使用含 `claude-sonnet-5-5`、`gpt-6.1-sol`、`gpt-6-astra` 的混合分组：Codex 与 Codex WebSocket 均自动显示 2 个 OpenAI 模型，刷新保持一致。实际下载的 `codex-models.json` 仅有两个 GPT，且不含密钥；实际下载的远程 HTTP、本地 HTTP、本地 WebSocket 三份 `config.toml` 均通过解析与字段校验。截图和构建/备份证据在 `.local/codex-openai-catalog/`，临时账号与数据均在隔离服务中。
- 本机 `127.0.0.1:18787` 已运行 `tapmodels:codex-openai`（linux/amd64），健康检查 200，浏览器静态文件和容器目录实现与当前构建一致。保留原数据挂载；用户 6、分组 6、Key 4，更新前后数量一致。镜像和回退容器信息在 `.local/codex-openai-catalog/deployment.json`。
- 本次不新增真实上游推理或 Codex 客户端调用验收。已下载的旧本地目录不会自动改写，需从“使用 → Codex”重新下载覆盖 `codex-models.json`；远程目录下一次读取即获得修正后的内容。

变更量：业务代码 +32/−24，净 +8；测试 +139/−14，净 +125；文档另计。保留普通混合模型发现、用户/分组/Key 权限及其他客户端行为，原有 `AGENTS.md` 空白修改未纳入。

## 首次交付验证（`41044202`，不代表本次修正验收）

- 前端完整测试：57 个文件、457 个测试通过。Codex/WS × Unix/CMD/PowerShell × 远程/本地的 12 种组合用 Python `tomllib` 解析，验证顶层/Provider/features 字段位置和密钥转义。
- 后端相关 34 项通过：两个目录与连接弹窗同源、分组白名单实时过滤、撤销授权拒绝、其他分组模型和密钥不泄露、元数据同步白名单。
- 修改文件 ESLint、TypeScript、Vite 构建与 workflow actionlint 通过。上一轮 CI 的旧上游下载测试地址已更新，相关 7 项通过。
- 浏览器隔离账号实测：两种客户端、两种目录模式、Windows 文件路径、目录自动加载、下载的真实 JSON/TOML 均验证；目录中只有关联分组的两个模型，JSON 不含测试密钥。
- 本机 18787 已更新。Docker Hub 基础镜像元数据请求超时，因此本地验收基于上一轮已验证的 linux/amd64 镜像，加当前源码和已编译前端；没有改动项目 Dockerfile 或跳过 GitHub 干净构建。最终镜像与数据备份记录在 `.local/codex-connection/deployment.json`。
- 没有运行真实上游推理、付费模型请求或正式发版。Codex 0.156 行为通过其官方源码、TOML 解析、HTTP 集成及浏览器下载验证；未声称运行了 Codex 客户端推理。

旧的两份模型授权过滤已收敛为一个共享函数；Codex 的环境变量配置片段与相应旧测试预期已移除。模型策略、定价、用户/分组/Key RPM、既有凭据与其他客户端保持各自现有逻辑。

变更量（含新文件）：业务代码 +409/−78，净 +331；测试 +239/−9，净 +230。官方模板、许可与来源说明另计 489 行；文档另计。原 AGENTS.md 空白修改未纳入。

最终 GitHub 验收（实现提交 `41044202`）：[CI](https://github.com/holeenlu/vm2api/actions/runs/39421715648) 的 unit、web、worker、kernel 全部通过；[仅构建验收](https://github.com/holeenlu/vm2api/actions/runs/39422404863) 的 prepare、checks、linux-amd64、image-amd64 全部通过，publish 跳过。仓库仍无正式 Release 或发布 tag。
