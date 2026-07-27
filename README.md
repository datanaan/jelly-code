# jelly-code

> **MCP-native, multi-language code knowledge graph service.**
>
> Analyze repos, map APIs, trace code evolution — all through AI-native MCP tools.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

---

## What is jelly-code?

jelly-code turns source code into a **queryable knowledge graph** — not text search, but real semantic understanding: symbols, imports, inheritance, call chains, API routes, and code evolution over time.

It exposes **33+ MCP tools** so AI assistants (Claude Code, Cursor, Windsurf, etc.) can navigate your codebase without manual context loading.

### What makes it different?

| Instead of... | jelly-code does... |
| --- | --- |
| Grep / full-text search | Semantic symbol graph + structured queries |
| Manual code review | Automated API analysis, dependency mapping, impact analysis |
| Context window limits | On-demand code queries via MCP — load only what you need |
| Hand-written docs that go stale | **Auto-discovered Wiki** — finds docs in your repo, tracks freshness |
| Static git log only | **Code time travel** — snapshot any point in history, narrated evolution |
| Single-language tools | 14 languages, one unified graph |

---

## ✨ Key Innovations

### 📖 Self-Discovering Documentation Wiki

Most tools need you to **tell them where the docs are**. jelly-code does the opposite — it **finds documentation automatically**.

- **Auto-discovery**: Scans your repo for READMEs, architecture docs, API references, inline docs — zero config
- **Freshness tracking**: Every indexed page gets a cryptographic signature. When code changes, jelly-code flags stale docs instantly
- **Entity cross-reference**: Maps code entities (classes, functions, APIs) to their documentation
- **Live lint**: Detects broken cross-references, orphaned pages, missing coverage — all automated

### ⏳ Code Time Travel

jelly-code lets you travel through your code's full history.

- **Snapshot any point in time**: See what any symbol or API looked like at any commit
- **Evolution narrative**: Ask "how did this function evolve?" and get a natural-language story
- **Change traceability**: From a bug report to the exact commit that introduced it

---

## Quick Demos

### 🖥️ CLI — Analyze a repository

```bash
# Index your project
npx jelly-code analyze /path/to/your-project

# Ask questions about the code
npx jelly-code query "find all API routes"
npx jelly-code query "which files import from auth.ts?"
```

### 🤖 AI Agent — Query via MCP

```
# 🔍 Code understanding
"What does the handleRequest function do?"
"Show me the call chain from login() to database write"
"Which files would be affected if I change the User model?"

# 📖 Wiki
"Find all documentation in this repo and check which pages are stale"
"Which code entities are missing documentation?"

# ⏳ Temporal
"What did the payment service look like 30 commits ago?"
"Tell me the story of how the SearchEngine class evolved"
```

---

## 33+ MCP Tools

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

### 📖 Wiki — Auto-Discovered Documentation (8 tools)

| Tool | What it does |
| --- | --- |
| `wiki_ingest` | Index a documentation page |
| `wiki_batch_ingest` | Bulk index multiple pages |
| `wiki_query` | Search indexed wiki content |
| `wiki_auto_discover` | Automatically find docs in the repo |
| `wiki_status` | Check wiki freshness (signature-based staleness detection) |
| `wiki_lint` | Detect broken cross-references, orphaned pages, missing coverage |
| `wiki_sync` | Resync stale pages |
| `wiki_entity_freshness` | Check if code entities are up-to-date with their docs |

### ⏳ Temporal — Code Time Travel (3 tools)

| Tool | What it does |
| --- | --- |
| `code_as_of` | Snapshot code at any point in history |
| `code_evolution_story` | Narrative of how a symbol/API changed over time |
| `changes_between` | Diff between two commits — node-level + project-level |

### 🛠️ Project & Intelligence (8 tools)

| Tool | What it does |
| --- | --- |
| `list_repos` | List all indexed repositories |
| `project_status` | Health and freshness of a project |
| `find_dead_code` | Find unreferenced code symbols |
| `list_dependencies` | List external + internal dependencies |
| `affected_tests` | Find test files affected by code changes |
| `route_map` | Show API route mappings + consumers |
| `tool_map` | Show MCP/RPC tool definitions |
| `shape_check` | Check API response shapes vs consumer access |

---

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker (for Neo4j + Typesense)

### 1. Install

```bash
git clone https://github.com/datanaan/jelly-code
cd jelly-code
npm install
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

Now connect any MCP client to `http://localhost:8095/mcp`.

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
AI Client ── MCP Protocol ──▶ MCP Server (Express)
                                   │
                          Ingestion Pipeline
                       Scan → Parse → Resolve → Enrich
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
                  Neo4j        Typesense       Qdrant
                 (Graph)      (Full-text)     (Vector)
```

### Pipeline phases

1. **Scan** — Walk the repository, discover files
2. **Parse** — Tree-sitter AST parsing per language
3. **Resolve** — Imports, calls, heritage, route detection
4. **Enrich** — Community detection (Leiden), process extraction, cross-file type propagation

### Dual Deployment Mode

- **Standalone mode** (`DEPLOY_MODE=standalone`) — independent API key auth, unlimited quota, no external dependencies
- **Jelly mode** (`DEPLOY_MODE=jelly`) — integrates with Jelly platform for auth/billing/routing

---

## Configuration

Key environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8095` | HTTP server port |
| `DEPLOY_MODE` | `standalone` | `standalone` or `jelly` |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | — | Neo4j password |
| `TYPESENSE_API_KEY` | — | Typesense API key |
| `TYPESENSE_HOST` | `localhost` | Typesense host |
| `TYPESENSE_PORT` | `8108` | Typesense port |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant URL (optional) |
| `STANDALONE_API_KEYS` | — | Comma-separated API keys (standalone mode) |
| `CODE_EMBEDDING_URL` | — | HTTP embedding API URL |

### Resilience Layer (v1.3.1)

LLM and Embedding calls go through a unified `RemoteService`:

- **Multi-endpoint pool**: `LLM_ENDPOINTS_JSON` / `CODE_EMBEDDING_URLS`
- **Load balancing**: priority, round-robin, weighted-random, least-connections
- **Circuit breaker**: cockatiel CircuitBreaker with configurable thresholds
- **Async queues**: Derivation tasks through BullMQ, non-blocking pipeline
- **Observability**: `/health/llm`, `/health/embedding`, `/health/queues`, `/readyz`, `/metrics`

---

## Development

```bash
npm run build       # Compile TypeScript
npm run lint        # Type check (tsc --noEmit)
npm test            # Run unit tests
npm run test:watch  # Run tests in watch mode
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
