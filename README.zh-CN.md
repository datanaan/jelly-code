<div align="center">

# jelly-code

**首个 MCP 原生代码知识图谱——不是代码搜索，是代码理解。**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/languages-14-blueviolet)](https://github.com/datanaan/jelly-code)

</div>

---

**中文** | [English](README.md)

---

## 什么是 jelly-code？

**jelly-code 不是一个代码搜索工具。它是一个能真正"理解"代码的知识图谱引擎。**

AI 助手（Claude Code、Cursor、Windsurf 等）通过 33+ 个 MCP 工具，可以直接查询你的代码库——不是靠关键词匹配，而是靠语义理解：符号、调用链、继承关系、API 路由、代码的演化历史。

### 两大核心创新

| 传统方式 | jelly-code 的做法 |
|---------|-----------------|
| 手动写文档，写完了就过期 | **自动发现文档**，代码变了自动标记过期 |
| git log 看"改了哪些文件" | **代码时光机**，问"这个函数是怎么演变的？" |
| grep 搜关键词 | 语义图查询：调用链、继承、API 影响分析 |
| 每个 AI 工具需要手动加载上下文 | **33+ MCP 工具**，按需查询，不占窗口 |

### 快速开始

```bash
# 1. 安装
git clone https://github.com/datanaan/jelly-code
cd jelly-code && npm install && npm run build

# 2. 启动基础设施
docker compose up -d

# 3. 分析你的项目
npx jelly-code analyze /path/to/your-project

# 4. 启动 MCP 服务
npx jelly-code mcp
```

然后任何 MCP 客户端连接 `http://localhost:8095/mcp` 即可。

### 支持 14 种语言

JavaScript / TypeScript · Python · Java · Go · Rust · C / C++ · C# · PHP · Ruby · Kotlin · Swift · Dart · COBOL

### 架构

```
AI Client ── MCP ──▶ Express Server
                        │
               Scan → Parse → Resolve → Enrich
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
           Neo4j    Typesense   Qdrant
          (图谱)    (全文搜索)   (向量)
```

---

## 33+ MCP 工具

### 🔍 代码分析
`analyze_repo` · `incremental_analyze` · `query` · `search_code` · `similar_code` · `context` · `impact` · `detect_changes` · `rename`

### 🗺️ 图谱与依赖
`hotspots` · `co_changes` · `code_ownership` · `symbol_lineage`

### 📊 API 分析
`route_map` · `tool_map` · `shape_check` · `api_impact` · `api_stability`

### 📖 Wiki（自动发现文档）
`wiki_ingest` · `wiki_batch_ingest` · `wiki_query` · `wiki_auto_discover` · `wiki_status` · `wiki_lint` · `wiki_sync` · `wiki_entity_freshness`

### ⏳ 时态查询（代码时光机）
`code_as_of` · `code_evolution_story` · `changes_between`

### 🛠️ 项目智能
`list_repos` · `project_status` · `find_dead_code` · `list_dependencies` · `affected_tests`

---

## License

Apache 2.0 — 详见 [LICENSE](LICENSE)。
