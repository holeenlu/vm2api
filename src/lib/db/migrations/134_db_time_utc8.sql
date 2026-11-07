-- 时间戳统一按 UTC+8 存储（用户决定 2026-11-07）：YYYY-MM-DDTHH:MM:SS.sss+08:00，固定偏移、固定宽度，
-- 字符串序仍等于时间序。绝对时刻不变，只换表示形式；写入侧由 src/shared/system-time.mjs 的 dbTime 与
-- db-client.mjs 的绑定改写统一产出，本迁移负责存量数据、触发器与 SQL 字面量。
--
-- 小时汇总键（usage_stats_hourly.hour、usage_cost_hourly.hour）不是时间戳，继续用 UTC 小时，
-- 因此触发器从 substr(created_at,1,13) 改为 strftime('%Y-%m-%dT%H', created_at)：SQLite 先按偏移归一到 UTC，
-- 桶键与 JS 侧 hourKey（toISOString().slice(0,13)）继续一致，存量汇总行无需重算。
--
-- 顺序：先删汇总触发器，再改写数据（否则逐行 UPDATE created_at 会触发汇总重算），最后按新定义重建全部触发器。
-- 本迁移按表名逐列改写，依赖 001–133 建好的表；jev 用量表（052 的附加模块，可被整体省略）单独放在 135。

-- 1) 先移除所有待重建的触发器（汇总触发器必须先于数据改写消失）
DROP TRIGGER gateway_facts_account_delete;
DROP TRIGGER gateway_facts_account_insert;
DROP TRIGGER gateway_facts_account_update;
DROP TRIGGER gateway_facts_credential_delete;
DROP TRIGGER gateway_facts_credential_insert;
DROP TRIGGER gateway_facts_credential_update;
DROP TRIGGER gateway_facts_group_delete;
DROP TRIGGER gateway_facts_group_insert;
DROP TRIGGER gateway_facts_group_rename;
DROP TRIGGER gateway_facts_group_update;
DROP TRIGGER gateway_facts_proxy_update;
DROP TRIGGER gateway_facts_vendor_update;
DROP TRIGGER usage_cost_hourly_delete;
DROP TRIGGER usage_cost_hourly_insert;
DROP TRIGGER usage_cost_hourly_update;
DROP TRIGGER usage_stats_hourly_delete;
DROP TRIGGER usage_stats_hourly_insert;
DROP TRIGGER usage_stats_hourly_update;

