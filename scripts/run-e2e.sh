#!/bin/bash
# E2E Test Runner for Incremental Analysis
#
# Runs the incremental E2E test against local backends.
# Requires: Neo4j, Typesense, Qdrant running
#
# Usage: ./scripts/run-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Jelly Code E2E Test Runner ==="
echo "Project: $PROJECT_DIR"
echo ""

# Check backends
echo "--- Checking backends ---"
# Neo4j
if curl -s -o /dev/null -w "%{http_code}" http://localhost:7474 2>/dev/null | grep -q "200"; then
  echo "  ✅ Neo4j: running (bolt://localhost:7687)"
else
  echo "  ⚠️  Neo4j: port 7474 not responding, checking 7687..."
  if nc -z localhost 7687 2>/dev/null; then
    echo "  ✅ Neo4j: bolt port responding"
  else
    echo "  ❌ Neo4j: NOT running. Start with: docker compose -f $PROJECT_DIR/docker-compose.yml up -d"
    exit 1
  fi
fi

# Typesense
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8108/health 2>/dev/null | grep -q "200"; then
  echo "  ✅ Typesense: running (localhost:8108)"
else
  echo "  ❌ Typesense: NOT running"
  exit 1
fi

# Qdrant
if curl -s -o /dev/null http://localhost:6333/health 2>/dev/null; then
  echo "  ✅ Qdrant: running (localhost:6333)"
else
  echo "  ❌ Qdrant: NOT running"
  exit 1
fi

echo ""

# Clean any stale data from previous E2E runs
echo "--- Cleaning stale E2E data ---"
npx tsx -e "
import neo4j from 'neo4j-driver';
const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', 'jelly2024'));
const session = driver.session();
await session.run('MATCH (p:Project {id: \$id}) DETACH DELETE p', {id: 'e2e-incremental-regression'}).catch(() => {});
await session.close();
await driver.close();
console.log('Cleaned project: e2e-incremental-regression');
" 2>/dev/null || echo "  Clean skipped or already clean"

rm -rf /tmp/jelly-code-e2e-test-repo /tmp/jelly-code-e2e-cache /tmp/jelly-code-e2e-baseline.json

echo ""

# Run the E2E tests
echo "--- Running E2E tests ---"
echo "Command: JELLY_CODE_E2E=1 npx vitest run test/incremental/incremental-e2e.test.ts --reporter=verbose"
echo ""

JELLY_CODE_E2E=1 npx vitest run test/incremental/incremental-e2e.test.ts --reporter=verbose 2>&1

exit_code=$?

echo ""
if [ $exit_code -eq 0 ]; then
  echo "✅ E2E tests PASSED"
else
  echo "❌ E2E tests FAILED (exit code: $exit_code)"
fi

exit $exit_code
