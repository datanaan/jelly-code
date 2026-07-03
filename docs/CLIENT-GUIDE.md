# jelly-code Client Guide

> 服务地址: **http://localhost:8095**  
> 部署日期: 2026-05-18  
> 版本: v0.1.0

---

## 1. 快速开始

```bash
# 健康检查 (无需认证)
curl http://localhost:8095/health
# → {"status":"ok","mode":"standalone","version":"0.1.0"}

# API 请求 (需认证)
curl -H "x-api-key: your-api-key" http://localhost:8095/api/projects
# → {"projects":["my-project",...]}
```

## 2. 认证

**认证方式**: API Key  
**模式**: standalone (无限配额，无用量限制)

### 在请求中携带 API Key

| 方式 | 示例 |
|------|------|
| HTTP Header (推荐) | `x-api-key: dev_key_1` |
| URL Query | `?apiKey=dev_key_1` |

### 可用 API Key

| Key | 用途 |
|-----|------|
| `dev_key_1` | 默认开发密钥 |
| `dev_key_2` | 备用开发密钥 |

> 管理员可通过修改 `/data/jelly_code/.env` 中的 `STANDALONE_API_KEYS` 增删密钥

### 错误响应

| HTTP 状态 | 响应 | 含义 |
|-----------|------|------|
| 401 | `{"error":"API Key required"}` | 未携带 API Key |
| 401 | `{"error":"Invalid API Key"}` | API Key 无效 |
| 429 | `{"error":"quota_exhausted"}` | 配额耗尽 (standalone 模式不会触发) |

---

## 3. REST API 参考

### 3.1 健康检查

```
GET /health
```

无需认证。

**响应示例:**
```json
{
  "status": "ok",
  "mode": "standalone",
  "version": "0.1.0"
}
```

### 3.2 列出所有项目

```
GET /api/projects
Header: x-api-key: <key>
```

**响应示例:**
```json
{
  "projects": ["my-project", "another-repo"]
}
```

### 3.3 启动代码分析

```
POST /api/analyze
Header: x-api-key: <key>
Content-Type: application/json
```

**请求体:**
```json
{
  "projectId": "my-project",
  "gitUrl": "https://github.com/user/repo.git"
}
```

或本地路径:
```json
{
  "projectId": "my-project",
  "repoPath": "/path/to/local/repo"
}
```

**响应:**
```json
{
  "status": "started",
  "projectId": "my-project"
}
```

> 分析异步执行，完成后数据写入 Neo4j + Typesense + Qdrant

### 3.4 查询项目状态

```
GET /api/status/:projectId
Header: x-api-key: <key>
```

**响应:**
```json
{
  "projectId": "my-project",
  "status": "indexed"
}
```

### 3.5 删除项目

```
DELETE /api/projects/:projectId
Header: x-api-key: <key>
```

**响应:**
```json
{
  "status": "deleted",
  "projectId": "my-project"
}
```

---

## 4. MCP 协议接入

### 4.1 连接信息

| 项 | 值 |
|----|-----|
| 端点 | `http://localhost:8095/mcp` |
| 协议 | MCP StreamableHTTP (2024-11-05) |
| 服务名 | `jelly-code` |
| 版本 | `0.1.0` |
| 认证 | `x-api-key` Header (每个请求都需携带) |
| 方法 | `POST` |

### 4.2 初始化

```bash
curl -X POST http://localhost:8095/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: dev_key_1" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "my-client", "version": "1.0"}
    },
    "id": 1
  }'
```

### 4.3 列出工具

```bash
curl -X POST http://localhost:8095/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: dev_key_1" \
  -H "mcp-session-id: <session-id-from-init>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 2
  }'
```

### 4.4 可用的 12 个 MCP 工具

| 工具 | 描述 |
|------|------|
| `list_repos` | 列出所有已索引的代码仓库 |
| `query` | 执行 Cypher 图查询 (知识图谱遍历) |
| `search_code` | 全文搜索代码符号 (函数/类/接口) |
| `similar_code` | 语义相似度搜索 (需向量嵌入) |
| `context` | 获取符号上下文 (定义 + 入站/出站依赖) |
| `impact` | BFS 爆炸半径分析，支持方向控制 |
| `detect_changes` | 检测文件变更影响的符号 |
| `rename` | 多文件协同重命名 (默认 dry-run) |
| `route_map` | 展示 API 路由映射及消费者 |
| `tool_map` | 展示 MCP/RPC 工具定义 |
| `shape_check` | 检查 API 响应 shape vs 消费者访问 |
| `api_impact` | 变更前 API 路由影响报告 |

