-- 113_gateway_instance_shared_state — Worker 心跳上报的共享运行态（统一控制面重构 P5，KIN_REDIS_URL）：
-- 后端（redis / local）、是否健康、最近错误、本实例持有的共享并发租约与生效中的其他实例限制条数。
-- 只用于「Gateway Worker」页展示，不参与调度。
ALTER TABLE gateway_worker_instances ADD COLUMN shared_state_json TEXT;
