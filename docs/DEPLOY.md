# Jelly Code 部署与配置报告

> 部署日期: 2026-05-18  
> 主机: 127-UBU2404-CODE-CENTER (172.80.1.127)  
> 磁盘: /dev/sdb1 59G (已用 3.7G / 7%)

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  systemd (systemctl)                                        │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ jelly-code   │  │ jelly-backends│  │  qdrant      │      │
│  │ (Node.js)    │  │ (docker      │  │  (native)    │      │
│  │ :8095        │  │  compose)    │  │  :6333       │      │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘      │
│         │                 │                                  │
│         │          ┌──────┴──────┐                          │
│         │          │ Docker      │                          │
│         │          │ ┌──────────┐│                          │
│         ├─────────►│ │ neo4j    ││ :7687 :7474              │
│         │          │ │ 5.26     ││                          │
│         │          │ ├──────────┤│                          │
│         │          │ │typesense ││ :8108                    │
│         │          │ │ 26.0     ││                          │
│         │          │ └──────────┘│                          │
│         │          └─────────────┘                          │
└─────────┴──────────────────────────────────────────────────┘
```

## 2. 目录结构

所有部署文件均在 `/data` 分区下：

| 路径 | 大小 | 说明 |
|------|------|------|
| `/data/jelly_code/` | 1.1G | 项目源码 + node_modules + dist |
| `/data/jelly_code/.env` | - | 应用环境配置 |
| `/data/jelly_code/docker-compose.yml` | - | Neo4j + Typesense 编排 |
| `/data/jelly_code/scripts/ctl.sh` | - | 运维管理脚本 |
| `/data/jelly_code/docs/DEPLOY.md` | - | 本报告 |
| `/data/qdrant/` | 71M | Qdrant 二进制 + 数据 |
| `/data/neo4j-data/` | 518M | Neo4j 图数据库数据 |
| `/data/typesense-data/` | 8M | Typesense 搜索索引 |
| `/data/docker/` | 3.2G | Docker 引擎 + 镜像 |

## 3. 服务端口

| 端口 | 服务 | 协议 | 认证 |
|------|------|------|------|
| 8095 | jelly-code (HTTP API + MCP) | HTTP | `x-api-key` header |
| 6333 | Qdrant 向量数据库 | HTTP | 内网免认证 |
| 7687 | Neo4j Bolt | Bolt | neo4j/password123 |
| 7474 | Neo4j HTTP | HTTP | neo4j/password123 |
| 8108 | Typesense 搜索 | HTTP | API Key: xyz |

## 4. 环境配置

文件: `/data/jelly_code/.env`

```ini
DEPLOY_MODE=standalone
PORT=8095
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
TYPESENSE_HOST=localhost
TYPESENSE_PORT=8108
TYPESENSE_API_KEY=xyz
QDRANT_URL=http://localhost:6333
STANDALONE_API_KEYS=dev_key_1,dev_key_2
```

## 5. Systemd 服务

| 服务名 | 管理对象 | 命令 |
|--------|---------|------|
| `jelly-code` | Node.js 应用 | `node dist/server/index.js` |
| `jelly-backends` | Docker Compose (Neo4j+Typesense) | `docker compose up -d` |
| `qdrant` | Qdrant 原生进程 | `/data/qdrant/qdrant` |

### 服务依赖关系

```
jelly-code.service
  └── Wants: jelly-backends.service, qdrant.service
       ├── jelly-backends.service ── Requires: docker.service
       └── qdrant.service
```

## 6. 运维命令

### 日常管理

```bash
# 一键状态查看
bash /data/jelly_code/scripts/ctl.sh status

# 改代码后重启（自动 npm run build）
bash /data/jelly_code/scripts/ctl.sh restart

# 完全停止/启动
bash /data/jelly_code/scripts/ctl.sh stop
bash /data/jelly_code/scripts/ctl.sh start

# 查看日志
bash /data/jelly_code/scripts/ctl.sh logs
```

### systemd 操作

```bash
systemctl start|stop|restart jelly-code
systemctl start|stop|restart jelly-backends
systemctl start|stop|restart qdrant
journalctl -u jelly-code -f          # 实时日志
```

### Docker Compose 操作

```bash
docker compose -f /data/jelly_code/docker-compose.yml up -d
docker compose -f /data/jelly_code/docker-compose.yml down
docker compose -f /data/jelly_code/docker-compose.yml logs -f
docker compose -f /data/jelly_code/docker-compose.yml ps
```

### 功能测试

```bash
# 健康检查
curl http://localhost:8095/health

# 项目列表 (带认证)
curl -H "x-api-key: dev_key_1" http://localhost:8095/api/projects

# 分析仓库
curl -X POST http://localhost:8095/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev_key_1" \
  -d '{"projectId":"my-project","gitUrl":"https://github.com/..."}'
```

## 7. 集群验证

| 测试项 | 结果 |
|--------|------|
| `/health` | `{"status":"ok","mode":"standalone","version":"1.3.1"}` |
| `GET /api/projects` | `{"error":"API Key required"}` (认证正常) |
| `GET /api/projects` (带 Key) | `{"projects":[]}` (Neo4j 连接正常) |
| Neo4j Schema | `[server] Neo4j schema initialized` |
| Qdrant healthz | `healthz check passed` |
| Typesense health | `{"ok":true}` |

## 8. 部署决策记录

| 决策 | 理由 |
|------|------|
| Neo4j/Typesense 用 Docker | 二进制下载受限(CloudFront 地域封禁)，Docker 镜像可通过国内镜像拉取 |
| jelly-code 用 systemd 直接管理 | 便于频繁修改代码、快速重启 |
| Qdrant 用原生二进制 | 体积小(71M)、无外部依赖、无需容器 |
| 统一使用 `/data` 分区 | 59G 专用磁盘，与系统盘隔离 |
| 独立 `standalone` 模式 | 无需依赖外部 Jelly 平台，本地 API Key 认证 |

## 9. 源码修改记录

`src/store/qdrant/adapter.ts:22` — 添加 `checkCompatibility: false`
- 原因: npm 镜像安装了 `@qdrant/js-client-rest` v1.18.0，而服务端是 v1.12.0，版本检查误报警告

## 10. 已知问题与建议

| 问题 | 影响 | 建议 |
|------|------|------|
| Docker Compose 健康检查偶发 unhealthy | 不影响功能 | 增大健康检查超时或改用 `pg_isready` |
| jelly-code 启动时 Neo4j 连接超时 30s | 首次启动慢 | Neo4j 已就绪时只需 ~5s |
| 嵌入模型 ONNX Runtime 未安装 | 向量搜索暂不可用 | 配置外部 HTTP 嵌入服务，或手动安装 onnxruntime-node 二进制 |
| 日志只输出到 journald | 排查需用 journalctl | 可追加 `StandardOutput=append:/data/jelly_code/logs/app.log` |
| `/data/jelly_code/node_modules` 含 ONNX 残留 | 磁盘浪费 ~几百MB | `npm prune --production` 清理 |
