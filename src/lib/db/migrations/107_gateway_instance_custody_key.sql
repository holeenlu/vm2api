-- 107_gateway_instance_custody_key — Worker 实例托管公钥（统一控制面重构 P3.5，设计第 6 节）。
-- Worker 在数据目录生成 X25519 密钥对，公钥随注册与心跳提交；控制面以凭据库托管令牌（KIN_CREDENTIAL_CUSTODY=control）时，
-- 按该公钥为实例封装凭据（custody_bundle），只有该实例能解开。数据目录重建后公钥改变，下一次心跳即更新。
ALTER TABLE gateway_worker_instances ADD COLUMN custody_public_key TEXT;
