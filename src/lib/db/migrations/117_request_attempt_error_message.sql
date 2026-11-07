-- 117_request_attempt_error_message — 请求尝试补充上游错误原文。
-- error_message：Gateway Worker 失败尝试的上游 error.message（没有时为响应体开头），Worker 已压缩空白、
-- 非 ASCII 替换为“?”并限 240 字节；控制面入库再限 500 字符。用于区分同一状态码下的不同拒绝原因
-- （例如 BPS 403 是 usage policy 还是其他拒绝）。被换号或转原生接住的失败只在这里留有原文。历史行为 NULL。
ALTER TABLE request_attempts ADD COLUMN error_message TEXT;
