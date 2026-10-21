# 定制差异逐文件清单

冻结上游：`eee8f6ecb6ca04455e6edef0c8e498fb3be21f21`。本轮交付前 main：`4effa35cf1fbf5947000b29988027e07d4f6c221`。

此清单来自最终暂存树相对两个基点的实际 diff，包含新增文件与删除项。不启用重命名推断，因此改名按删除/新增分别计数；二进制只统计文件数，不折算行数。业务实现包含生成路由；原生目录数据、许可、文档、测试与交付工具单列。

功能、清理、破坏性变更和升级指南见 [定制版 Release Note](CUSTOMIZATION_RELEASE_NOTES.md)。只有相对上游的差异是累计定制；上游原有功能和未实现规划不计为本地新增。

## 累计定制：相对冻结上游

| 分类 | 文件数 | 新增行 | 删除行 | 净变化 | 二进制文件 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务实现 | 275 | 11129 | 6691 | +4438 | 0 |
| 部署、构建与交付工具 | 38 | 1358 | 437 | +921 | 0 |
| 测试 | 112 | 4125 | 1503 | +2622 | 0 |
| 原生目录数据与许可 | 5 | 1618 | 0 | +1618 | 0 |
| 文档与图示 | 39 | 2430 | 226 | +2204 | 7 |

## 本轮调整：相对交付前 main

| 分类 | 文件数 | 新增行 | 删除行 | 净变化 | 二进制文件 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务实现 | 9 | 77 | 66 | +11 | 0 |
| 部署、构建与交付工具 | 0 | 0 | 0 | +0 | 0 |
| 测试 | 5 | 90 | 56 | +34 | 0 |
| 原生目录数据与许可 | 0 | 0 | 0 | +0 | 0 |
| 文档与图示 | 5 | 42 | 29 | +13 | 0 |

本轮恢复槽位表单上游行为、增加台湾繁体、移除语言时区耦合并修正选项布局；包含对应测试和说明。本机技能、本轮临时浏览器夹具和私有验收日志不计入 Git 交付差异。

## 累计逐文件范围

A = 新增，M = 修改，D = 删除。以下每项都属于最终定制提交。

### 业务实现