-- 2) 存量数据：155 个文本时间列，逐列把 ISO-Z 改写成 UTC+8 存储形式
--    GLOB 只匹配 Z 结尾的值，已是 +08:00 的行不动，迁移可重复执行
UPDATE "account_allocations" SET "at" = strftime('%Y-%m-%dT%H:%M:%f', "at", '+8 hours') || '+08:00'
  WHERE "at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "account_groups" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "account_runtime" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "account_runtime_states_legacy" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "last_used_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_used_at", '+8 hours') || '+08:00'
  WHERE "last_used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "rate_limited_at" = strftime('%Y-%m-%dT%H:%M:%f', "rate_limited_at", '+8 hours') || '+08:00'
  WHERE "rate_limited_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "rate_limit_reset_at" = strftime('%Y-%m-%dT%H:%M:%f', "rate_limit_reset_at", '+8 hours') || '+08:00'
  WHERE "rate_limit_reset_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "overload_until" = strftime('%Y-%m-%dT%H:%M:%f', "overload_until", '+8 hours') || '+08:00'
  WHERE "overload_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "temp_unschedulable_until" = strftime('%Y-%m-%dT%H:%M:%f', "temp_unschedulable_until", '+8 hours') || '+08:00'
  WHERE "temp_unschedulable_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "session_window_start" = strftime('%Y-%m-%dT%H:%M:%f', "session_window_start", '+8 hours') || '+08:00'
  WHERE "session_window_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "session_window_end" = strftime('%Y-%m-%dT%H:%M:%f', "session_window_end", '+8 hours') || '+08:00'
  WHERE "session_window_end" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "accounts_legacy" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "admin_domains" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "admin_domains" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_endpoint_keys" SET "cooldown_until" = strftime('%Y-%m-%dT%H:%M:%f', "cooldown_until", '+8 hours') || '+08:00'
  WHERE "cooldown_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_endpoint_keys" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_endpoints" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_endpoints" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "last_used_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_used_at", '+8 hours') || '+08:00'
  WHERE "last_used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "window_5h_start" = strftime('%Y-%m-%dT%H:%M:%f', "window_5h_start", '+8 hours') || '+08:00'
  WHERE "window_5h_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "window_1d_start" = strftime('%Y-%m-%dT%H:%M:%f', "window_1d_start", '+8 hours') || '+08:00'
  WHERE "window_1d_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "window_7d_start" = strftime('%Y-%m-%dT%H:%M:%f', "window_7d_start", '+8 hours') || '+08:00'
  WHERE "window_7d_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "api_keys" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "backup_records" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "billing_charges" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "billing_inflight" SET "started_at" = strftime('%Y-%m-%dT%H:%M:%f', "started_at", '+8 hours') || '+08:00'
  WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "billing_reservations" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "billing_reservations" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "cluster_node_direct_links" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "cluster_nodes" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "cluster_nodes" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "config_revisions" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_credentials" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_credentials" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_event_cursors" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_event_inbox" SET "occurred_at" = strftime('%Y-%m-%dT%H:%M:%f', "occurred_at", '+8 hours') || '+08:00'
  WHERE "occurred_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_event_inbox" SET "received_at" = strftime('%Y-%m-%dT%H:%M:%f', "received_at", '+8 hours') || '+08:00'
  WHERE "received_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_event_inbox" SET "checked_at" = strftime('%Y-%m-%dT%H:%M:%f', "checked_at", '+8 hours') || '+08:00'
  WHERE "checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "executor_settings" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_account_fact_revisions" SET "changed_at" = strftime('%Y-%m-%dT%H:%M:%f', "changed_at", '+8 hours') || '+08:00'
  WHERE "changed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_account_freezes" SET "frozen_until" = strftime('%Y-%m-%dT%H:%M:%f', "frozen_until", '+8 hours') || '+08:00'
  WHERE "frozen_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_account_freezes" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_account_bindings" SET "last_projected_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_projected_at", '+8 hours') || '+08:00'
  WHERE "last_projected_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_account_bindings" SET "last_seen_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_seen_at", '+8 hours') || '+08:00'
  WHERE "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_account_bindings" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_account_bindings" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_dead_letters" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_dead_letters" SET "resolved_at" = strftime('%Y-%m-%dT%H:%M:%f', "resolved_at", '+8 hours') || '+08:00'
  WHERE "resolved_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_dispatches" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_dispatches" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_dispatches" SET "sent_at" = strftime('%Y-%m-%dT%H:%M:%f', "sent_at", '+8 hours') || '+08:00'
  WHERE "sent_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_dispatches" SET "completed_at" = strftime('%Y-%m-%dT%H:%M:%f', "completed_at", '+8 hours') || '+08:00'
  WHERE "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_instances" SET "last_heartbeat_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_heartbeat_at", '+8 hours') || '+08:00'
  WHERE "last_heartbeat_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_instances" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_instances" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_oauth_sessions" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_oauth_sessions" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_oauth_sessions" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_receipts" SET "started_at" = strftime('%Y-%m-%dT%H:%M:%f', "started_at", '+8 hours') || '+08:00'
  WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_receipts" SET "first_byte_at" = strftime('%Y-%m-%dT%H:%M:%f', "first_byte_at", '+8 hours') || '+08:00'
  WHERE "first_byte_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_receipts" SET "finished_at" = strftime('%Y-%m-%dT%H:%M:%f', "finished_at", '+8 hours') || '+08:00'
  WHERE "finished_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_receipts" SET "applied_at" = strftime('%Y-%m-%dT%H:%M:%f', "applied_at", '+8 hours') || '+08:00'
  WHERE "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_receipts" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_receipts" SET "received_at" = strftime('%Y-%m-%dT%H:%M:%f', "received_at", '+8 hours') || '+08:00'
  WHERE "received_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_reconciliation_jobs" SET "next_attempt_at" = strftime('%Y-%m-%dT%H:%M:%f', "next_attempt_at", '+8 hours') || '+08:00'
  WHERE "next_attempt_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_reconciliation_jobs" SET "lease_until" = strftime('%Y-%m-%dT%H:%M:%f', "lease_until", '+8 hours') || '+08:00'
  WHERE "lease_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_reconciliation_jobs" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "gateway_worker_reconciliation_jobs" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "groups" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "groups" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "groups" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "operation_audit" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "panel_users_legacy" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "panel_users_legacy" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "panel_users_legacy" SET "last_login_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_login_at", '+8 hours') || '+08:00'
  WHERE "last_login_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "last_probe_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_probe_at", '+8 hours') || '+08:00'
  WHERE "last_probe_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "geo_checked_at" = strftime('%Y-%m-%dT%H:%M:%f', "geo_checked_at", '+8 hours') || '+08:00'
  WHERE "geo_checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "geo_v6_checked_at" = strftime('%Y-%m-%dT%H:%M:%f', "geo_v6_checked_at", '+8 hours') || '+08:00'
  WHERE "geo_v6_checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "proxies" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "quota_observations" SET "reset_at" = strftime('%Y-%m-%dT%H:%M:%f', "reset_at", '+8 hours') || '+08:00'
  WHERE "reset_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "quota_observations" SET "observed_at" = strftime('%Y-%m-%dT%H:%M:%f', "observed_at", '+8 hours') || '+08:00'
  WHERE "observed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "redeem_codes" SET "used_at" = strftime('%Y-%m-%dT%H:%M:%f', "used_at", '+8 hours') || '+08:00'
  WHERE "used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "redeem_codes" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "redeem_codes" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "refusal_device_blocks" SET "first_seen_at" = strftime('%Y-%m-%dT%H:%M:%f', "first_seen_at", '+8 hours') || '+08:00'
  WHERE "first_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "refusal_device_blocks" SET "last_seen_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_seen_at", '+8 hours') || '+08:00'
  WHERE "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "refusal_guards" SET "first_seen_at" = strftime('%Y-%m-%dT%H:%M:%f', "first_seen_at", '+8 hours') || '+08:00'
  WHERE "first_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "refusal_guards" SET "last_seen_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_seen_at", '+8 hours') || '+08:00'
  WHERE "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "refusal_guards" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "relay_migrations" SET "applied_at" = strftime('%Y-%m-%dT%H:%M:%f', "applied_at", '+8 hours') || '+08:00'
  WHERE "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "request_attempts" SET "started_at" = strftime('%Y-%m-%dT%H:%M:%f', "started_at", '+8 hours') || '+08:00'
  WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "request_attempts" SET "completed_at" = strftime('%Y-%m-%dT%H:%M:%f', "completed_at", '+8 hours') || '+08:00'
  WHERE "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "runtime_config" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "schema_migrations" SET "applied_at" = strftime('%Y-%m-%dT%H:%M:%f', "applied_at", '+8 hours') || '+08:00'
  WHERE "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "settings" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "usage_logs" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "usage_logs" SET "price_version" = strftime('%Y-%m-%dT%H:%M:%f', "price_version", '+8 hours') || '+08:00'
  WHERE "price_version" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "user_groups" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "user_subscriptions" SET "starts_at" = strftime('%Y-%m-%dT%H:%M:%f', "starts_at", '+8 hours') || '+08:00'
  WHERE "starts_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "user_subscriptions" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "user_subscriptions" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "user_subscriptions" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "users" SET "last_login_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_login_at", '+8 hours') || '+08:00'
  WHERE "last_login_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "users" SET "last_active_at" = strftime('%Y-%m-%dT%H:%M:%f', "last_active_at", '+8 hours') || '+08:00'
  WHERE "last_active_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "users" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "users" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "users" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_audit_events" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_capabilities" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_capabilities" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_contracts" SET "effective_at" = strftime('%Y-%m-%dT%H:%M:%f', "effective_at", '+8 hours') || '+08:00'
  WHERE "effective_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_contracts" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_execution_policies" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_execution_policies" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_members" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_members" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_payments" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_resource_grants" SET "effective_at" = strftime('%Y-%m-%dT%H:%M:%f', "effective_at", '+8 hours') || '+08:00'
  WHERE "effective_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_resource_grants" SET "revoked_at" = strftime('%Y-%m-%dT%H:%M:%f', "revoked_at", '+8 hours') || '+08:00'
  WHERE "revoked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_resources" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_resources" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_resources" SET "archived_at" = strftime('%Y-%m-%dT%H:%M:%f', "archived_at", '+8 hours') || '+08:00'
  WHERE "archived_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_resources" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlement_allocations" SET "released_at" = strftime('%Y-%m-%dT%H:%M:%f', "released_at", '+8 hours') || '+08:00'
  WHERE "released_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlement_previews" SET "expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "expires_at", '+8 hours') || '+08:00'
  WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlement_previews" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlements" SET "period_start" = strftime('%Y-%m-%dT%H:%M:%f', "period_start", '+8 hours') || '+08:00'
  WHERE "period_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlements" SET "period_end" = strftime('%Y-%m-%dT%H:%M:%f', "period_end", '+8 hours') || '+08:00'
  WHERE "period_end" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlements" SET "confirmed_at" = strftime('%Y-%m-%dT%H:%M:%f', "confirmed_at", '+8 hours') || '+08:00'
  WHERE "confirmed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlements" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_settlements" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_usage_facts" SET "occurred_at" = strftime('%Y-%m-%dT%H:%M:%f', "occurred_at", '+8 hours') || '+08:00'
  WHERE "occurred_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendor_usage_facts" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendors" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendors" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vendors" SET "deleted_at" = strftime('%Y-%m-%dT%H:%M:%f', "deleted_at", '+8 hours') || '+08:00'
  WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vm_bulk_edits" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vm_pool_members" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vm_pools" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vm_pools" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vms" SET "oauth_expires_at" = strftime('%Y-%m-%dT%H:%M:%f', "oauth_expires_at", '+8 hours') || '+08:00'
  WHERE "oauth_expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vms" SET "synced_at" = strftime('%Y-%m-%dT%H:%M:%f', "synced_at", '+8 hours') || '+08:00'
  WHERE "synced_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vms" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "vms" SET "updated_at" = strftime('%Y-%m-%dT%H:%M:%f', "updated_at", '+8 hours') || '+08:00'
  WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "wallet_ledger" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';

