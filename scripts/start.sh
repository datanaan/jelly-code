#!/bin/bash
set -e
cd "$(dirname "$0")/.."
docker compose -f docker/docker-compose.yml up -d
echo "jelly_code_project started on port 8095"
echo "Health check: http://localhost:8095/health"