| 状态 | 文件 | + / − |
| --- | --- | ---: |
| M | `src/lib/admin/api-keys.mjs` | 84 / 59 |
| M | `src/lib/admin/builtin-rates.mjs` | 3 / 3 |
| M | `src/lib/admin/error-class.mjs` | 2 / 2 |
| A | `src/lib/admin/group-metrics.mjs` | 31 / 0 |
| A | `src/lib/admin/key-connection.mjs` | 18 / 0 |
| A | `src/lib/admin/key-ip-rules.mjs` | 38 / 0 |
| M | `src/lib/admin/key-scope.mjs` | 67 / 158 |
| M | `src/lib/admin/onboarding.mjs` | 4 / 2 |
| M | `src/lib/admin/panel-acl.mjs` | 90 / 184 |
| M | `src/lib/admin/panel-api.mjs` | 6 / 4 |
| A | `src/lib/admin/panel-profile.mjs` | 72 / 0 |
| M | `src/lib/admin/panel-routes.mjs` | 260 / 249 |
| M | `src/lib/admin/panel-tenant.mjs` | 1 / 79 |
| M | `src/lib/admin/panel-users.mjs` | 36 / 14 |
| M | `src/lib/admin/pricing.mjs` | 4 / 4 |
| A | `src/lib/admin/relay-billing.mjs` | 348 / 0 |
| A | `src/lib/admin/relay-common.mjs` | 33 / 0 |
| A | `src/lib/admin/relay-migration.mjs` | 94 / 0 |
| A | `src/lib/admin/relay-ops.mjs` | 108 / 0 |
| A | `src/lib/admin/relay-routes.mjs` | 418 / 0 |
| M | `src/lib/admin/release-kernel.mjs` | 6 / 6 |
| M | `src/lib/admin/release.mjs` | 17 / 16 |
| M | `src/lib/admin/request-log.mjs` | 12 / 4 |
| M | `src/lib/admin/resource-owner.mjs` | 7 / 33 |
| A | `src/lib/admin/site-branding.mjs` | 43 / 0 |
| A | `src/lib/admin/usage-projection.mjs` | 141 / 0 |
| D | `src/lib/admin/vm-pools.mjs` | 0 / 98 |
| M | `src/lib/cluster/cluster-manager.mjs` | 3 / 3 |
| M | `src/lib/cluster/direct-link.mjs` | 2 / 2 |
| M | `src/lib/cluster/docker-remote.mjs` | 2 / 2 |
| M | `src/lib/cluster/native-slot.mjs` | 2 / 2 |
| M | `src/lib/cluster/node-edit.mjs` | 2 / 2 |
| M | `src/lib/cluster/node-host.mjs` | 2 / 2 |
| M | `src/lib/cluster/remote-slot.mjs` | 3 / 3 |
| M | `src/lib/cluster/slot-image.mjs` | 2 / 2 |
| M | `src/lib/cluster/socket-relay.mjs` | 1 / 1 |
| M | `src/lib/core/config.mjs` | 2 / 2 |
| M | `src/lib/core/errors.mjs` | 1 / 1 |
| M | `src/lib/core/refusal-guard.mjs` | 1 / 1 |
| A | `src/lib/core/runtime-secrets.mjs` | 42 / 0 |
| M | `src/lib/core/security.mjs` | 2 / 2 |
| D | `src/lib/db/migrations/039_cluster_node_direct_links.sql` | 0 / 15 |
| A | `src/lib/db/migrations/039_relay_operations.sql` | 66 / 0 |
| D | `src/lib/db/migrations/040_cluster_node_platform.sql` | 0 / 7 |
| A | `src/lib/db/migrations/040_remove_unused_fallback_group.sql` | 3 / 0 |
| A | `src/lib/db/migrations/041_proxy_quality.sql` | 2 / 0 |
| D | `src/lib/db/migrations/041_usage_logs_inbound_device.sql` | 0 / 6 |
| A | `src/lib/db/migrations/042_proxy_lifetime.sql` | 3 / 0 |
| A | `src/lib/db/migrations/043_user_group_overrides.sql` | 12 / 0 |
| A | `src/lib/db/migrations/044_user_profile.sql` | 1 / 0 |
| A | `src/lib/db/migrations/045_cluster_node_direct_links.sql` | 15 / 0 |
| A | `src/lib/db/migrations/046_cluster_node_platform.sql` | 7 / 0 |
| A | `src/lib/db/migrations/047_usage_logs_inbound_device.sql` | 6 / 0 |
| M | `src/lib/db/repos/account-runtime-repo.mjs` | 1 / 5 |
| M | `src/lib/db/repos/accounts-repo.mjs` | 1 / 6 |
| M | `src/lib/db/repos/api-keys-repo.mjs` | 4 / 7 |
| M | `src/lib/db/repos/groups-repo.mjs` | 311 / 54 |
| M | `src/lib/db/repos/proxies-repo.mjs` | 9 / 2 |
| M | `src/lib/db/repos/redeem-codes-repo.mjs` | 7 / 1 |
| M | `src/lib/db/repos/statistics-repo.mjs` | 21 / 6 |
| M | `src/lib/db/repos/usage-log-preds.mjs` | 2 / 6 |
| M | `src/lib/db/repos/usage-logs-repo.mjs` | 9 / 2 |
| M | `src/lib/db/repos/usage-logs-view.mjs` | 40 / 14 |
| M | `src/lib/db/repos/users-repo.mjs` | 22 / 8 |
| D | `src/lib/db/repos/vm-pools-repo.mjs` | 0 / 130 |
| M | `src/lib/db/secure.mjs` | 2 / 2 |
| M | `src/lib/identity/workstation-fingerprint.mjs` | 1 / 1 |
| M | `src/lib/oauth/cookie-auth.mjs` | 1 / 1 |
| M | `src/lib/oauth/oauth-auth-url.mjs` | 4 / 4 |
| M | `src/lib/pool/api-protocol.mjs` | 4 / 1 |
| M | `src/lib/pool/api-scheduler.mjs` | 4 / 4 |
| M | `src/lib/pool/pool-scheduler.mjs` | 8 / 1 |
| M | `src/lib/pool/schedule-eligibility.mjs` | 2 / 2 |
| M | `src/lib/pool/sticky-router.mjs` | 16 / 12 |
| A | `src/lib/protocol/codex-catalog.mjs` | 219 / 0 |
| M | `src/lib/protocol/codex-models.mjs` | 6 / 6 |
| M | `src/lib/protocol/eager-tool-streaming.mjs` | 7 / 4 |
| M | `src/lib/protocol/gpt-ids.mjs` | 11 / 0 |
| M | `src/lib/protocol/gpt-model-policy.mjs` | 36 / 13 |
| M | `src/lib/protocol/handle-codex.mjs` | 7 / 7 |
| M | `src/lib/protocol/handle-protocol.mjs` | 147 / 49 |
| A | `src/lib/protocol/key-models.mjs` | 27 / 0 |
| M | `src/lib/protocol/model-policy.mjs` | 33 / 28 |
| M | `src/lib/protocol/outbound-attempt.mjs` | 3 / 9 |
| M | `src/lib/protocol/user-count-tokens.mjs` | 12 / 4 |
| M | `src/lib/protocol/warmup-intercept.mjs` | 1 / 1 |
| M | `src/lib/vm/egress.mjs` | 2 / 2 |
| M | `src/lib/vm/host-path.mjs` | 6 / 6 |
| M | `src/lib/vm/kvm-host.mjs` | 2 / 2 |
| A | `src/lib/vm/proxy-address.mjs` | 73 / 0 |
| M | `src/lib/vm/proxy-agent.mjs` | 2 / 2 |
| M | `src/lib/vm/proxy-geo.mjs` | 7 / 4 |
| M | `src/lib/vm/proxy-policy-runtime.mjs` | 3 / 3 |
| M | `src/lib/vm/proxy-policy.mjs` | 7 / 3 |
| M | `src/lib/vm/proxy-pool.mjs` | 297 / 57 |
| A | `src/lib/vm/proxy-quality.mjs` | 118 / 0 |
| M | `src/lib/vm/proxy-resolve.mjs` | 3 / 3 |
| D | `src/lib/vm/socks-address.mjs` | 0 / 67 |
| M | `src/lib/vm/vm-db-sync.mjs` | 1 / 16 |
| M | `src/lib/vm/vm-package.mjs` | 19 / 16 |
| M | `src/lib/vm/vm-registry.mjs` | 9 / 31 |
| M | `src/lib/vm/vm-runtime.mjs` | 3 / 3 |
| M | `src/lib/vm/wrap-cli-runtime.mjs` | 1 / 1 |
| M | `src/server.mjs` | 80 / 18 |
| M | `web/index.html` | 17 / 4 |
| D | `web/src/assets/custom/icon-dir.tsx` | 0 / 110 |
| D | `web/src/assets/custom/icon-layout-compact.tsx` | 0 / 131 |
| D | `web/src/assets/custom/icon-layout-default.tsx` | 0 / 124 |
| D | `web/src/assets/custom/icon-layout-full.tsx` | 0 / 100 |
| D | `web/src/assets/custom/icon-sidebar-floating.tsx` | 0 / 82 |
| D | `web/src/assets/custom/icon-sidebar-inset.tsx` | 0 / 58 |
| D | `web/src/assets/custom/icon-sidebar-sidebar.tsx` | 0 / 53 |
| D | `web/src/assets/custom/icon-theme-dark.tsx` | 0 / 79 |
| D | `web/src/assets/custom/icon-theme-light.tsx` | 0 / 78 |
| D | `web/src/assets/custom/icon-theme-system.tsx` | 0 / 116 |
| M | `web/src/assets/logo.tsx` | 22 / 6 |
| A | `web/src/components/account-menu-items.tsx` | 55 / 0 |
| M | `web/src/components/choice-tiles.tsx` | 1 / 1 |
| M | `web/src/components/command-menu.tsx` | 39 / 31 |
| D | `web/src/components/config-drawer.tsx` | 0 / 362 |
| A | `web/src/components/form-field.tsx` | 15 / 0 |
| A | `web/src/components/language-select.tsx` | 41 / 0 |
| M | `web/src/components/layout/app-header.tsx` | 5 / 3 |
| M | `web/src/components/layout/app-sidebar.tsx` | 8 / 14 |
| M | `web/src/components/layout/app-title.tsx` | 13 / 36 |
| M | `web/src/components/layout/authenticated-layout.tsx` | 2 / 16 |
| M | `web/src/components/layout/data/sidebar-data.ts` | 7 / 13 |
| D | `web/src/components/layout/nav-user.tsx` | 0 / 121 |
| M | `web/src/components/layout/star-hint.tsx` | 2 / 2 |
| M | `web/src/components/layout/types.ts` | 0 / 14 |
| M | `web/src/components/page-header.tsx` | 7 / 3 |
| M | `web/src/components/profile-dropdown.tsx` | 13 / 17 |
| A | `web/src/components/search-select.tsx` | 167 / 0 |
| M | `web/src/components/sign-out-dialog.tsx` | 6 / 4 |
| M | `web/src/components/theme-switch.tsx` | 6 / 4 |
| M | `web/src/config/nav.ts` | 9 / 3 |
| M | `web/src/config/repo.ts` | 2 / 2 |
| A | `web/src/context/branding-provider.tsx` | 47 / 0 |
| A | `web/src/context/locale-provider.tsx` | 44 / 0 |
| M | `web/src/features/anthropic/index.tsx` | 8 / 12 |
| A | `web/src/features/api-endpoints/endpoint-card.tsx` | 164 / 0 |
| A | `web/src/features/api-endpoints/endpoint-groups.tsx` | 106 / 0 |
| M | `web/src/features/api-endpoints/index.tsx` | 22 / 120 |
| M | `web/src/features/auth/login-page.tsx` | 35 / 21 |
| M | `web/src/features/billing/index.tsx` | 318 / 156 |
| D | `web/src/features/billing/queries.ts` | 0 / 13 |
| D | `web/src/features/billing/split.ts` | 0 / 48 |
| M | `web/src/features/fleet/fleet-actions.tsx` | 7 / 5 |
| A | `web/src/features/groups/api-resource-picker.tsx` | 83 / 0 |
| A | `web/src/features/groups/index.tsx` | 663 / 0 |
| A | `web/src/features/groups/model-whitelist.tsx` | 138 / 0 |
| A | `web/src/features/groups/queries.ts` | 43 / 0 |
| A | `web/src/features/groups/user-overrides.tsx` | 190 / 0 |
| M | `web/src/features/import/import-proxy-step.tsx` | 45 / 52 |
| M | `web/src/features/import/vm-package-card.tsx` | 1 / 1 |
| A | `web/src/features/keys/codex-catalog.ts` | 77 / 0 |
| A | `web/src/features/keys/connection-config.ts` | 177 / 0 |
| M | `web/src/features/keys/index.tsx` | 582 / 413 |
| D | `web/src/features/keys/key-limits-dialog.tsx` | 0 / 384 |
| D | `web/src/features/keys/key-payload.ts` | 0 / 67 |
| M | `web/src/features/keys/key-stats-dialog.tsx` | 1 / 6 |
| A | `web/src/features/keys/use-key-dialog.tsx` | 300 / 0 |
| D | `web/src/features/keys/vm-pools-card.tsx` | 0 / 216 |
| M | `web/src/features/logs/active-sessions-list.tsx` | 1 / 1 |
| M | `web/src/features/logs/column-visibility.ts` | 2 / 2 |
| M | `web/src/features/logs/export-dialog.tsx` | 22 / 6 |
| D | `web/src/features/logs/filters/filter-combobox.tsx` | 0 / 101 |
| M | `web/src/features/logs/filters/identity-filters.tsx` | 12 / 33 |
| M | `web/src/features/logs/filters/quick-filters-bar.tsx` | 1 / 1 |
| M | `web/src/features/logs/filters/request-filters.tsx` | 10 / 30 |
| M | `web/src/features/logs/index.tsx` | 96 / 20 |
| M | `web/src/features/logs/log-cells.tsx` | 1 / 1 |
| M | `web/src/features/logs/log-detail/latency-breakdown-bar.tsx` | 1 / 1 |
| M | `web/src/features/logs/log-detail/log-detail-dialog.tsx` | 39 / 18 |
| M | `web/src/features/logs/log-detail/logic-trace-tab.tsx` | 3 / 3 |
| M | `web/src/features/logs/log-detail/performance-tab.tsx` | 1 / 1 |
| M | `web/src/features/logs/log-detail/summary-tab.tsx` | 2 / 2 |
| M | `web/src/features/logs/log-display.ts` | 3 / 3 |
| M | `web/src/features/logs/provider-chain-popover.tsx` | 2 / 2 |
| M | `web/src/features/logs/queries.ts` | 4 / 2 |
| M | `web/src/features/logs/search.ts` | 9 / 0 |
| A | `web/src/features/logs/usage-rankings.tsx` | 103 / 0 |
| M | `web/src/features/logs/virtualized-logs-table.tsx` | 3 / 1 |
| M | `web/src/features/models/entry-strip.tsx` | 1 / 1 |
| M | `web/src/features/models/index.tsx` | 3 / 6 |
| A | `web/src/features/ops/index.tsx` | 160 / 0 |
| M | `web/src/features/overview/billing-strip.tsx` | 4 / 16 |
| A | `web/src/features/profile/index.tsx` | 155 / 0 |
| M | `web/src/features/proxies/index.tsx` | 109 / 40 |
| M | `web/src/features/proxies/proxy-edit-dialog.tsx` | 213 / 88 |
| M | `web/src/features/proxies/proxy-import-panel.tsx` | 237 / 70 |
| A | `web/src/features/proxies/proxy-lifetime-fields.tsx` | 127 / 0 |
| A | `web/src/features/proxies/proxy-lifetime.ts` | 18 / 0 |
| M | `web/src/features/proxies/proxy-list.tsx` | 2 / 2 |
| A | `web/src/features/proxies/proxy-quality-dialog.tsx` | 136 / 0 |
| M | `web/src/features/proxies/proxy-results.ts` | 29 / 0 |
| M | `web/src/features/proxies/proxy-row.tsx` | 163 / 84 |
| M | `web/src/features/proxies/proxy-sort.ts` | 4 / 0 |
| M | `web/src/features/proxies/proxy-tone.ts` | 5 / 3 |
| M | `web/src/features/proxies/vm-chip.tsx` | 1 / 1 |
| M | `web/src/features/settings/about-pane.tsx` | 1 / 1 |
| A | `web/src/features/settings/branding-pane.tsx` | 142 / 0 |
| M | `web/src/features/settings/index.tsx` | 7 / 1 |
| M | `web/src/features/settings/navigation.ts` | 2 / 0 |
| M | `web/src/features/settings/settings-nav.tsx` | 9 / 7 |
| M | `web/src/features/settings/socks5-pane.tsx` | 1 / 1 |
| M | `web/src/features/specs/index.tsx` | 3 / 3 |
| M | `web/src/features/statistics/index.tsx` | 24 / 13 |
| M | `web/src/features/statistics/leaderboard-card.tsx` | 15 / 3 |
| M | `web/src/features/statistics/leaderboard-section.tsx` | 15 / 6 |
| M | `web/src/features/statistics/statistics-chart-card.tsx` | 32 / 24 |
| M | `web/src/features/statistics/stats-format.ts` | 1 / 1 |
| A | `web/src/features/subscriptions/index.tsx` | 175 / 0 |
| A | `web/src/features/users/group-grants.tsx` | 145 / 0 |
| M | `web/src/features/users/index.tsx` | 401 / 623 |
| M | `web/src/features/vm/create-options.ts` | 1 / 0 |
| M | `web/src/features/vm/create-vm-form.tsx` | 1 / 1 |
| M | `web/src/features/vm/detail-ops-tab.tsx` | 2 / 2 |
| M | `web/src/features/vm/detail-page.tsx` | 15 / 25 |
| M | `web/src/features/vm/detail-test-tab.tsx` | 10 / 14 |
| M | `web/src/features/vm/list-page.tsx` | 34 / 5 |
| M | `web/src/features/vm/queries.ts` | 5 / 3 |
| M | `web/src/features/vm/seed-settings.ts` | 1 / 0 |
| M | `web/src/features/vm/use-vm-column-order.ts` | 1 / 0 |
| A | `web/src/features/vm/use-vm-index.ts` | 23 / 0 |
| M | `web/src/features/vm/vm-action-menu.tsx` | 5 / 15 |
| M | `web/src/features/vm/vm-actions-context.ts` | 3 / 4 |
| M | `web/src/features/vm/vm-actions-provider.tsx` | 32 / 56 |
| D | `web/src/features/vm/vm-assign-owner-dialog.tsx` | 0 / 126 |
| A | `web/src/features/vm/vm-batch-groups.tsx` | 173 / 0 |
| M | `web/src/features/vm/vm-detail-card.tsx` | 9 / 34 |
| A | `web/src/features/vm/vm-group-actions.ts` | 13 / 0 |
| A | `web/src/features/vm/vm-groups.tsx` | 168 / 0 |
| M | `web/src/features/vm/vm-list-table.tsx` | 68 / 60 |
| D | `web/src/features/vm/vm-owner-admin-card.tsx` | 0 / 120 |
| D | `web/src/features/vm/vm-owner-line.tsx` | 0 / 25 |
| D | `web/src/features/vm/vm-owner.ts` | 0 / 52 |
| M | `web/src/features/vm/vm-package-view.tsx` | 2 / 2 |
| M | `web/src/features/vm/vm-perms.ts` | 5 / 4 |
| M | `web/src/features/vm/vm-rack-blade.tsx` | 2 / 0 |
| M | `web/src/features/vm/vm-test-schedule.tsx` | 2 / 2 |
| M | `web/src/features/welcome/capabilities.tsx` | 1 / 1 |
| M | `web/src/features/welcome/checklist.tsx` | 1 / 0 |
| M | `web/src/features/welcome/client-snippets.tsx` | 7 / 7 |
| M | `web/src/features/welcome/cta.tsx` | 2 / 2 |
| M | `web/src/features/welcome/hero.tsx` | 1 / 1 |
| M | `web/src/features/welcome/module-guide.tsx` | 43 / 10 |
| M | `web/src/features/welcome/steps.ts` | 10 / 1 |
| M | `web/src/features/welcome/top-bar.tsx` | 6 / 2 |
| M | `web/src/features/wrap/index.tsx` | 12 / 23 |
| D | `web/src/hooks/use-vm-index.ts` | 0 / 30 |
| A | `web/src/i18n/messages.ts` | 179 / 0 |
| M | `web/src/lib/login-terminal.ts` | 5 / 2 |
| M | `web/src/lib/usage-format.ts` | 1 / 1 |
| M | `web/src/main.tsx` | 24 / 7 |
| M | `web/src/routeTree.gen.ts` | 85 / 0 |
| A | `web/src/routes/_authenticated/groups.tsx` | 6 / 0 |
| M | `web/src/routes/_authenticated/index.tsx` | 3 / 0 |
| A | `web/src/routes/_authenticated/ops.tsx` | 6 / 0 |
| A | `web/src/routes/_authenticated/profile.tsx` | 6 / 0 |
| M | `web/src/routes/_authenticated/route.tsx` | 26 / 1 |
| A | `web/src/routes/_authenticated/subscriptions.tsx` | 6 / 0 |
| M | `web/src/types/panel-api-endpoints.ts` | 2 / 0 |
| M | `web/src/types/panel-auth.ts` | 2 / 1 |
| D | `web/src/types/panel-billing.ts` | 0 / 21 |
| M | `web/src/types/panel-keys.ts` | 9 / 12 |
| M | `web/src/types/panel-models.ts` | 1 / 0 |
| M | `web/src/types/panel-statistics.ts` | 5 / 3 |
| M | `web/src/types/panel-usage-logs.ts` | 7 / 3 |
| M | `web/src/types/panel-users.ts` | 9 / 1 |
| M | `web/src/types/panel-vm.ts` | 10 / 4 |
| A | `web/src/types/proxy-quality.ts` | 21 / 0 |
| M | `worker/internal/config/config.go` | 2 / 2 |
| A | `worker/internal/proxy/dialer.go` | 177 / 0 |
| M | `worker/internal/proxy/socks5.go` | 0 / 91 |

