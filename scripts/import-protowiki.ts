/**
 * Import protowiki pages from jelly-llm-wiki into Neo4j.
 *
 * Reads the 262 Markdown files from learn_projects/jelly-llm-wiki/wiki/entities/
 * and writes them as WikiEntity and WikiSource nodes to Neo4j via WikiGraph.
 *
 * Usage:
 *   cd /data/openclaw_opencode_test_space/projects/jelly_code
 *   npx tsx scripts/import-protowiki.ts
 *
 * Environment variables (from .env):
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import fs from 'node:fs';
import path from 'node:path';
import { WikiGraph } from '../src/wiki/graph.js';
import type { WikiEntity, WikiSource } from '../src/wiki/models.js';
import { createStoreSet } from '../src/store/factory.js';
import { loadConfig } from '../src/config/index.js';

const WIKI_DIR = path.resolve(
  __dirname,
  '../../learn_projects/jelly-llm-wiki/wiki/entities',
);

interface ParsedEntity {
  name: string;
  entityType: string;
  firstCompiled: string;
  definition: string;
  details: string;
  links: Array<{ target: string; relationship: string }>;
  sources: string[];
}

interface ParsedSource {
  id: string;
  title: string;
  sourcePath: string;
  summary: string;
  keyPoints: string[];
  compiledAt: string;
  extractedEntities: Array<{ target: string; reason: string }>;
}

/**
 * Parse a protowiki entity Markdown file.
 * Handles two formats:
 * 1. Entity: # Name / > 类型：xxx / > 首次编译：xxx
 * 2. Source: # Title / > 来源：xxx / > 编译日期：xxx
 */
