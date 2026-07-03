/**
 * Tests: Tree-sitter Parser Loader — 深层测试（真实解析器）
 *
 * Covers:
 * 1. isLanguageAvailable — 纯逻辑，零 mock
 * 2. LANGUAGE_PACKAGES — 14 语言完整性
 * 3. loadLanguage — 真实动态 import，标准导出格式
 * 4. loadLanguage 缓存 — 第二次调用不重新导入
 * 5. loadLanguage 特殊语言 — TypeScript (typescript/tsx) + PHP (php_only) 多导出分发
 * 6. loadParser — 真实 Parser 创建，setLanguage，parse 执行
 * 7. loadParser 缓存 — 第二次调用复用 parserCache
 * 8. 真实代码解析 — 用 loadParser 解析 JS/TS 代码验证 AST 正确
 * 9. 并发安全 — 同一语言并发 loadLanguage/loadParser 不冲突
 *
 * 所有测试使用真实 tree-sitter 包（已安装在 node_modules/），零 mock。
 */

import { describe, it, expect } from 'vitest';

// ====================================================================
// Layer 1: 纯逻辑 (零 mock，零 I/O)
// ====================================================================

describe('isLanguageAvailable', () => {
  it('14 种 tree-sitter 语言均应返回 true', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');

    const tsLangs = [
      'javascript', 'typescript', 'python', 'java',
      'c', 'cpp', 'csharp', 'go', 'ruby', 'rust',
      'php', 'kotlin', 'swift', 'dart',
    ];

    for (const lang of tsLangs) {
      expect(isLanguageAvailable(lang)).toBe(true);
    }
  });

  it('Cobol 不支持 tree-sitter 应返回 false', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isLanguageAvailable('cobol')).toBe(false);
  });

  it('未知语言字符串返回 false', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isLanguageAvailable('brainfuck')).toBe(false);
    expect(isLanguageAvailable('')).toBe(false);
  });

  it('区分大小写 — JavaScript(大写) 返回 false', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isLanguageAvailable('JavaScript')).toBe(false);
    expect(isLanguageAvailable('TypeScript')).toBe(false);
  });
});

describe('LANGUAGE_PACKAGES 完整性', () => {
  it('14 种语言的 package name 映射全部存在', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');

    expect(isLanguageAvailable('javascript')).toBe(true);
    expect(isLanguageAvailable('typescript')).toBe(true);
    expect(isLanguageAvailable('python')).toBe(true);
    expect(isLanguageAvailable('java')).toBe(true);
    expect(isLanguageAvailable('c')).toBe(true);
    expect(isLanguageAvailable('cpp')).toBe(true);
    expect(isLanguageAvailable('csharp')).toBe(true);
    expect(isLanguageAvailable('go')).toBe(true);
    expect(isLanguageAvailable('ruby')).toBe(true);
    expect(isLanguageAvailable('rust')).toBe(true);
    expect(isLanguageAvailable('php')).toBe(true);
    expect(isLanguageAvailable('kotlin')).toBe(true);
    expect(isLanguageAvailable('swift')).toBe(true);
    expect(isLanguageAvailable('dart')).toBe(true);

    // Cobol 无 tree-sitter 支持
    expect(isLanguageAvailable('cobol')).toBe(false);
  });
});

// ====================================================================
// Layer 2: loadLanguage — 真实动态 import
// ====================================================================

describe('loadLanguage — 真实导入', () => {
  it('JavaScript 应成功加载语言对象', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const lang = await loadLanguage('javascript');

    expect(lang).not.toBeNull();
    expect(typeof lang).toBe('object');
    expect((lang as any)?.name).toBe('javascript');
  });

  it('TypeScript 应成功加载语言对象', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const lang = await loadLanguage('typescript');

    expect(lang).not.toBeNull();
    expect(typeof lang).toBe('object');
  });

  it('Python 应成功加载语言对象', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const lang = await loadLanguage('python');

    expect(lang).not.toBeNull();
    expect(typeof lang).toBe('object');
  });

  it('Cobol 返回 null（无 package）', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const lang = await loadLanguage('cobol');
    expect(lang).toBeNull();
  });

  it('空字符串返回 null', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const lang = await loadLanguage('');
    expect(lang).toBeNull();
  });

  it('未知语言字符串返回 null', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const lang = await loadLanguage('nonexistent');
    expect(lang).toBeNull();
  });
});

