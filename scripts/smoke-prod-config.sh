#!/usr/bin/env bash
# =========================================================================
# smoke-prod-config.sh — CK-26: 生产配置冒烟测试
#
# 用 production.env.example 配置启动 server，
# 验证 4 台 ollama 全部注册，健康端点正常。
# =========================================================================
set -euo pipefail

BASE="${1:-http://localhost:8095}"
FAILED=0

check() {
  local desc="$1" cmd="$2"
  echo -n "[CK-26] $desc ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo "PASS"
  else
    echo "FAIL"
    FAILED=1
  fi
}

echo "=== CK-26: 生产配置冒烟测试 ==="
echo "注意：此测试需用 production.env.example 配置启动 server"
echo "  CODE_EMBEDDING_URLS=http://172.80.1.203:11434,...,172.80.1.206:11434"
echo ""

# 1. 4 节点 embedding pool
check "Embedding pool has 4 endpoints" \
  "curl -sf \"$BASE/health/embedding\" | jq -e '.stats.endpoints | length == 4'"

# 2. LLM pool 状态正常
check "LLM pool status" \
  "curl -sf \"$BASE/health/llm\" | jq -e '.status == \"ok\"'"

# 3. Readyz
check "Readyz" \
  "curl -sf -o /dev/null -w '%{http_code}' \"$BASE/readyz\" | grep -q 200"

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "[CK-26] ✅ 生产配置检查通过"
  exit 0
else
  echo "[CK-26] ❌ 部分检查失败"
  exit 1
fi
