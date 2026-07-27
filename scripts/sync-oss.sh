#!/usr/bin/env bash
# ============================================================
# sync-oss.sh — 从内部版同步到 OSS 版
#
# 用法: ./scripts/sync-oss.sh
#
# 功能:
#   1. 同步 src/ 代码（内部版 → OSS 版）
#   2. 同步 package.json（保留 OSS 版的 name/license/description）
#   3. 同步配置文件（tsconfig.json, vitest.config.ts, .gitignore）
#   4. 同步测试文件
#   5. 不同步: .env, docs/, 内部部署配置
#
# 前提: 两个版本的功能代码已对齐（@shared 路径别名统一）
# ============================================================

set -euo pipefail

# 路径配置
INTERNAL="/data/openclaw_opencode_test_space/projects/jelly_code"
OSS="/data/jelly-code-oss"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[sync-oss]${NC} $1"; }
warn() { echo -e "${YELLOW}[sync-oss WARN]${NC} $1"; }

# 前置检查
if [ ! -d "$INTERNAL/src" ]; then
  echo "ERROR: 内部版 src/ 不存在: $INTERNAL/src"
  exit 1
fi
if [ ! -d "$OSS/src" ]; then
  echo "ERROR: OSS 版 src/ 不存在: $OSS/src"
  exit 1
fi

log "开始同步: $INTERNAL → $OSS"

# 1. 同步 src/ 代码
log "同步 src/ ..."
rsync -a --delete \
  --exclude 'node_modules' \
  "$INTERNAL/src/" "$OSS/src/"

# 2. 同步测试文件
log "同步 test/ ..."
rsync -a --delete \
  --exclude 'tmp/' \
  "$INTERNAL/test/" "$OSS/test/"

# 3. 同步配置文件
log "同步配置文件..."
cp "$INTERNAL/tsconfig.json" "$OSS/tsconfig.json"
cp "$INTERNAL/vitest.config.ts" "$OSS/vitest.config.ts"
cp "$INTERNAL/.gitignore" "$OSS/.gitignore"
cp "$INTERNAL/test-parser.ts" "$OSS/test-parser.ts"

# 4. 同步 docker-compose.yml
log "同步 docker-compose.yml..."
cp "$INTERNAL/docker-compose.yml" "$OSS/docker-compose.yml"

# 5. 同步 .env.example（OSS 版不需要 Jelly 模式配置，但保留嵌入配置）
log "同步 .env.example..."
cp "$INTERNAL/.env.example" "$OSS/.env.example"

# 6. 同步社区文档（双向）
log "同步社区文档..."
for doc in CODE_OF_CONDUCT.md CONTRIBUTING.md SECURITY.md CHANGELOG.md LICENSE; do
  if [ -f "$OSS/$doc" ]; then
    cp "$OSS/$doc" "$INTERNAL/$doc"
  fi
done

# 7. 同步 docker/Dockerfile
log "同步 Dockerfile..."
if [ -f "$INTERNAL/docker/Dockerfile" ]; then
  cp "$INTERNAL/docker/Dockerfile" "$OSS/docker/Dockerfile"
fi

# 8. 同步 package.json（只同步 dependencies/devDependencies/scripts，保留 OSS 元信息）
log "处理 package.json..."
# 使用 node 脚本合并 package.json
node -e "
const fs = require('fs');
const internal = JSON.parse(fs.readFileSync('$INTERNAL/package.json', 'utf8'));
const oss = JSON.parse(fs.readFileSync('$OSS/package.json', 'utf8'));

// 保留 OSS 版的元信息，同步依赖和脚本
oss.dependencies = internal.dependencies;
oss.devDependencies = internal.devDependencies;
oss.scripts = internal.scripts;
oss.version = internal.version;
oss.main = internal.main;
oss.bin = internal.bin;
oss.type = internal.type;

fs.writeFileSync('$OSS/package.json', JSON.stringify(oss, null, 2) + '\n');
log('package.json 已同步（保留 OSS 元信息）');
"

# 9. 验证编译
log "验证 OSS 版编译..."
cd "$OSS"
if [ -d node_modules ]; then
  npx tsc --noEmit && log "✅ OSS 版编译通过" || { warn "❌ OSS 版编译失败"; exit 1; }
else
  warn "跳过编译验证（node_modules 不存在，请先 npm install）"
fi

# 10. 验证零残留
log "验证零 gitnexus 残留..."
RESIDUAL=$(grep -ri "gitnexus" "$OSS/src/" 2>/dev/null | wc -l)
if [ "$RESIDUAL" -gt 0 ]; then
  warn "发现 $RESIDUAL 处 gitnexus 残留引用"
  grep -ri "gitnexus" "$OSS/src/" || true
  exit 1
fi
log "✅ 零 gitnexus 残留"

log "同步完成！"
log "下一步:"
log "  1. cd $OSS && npm install --ignore-scripts"
log "  2. npx tsc --noEmit"
log "  3. npx vitest run"
log "  4. git add -A && git commit -m 'sync: align with internal v$(node -p \"require('./package.json').version\")'"
