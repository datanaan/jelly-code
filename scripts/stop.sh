#!/bin/bash
set -e
cd "$(dirname "$0")/.."
docker compose -f docker/docker-compose.yml down
echo "jelly_code_project stopped"