---

## 5. SDK 集成示例

### 5.1 Node.js (REST API)

```javascript
const BASE = 'http://localhost:8095';
const API_KEY = 'dev_key_1';

// 列出项目
const res = await fetch(`${BASE}/api/projects`, {
  headers: { 'x-api-key': API_KEY }
});
const { projects } = await res.json();
console.log('已索引项目:', projects);

// 启动分析
await fetch(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
  },
  body: JSON.stringify({
    projectId: 'my-project',
    gitUrl: 'https://github.com/user/repo.git',
  }),
});
```

### 5.2 Node.js (MCP Client SDK)

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://localhost:8095/mcp'),
  {
    requestInit: {
      headers: { 'x-api-key': 'dev_key_1' },
    },
  }
);

const client = new Client(
  { name: 'my-app', version: '1.0' },
  { capabilities: {} }
);

await client.connect(transport);

// 列出所有已索引仓库
const repos = await client.callTool({
  name: 'list_repos',
  arguments: {},
});
console.log(repos);

// 搜索代码符号
const results = await client.callTool({
  name: 'search_code',
  arguments: { query: 'authenticate', projectId: 'my-project' },
});

// 查询符号上下文
const ctx = await client.callTool({
  name: 'context',
  arguments: { symbolId: 'sym-xxx', projectId: 'my-project' },
});
```

### 5.3 Python

```python
import requests

BASE = "http://localhost:8095"
HEADERS = {"x-api-key": "dev_key_1"}

# 健康检查
resp = requests.get(f"{BASE}/health")
print(resp.json())  # {"status":"ok","mode":"standalone","version":"0.1.0"}

# 列出项目
resp = requests.get(f"{BASE}/api/projects", headers=HEADERS)
print(resp.json())  # {"projects":[...]}

# 启动分析
resp = requests.post(
    f"{BASE}/api/analyze",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={
        "projectId": "my-python-project",
        "gitUrl": "https://github.com/user/repo.git",
    },
)
print(resp.json())  # {"status":"started","projectId":"my-python-project"}
```

### 5.4 cURL 测试脚本

```bash
#!/bin/bash
BASE="http://localhost:8095"
KEY="your-api-key"

echo "=== 健康检查 ==="
curl -s "$BASE/health" | python3 -m json.tool

echo "=== 项目列表 ==="
curl -s -H "x-api-key: $KEY" "$BASE/api/projects" | python3 -m json.tool

echo "=== 启动分析 ==="
curl -s -X POST "$BASE/api/analyze" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{"projectId":"demo","gitUrl":"https://github.com/user/repo.git"}' \
  | python3 -m json.tool
```

---

## 6. CodeBuddy / Claude 集成

在 CodeBuddy 的 MCP 配置中添加:

```json
{
  "mcpServers": {
    "jelly-code": {
      "url": "http://localhost:8095/mcp",
      "headers": {
        "x-api-key": "dev_key_1"
      }
    }
  }
}
```

配置后 AI 即可调用 `list_repos`、`search_code`、`context`、`impact` 等工具分析你的代码库。

---

## 7. 网络端口一览

| 端口 | 服务 | 是否需对外开放 |
|------|------|---------------|
| 8095 | jelly-code API + MCP | ✅ 客户端必需 |
| 6333 | Qdrant 向量数据库 | ❌ 内网即可 |
| 7687 | Neo4j Bolt | ❌ 内网即可 |
| 7474 | Neo4j HTTP | ❌ 内网即可 |
| 8108 | Typesense 搜索 | ❌ 内网即可 |

客户端只需访问 **8095 端口**。

---

## 8. 常见问题

**Q: 分析一个仓库需要多长时间？**  
A: 取决于仓库大小。小项目几秒，大中型项目几分钟。

**Q: 支持哪些编程语言？**  
A: C, C++, C#, Go, Java, JavaScript, PHP, Python, Ruby, Rust, TypeScript (共 11 种)。

**Q: `similar_code` 返回空？**  
A: 需要先完成代码分析 (包含 Qdrant 向量嵌入)，且 ONNX Runtime 已安装或配置了外部嵌入服务。

**Q: API Key 如何更换？**  
A: 编辑 `/data/jelly_code/.env` 中 `STANDALONE_API_KEYS`，然后 `systemctl restart jelly-code`。
