#!/usr/bin/env bash
# 检查 strace -f -e trace=connect 的输出里没有连向环回以外地址的 connect 调用（不覆盖不经 connect 的 UDP sendto、io_uring）（真实 Worker e2e 封闭环境，最终审计 U10a）。
# 用法：no-external-egress.sh <strace 输出文件>；有外联时列出并以 1 退出。
set -euo pipefail
trace=$1
[ -s "$trace" ] || { echo "no strace output in $trace"; exit 1; }
external=$(grep -E 'connect\(.*sa_family=AF_INET6?' "$trace" |
  grep -vE 'inet_addr\("(127\.[0-9.]+|0\.0\.0\.0)"\)' |
  grep -vE 'inet_pton\(AF_INET6, "(::1|::|::ffff:127\.[0-9.]+)"' || true)
if [ -n "$external" ]; then
  echo "external connections attempted during the e2e run:"
  echo "$external" | grep -oE 'inet_addr\("[^"]+"\)|inet_pton\(AF_INET6, "[^"]+"' | sort | uniq -c
  exit 1
fi
echo "no external connections"
