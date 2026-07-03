/**
 * LLM prompt templates for Wiki compilation, merging, and synthesis.
 */

import type { EvolutionFacts } from '../wiki/evolution-facts-query.js';
import type { Chapter } from '../wiki/chapter-detector.js';

export const COMPILE_PROMPT = (content: string, existingEntities: string[]) => `你是一个知识编译器。将原始文档编译为结构化 Wiki 数据。

输入：原始文档内容
输出：严格 JSON 格式

${existingEntities.length > 0 ? `已有实体列表（不要重复创建，放入 existingUpdates）：\n${existingEntities.join(', ')}` : ''}

原始文档：
---
${content}
---

输出格式（严格 JSON，不要包含其他文字）：
{
  "title": "文档标题",
  "summary": "≤200字摘要",
  "keyPoints": ["要点1", "要点2"],
  "entities": [
    {
      "name": "entity-name",
      "type": "concept|project|service|api",
      "definition": "≤100字定义",
      "details": "技术细节描述",
      "links": [
        {"target": "existing-entity", "relationship": "关系说明"}
      ]
    }
  ],
  "existingUpdates": [
    {
      "entityName": "已存在实体名",
      "newInfo": "新增信息",
      "sourceSection": "引用章节"
    }
  ],
  "contradictions": [
    {
      "entityName": "冲突实体名",
      "description": "矛盾描述"
    }
  ]
}

规则：
- 实体命名用英文 kebab-case
- 只提取文档中明确提及的实体
- 不要添加原文中没有的评价
- 如果实体已存在（通过已有实体列表提供），合并更新而不要创建重复`;

export const MERGE_PROMPT = (entityName: string, existingDetails: string, newInfo: string) =>
  `合并以下两段关于 "${entityName}" 的描述，生成一份精炼的综合描述。

已有描述：
---
${existingDetails}
---

新增信息：
---
${newInfo}
---

要求：
1. 合并重复内容，不简单拼接
2. 保留所有独特信息
3. 如果有矛盾，保留最新信息并标注"⚠️ 矛盾"
4. 输出纯文本，不要 JSON
5. 控制在合理长度内`;

export const SYNTHESIZE_PROMPT = (question: string, contextPages: string) =>
  `基于以下 wiki 页面回答问题。引用实体时用 [[entity-name]] 格式。

问题：${question}

相关 Wiki 页面：
---
${contextPages}
---

要求：
1. 基于提供的页面内容回答，不要编造
2. 引用相关实体时用 [[entity-name]] 格式
3. 如果信息不足，明确说明
4. 回答简洁准确`;

// ─── Evolution Story Prompt (P2-T3) ──────────────────────────────

/**
 * Build the evolution story prompt for the narrator.
 *
 * This prompt is designed to minimize hallucination by:
 *   1. Providing all known facts as structured data
 *   2. Instructing the LLM to only use provided facts
 *   3. Requiring [commit:HASH] citations for every claim
 *   4. Explicitly prohibiting fabricated commit hashes
 *
 * @param facts — aggregated evolution facts (from T1)
 * @param chapters — detected evolution chapters (from T2)
 * @returns the prompt string to send to the LLM
 */
export function EVOLUTION_STORY_PROMPT(
  facts: EvolutionFacts,
  chapters: Chapter[],
): string {
  // Format commit facts
  const commitLines = facts.changedIn.length > 0
    ? facts.changedIn.map((c) =>
        `  - [commit:${c.commit}] ${c.timestamp} author=${c.author} +${c.additions}/-${c.deletions}`,
      ).join('\n')
    : '  (no commit data)';

  // Format evolvedFrom lineage
  const evoLines = facts.evolvedFrom.length > 0
    ? facts.evolvedFrom.map((e) =>
        `  - [commit:${e.commit}] ${e.from} → ${e.to} at ${e.timestamp}`,
      ).join('\n')
    : '  (no lineage data)';

  // Format authors
  const authorLines = facts.authoredBy.length > 0
    ? facts.authoredBy.map((a) =>
        `  - ${a.author}: ${a.commitCount} commits (${a.firstSeen.substring(0, 10)} to ${a.lastSeen.substring(0, 10)})`,
      ).join('\n')
    : '  (no author data)';

  // Format co-changes
  const coChangeLines = facts.coChangedWith.length > 0
    ? facts.coChangedWith.map((c) =>
        `  - ${c.nodeId}: ${c.coChangeCount} co-changes (jaccard=${c.jaccard.toFixed(3)})`,
      ).join('\n')
    : '  (no co-change data)';

  // Format chapters
  const chapterLines = chapters.length > 0
    ? chapters.map((ch) =>
        `  - ${ch.type} (${ch.from.substring(0, 10)} to ${ch.to.substring(0, 10)}): ${ch.description} [key commits: ${ch.keyCommits.join(', ')}]`,
      ).join('\n')
    : '  (no chapters detected)';

  return `You are a code archaeologist. Write a concise, factual evolution narrative for the symbol "${facts.nodeId}".

## Known Facts (use ONLY these — do NOT fabricate)

### Commits that changed this symbol:
${commitLines}

### Symbol lineage (renames/moves):
${evoLines}

### Contributors:
${authorLines}

### Frequently co-changed with:
${coChangeLines}

### Detected evolution phases:
${chapterLines}

## Rules (STRICT — violations are unacceptable):

1. **Anti-hallucination**: Only use the facts provided above. Do NOT invent commits, dates, authors, or events that are not listed.
2. **Citation required**: Every factual claim MUST include a [commit:HASH] citation using the exact hashes from the facts above.
3. **No fabricated hashes**: Only use [commit:HASH] with hashes that appear in the facts above. Using any hash not in the facts is strictly prohibited.
4. **Narrative flow**: Write in clear prose, grouping related changes into themes or phases.
5. **Length**: Keep the narrative between 100-300 words.
6. **Language**: Write in English.

## Output:

Write the narrative below. Do not include any meta-commentary or acknowledgments.`;
}
