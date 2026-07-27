# Changelog

## [1.3.1] - 2026-07-23

### 新增
- `find_dead_code` MCP 工具 — 死代码检测，3 条 Cypher（导出/非导出/self-ref），置信度评分
- `list_dependencies` MCP 工具 — 依赖清单，scope 过滤（external/internal/all），LIMIT 保护
- `affected_tests` MCP 工具 — 测试影响分析，三步查询（直接导入/调用链/未测试文件）
- 26 单元测试 + 6 E2E 测试（3 新工具全量覆盖）

### 韧性增强
- Resilience 层: RemoteService(cockatiel 熔断/重试/超时/fallback), EndpointSelector(4 策略), JobDispatcher(BullMQ)
- LLM 多端点池化: LLMService + EmbeddingService 多节点 least-connections 分发
- 健康检查: 5 个端点 (/health/llm, /health/embedding, /health/queues, /readyz, /metrics)
- Prometheus metrics: 7 个 jelly_ 新指标 (pool/queue)
- 配置校验: ConfigValidator fail-fast, 非法配置拒绝启动
- 凭证管理: CredentialLoader 三级降级 (file → env → fallback)
- 优雅关闭: SIGTERM → closeResilienceQueues + stores.close
- Worker 异步队列: llm-derivation + llm-enrichment (BullMQ, 幂等 jobId)
- 冒烟测试: 3 个自动化脚本 (health/backward-compat/prod-config)

### 修复
- Wiki generateEmbedding 自动初始化 embedder，消除 "Embedder not initialized" 降级
- MCP project_status 加 Neo4j 回退，服务重启后仍可查到已分析项目

## [1.3.0] - 2026-07-22

### 新增
- Wiki 自动激活: analyze_repo 完成后自动派生 WikiEntity (Gate-1 覆盖率 125%)
- 跨域边: DESCRIBES / DOCUMENTED_BY, bi-temporal (valid_from/valid_to/txn_from)
- CodeEntitySelector: JSON 规则驱动节点选择 (exported_funcs / high_centrality / community_top / hotspots)
- 配置化派生规则: config/derivation-rules.json (enabled 安全开关)
- changes_between MCP 工具: 查询两 commit 间变更 (节点级 + 项目级)
- wiki_auto_fix MCP 工具: scan / fix / delete-orphaned / undo-auto-derived
- provenance 追踪: auto-derived vs manual，可过滤可回滚
- NL 时间解析: since/after/before ISO date 前缀支持

## [1.1.4] - 2026-07-15

### 修复
- 修复 `shared/lbug/schema-constants.ts` 缺失导致的断链 Bug (OSS 版)
- 统一品牌命名: `gitnexus-shared` → `@shared` (60 个文件)
- 统一环境变量: `GITNEXUS_EMBEDDING_*` → `CODE_EMBEDDING_*`
- 统一 CLI 名称: `jelly-code-project` → `jelly-code`
- 清理所有注释中的 gitnexus 品牌残留
- docker-compose 参数化 (硬编码密码 → 环境变量)
- .gitignore 升级 (5 行 → 38 行)
- .env.example 合并嵌入配置
- 新增社区文档: CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, CHANGELOG

## [1.0.0] - 2026-07-03

### 新增
- 基于 MCP 协议的多仓库代码知识图谱云服务
- 33+ MCP 工具: 代码分析、API 分析、Wiki 管理、时态查询
- 14 种语言 Tree-sitter AST 解析
- 三层存储: Neo4j (图) + Typesense (全文) + Qdrant (向量)
- 增量代码分析 (onlyFiles 模式)
- 代码演化叙事 (code_evolution_story)
- 时间点快照 (code_as_of)
- 自动文档发现与 Wiki 管理
- 社区检测 (Leiden 算法) 与执行流追踪
- 多语言导入解析 (路径别名/Go Module/PSR-4/C# 命名空间/Swift Package)
- 路由映射与 MCP 工具检测
- ORM 数据流分析 (Prisma + Supabase)
