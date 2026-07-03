#!/bin/bash
# ============================================================
# Jelly Code - 服务管理脚本
# 用法: bash /data/jelly_code/scripts/ctl.sh {start|stop|restart|status|logs}
# ============================================================
set -e

COMPOSE_FILE="/data/jelly_code/docker-compose.yml"
ACTION="${1:-status}"

case "$ACTION" in
  start)
    echo ">>> 启动后端 (Neo4j + Typesense)..."
    systemctl start jelly-backends
    echo ">>> 启动 Qdrant..."
    systemctl start qdrant
    sleep 8
    echo ">>> 启动 jelly-code..."
    systemctl start jelly-code
    sleep 3
    echo ""
    echo ">>> 健康检查:"
    curl -s http://localhost:8095/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  jelly-code 未就绪"
    ;;
  stop)
    echo ">>> 停止 jelly-code..."
    systemctl stop jelly-code
    echo ">>> 停止后端..."
    systemctl stop jelly-backends qdrant
    echo "已停止"
    ;;
  restart)
    echo ">>> 重启 jelly-code..."
    cd /data/jelly_code && npm run build 2>/dev/null
    systemctl restart jelly-code
    sleep 3
    echo "已重启 (后端未重启)"
    curl -s http://localhost:8095/health | python3 -m json.tool 2>/dev/null
    ;;
  status)
    echo "============================================"
    echo " Jelly Code - 服务状态"
    echo "============================================"
    echo ""
    echo "--- Systemd 服务 ---"
    for svc in jelly-code jelly-backends qdrant; do
      STATE=$(systemctl is-active $svc 2>/dev/null)
      if [ "$STATE" = "active" ]; then
        echo -e "  $svc:\t\033[0;32m● 运行中\033[0m"
      else
        echo -e "  $svc:\t\033[0;31m○ 未运行\033[0m"
      fi
    done

    echo ""
    echo "--- Docker Compose 容器 ---"
    cd /data/jelly_code && docker compose ps 2>/dev/null

    echo ""
    echo "--- 端口监听 ---"
    ss -tlnp 2>/dev/null | grep -E "8095|6333|7687|7474|8108" | awk '{printf "  %-8s %s\n", $4, $NF}' || echo "  无"

    echo ""
    echo "--- 健康检查 ---"
    HEALTH=$(curl -s http://localhost:8095/health 2>/dev/null)
    if [ -n "$HEALTH" ]; then
      echo "$HEALTH" | python3 -m json.tool 2>/dev/null
    else
      echo "  jelly-code 未响应"
    fi
    ;;
  logs)
    echo ">>> jelly-code 日志 (最后50行):"
    journalctl -u jelly-code --no-pager -n 50
    echo ""
    echo ">>> Docker Compose 日志 (最后30行):"
    cd /data/jelly_code && docker compose logs --tail 30
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