### 部署、构建与交付工具

| 状态 | 文件 | + / − |
| --- | --- | ---: |
| M | `"docs/\346\212\200\346\234\257\350\267\257\347\272\277.md"` | 1 / 5 |
| M | `.env.example` | 7 / 7 |
| M | `.github/ISSUE_TEMPLATE/bug_report.yml` | 5 / 5 |
| M | `.github/ISSUE_TEMPLATE/config.yml` | 1 / 1 |
| M | `.github/workflows/guest-images.yml` | 26 / 1 |
| M | `.github/workflows/release.yml` | 133 / 155 |
| M | `.github/workflows/test.yml` | 119 / 28 |
| A | `.github/workflows/upstream-sync.yml` | 111 / 0 |
| M | `.gitignore` | 3 / 1 |
| M | `Dockerfile` | 21 / 21 |
| M | `deploy/Dockerfile.arm64-control` | 26 / 26 |
| M | `deploy/init-arm64-env.py` | 11 / 11 |
| M | `deploy/install.sh` | 54 / 56 |
| M | `deploy/prepare-arm64.py` | 2 / 2 |
| M | `deploy/qemu-x86_64.conf` | 1 / 1 |
| M | `docker-compose.arm64.yml` | 11 / 11 |
| M | `docker-compose.build.yml` | 2 / 2 |
| M | `docker-compose.yml` | 21 / 21 |
| M | `docker/kin-kvm/build.mjs` | 2 / 2 |
| M | `docker/kin-os/build.mjs` | 2 / 2 |
| M | `package-lock.json` | 2 / 2 |
| M | `package.json` | 1 / 1 |
| M | `scripts/claude-auth-login-pty.py` | 1 / 1 |
| M | `scripts/docker-entrypoint.sh` | 27 / 47 |
| M | `scripts/fetch-payload.mjs` | 7 / 6 |
| M | `scripts/fleet-services.mjs` | 1 / 1 |
| M | `scripts/migrate-legacy-cluster-slots.mjs` | 1 / 1 |
| M | `scripts/panel-upgrade.sh` | 22 / 12 |
| A | `scripts/release/guest_publish_guard.py` | 49 / 0 |
| A | `scripts/release/plan.py` | 102 / 0 |
| A | `scripts/release/publish.py` | 69 / 0 |
| A | `scripts/release/smoke_image.py` | 57 / 0 |
| A | `scripts/start-server.mjs` | 3 / 0 |
| M | `scripts/sync-wrap-cli.mjs` | 6 / 6 |
| A | `scripts/upstream-sync/contracts.json` | 128 / 0 |
| A | `scripts/upstream-sync/preview.py` | 321 / 0 |
| M | `web/package.json` | 1 / 1 |
| M | `web/vite.config.ts` | 1 / 1 |

