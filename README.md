# jelly-code

> **MCP-native, multi-language code knowledge graph service.**
>
> Analyze repos, map APIs, trace code evolution — all through AI-native MCP tools.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

---

## What is jelly-code?

jelly-code turns your source code into a **queryable knowledge graph** — not just text search, but real semantic understanding of symbols, imports, inheritance, call chains, API routes, and code evolution over time.

It exposes **33+ MCP tools** so AI assistants (Claude Code, Cursor, Windsurf, etc.) can understand and navigate your codebase without manual context loading.

### What makes it different?

| Instead of... | jelly-code does... |
| --- | --- |
| Grep / full-text search | Semantic symbol graph + structured queries |
| Manual code review | Automated API analysis, dependency mapping, impact analysis |
| Context window limits | On-demand code queries via MCP — only load what you need |
| Static docs that go stale | Live Wiki that syncs with your code |
| Single-language tools | 14 languages, one unified graph |

---

## Quick Demos

### 🖥️ CLI — Analyze a repository

```bash
# Index your project
npx jelly-code analyze /path/to/your-project

# Query what it found
npx jelly-code query "find all API routes"
npx jelly-code query "which files import from auth.ts?"
npx jelly-code query "show me the inheritance hierarchy"
```

### 🤖 AI Agent — Ask questions naturally

Connect jelly-code's MCP server to any MCP-compatible AI client:

```
# "What does the handleRequest function do?"
# "Show me the call chain from login() to database write"
# "Which files would be affected if I change the User model?"
# "Map all HTTP routes and their response types"
# "Compare this file to how it looked 10 commits ago"
```

---

## 33+ MCP Tools

jelly-code exposes a rich set of tools for AI agents. They fall into six categories:

### 🔍 Code Analysis (9 tools)

| Tool | What it does |
| --- | --- |
| `analyze_repo` | Full ingestion: scan → parse → resolve → enrich |
| `incremental_analyze` | Re-analyze only changed files (fast mode) |
| `query` | Ask natural-language questions about the code |
| `search_code` | Full-text + vector similarity search |
| `similar_code` | Find structurally similar code patterns |
| `context` | Get full context around a symbol |
| `impact` | Estimate blast radius of a change |
| `detect_changes` | Diff between two commits |
| `rename` | Smart rename with dependency updates |

### 🗺️ Graph & Dependency (4 tools)

| Tool | What it does |
| --- | --- |
| `hotspots` | Find frequently modified, complex files |
| `co_changes` | Discover files that change together |
| `code_ownership` | Who owns what, by git blame |
| `symbol_lineage` | Trace a symbol through renames and moves |

### 📊 API Analysis (5 tools)

| Tool | What it does |
| --- | --- |
| `route_map` | Discover all HTTP routes + handlers |
| `tool_map` | Find MCP tool definitions in code |
| `shape_check` | Validate API contract compatibility |
| `api_impact` | Estimate which consumers break on API change |
| `api_stability` | Assess endpoint stability from change history |

### 📖 Wiki (8 tools)

| Tool | What it does |
| --- | --- |
| `wiki_ingest` | Index a documentation page |
| `wiki_batch_ingest` | Bulk index multiple pages |
| `wiki_query` | Search indexed Wiki content |
| `wiki_auto_discover` | Automatically find docs in the repo |
| `wiki_status` | Check wiki freshness |
| `wiki_lint` | Detect broken cross-references |
| `wiki_sync` | Resync stale pages |
| `wiki_entity_freshness` | Check if code entities are up-to-date with docs |

### ⏳ Temporal (2 tools)

| Tool | What it does |
| --- | --- |
| `code_as_of` | View code state at any point in history |
| `code_evolution_story` | Narrative of how a symbol/API evolved |

### 🛠️ Project (2 tools)

| Tool | What it does |
| --- | --- |
| `list_repos` | List all indexed repositories |
| `project_status` | Health and freshness of a project |

---

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker (for Neo4j + Typesense)

### 1. Install

```bash
git clone https://github.com/<your-org>/jelly-code
cd jelly-code
npm ci
npm run build
```

### 2. Start infrastructure

```bash
cp .env.example .env
# Edit .env with your passwords, or use defaults for local dev

docker compose up -d
```

### 3. Analyze a project

```bash
npx jelly-code analyze /path/to/your-project
```

### 4. Start MCP server

```bash
npx jelly-code mcp
```

Now connect any MCP client (`claude mcp add`, Cursor, etc.) to `http://localhost:8095/mcp`.

---

## Supported Languages

| Language | Status |
| --- | --- |
| JavaScript / TypeScript | ✅ Full |
| Python | ✅ Full |
| Java | ✅ Full |
| Go | ✅ Full |
| Rust | ✅ Full |
| C / C++ | ✅ Full |
| C# | ✅ Full |
| PHP | ✅ Full |
| Ruby | ✅ Full |
| Kotlin | ✅ Full |
| Swift | ✅ Full |
| Dart | ✅ Full |
| COBOL | ✅ Basic (regex-based) |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│             AI Client                        │
│   (Claude Code · Cursor · Windsurf · etc.)  │
└───────────────────┬─────────────────────────┘
                    │ MCP Protocol (HTTP/SSE)
                    ▼
┌─────────────────────────────────────────────┐
│              MCP Server (Express)            │
│   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐  │
│   │Code  │ │Graph │ │API   │ │Wiki      │  │
│   │Tools │ │Tools │ │Tools │ │Tools     │  │
│   └──┬───┘ └──┬───┘ └──┬───┘ └────┬─────┘  │
│      └────────┼────────┼───────────┘         │
└───────────────┼────────┼─────────────────────┘
                │        │
    ┌───────────▼────────▼───────────────────┐
    │        Ingestion Pipeline               │
    │  Scan → Tree-sitter Parse → Resolve →  │
    │  Community Detection → Process Extract  │
    └───────────┬────────┬───────────────────┘
                │        │
    ┌───────────▼────────▼───────────────────┐
    │     Storage Layer                       │
    │  ┌──────┐  ┌────────┐  ┌──────────┐    │
    │  │Neo4j │  │Typesense│  │ Qdrant   │    │
    │  │Graph │  │Search  │  │ Vector   │    │
    │  └──────┘  └────────┘  └──────────┘    │
    └─────────────────────────────────────────┘
```

### Pipeline phases

1. **Scan** — Walk the repository, discover files
2. **Parse** — Tree-sitter AST parsing per language
3. **Resolve** — Imports, calls, heritage, route detection
4. **Enrich** — Community detection (Leiden), process extraction, cross-file type propagation

---

## Configuration

Key environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8095` | HTTP server port |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | — | Neo4j password |
| `TYPESENSE_API_KEY` | — | Typesense API key |
| `TYPESENSE_HOST` | `localhost` | Typesense host |
| `TYPESENSE_PORT` | `8108` | Typesense port |
| `QDRANT_HOST` | — | Qdrant host (optional) |
| `CODE_EMBEDDING_URL` | — | HTTP embedding API URL |
| `CODE_EMBEDDING_MODEL` | — | Embedding model name |

---

## Roadmap

- [ ] File watcher — real-time incremental updates
- [ ] Web UI — graph visualization dashboard
- [ ] GitHub App — auto-index on push
- [ ] Monorepo-native — workspace-aware analysis
- [ ] More languages — add community grammar support
- [ ] LLM-enhanced description extraction

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

> **Name disclaimer:** "jelly-code" is an independent open-source project. It is not affiliated with, endorsed by, or related to any other project or organization using the "jelly" name.
