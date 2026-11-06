-- 125_gateway_instance_keys — 按实例签发的 Gateway 内部 HMAC 密钥（中期技术债 M2：执行器信任边界）。
-- Worker 首次注册用共用内部令牌认证并出示引导授权（托管器的一次性引导令牌或管理员授权窗口），控制面签发随机 32 字节密钥，加密包裹后经注册响应下发；
-- 之后该实例与控制面之间的请求都用它签名。密钥只以 AES-256-GCM 密文保存（sealed_secret，附加认证数据绑定实例与 key_id），
-- 包裹密钥由数据库字段密钥（TAPMODELS_DB_SECRET）派生，没有时用 runtime-secrets.json 里单独生成的随机值，不明文落库。
--   state：active（当前密钥）、retiring（轮换后的旧密钥，expires_at 之前仍有效）、revoked（吊销，立即失效）
--   confirmed_at：控制面第一次验证到 Worker 用这把密钥签名的时刻；控制面发往 Worker 的请求只用已确认的密钥签名
CREATE TABLE IF NOT EXISTS gateway_worker_instance_keys (
  key_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  sealed_secret TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'revoked')),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_by TEXT,
  -- 轮换时记下接替它的新密钥：宽限期已过、新密钥还没被 Worker 用过时，旧密钥可以在续接窗口内换取新密钥（复审 P2-7）
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_instance_keys_instance
  ON gateway_worker_instance_keys(instance_id, state, created_at);
-- 外部 Worker 的引导授权（审查 P0-1/P0-2）：管理员在面板上“允许引导”后，该实例在 expires_at 之前可以用共用令牌
-- 引导一次；签发时在同一事务里写 consumed_at（一次性）。吊销实例密钥时未使用的授权一并作废。
-- 控制面托管的同机 Worker 不用这张表：托管器每次拉起子进程时生成一次性引导令牌，只在控制面内存里保存摘要。
CREATE TABLE IF NOT EXISTS gateway_worker_bootstrap_grants (
  instance_id TEXT PRIMARY KEY,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_key_id TEXT
);
-- 待批准的实例（复审 P1-1）：on 模式下表里还没有的新实例 ID 用共用令牌登记时记为 'pending'；管理员批准（允许引导）或
-- 该实例完成引导、用确认过的实例密钥签名后清除（NULL）。待批准期间不投影、不派发、不采信其冻结、凭据、额度、事件与租约。
-- 用单独的列而不是 admission_state：后者有 CHECK 约束（迁移 079），扩充取值需要重建被多表外键引用的实例表。
ALTER TABLE gateway_worker_instances ADD COLUMN approval_state TEXT;
