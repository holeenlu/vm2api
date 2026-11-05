-- 105_refresh_lease_fingerprint — 刷新租约记录刷新令牌指纹（统一控制面重构 P3.2，设计第 6 节）。
-- 指纹是刷新令牌 SHA-256 的前 8 字节（十六进制），不可逆。最近一次轮换（outcome='rotated'）后记录新令牌的指纹；
-- 其他实例申请租约时若手里令牌的指纹不同，说明它持有的令牌已被轮换（BPS 授权轮换不改代次，只能这样判断），
-- 控制面拒绝并把新凭据从轮换者投影过去。
ALTER TABLE credential_refresh_leases ADD COLUMN token_fingerprint TEXT;
