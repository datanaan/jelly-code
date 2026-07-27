"""
Post-build: replace `@shared` path alias in compiled JS with relative paths.

TypeScript's `paths` alias (`@shared` → `./src/shared/index.ts`) is only
resolved at compile time for type-checking. At runtime, Node.js does NOT
understand `@shared` as a module name — it needs a real relative path.

This script walks `dist/` and rewrites `from '@shared'` / `require('@shared')`
to the correct relative path from each file's location to `dist/shared/index.js`.
"""

import os
import re
import sys

dist_dir = 'dist'
count = 0
errors = []

shared_rel = os.path.join(dist_dir, 'shared/index.js')

if not os.path.exists(shared_rel):
    print(f'[fix-shared-paths] 警告: {shared_rel} 不存在，跳过')
    sys.exit(0)

for root, dirs, files in os.walk(dist_dir):
    for f in files:
        if not (f.endswith('.js') or f.endswith('.d.ts') or f.endswith('.mjs')):
            continue
        fpath = os.path.join(root, f)

        # 跳过 shared/ 自身（不需要引用自己）
        if fpath.startswith(os.path.join(dist_dir, 'shared' + os.sep)):
            continue

        rel = os.path.relpath(shared_rel, os.path.dirname(fpath))

        with open(fpath, 'r') as fh:
            content = fh.read()

        # 替换 import ... from '@shared' 和 require('@shared')
        new_content = re.sub(
            r'''(["'])@shared(['"])''',
            lambda m: m.group(1) + rel + m.group(2),
            content
        )

        if new_content != content:
            with open(fpath, 'w') as fh:
                fh.write(new_content)
            count += 1
            print(f'  {fpath}: @shared → {rel}')

if count:
    print(f'[fix-shared-paths] ✅ 替换 {count} 个文件中的 @shared → 相对路径')
else:
    print('[fix-shared-paths] ✅ 无需替换')