### 测试

| 状态 | 文件 | + / − |
| --- | --- | ---: |
| M | `test/deploy/smoke_arm64_image.py` | 5 / 5 |
| A | `test/deploy/test_branding.py` | 22 / 0 |
| M | `test/deploy/test_install_schedule.py` | 1 / 1 |
| A | `test/deploy/test_install_versions.py` | 50 / 0 |
| M | `test/e2e/auto-mode.e2e.test.mjs` | 1 / 1 |
| M | `test/e2e/backup.e2e.test.mjs` | 2 / 1 |
| A | `test/e2e/codex-key-catalog.e2e.test.mjs` | 156 / 0 |
| M | `test/e2e/messages.e2e.test.mjs` | 15 / 12 |
| A | `test/e2e/panel-profile.e2e.test.mjs` | 44 / 0 |
| M | `test/e2e/panel-users.e2e.test.mjs` | 24 / 31 |
| A | `test/e2e/relay-operations.e2e.test.mjs` | 448 / 0 |
| A | `test/e2e/relay-refinements.e2e.test.mjs` | 90 / 0 |
| M | `test/harness.mjs` | 1 / 0 |
| A | `test/release/test_guest_publish_guard.py` | 69 / 0 |
| A | `test/release/test_plan.py` | 145 / 0 |
| A | `test/release/test_publish.py` | 120 / 0 |
| M | `test/unit/api-backend.test.mjs` | 19 / 16 |
| M | `test/unit/api-keys.test.mjs` | 8 / 20 |
| M | `test/unit/api-scheduler.test.mjs` | 24 / 0 |
| M | `test/unit/catalog-sync.test.mjs` | 141 / 2 |
| M | `test/unit/cli-hop-body.test.mjs` | 88 / 72 |
| M | `test/unit/cluster-direct-link.test.mjs` | 8 / 8 |
| M | `test/unit/cluster-native-node.test.mjs` | 20 / 20 |
| M | `test/unit/cluster-node-edit-repo.test.mjs` | 4 / 4 |
| M | `test/unit/cluster-node-edit.test.mjs` | 3 / 3 |
| M | `test/unit/cluster-placement.test.mjs` | 4 / 4 |
| M | `test/unit/codex-models.test.mjs` | 29 / 0 |
| M | `test/unit/config-public-url.test.mjs` | 2 / 2 |
| M | `test/unit/convert-cache-shape.test.mjs` | 3 / 5 |
| M | `test/unit/crs-clean.test.mjs` | 3 / 3 |
| M | `test/unit/crs-persona.test.mjs` | 1 / 0 |
| M | `test/unit/database.test.mjs` | 88 / 0 |
| M | `test/unit/distill-detect.test.mjs` | 1 / 1 |
| M | `test/unit/eager-tool-streaming.test.mjs` | 7 / 7 |
| M | `test/unit/egress.test.mjs` | 1 / 1 |
| M | `test/unit/execution-context.test.mjs` | 1 / 1 |
| A | `test/unit/fetch-payload.test.mjs` | 55 / 0 |
| M | `test/unit/haiku-55-policy.test.mjs` | 12 / 12 |
| M | `test/unit/handle-codex-search.test.mjs` | 3 / 3 |
| M | `test/unit/host-path.test.mjs` | 25 / 21 |
| M | `test/unit/kernel-watchdog-node-slot.test.mjs` | 7 / 7 |
| M | `test/unit/key-scope.test.mjs` | 17 / 71 |
| M | `test/unit/kvm-host.test.mjs` | 2 / 2 |
| M | `test/unit/max-tokens-default.test.mjs` | 1 / 1 |
| M | `test/unit/models.test.mjs` | 1 / 1 |
| M | `test/unit/oauth-credentials.test.mjs` | 1 / 1 |
| M | `test/unit/onboarding.test.mjs` | 10 / 13 |
| M | `test/unit/opus-55-policy.test.mjs` | 2 / 2 |
| M | `test/unit/panel-acl.test.mjs` | 21 / 122 |
| M | `test/unit/panel-api-proxy.test.mjs` | 1 / 5 |
| A | `test/unit/panel-profile.test.mjs` | 43 / 0 |
| M | `test/unit/panel-public-boot.test.mjs` | 4 / 4 |
| M | `test/unit/panel-route-coverage.test.mjs` | 0 / 4 |
| M | `test/unit/panel-tenant-guards.test.mjs` | 13 / 218 |
| M | `test/unit/panel-upgrade-script.test.mjs` | 7 / 7 |
| M | `test/unit/panel-users.test.mjs` | 6 / 11 |
| M | `test/unit/panel-vm-create.test.mjs` | 25 / 2 |
| M | `test/unit/panel-vm-seed-settings.test.mjs` | 44 / 0 |
| M | `test/unit/panel-wrap-sync.test.mjs` | 9 / 9 |
| M | `test/unit/pool-scheduler.test.mjs` | 39 / 36 |
| M | `test/unit/pricing.test.mjs` | 3 / 3 |
| M | `test/unit/proxy-agent.test.mjs` | 2 / 2 |
| M | `test/unit/proxy-geo-dns.test.mjs` | 4 / 4 |
| M | `test/unit/proxy-geo.test.mjs` | 23 / 20 |
| M | `test/unit/proxy-ipv6.test.mjs` | 12 / 12 |
| M | `test/unit/proxy-pool-parse.test.mjs` | 10 / 10 |
| M | `test/unit/proxy-pool-update.test.mjs` | 3 / 2 |
| A | `test/unit/proxy-protocols.test.mjs` | 140 / 0 |
| A | `test/unit/proxy-quality.test.mjs` | 99 / 0 |
| M | `test/unit/proxy-resolve.test.mjs` | 1 / 1 |
| A | `test/unit/relay-feedback.test.mjs` | 63 / 0 |
| A | `test/unit/relay-operations.test.mjs` | 266 / 0 |
| A | `test/unit/relay-refinements.test.mjs` | 135 / 0 |
| A | `test/unit/relay-rpm.test.mjs` | 117 / 0 |
| M | `test/unit/release-kernel.test.mjs` | 126 / 123 |
| M | `test/unit/release.test.mjs` | 84 / 19 |
| M | `test/unit/remote-egress.test.mjs` | 1 / 1 |
| M | `test/unit/remote-slot-gpt.test.mjs` | 2 / 2 |
| M | `test/unit/remote-slot-migration.test.mjs` | 1 / 1 |
| M | `test/unit/request-log.test.mjs` | 7 / 7 |
| M | `test/unit/resource-owner.test.mjs` | 15 / 54 |
| M | `test/unit/responses-ws.test.mjs` | 53 / 11 |
| A | `test/unit/site-branding.test.mjs` | 22 / 0 |
| M | `test/unit/slot-model-gate.test.mjs` | 4 / 4 |
| M | `test/unit/slot-oauth.test.mjs` | 3 / 0 |
| M | `test/unit/slot-recovery.test.mjs` | 9 / 2 |
| M | `test/unit/statistics-repo.test.mjs` | 5 / 3 |
| M | `test/unit/sync-wrap-cli.test.mjs` | 2 / 2 |
| M | `test/unit/telemetry-status.test.mjs` | 1 / 1 |
| M | `test/unit/usage-logs-repo.test.mjs` | 28 / 0 |
| M | `test/unit/usage-logs-view.test.mjs` | 5 / 3 |
| M | `test/unit/user-count-tokens.test.mjs` | 19 / 3 |
| M | `test/unit/vm-db-sync.test.mjs` | 9 / 57 |
| M | `test/unit/vm-package.test.mjs` | 12 / 21 |
| D | `test/unit/vm-pools.test.mjs` | 0 / 65 |
| M | `test/unit/vm-test-chat-codex.test.mjs` | 10 / 10 |
| M | `test/unit/web-dist.test.mjs` | 4 / 4 |
| A | `test/upstream_sync/test_preview.py` | 378 / 0 |
| D | `web/src/features/billing/split.test.ts` | 0 / 41 |
| A | `web/src/features/keys/codex-catalog.test.ts` | 116 / 0 |
| A | `web/src/features/keys/connection-config.test.ts` | 166 / 0 |
| D | `web/src/features/keys/key-payload.test.ts` | 0 / 101 |
| M | `web/src/features/proxies/proxy-results.test.ts` | 16 / 0 |
| M | `web/src/features/settings/about-pane.test.ts` | 1 / 1 |
| M | `web/src/features/vm/seed-settings.test.ts` | 13 / 5 |
| D | `web/src/features/vm/vm-owner.test.ts` | 0 / 115 |
| M | `web/src/features/vm/vm-perms.test.ts` | 14 / 18 |
| A | `web/src/i18n/messages.test.ts` | 20 / 0 |
| M | `web/src/lib/login-terminal.test.ts` | 4 / 0 |
| M | `web/src/lib/persona-template.test.ts` | 8 / 2 |
| A | `worker/internal/proxy/http_connect_test.go` | 92 / 0 |
| M | `worker/internal/proxy/socks5_test.go` | 1 / 1 |

