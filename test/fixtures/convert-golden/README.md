# 协议转换器 golden 夹具（审计阶段 2 · W8）

运行器：`test/unit/convert-golden.test.mjs`。它是 W12（统一 Codex 请求计划）、W15（单一 SSE 管线）重构转换器前的安全网：只记录现状，不改转换器。

## 文件

- `<场景>.json`：手写输入。`requests` 含三种入站请求（`anthropic.messages`、`openai.chat`、`openai.responses`，不写 `model`，运行器按后端注入 `claude-sonnet-4-5-20250929` / `gpt-5.4`）；`upstream.claude` 是 Anthropic SSE 事件，`upstream.codex` 是 Responses SSE 事件（按 kin-codex-kernel 的 `event: response` 标注成帧）。数组元素为字符串时按原始行送入。
- `<场景>.golden.json`：生成的期望值。`claude.<协议>` / `codex.<协议>` 各含 `outbound`（出站请求）、`stream`（客户端流式输出，SSE 文本已解析为 `{ event?, data }`）、`nonStream`（客户端 JSON）。Claude 后端的 Anthropic 入站流式是原样透传，记为 `"passthrough"`。

调用链与处理器一致：

- Claude 后端：`toClaudeMessages` → `claudeSSELineToOpenAIChatChunks` / `claudeSSELineToResponsesEvents`（流式），`applyClaudeSSELineToMessage` → `fromClaudeToOpenAIChat` / `fromClaudeToResponses`（非流式）。
- Codex 后端：`toCodexResponses`（`anthropic_to_codex: true`）→ `responsesSseToAnthropicEvents` / `responsesSseToChatChunk` / `createResponsesSseEventNamer`（流式），`assembleCodexBodyFromSse` → `codexBodyToAnthropicMessage` → `fromClaudeToOpenAIChat` + `withChatUrlCitations`（非流式）。

`Date.now` 与 `Math.random` 在转换期间固定，生成的 id 和时间戳稳定。

## 更新

```bash
UPDATE_GOLDEN=1 node --test test/unit/convert-golden.test.mjs
git diff test/fixtures/convert-golden
```

默认只比对。改动转换器后若 golden 变化，逐项审查 diff 是否为预期行为再提交。

## 往返与流契约

- 往返（A→B→A 语义字段：正文、工具调用、停止原因/状态、用量）：`claude-json`、`codex-json`、`claude-stream`、`codex-stream`、`chat-request`（Chat 直转 Responses 与经 Claude 再转一致）、`anthropic-request`。
- 流契约：Anthropic 内容块不交叠；Responses 条目事件只出现在 added 与唯一 done 之间；Chat 工具参数在头之后、只有最后一块带 `finish_reason`。
- 已知缺陷 G1–G7 在运行器顶部 `GAP` 登记，对应字段以 `todo` 运行（报告但不失败），其余字段照常断言。修复后删除登记项。`09-failed` 的终态由传输层（go-worker-client、api-protocol）转换为错误，不做往返与流契约检查。
