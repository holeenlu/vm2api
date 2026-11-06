#!/bin/sh
# 生成 Gateway Worker mTLS 测试证书链（中期技术债 M2：证书主体与实例 ID 绑定）。
#
#   sh scripts/gateway-mtls-certs.sh <输出目录> [--control-plane-name 名称] [--days 天数] <实例 ID>...
#
# 输出（目录 0700，私钥 0600）：
#   ca.crt / ca.key                    测试 CA（只用于测试与演练；生产请用自己的 CA 并妥善保管 ca.key）
#   control-plane.crt / .key           控制面证书：CN 与 DNS 为 --control-plane-name（默认 control-plane），另带
#                                      DNS:localhost、IP:127.0.0.1 与 URI:urn:kin:control-plane；serverAuth + clientAuth
#                                      （同一张证书用于内部 mTLS 监听与控制面 → Worker 的客户端证书）
#   worker-<实例 ID>.crt / .key        Worker 证书：CN=<实例 ID>，SAN URI:urn:kin:gateway:<实例 ID> 与 DNS:<实例 ID>；
#                                      serverAuth + clientAuth（Worker 内部接口的服务端证书与回连控制面的客户端证书）
#
# 对应配置见 docs/CODEX_GATEWAY_WORKER_SETUP.md 第 7 节。需要 openssl（OpenSSL 或 LibreSSL）。
set -eu

die() {
  echo "gateway-mtls-certs: $1" >&2
  exit 1
}

[ $# -ge 1 ] || die "用法：sh scripts/gateway-mtls-certs.sh <输出目录> [--control-plane-name 名称] [--days 天数] <实例 ID>..."
OUT=$1
shift
CP_NAME=control-plane
DAYS=30
INSTANCES=""
while [ $# -gt 0 ]; do
  case $1 in
    --control-plane-name)
      [ $# -ge 2 ] || die "--control-plane-name 需要一个值"
      CP_NAME=$2
      shift 2
      ;;
    --days)
      [ $# -ge 2 ] || die "--days 需要一个值"
      DAYS=$2
      shift 2
      ;;
    -*) die "未知参数 $1" ;;
    *)
      INSTANCES="$INSTANCES $1"
      shift
      ;;
  esac
done
[ -n "$INSTANCES" ] || die "至少给出一个实例 ID"
case $DAYS in '' | *[!0-9]*) die "--days 必须是正整数" ;; esac
command -v openssl >/dev/null 2>&1 || die "找不到 openssl"

umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

check_name() {
  case $1 in '' | *[!A-Za-z0-9._-]*) die "名称只能包含字母、数字、点、下划线与连字符：$1" ;; esac
}
check_name "$CP_NAME"
for id in $INSTANCES; do check_name "$id"; done

newkey() {
  openssl ecparam -name prime256v1 -genkey -noout -out "$1" 2>/dev/null
  chmod 600 "$1"
}

# CA
newkey "$OUT/ca.key"
cat >"$WORK/ca.ext" <<EOF
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
openssl req -new -key "$OUT/ca.key" -subj "/CN=kin gateway test CA" -out "$WORK/ca.csr" 2>/dev/null
openssl x509 -req -in "$WORK/ca.csr" -signkey "$OUT/ca.key" -days "$DAYS" -sha256 -extfile "$WORK/ca.ext" \
  -out "$OUT/ca.crt" 2>/dev/null

# leaf <文件名前缀> <CN> <subjectAltName>
leaf() {
  newkey "$OUT/$1.key"
  cat >"$WORK/$1.ext" <<EOF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = $3
EOF
  openssl req -new -key "$OUT/$1.key" -subj "/CN=$2" -out "$WORK/$1.csr" 2>/dev/null
  openssl x509 -req -in "$WORK/$1.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
    -CAserial "$WORK/ca.srl" -days "$DAYS" -sha256 -extfile "$WORK/$1.ext" -out "$OUT/$1.crt" 2>/dev/null
}

leaf control-plane "$CP_NAME" "DNS:$CP_NAME, DNS:localhost, IP:127.0.0.1, URI:urn:kin:control-plane"
for id in $INSTANCES; do
  leaf "worker-$id" "$id" "URI:urn:kin:gateway:$id, DNS:$id"
done
chmod 644 "$OUT"/*.crt

echo "gateway-mtls-certs: wrote $OUT (CA, control-plane, worker:$INSTANCES)"