// ====================================================================
// Layer 3: 缓存行为
// ====================================================================

describe('loadLanguage 缓存', () => {
  it('首次调用应返回对象，再次调用应返回相同引用（缓存命中）', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');

    // 首次调用 — 触发动态 import
    const first = await loadLanguage('javascript');
    expect(first).not.toBeNull();

    // 再次调用 — 应命中缓存（同引用）
    const second = await loadLanguage('javascript');
    expect(second).toBe(first);
  });
});

describe('loadParser 缓存', () => {
  it('首次调用返回 Parser，再次调用返回相同 Parser 实例', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');

    const first = await loadParser('javascript');
    expect(first).not.toBeNull();

    const second = await loadParser('javascript');
    expect(second).toBe(first);
  });
});

// ====================================================================
// Layer 4: loadParser — 真实 Parser 创建 + 解析
// ====================================================================

describe('loadParser — 真实解析', () => {
  it('JavaScript Parser 应能解析代码并生成 AST', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const parser = await loadParser('javascript');

    expect(parser).not.toBeNull();

    const tree = parser!.parse('function hello() { return 42; }');
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.children.length).toBeGreaterThan(0);

    // 验证能找到函数定义
    const funcNode = tree.rootNode.children[0];
    expect(funcNode.type).toBe('function_declaration');
  });

  it('TypeScript Parser 应能解析 TS 特有语法', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const parser = await loadParser('typescript');

    expect(parser).not.toBeNull();

    const tree = parser!.parse('interface User { name: string; age: number; }');
    expect(tree.rootNode.type).toBe('program');

    // TypeScript 特有语法
    const interfaceNode = tree.rootNode.children[0];
    expect(interfaceNode.type).toBe('interface_declaration');
  });

  it('空语言参数返回 null', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const parser = await loadParser('');
    expect(parser).toBeNull();
  });

  it('未知语言返回 null', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const parser = await loadParser('nonexistent-lang');
    expect(parser).toBeNull();
  });
});

// ====================================================================
// Layer 5: 并发安全
// ====================================================================

describe('并发安全', () => {
  it('同一语言的并发 loadLanguage 调用应全部返回', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');

    const results = await Promise.all([
      loadLanguage('javascript'),
      loadLanguage('javascript'),
      loadLanguage('javascript'),
    ]);

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r).not.toBeNull();
    }
    // 所有结果应为同一个缓存引用
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it('多语言并发 loadParser 应全部返回', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');

    const results = await Promise.all([
      loadParser('javascript'),
      loadParser('typescript'),
      loadParser('python'),
    ]);

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r).not.toBeNull();
    }
  });
});

// ====================================================================
// Layer 6: isLanguageAvailable + loadLanguage + loadParser 串联测试
// ====================================================================

describe('串联集成', () => {
  it('isLanguageAvailable → loadLanguage → loadParser → parse 完整链路', async () => {
    const mod = await import('../../src/core/tree-sitter/parser-loader.js');

    expect(mod.isLanguageAvailable('javascript')).toBe(true);

    const lang = await mod.loadLanguage('javascript');
    expect(lang).not.toBeNull();

    const parser = await mod.loadParser('javascript');
    expect(parser).not.toBeNull();

    const tree = parser!.parse('const x: number = 1;');
    // 至少能解析出 program 节点
    expect(tree.rootNode.type).toBe('program');
  });

  it('多个语言逐一可用', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');

    const langs = ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'php'];
    for (const lang of langs) {
      const parser = await loadParser(lang);
      expect(parser, `Parser for ${lang} should not be null`).not.toBeNull();
    }
  }, 30000);  // 多语言加载可能需要更多时间
});
