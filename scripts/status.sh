#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "=== Docker Services ==="
docker compose -f docker/docker-compose.yml ps
echo ""
echo "=== Health Check ==="
curl -s http://localhost:8095/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Service not responding"
