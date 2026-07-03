#!/usr/bin/env bash
# ============================================
# verify-schema.sh — 部署前 Neo4j 约束预检
# v0.1.1
#
# 在部署 jelly_code 之前运行，确保 Neo4j
# 约束状态与代码期望一致，避免旧约束残留
# 导致分析失败。
#
# 用法:
#   bash scripts/verify-schema.sh [neo4j-uri]
#   默认 neo4j-uri: bolt://localhost:7687
#
# 退出码:
#   0 = 约束检查通过，可以部署
#   1 = 存在旧约束，需要清理
#   2 = 连接 Neo4j 失败
# ============================================

set -euo pipefail
NEO4J_URI="${1:-bolt://localhost:7687}"
PASS="${NEO4J_PASSWORD:-}"

echo "=== jelly_code v0.1.1 Schema 预检 ==="
echo "Neo4j: $NEO4J_URI"
echo ""

CYPHER=$(command -v cypher-shell || true)
if [ -z "$CYPHER" ]; then
  echo "[ERROR] cypher-shell 未安装。请安装 Neo4j 客户端。"
  exit 2
fi

AUTH_ARGS=""
if [ -n "$PASS" ]; then
  AUTH_ARGS="-a neo4j:$PASS"
fi

echo "1. 连接 Neo4j ..."
SHOW_OUTPUT=$("$CYPHER" -a "$NEO4J_URI" $AUTH_ARGS "SHOW CONSTRAINTS" 2>&1 || true)

if echo "$SHOW_OUTPUT" | grep -qi "ConnectionError\|timeout\|refused\|Could not connect"; then
  echo "[ERROR] 无法连接 Neo4j"
  exit 2
fi
echo "   连接成功"
echo ""

echo "2. 检查旧约束 (id UNIQUE) ..."
OLD_CONSTRAINTS=$(echo "$SHOW_OUTPUT" | grep -i "UNIQUE" | grep -iv "projectId" || true)
OLD_COUNT=$(echo "$OLD_CONSTRAINTS" | grep -c . || echo 0)

if [ "$OLD_COUNT" -gt 0 ]; then
  echo "[WARN] 发现 $OLD_COUNT 个旧约束 (id UNIQUE 无 projectId):"
  echo "$OLD_CONSTRAINTS"
  echo ""
  echo "需要启动服务跑 initializeSchema() 迁移，或手动清理:"
  echo "  CALL db.constraints() YIELD name"
  echo "  WHERE name CONTAINS 'id IS UNIQUE' AND name NOT CONTAINS 'projectId'"
  echo "  CALL db.drop.constraint(name)"
  echo "  RETURN name;"
  exit 1
fi
echo "   无旧约束残留"
echo ""

echo "3. 检查复合约束 (id, projectId) ..."
COMPOSITE_COUNT=$(echo "$SHOW_OUTPUT" | grep -ic "projectId" || echo 0)
echo "   就绪: $COMPOSITE_COUNT 个复合约束"
echo ""

echo "=== 预检通过，可以部署 ==="
exit 0
