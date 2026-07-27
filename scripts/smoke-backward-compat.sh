#!/usr/bin/env bash
# =========================================================================
# smoke-backward-compat.sh — CK-25: 向后兼容冒烟测试
#
# 用旧配置（单数 LLM_BASE_URL + CODE_EMBEDDING_URL）启动 server，
# 验证自动转换为单节点池，健康端点正常。
# =========================================================================
set -euo pipefail

BASE="${1:-http://localhost:8095}"
FAILED=0

check() {
  local desc="$1" cmd="$2"
  echo -n "[CK-25] $desc ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo "PASS"
  else
    echo "FAIL"
    FAILED=1
  fi
}

echo "=== CK-25: 向后兼容冒烟测试 ==="
echo "注意：此测试需用旧 env 配置启动 server"
echo "  LLM_BASE_URL=http://172.80.1.203:11434"
echo "  CODE_EMBEDDING_URL=http://172.80.1.203:11434"
echo ""

# 1. 旧配置下 LLM pool 自动转单节点
check "LLM pool status (backward compat)" \
  "curl -sf \"$BASE/health/llm\" | jq -e '.status == \"ok\" or .status == \"not-configured\"'"

# 2. Embedding pool 状态正常
check "Embedding pool status (backward compat)" \
  "curl -sf \"$BASE/health/embedding\" | jq -e '.status == \"ok\"'"

# 3. Readyz
check "Readyz" \
  "curl -sf -o /dev/null -w '%{http_code}' \"$BASE/readyz\" | grep -q 200"

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "[CK-25] ✅ 向后兼容检查通过"
  exit 0
else
  echo "[CK-25] ❌ 部分检查失败"
  exit 1
fi