-- 3) 按新定义重建触发器
CREATE TRIGGER gateway_facts_account_delete
AFTER DELETE ON vendor_resources
WHEN OLD.resource_type = 'account' AND json_extract(OLD.config_json, '$.execution_kind') = 'gateway_worker'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (OLD.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_account_insert
AFTER INSERT ON vendor_resources
WHEN NEW.resource_type = 'account' AND json_extract(NEW.config_json, '$.execution_kind') = 'gateway_worker'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_account_update
AFTER UPDATE ON vendor_resources
WHEN NEW.resource_type = 'account'
  AND (json_extract(NEW.config_json, '$.execution_kind') = 'gateway_worker'
    OR json_extract(OLD.config_json, '$.execution_kind') = 'gateway_worker')
  AND (
    NEW.status IS NOT OLD.status
    OR NEW.secret_json IS NOT OLD.secret_json
    OR NEW.archived_at IS NOT OLD.archived_at
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.name IS NOT OLD.name
    OR json_array(
      json_extract(OLD.config_json, '$.execution_kind'), json_extract(OLD.config_json, '$.platform'),
      json_extract(OLD.config_json, '$.max_concurrency'), json_extract(OLD.config_json, '$.max_rpm'),
      json_extract(OLD.config_json, '$.weight'), json_extract(OLD.config_json, '$.model_access'),
      json_extract(OLD.config_json, '$.reset_credit_auto'), json_extract(OLD.config_json, '$.proxy_id'),
      json_extract(OLD.config_json, '$.email'), json_extract(OLD.config_json, '$.plan'),
      json_extract(OLD.config_json, '$.chatgpt_account_id'), json_extract(OLD.config_json, '$.runtime_account_id'),
      json_extract(OLD.config_json, '$.installation_id')
    ) IS NOT json_array(
      json_extract(NEW.config_json, '$.execution_kind'), json_extract(NEW.config_json, '$.platform'),
      json_extract(NEW.config_json, '$.max_concurrency'), json_extract(NEW.config_json, '$.max_rpm'),
      json_extract(NEW.config_json, '$.weight'), json_extract(NEW.config_json, '$.model_access'),
      json_extract(NEW.config_json, '$.reset_credit_auto'), json_extract(NEW.config_json, '$.proxy_id'),
      json_extract(NEW.config_json, '$.email'), json_extract(NEW.config_json, '$.plan'),
      json_extract(NEW.config_json, '$.chatgpt_account_id'), json_extract(NEW.config_json, '$.runtime_account_id'),
      json_extract(NEW.config_json, '$.installation_id')
    )
  )
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_credential_delete
AFTER DELETE ON executor_credentials
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (OLD.account_resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_credential_insert
AFTER INSERT ON executor_credentials
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.account_resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_credential_update
AFTER UPDATE ON executor_credentials
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.account_resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_group_delete
AFTER DELETE ON group_resources
WHEN OLD.resource_kind = 'gateway_worker_account'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (OLD.resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_group_insert
AFTER INSERT ON group_resources
WHEN NEW.resource_kind = 'gateway_worker_account'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00')
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_group_rename
AFTER UPDATE OF name ON groups
WHEN NEW.name IS NOT OLD.name
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT r.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00'
  FROM group_resources gr
  JOIN vendor_resources r ON r.id = gr.resource_id
  WHERE gr.group_id = NEW.id
    AND gr.resource_kind = 'gateway_worker_account'
    AND r.vendor_id IS NOT NULL
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_group_update
AFTER UPDATE ON group_resources
WHEN NEW.resource_kind = 'gateway_worker_account' OR OLD.resource_kind = 'gateway_worker_account'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00'
  FROM (SELECT OLD.resource_id AS id WHERE OLD.resource_kind = 'gateway_worker_account'
        UNION SELECT NEW.resource_id WHERE NEW.resource_kind = 'gateway_worker_account')
  WHERE true
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_proxy_update
AFTER UPDATE ON proxies
WHEN json_array(
    OLD.max_websocket_connections, OLD.request_location_mode, OLD.location_country, OLD.location_region,
    OLD.location_city, OLD.location_timezone, OLD.geo_country_code, OLD.geo_region, OLD.geo_city, OLD.geo_timezone,
    OLD.geo_v6_country_code, OLD.geo_v6_region, OLD.geo_v6_city, OLD.geo_v6_timezone
  ) IS NOT json_array(
    NEW.max_websocket_connections, NEW.request_location_mode, NEW.location_country, NEW.location_region,
    NEW.location_city, NEW.location_timezone, NEW.geo_country_code, NEW.geo_region, NEW.geo_city, NEW.geo_timezone,
    NEW.geo_v6_country_code, NEW.geo_v6_region, NEW.geo_v6_city, NEW.geo_v6_timezone
  )
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT r.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00'
  FROM vendor_resources r
  WHERE r.resource_type = 'account'
    AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
    AND json_extract(r.config_json, '$.proxy_id') = NEW.id
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER gateway_facts_vendor_update
AFTER UPDATE ON vendors
WHEN NEW.status IS NOT OLD.status
  OR NEW.parent_id IS NOT OLD.parent_id
  OR NEW.groups_json IS NOT OLD.groups_json
  OR NEW.platforms_json IS NOT OLD.platforms_json
  OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT r.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+8 hours') || '+08:00'
  FROM vendor_resources r
  WHERE r.resource_type = 'account'
    AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
    AND (r.vendor_id = NEW.id OR r.vendor_id IN (SELECT c.id FROM vendors c WHERE c.parent_id = NEW.id))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER usage_cost_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_prune_marker)
BEGIN
  UPDATE usage_cost_hourly SET
    requests = requests - 1,
    unpriced = unpriced - (CASE WHEN OLD.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0) + IFNULL(OLD.output_tokens, 0) + IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0) + IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END),
    input_tokens = input_tokens - IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0),
    output_tokens = output_tokens - IFNULL(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0),
    cache_creation_tokens = cache_creation_tokens - IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0),
    input_cost_micros = input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0),
    input_cost = (input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    output_cost_micros = output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0),
    output_cost = (output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0),
    cache_read_cost = (cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0),
    cache_creation_cost = (cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    total_cost_micros = total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0),
    total_cost = (total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0)) / 1000000.0
  WHERE hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_cost_hourly
  WHERE requests <= 0
    AND hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