### 原生目录数据与许可

| 状态 | 文件 | + / − |
| --- | --- | ---: |
| A | `src/lib/protocol/codex-assets/LICENSE` | 201 / 0 |
| A | `src/lib/protocol/codex-assets/NOTICE` | 6 / 0 |
| A | `src/lib/protocol/codex-assets/PROVENANCE.txt` | 39 / 0 |
| A | `src/lib/protocol/codex-assets/instructions.txt` | 275 / 0 |
| A | `src/lib/protocol/codex-assets/models.json` | 1097 / 0 |

### 文档与图示

| 状态 | 文件 | + / − |
| --- | --- | ---: |
| A | `AGENTS.md` | 35 / 0 |
| M | `CHANGELOG.md` | 5 / 2 |
| M | `ISSUE_GUIDE.md` | 18 / 18 |
| M | `PRODUCT.md` | 1 / 1 |
| M | `README.md` | 35 / 34 |
| M | `docs/API.md` | 1 / 1 |
| M | `docs/ARM64.md` | 19 / 20 |
| A | `docs/BRANDING_AND_RELEASE.md` | 68 / 0 |
| M | `docs/BUILD.md` | 21 / 23 |
| A | `docs/CHANGE_DELIVERY.md` | 158 / 0 |
| A | `docs/CODEX_KEY_CONNECTION.md` | 107 / 0 |
| A | `docs/CONSOLE_IDENTITY_DELIVERY.md` | 43 / 0 |
| A | `docs/CUSTOMIZATION_FILE_INDEX.md` | 527 / 0 |
| A | `docs/CUSTOMIZATION_RELEASE_NOTES.md` | 132 / 0 |
| M | `docs/DEPLOY.md` | 42 / 34 |
| M | `docs/MACOS_NODE.md` | 9 / 9 |
| M | `docs/PANEL_API.md` | 107 / 44 |
| M | `docs/README.md` | 10 / 3 |
| A | `docs/RELAY_OPERATIONS.md` | 424 / 0 |
| A | `docs/RELAY_OPERATIONS_DELIVERY.md` | 136 / 0 |
| A | `docs/RELAY_OPERATIONS_FEEDBACK.md` | 126 / 0 |
| A | `docs/RELAY_OPERATIONS_REFINEMENTS.md` | 101 / 0 |
| A | `docs/SEARCH_INTERACTION_PLAN.md` | 108 / 0 |
| A | `docs/UPSTREAM_SYNC.md` | 70 / 0 |
| A | `docs/UPSTREAM_SYNC_2026-10-21.md` | 81 / 0 |
| M | `docs/deploy/env.example` | 13 / 13 |
| A | `docs/deploy/tapmodels.service` | 16 / 0 |
| D | `docs/deploy/vm2api.service` | 0 / 16 |
| D | `docs/images/brand-hero.png` | binary |
| M | `docs/images/issue-flow.svg` | 5 / 5 |
| A | `docs/images/tapmodels-hero.svg` | 9 / 0 |
| D | `docs/images/vm2api-01-console-api.png` | binary |
| D | `docs/images/vm2api-02-route.png` | binary |
| D | `docs/images/vm2api-03-vm-subagent.png` | binary |
| D | `docs/images/vm2api-04-telemetry.png` | binary |
| D | `docs/images/vm2api-security-distill.jpg` | binary |
| D | `docs/images/vm2api-vm-hardware-network.jpg` | binary |
| M | `docs/nginx-shell.md` | 1 / 1 |
| M | `web/README.md` | 2 / 2 |
