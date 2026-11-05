-- 109_executor_settings — 执行服务本地设置与配置版本（统一控制面重构 P4.2–P4.3，设计第 10 节）。
-- executor_settings：每个作用域（目前只有 codex）一条，保存本地设置（上游 routing.json 之外的键，见 codex-settings.mjs）。
-- config_revisions：全局单调递增的配置版本，每次修改一条，记录作用域、改动的键与操作者；心跳与请求日志引用这里的版本。
CREATE TABLE IF NOT EXISTS executor_settings (
  scope TEXT PRIMARY KEY,
  values_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_revisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  keys_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