END;

CREATE TRIGGER usage_cost_hourly_insert AFTER INSERT ON usage_logs
WHEN NEW.created_at IS NOT NULL
BEGIN
  INSERT INTO usage_cost_hourly (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code, requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros, input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost)
  VALUES (
    strftime('%Y-%m-%dT%H', NEW.created_at),
    COALESCE(NULLIF(NEW.final_account_id, ''), NULLIF(NEW.account_id, ''), NEW.vm_id, '—'),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.execution_kind, ''),
    COALESCE(NEW.account_resource_id, ''),
    CASE WHEN instr(lower(COALESCE(NULLIF(trim(NEW.upstream_model), ''), trim(NEW.model), '')), 'fable') > 0 THEN 1 ELSE 0 END,
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    CASE WHEN NEW.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0) + IFNULL(NEW.output_tokens, 0) + IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0) + IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END,
    IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0),
    IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0),
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0) / 1000000.0
  )
  ON CONFLICT (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    unpriced = unpriced + excluded.unpriced,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    input_cost_micros = input_cost_micros + excluded.input_cost_micros,
    input_cost = (input_cost_micros + excluded.input_cost_micros) / 1000000.0,
    output_cost_micros = output_cost_micros + excluded.output_cost_micros,
    output_cost = (output_cost_micros + excluded.output_cost_micros) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros + excluded.cache_read_cost_micros,
    cache_read_cost = (cache_read_cost_micros + excluded.cache_read_cost_micros) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros + excluded.cache_creation_cost_micros,
    cache_creation_cost = (cache_creation_cost_micros + excluded.cache_creation_cost_micros) / 1000000.0,
    total_cost_micros = total_cost_micros + excluded.total_cost_micros,
    total_cost = (total_cost_micros + excluded.total_cost_micros) / 1000000.0;
END;

CREATE TRIGGER usage_cost_hourly_update AFTER UPDATE OF
  created_at, final_account_id, account_id, vm_id, execution_kind, account_resource_id,
  model, upstream_model, pricing_model, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  upstream_input_tokens, upstream_cache_read_tokens, upstream_cache_creation_tokens,
  input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost,
  input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros
ON usage_logs
BEGIN
  UPDATE usage_cost_hourly SET
    requests = requests - 1,
    unpriced = unpriced - (CASE WHEN OLD.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0) + IFNULL(OLD.output_tokens, 0) + IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0) + IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END),
    input_tokens = input_tokens - IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0),
    output_tokens = output_tokens - IFNULL(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0),
    cache_creation_tokens = cache_creation_tokens - IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0),
    input_cost_micros = input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0),
    input_cost = (input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    output_cost_micros = output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0),
    output_cost = (output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0),
    cache_read_cost = (cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0),
    cache_creation_cost = (cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    total_cost_micros = total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0),
    total_cost = (total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0)) / 1000000.0
  WHERE OLD.created_at IS NOT NULL
    AND hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_cost_hourly
  WHERE OLD.created_at IS NOT NULL
    AND requests <= 0
    AND hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  INSERT INTO usage_cost_hourly (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code, requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros, input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost)
  SELECT
    strftime('%Y-%m-%dT%H', NEW.created_at),
    COALESCE(NULLIF(NEW.final_account_id, ''), NULLIF(NEW.account_id, ''), NEW.vm_id, '—'),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.execution_kind, ''),
    COALESCE(NEW.account_resource_id, ''),
    CASE WHEN instr(lower(COALESCE(NULLIF(trim(NEW.upstream_model), ''), trim(NEW.model), '')), 'fable') > 0 THEN 1 ELSE 0 END,
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    CASE WHEN NEW.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0) + IFNULL(NEW.output_tokens, 0) + IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0) + IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END,
    IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0),
    IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0),
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0) / 1000000.0
  WHERE NEW.created_at IS NOT NULL
  ON CONFLICT (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    unpriced = unpriced + excluded.unpriced,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    input_cost_micros = input_cost_micros + excluded.input_cost_micros,
    input_cost = (input_cost_micros + excluded.input_cost_micros) / 1000000.0,
    output_cost_micros = output_cost_micros + excluded.output_cost_micros,
    output_cost = (output_cost_micros + excluded.output_cost_micros) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros + excluded.cache_read_cost_micros,
    cache_read_cost = (cache_read_cost_micros + excluded.cache_read_cost_micros) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros + excluded.cache_creation_cost_micros,
    cache_creation_cost = (cache_creation_cost_micros + excluded.cache_creation_cost_micros) / 1000000.0,
    total_cost_micros = total_cost_micros + excluded.total_cost_micros,
    total_cost = (total_cost_micros + excluded.total_cost_micros) / 1000000.0;
END;

CREATE TRIGGER usage_stats_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_prune_marker)
BEGIN
  UPDATE usage_stats_hourly SET
    requests = requests - (1),
    input_tokens = input_tokens - (IFNULL(OLD.input_tokens, 0)),
    output_tokens = output_tokens - (IFNULL(OLD.output_tokens, 0)),
    cache_read_tokens = cache_read_tokens - (IFNULL(OLD.cache_read_tokens, 0)),
    cache_creation_tokens = cache_creation_tokens - (IFNULL(OLD.cache_creation_tokens, 0)),
    cache_creation_5m_tokens = cache_creation_5m_tokens - (IFNULL(OLD.cache_creation_5m_tokens, 0)),
    cache_creation_1h_tokens = cache_creation_1h_tokens - (IFNULL(OLD.cache_creation_1h_tokens, 0)),
    cost_micros = cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0)),
    cost = (cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0))) / 1000000.0,
    cost_n = cost_n - (CASE WHEN COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END),
    duration_sum = duration_sum - (IFNULL(OLD.duration_ms, 0)),
    duration_n = duration_n - (CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END),
    ttft_sum = ttft_sum - (IFNULL(OLD.first_token_ms, 0)),
    ttft_n = ttft_n - (CASE WHEN OLD.first_token_ms IS NULL THEN 0 ELSE 1 END)
  WHERE hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_stats_hourly
  WHERE requests <= 0
    AND hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
