/**
 * Language-aware ignore profiles
 *
 * Returns language-specific ignore patterns for common build artifacts,
 * dependency directories, and generated files that should be excluded
 * during code indexing.
 *
 * Used by the filesystem walker to complement the base ignore-service
 * with patterns specific to the detected project language.
 */

/**
 * Map of language -> ignore patterns.
 *
 * NOTE: Some patterns here intentionally overlap with DEFAULT_IGNORE_PATTERNS
 * in ignore-service.ts (e.g., node_modules, .pyc, *.class, dist, build, target).
 * The overlap is harmless — language profiles provide language context for
 * vendor/dependency detection, and redundant ignore entries are fine.
 */
const LANGUAGE_PROFILES: Record<string, string[]> = {
  javascript: [
    'node_modules',
    'bower_components',
    'dist',
    'build',
    'out',
    '.npm',
    '.yarn',
    '*.min.js',
    '*.min.css',
    '*.map',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.cache',
    '.parcel-cache',
    '.turbo',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
  ],

  cpp: [
    '*.o',
    '*.obj',
    '*.so',
    '*.dll',
    '*.dylib',
    '*.a',
    '*.lib',
    '*.pdb',
    '*.exe',
    '*.ilk',
    '*.exp',
    'cmake-build-debug',
    'cmake-build-release',
    'CMakeFiles',
    'CMakeCache.txt',
    'Debug',
    'Release',
    '.vs',
    '*.ipdb',
    '*.iobj',
  ],

  rust: [
    'target/',
    'Cargo.lock',
    '*.rs.bk',
  ],

  python: [
    '__pycache__',
    '*.pyc',
    '*.pyo',
    '*.pyd',
    '*.egg-info',
    '*.egg-link',
    'dist',
    'build',
    '.eggs',
    '.mypy_cache',
    '.pytest_cache',
    '.tox',
    '.ruff_cache',
    '.venv',
    'venv',
    'env',
    '.coverage',
    'htmlcov',
    '*.whl',
  ],

  go: [
    'vendor',
    '*.exe',
    '*.exe~',
    '*.test',
    '*.out',
    'bin',
    '*.prof',
  ],

  java: [
    'target',
    'build',
    '.gradle',
    'gradle-app.setting',
    '*.class',
    '*.jar',
    '*.war',
    '*.ear',
    '*.nar',
    'bin',
    '.classpath',
    '.project',
    '.settings',
    'node_modules',
  ],

  ruby: [
    'vendor/bundle',
    '.bundle',
    'Gemfile.lock',
    '*.gem',
    '.ruby-version',
    '.rvmrc',
    '_yardoc',
    'doc',
    '.yardoc',
  ],

  csharp: [
    'bin',
    'obj',
    'packages',
    '*.nupkg',
    '*.snupkg',
    '*.suo',
    '*.user',
    '*.userosscache',
    '*.sln.docstates',
    '.vs',
    '.dotnet',
  ],
};

/**
 * Get language-specific ignore patterns for the given language.
 *
 * @param language - Language identifier (e.g., 'javascript', 'cpp', 'rust', 'python', 'go', 'java')
 * @returns Array of ignore pattern strings, or empty array if language is unknown
 */
export function getLanguageIgnorePatterns(language: string): string[] {
  const normalized = language.toLowerCase();
  return LANGUAGE_PROFILES[normalized]?.slice() ?? [];
}

/** File extension -> language mapping for detection */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'javascript',
  '.svelte': 'javascript',
  '.c': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.rs': 'rust',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'java',
  '.scala': 'java',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.gemspec': 'ruby',
  '.cs': 'csharp',
  '.vb': 'csharp',
};

/** Config files that hint at language */
const CONFIG_FILE_LANGUAGE_MAP: Record<string, string> = {
  'package.json': 'javascript',
  'tsconfig.json': 'javascript',
  'Cargo.toml': 'rust',
  'setup.py': 'python',
  'setup.cfg': 'python',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'go.mod': 'go',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  'cmakelists.txt': 'cpp',
  'makefile': 'cpp',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  'nuget.config': 'csharp',
};

/**
 * Detect the primary language of a project from its file list.
 *
 * Uses both file extensions and known config filenames to determine
 * the dominant language.
 *
 * @param files - List of file paths in the repository
 * @returns Detected language identifier, or null if no recognized language
 */
export function detectLanguageFromFiles(files: string[]): string | null {
  if (files.length === 0) return null;

  const counts: Record<string, number> = {};

  for (const file of files) {
    const basename = file.split('/').pop() ?? file;
    const lowerBasename = basename.toLowerCase();

    // Check config files (higher weight)
    if (CONFIG_FILE_LANGUAGE_MAP[lowerBasename]) {
      const lang = CONFIG_FILE_LANGUAGE_MAP[lowerBasename];
      counts[lang] = (counts[lang] ?? 0) + 3; // config files weighted higher
      continue;
    }

    // Check file extensions
    const dotIndex = basename.lastIndexOf('.');
    if (dotIndex >= 0) {
      const ext = basename.slice(dotIndex).toLowerCase();
      if (EXTENSION_LANGUAGE_MAP[ext]) {
        const lang = EXTENSION_LANGUAGE_MAP[ext];
        counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }
  }

  const entries = Object.entries(counts);
  if (entries.length === 0) return null;

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}
