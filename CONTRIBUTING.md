# Contributing to jelly-code

## 开发流程

1. Fork 本仓库
2. 创建特性分支: `git checkout -b feature/my-feature`
3. 提交变更: `git commit -am 'feat: add my feature'`
4. 推送到分支: `git push origin feature/my-feature`
5. 提交 Pull Request

## 提交信息规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — 新功能
- `fix:` — Bug 修复
- `docs:` — 文档变更
- `refactor:` — 重构
- `test:` — 测试
- `chore:` — 构建/工具

## 代码风格

- TypeScript strict 模式
- ES2022 目标
- Node16 模块解析
- 所有公共 API 必须有 JSDoc 注释

## 测试

```bash
# 运行全部测试
npm test

# 运行单个测试文件
npx vitest run test/unit/parser-loader.test.ts

# 运行测试并 watch
npm run test:watch
```

## 添加新语言

1. 在 `src/shared/languages.ts` 的 `SupportedLanguages` 枚举中添加新成员
2. 在 `src/core/ingestion/languages/` 下创建语言分析器文件
3. 在 `src/core/ingestion/languages/index.ts` 中注册
4. 在 `src/core/tree-sitter/parser-loader.ts` 中添加 tree-sitter 包名映射
5. 添加对应 tree-sitter 依赖到 `package.json`

## Pull Request 检查清单

- [ ] 测试通过 (`npm test`)
- [ ] 编译通过 (`npm run lint`)
- [ ] 新增功能有对应的测试
- [ ] 文档已更新
- [ ] 遵循提交信息规范