END;

CREATE TRIGGER usage_stats_hourly_insert AFTER INSERT ON usage_logs
WHEN NEW.created_at IS NOT NULL
BEGIN
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
  VALUES (
    strftime('%Y-%m-%dT%H', NEW.created_at),
    COALESCE(NEW.user_id, ''),
    COALESCE(NEW.api_key_id, ''),
    COALESCE(NEW.model, ''),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.billing_group_id, -1),
    COALESCE(NEW.path, ''),
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    IFNULL(NEW.input_tokens, 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(NEW.cache_read_tokens, 0),
    IFNULL(NEW.cache_creation_tokens, 0),
    IFNULL(NEW.cache_creation_5m_tokens, 0),
    IFNULL(NEW.cache_creation_1h_tokens, 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    CASE WHEN COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.duration_ms, 0),
    CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.first_token_ms, 0),
    CASE WHEN NEW.first_token_ms IS NULL THEN 0 ELSE 1 END
  )
  ON CONFLICT (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    cache_creation_5m_tokens = cache_creation_5m_tokens + excluded.cache_creation_5m_tokens,
    cache_creation_1h_tokens = cache_creation_1h_tokens + excluded.cache_creation_1h_tokens,
    cost_micros = cost_micros + excluded.cost_micros,
    cost = (cost_micros + excluded.cost_micros) / 1000000.0,
    cost_n = cost_n + excluded.cost_n,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;

CREATE TRIGGER usage_stats_hourly_update AFTER UPDATE OF
  created_at, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
  actual_cost, actual_cost_micros, duration_ms, first_token_ms
ON usage_logs
BEGIN
  UPDATE usage_stats_hourly SET
    requests = requests - (1),
    input_tokens = input_tokens - (IFNULL(OLD.input_tokens, 0)),
    output_tokens = output_tokens - (IFNULL(OLD.output_tokens, 0)),
    cache_read_tokens = cache_read_tokens - (IFNULL(OLD.cache_read_tokens, 0)),
    cache_creation_tokens = cache_creation_tokens - (IFNULL(OLD.cache_creation_tokens, 0)),
    cache_creation_5m_tokens = cache_creation_5m_tokens - (IFNULL(OLD.cache_creation_5m_tokens, 0)),
    cache_creation_1h_tokens = cache_creation_1h_tokens - (IFNULL(OLD.cache_creation_1h_tokens, 0)),
    cost_micros = cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0)),
    cost = (cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0))) / 1000000.0,
    cost_n = cost_n - (CASE WHEN COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END),
    duration_sum = duration_sum - (IFNULL(OLD.duration_ms, 0)),
    duration_n = duration_n - (CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END),
    ttft_sum = ttft_sum - (IFNULL(OLD.first_token_ms, 0)),
    ttft_n = ttft_n - (CASE WHEN OLD.first_token_ms IS NULL THEN 0 ELSE 1 END)
  WHERE OLD.created_at IS NOT NULL
    AND hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_stats_hourly
  WHERE OLD.created_at IS NOT NULL
    AND requests <= 0
    AND hour = strftime('%Y-%m-%dT%H', OLD.created_at)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
  SELECT
    strftime('%Y-%m-%dT%H', NEW.created_at),
    COALESCE(NEW.user_id, ''),
    COALESCE(NEW.api_key_id, ''),
    COALESCE(NEW.model, ''),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.billing_group_id, -1),
    COALESCE(NEW.path, ''),
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    IFNULL(NEW.input_tokens, 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(NEW.cache_read_tokens, 0),
    IFNULL(NEW.cache_creation_tokens, 0),
    IFNULL(NEW.cache_creation_5m_tokens, 0),
    IFNULL(NEW.cache_creation_1h_tokens, 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    CASE WHEN COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.duration_ms, 0),
    CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.first_token_ms, 0),
    CASE WHEN NEW.first_token_ms IS NULL THEN 0 ELSE 1 END
  WHERE NEW.created_at IS NOT NULL
  ON CONFLICT (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    cache_creation_5m_tokens = cache_creation_5m_tokens + excluded.cache_creation_5m_tokens,
    cache_creation_1h_tokens = cache_creation_1h_tokens + excluded.cache_creation_1h_tokens,
    cost_micros = cost_micros + excluded.cost_micros,
    cost = (cost_micros + excluded.cost_micros) / 1000000.0,
    cost_n = cost_n + excluded.cost_n,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;

-- 4) 守卫：任一时间列仍残留 Z 值则整个迁移失败回滚（参照 126 的做法）
CREATE TEMP TABLE db_time_utc8__fix_rows_first (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO db_time_utc8__fix_rows_first(ok)
SELECT CASE WHEN
  EXISTS(SELECT 1 FROM "account_allocations" WHERE "at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "account_groups" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "account_runtime" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "account_runtime_states_legacy" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "last_used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "rate_limited_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "rate_limit_reset_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "overload_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "temp_unschedulable_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "session_window_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "session_window_end" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "accounts_legacy" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "admin_domains" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "admin_domains" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_endpoint_keys" WHERE "cooldown_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_endpoint_keys" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_endpoints" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_endpoints" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "last_used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "window_5h_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "window_1d_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "window_7d_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "api_keys" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "backup_records" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "billing_charges" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "billing_inflight" WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "billing_reservations" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "billing_reservations" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "cluster_node_direct_links" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "cluster_nodes" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "cluster_nodes" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "config_revisions" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_credentials" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_credentials" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_event_cursors" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_event_inbox" WHERE "occurred_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_event_inbox" WHERE "received_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_event_inbox" WHERE "checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "executor_settings" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_account_fact_revisions" WHERE "changed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_account_freezes" WHERE "frozen_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_account_freezes" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_account_bindings" WHERE "last_projected_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_account_bindings" WHERE "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_account_bindings" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_account_bindings" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_dead_letters" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_dead_letters" WHERE "resolved_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_dispatches" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_dispatches" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_dispatches" WHERE "sent_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_dispatches" WHERE "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_instances" WHERE "last_heartbeat_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_instances" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_instances" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_oauth_sessions" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_oauth_sessions" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_oauth_sessions" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_receipts" WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_receipts" WHERE "first_byte_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_receipts" WHERE "finished_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_receipts" WHERE "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_receipts" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_receipts" WHERE "received_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_reconciliation_jobs" WHERE "next_attempt_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_reconciliation_jobs" WHERE "lease_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_reconciliation_jobs" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "gateway_worker_reconciliation_jobs" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "groups" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "groups" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "groups" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "operation_audit" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "panel_users_legacy" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "panel_users_legacy" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "panel_users_legacy" WHERE "last_login_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "last_probe_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "geo_checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "geo_v6_checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "proxies" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "quota_observations" WHERE "reset_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "quota_observations" WHERE "observed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "redeem_codes" WHERE "used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "redeem_codes" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "redeem_codes" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "refusal_device_blocks" WHERE "first_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "refusal_device_blocks" WHERE "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "refusal_guards" WHERE "first_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "refusal_guards" WHERE "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "refusal_guards" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "relay_migrations" WHERE "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "request_attempts" WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "request_attempts" WHERE "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "runtime_config" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "schema_migrations" WHERE "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "settings" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "usage_logs" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "usage_logs" WHERE "price_version" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "user_groups" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "user_subscriptions" WHERE "starts_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "user_subscriptions" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "user_subscriptions" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "user_subscriptions" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "users" WHERE "last_login_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "users" WHERE "last_active_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "users" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "users" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "users" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_audit_events" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_capabilities" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_capabilities" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_contracts" WHERE "effective_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_contracts" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_execution_policies" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_execution_policies" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_members" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_members" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_payments" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_resource_grants" WHERE "effective_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_resource_grants" WHERE "revoked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_resources" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_resources" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_resources" WHERE "archived_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_resources" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlement_allocations" WHERE "released_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlement_previews" WHERE "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlement_previews" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlements" WHERE "period_start" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlements" WHERE "period_end" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlements" WHERE "confirmed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlements" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_settlements" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_usage_facts" WHERE "occurred_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendor_usage_facts" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendors" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendors" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vendors" WHERE "deleted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vm_bulk_edits" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vm_pool_members" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vm_pools" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vm_pools" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vms" WHERE "oauth_expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vms" WHERE "synced_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vms" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "vms" WHERE "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "wallet_ledger" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
THEN 0 ELSE 1 END;
DROP TABLE db_time_utc8__fix_rows_first;

