-- 088_gateway_runtime_load — Gateway Worker 心跳上报的负载：实例两次心跳之间的峰值在途数，
-- 以及各运行账号的在途数（运营端 Codex 账号与账号池与虚拟机一样显示并发占用）。
ALTER TABLE gateway_worker_instances ADD COLUMN peak_concurrency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN inflight INTEGER NOT NULL DEFAULT 0;