function parseFile(filePath: string, content: string): { type: 'entity' | 'source'; data: ParsedEntity | ParsedSource } | null {
  const lines = content.split('\n');
  if (lines.length === 0 || !lines[0].startsWith('# ')) return null;

  const title = lines[0].replace(/^# /, '').trim();

  // Check if this is a source file (starts with source-)
  if (path.basename(filePath).startsWith('source-')) {
    return parseSourceFile(filePath, title, content);
  }

  return parseEntityFile(filePath, title, content);
}

function parseSourceFile(filePath: string, title: string, content: string): { type: 'source'; data: ParsedSource } | null {
  const sourcePathMatch = content.match(/来源[：:]\s*(.+)/);
  const compiledAtMatch = content.match(/编译日期[：:]\s*(.+)/);

  // Extract sections
  const summaryMatch = content.match(/## 摘要\s*\n([\s\S]*?)(?=\n## |\n$)/);
  const keyPointsMatch = content.match(/## 关键要点\s*\n([\s\S]*?)(?=\n## |\n$)/);
  const entitiesMatch = content.match(/## 提取的实体\s*\n([\s\S]*?)(?=\n## |\n$)/);

  const summary = summaryMatch ? summaryMatch[1].trim() : '';
  const keyPoints = keyPointsMatch
    ? keyPointsMatch[1].split('\n')
        .filter(l => l.trim().startsWith('- '))
        .map(l => l.replace(/^-\s*/, '').trim())
    : [];

  const extractedEntities = entitiesMatch
    ? entitiesMatch[1].split('\n')
        .filter(l => l.includes('[['))
        .map(l => {
          const targetMatch = l.match(/\[\[([^\]]+)\]\]/);
          const reasonMatch = l.match(/\]\]\s*[—-]\s*(.+)/);
          return {
            target: targetMatch ? targetMatch[1] : '',
            reason: reasonMatch ? reasonMatch[1].trim() : '',
          };
        })
        .filter(e => e.target)
    : [];

  const baseName = path.basename(filePath, '.md');
  return {
    type: 'source',
    data: {
      id: baseName,
      title,
      sourcePath: sourcePathMatch ? sourcePathMatch[1].trim() : '',
      summary,
      keyPoints,
      compiledAt: compiledAtMatch ? compiledAtMatch[1].trim() : '2026-04-23',
      extractedEntities,
    },
  };
}

function parseEntityFile(filePath: string, title: string, content: string): { type: 'entity'; data: ParsedEntity } | null {
  const typeMatch = content.match(/类型[：:]\s*(.+)/);
  const compiledAtMatch = content.match(/首次编译[：:]\s*(.+)/);

  if (!typeMatch) return null; // Skip files without entity type

  const entityType = normalizeEntityType(typeMatch[1].trim());

  // Extract sections
  const definitionMatch = content.match(/## 定义\s*\n([\s\S]*?)(?=\n## |\n$)/);
  const detailsMatch = content.match(/## 详情\s*\n([\s\S]*?)(?=\n## |\n$)/);
  const linksMatch = content.match(/## 关联实体\s*\n([\s\S]*?)(?=\n## |\n$)/);
  const sourcesMatch = content.match(/## 来源\s*\n([\s\S]*?)(?=\n## |\n$)/);

  const definition = definitionMatch ? definitionMatch[1].trim() : '';
  const details = detailsMatch ? detailsMatch[1].trim() : '';

  const links = linksMatch
    ? linksMatch[1].split('\n')
        .filter(l => l.includes('[['))
        .map(l => {
          const targetMatch = l.match(/\[\[([^\]]+)\]\]/);
          const relMatch = l.match(/\]\]\s*[—-]\s*(.+)/);
          return {
            target: targetMatch ? targetMatch[1] : '',
            relationship: relMatch ? relMatch[1].trim() : '',
          };
        })
        .filter(l => l.target)
    : [];

  const sources = sourcesMatch
    ? sourcesMatch[1].split('\n')
        .filter(l => l.includes('[['))
        .map(l => {
          const m = l.match(/\[\[([^\]]+)\]\]/);
          return m ? m[1] : '';
        })
        .filter(Boolean)
    : [];

  return {
    type: 'entity',
    data: {
      name: title,
      entityType,
      firstCompiled: compiledAtMatch ? compiledAtMatch[1].trim() : '2026-04-23',
      definition,
      details,
      links,
      sources,
    },
  };
}

function normalizeEntityType(raw: string): string {
  const mapping: Record<string, string> = {
    '概念': 'concept',
    '项目': 'project',
    '服务': 'service',
    'API': 'api',
  };
  return mapping[raw] || 'concept';
}

async function main() {
  console.log('=== Protowiki Import Script ===');
  console.log(`Reading from: ${WIKI_DIR}`);

  if (!fs.existsSync(WIKI_DIR)) {
    console.error(`Wiki directory not found: ${WIKI_DIR}`);
    process.exit(1);
  }

  const config = loadConfig();
  const stores = createStoreSet(config);
  const wiki = new WikiGraph(stores.graph);

  // Initialize schema (includes Wiki labels)
  await stores.graph.initializeSchema();
  console.log('Schema initialized.');

  const files = fs.readdirSync(WIKI_DIR).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} Markdown files.`);

  let entitiesCreated = 0;
  let sourcesCreated = 0;
  let linksCreated = 0;
  let errors: Array<{ file: string; error: string }> = [];

  // First pass: parse all files
  const parsedEntities = new Map<string, ParsedEntity>();
  const parsedSources = new Map<string, ParsedSource>();

  for (const file of files) {
    try {
      const filePath = path.join(WIKI_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const result = parseFile(filePath, content);

      if (!result) continue;

      if (result.type === 'entity') {
        parsedEntities.set(file.replace('.md', ''), result.data);
      } else {
        parsedSources.set((result.data as ParsedSource).id, result.data as ParsedSource);
      }
    } catch (err) {
      errors.push({ file, error: String(err) });
    }
  }

  console.log(`Parsed: ${parsedEntities.size} entities, ${parsedSources.size} sources, ${errors.length} errors`);

  // Second pass: write to Neo4j
  // Sources first
  for (const [id, src] of parsedSources) {
    try {
      const wikiSource: WikiSource = {
        id: src.id,
        title: src.title,
        sourcePath: src.sourcePath,
        summary: src.summary,
        keyPoints: src.keyPoints,
        compiledAt: src.compiledAt,
      };
      await wiki.createSource(wikiSource);
      sourcesCreated++;

      // Create EXTRACTS relations
      for (const extracted of src.extractedEntities) {
        const entityId = extracted.target;
        if (parsedEntities.has(entityId)) {
          await wiki.createExtractsRelation(src.id, entityId, extracted.reason);
          linksCreated++;
        }
      }
    } catch (err) {
      errors.push({ file: id, error: String(err) });
    }
  }

  // Then entities
  for (const [id, ent] of parsedEntities) {
    try {
      const entityId = id; // kebab-case from filename
      const wikiEntity: WikiEntity = {
        id: entityId,
        name: ent.name,
        entityType: ent.entityType as WikiEntity['entityType'],
        definition: ent.definition,
        details: ent.details,
        firstCompiled: ent.firstCompiled,
        lastUpdated: ent.firstCompiled,
      };
      await wiki.createEntity(wikiEntity);
      entitiesCreated++;

      // Create LINKS_TO relations
      for (const link of ent.links) {
        if (parsedEntities.has(link.target)) {
          await wiki.createLinksToRelation(entityId, link.target, link.relationship);
          linksCreated++;
        }
      }

      // Create SOURCED_FROM relations
      for (const sourceId of ent.sources) {
        if (parsedSources.has(sourceId)) {
          await wiki.createSourcedFromRelation(entityId, sourceId, '');
        }
      }
    } catch (err) {
      errors.push({ file: id, error: String(err) });
    }
  }

  // Consistency check: find broken [[links]]
  const allEntityIds = new Set(parsedEntities.keys());
  let brokenLinks = 0;
  for (const [id, ent] of parsedEntities) {
    for (const link of ent.links) {
      if (!allEntityIds.has(link.target)) {
        brokenLinks++;
      }
    }
  }

  // Append log entry
  await wiki.appendLog({
    id: `log-import-${Date.now()}`,
    action: 'batch_ingest',
    description: `Imported protowiki: ${entitiesCreated} entities, ${sourcesCreated} sources`,
    details: JSON.stringify({ entitiesCreated, sourcesCreated, linksCreated, brokenLinks, errors: errors.length }),
    pageCount: entitiesCreated + sourcesCreated,
    createdAt: new Date().toISOString(),
  });

  console.log('\n=== Import Results ===');
  console.log(`Entities created: ${entitiesCreated}`);
  console.log(`Sources created: ${sourcesCreated}`);
  console.log(`Links created: ${linksCreated}`);
  console.log(`Broken links (target not found): ${brokenLinks}`);
  console.log(`Errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log('\nError details:');
    for (const e of errors.slice(0, 10)) {
      console.log(`  - ${e.file}: ${e.error}`);
    }
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more`);
    }
  }

  await stores.graph.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
