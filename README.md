<div align="center">

# jelly-code

**The first MCP-native code knowledge graph — not code search, code understanding.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/datanaan/jelly-code?style=social)](https://github.com/datanaan/jelly-code)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/languages-14-blueviolet)](https://github.com/datanaan/jelly-code)

</div>

---

[**中文文档**](README.zh-CN.md) | **English**

---

## What is jelly-code?

**jelly-code is not a code search tool. It's a knowledge graph engine that actually understands your code.**

It exposes **33+ MCP tools** so AI assistants (Claude Code, Cursor, Windsurf, etc.) can navigate your codebase without manual context loading — not by keyword matching, but by semantic understanding: symbols, imports, call chains, inheritance, API routes, and evolution over time.

### Two Innovations That Set It Apart

| Instead of... | jelly-code does... |
|-------------|-------------------|
| Hand-written docs that go stale | **Auto-discovered Wiki** — finds docs, tracks freshness cryptographically |
| Static git log | **Code time travel** — query any point in history, narrated evolution |
| Grep / full-text search | Semantic graph: call chains, inheritance, impact analysis |
| Manual context loading for AI | **33+ MCP tools** — on-demand, context-window friendly |

### Quick Start

```bash
# 1. Install
git clone https://github.com/datanaan/jelly-code
cd jelly-code && npm install && npm run build

# 2. Start infrastructure
docker compose up -d

# 3. Analyze your project
npx jelly-code analyze /path/to/your-project

# 4. Start MCP server
npx jelly-code mcp
```

Connect any MCP client to `http://localhost:8095/mcp`.

### 14 Supported Languages

JavaScript / TypeScript · Python · Java · Go · Rust · C / C++ · C# · PHP · Ruby · Kotlin · Swift · Dart · COBOL

### Architecture

```
AI Client ── MCP ──▶ Express Server
                        │
               Scan → Parse → Resolve → Enrich
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
           Neo4j    Typesense   Qdrant
          (Graph)   (Full-text) (Vector)
```

---

## 33+ MCP Tools

### 🔍 Code Analysis
`analyze_repo` · `incremental_analyze` · `query` · `search_code` · `similar_code` · `context` · `impact` · `detect_changes` · `rename`

### 🗺️ Graph & Dependency
`hotspots` · `co_changes` · `code_ownership` · `symbol_lineage`

### 📊 API Analysis
`route_map` · `tool_map` · `shape_check` · `api_impact` · `api_stability`

### 📖 Wiki (Auto-Discovered Documentation)
`wiki_ingest` · `wiki_batch_ingest` · `wiki_query` · `wiki_auto_discover` · `wiki_status` · `wiki_lint` · `wiki_sync` · `wiki_entity_freshness`

### ⏳ Temporal (Code Time Travel)
`code_as_of` · `code_evolution_story` · `changes_between`

### 🛠️ Project Intelligence
`list_repos` · `project_status` · `find_dead_code` · `list_dependencies` · `affected_tests`

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8095` | HTTP server port |
| `DEPLOY_MODE` | `standalone` | `standalone` or `jelly` |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection |
| `TYPESENSE_API_KEY` | — | Typesense API key |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant (optional) |
| `STANDALONE_API_KEYS` | — | API keys for standalone mode |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
