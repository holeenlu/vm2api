-- 106_executor_credentials — 凭据库（统一控制面重构 P3.4，设计第 6 节）。
-- 每个账号、每类授权（native / bps）一条记录：载荷（令牌 JSON）由随机数据密钥 AES-256-GCM 加密，
-- 数据密钥由主密钥包裹（主密钥在数据库之外的文件里，见 src/lib/executor/vault.mjs）。明文不落库。
-- revision 是凭据代次（原生授权与 Worker 的 CredentialRevision 一致；BPS 授权为控制面计数），写入按代次 CAS。
CREATE TABLE IF NOT EXISTS executor_credentials (
  account_resource_id TEXT NOT NULL,
  grant_kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  master_key_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  token_fingerprint TEXT,
  expires_at TEXT,
  source TEXT NOT NULL,
  source_instance_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_resource_id, grant_kind)
);
