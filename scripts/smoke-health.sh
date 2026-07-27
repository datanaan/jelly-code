#!/usr/bin/env bash
# =========================================================================
# smoke-health.sh — v1.4.0 Resilience Layer 健康端点冒烟测试（CK-21）
#
# 验证 5 个健康端点返回预期值。所有检查通过后退出码为 0。
# 用法: bash scripts/smoke-health.sh [base_url]
#       默认 base_url=http://localhost:8095
# =========================================================================
set -euo pipefail

BASE="${1:-http://localhost:8095}"
FAILED=0

check() {
  local desc="$1" cmd="$2"
  echo -n "[CK-21] $desc ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo "PASS"
  else
    echo "FAIL"
    FAILED=1
  fi
}

echo "=== CK-21: 健康端点冒烟测试 (base=$BASE) ==="

# 1. LLM pool
check "LLM pool status" \
  "curl -sf \"$BASE/health/llm\" | jq -e '.status == \"ok\" or .status == \"not-configured\"'"

# 2. Embedding pool
check "Embedding pool status" \
  "curl -sf \"$BASE/health/embedding\" | jq -e '.status == \"ok\"'"

# 3. Queues
check "Queue counts" \
  "curl -sf \"$BASE/health/queues\" | jq -e '.derivation | has(\"waiting\")'"

# 4. Readyz
check "Readyz probe" \
  "curl -sf -o /dev/null -w '%{http_code}' \"$BASE/readyz\" | grep -q 200"

# 5. Metrics
check "Metrics contain jelly_llm_pool" \
  "curl -sf \"$BASE/metrics\" | grep -q 'jelly_llm_pool_requests_total'"

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "[CK-21] ✅ 全部 5 个健康端点检查通过"
  exit 0
else
  echo "[CK-21] ❌ 部分检查失败"
  exit 1
fi
