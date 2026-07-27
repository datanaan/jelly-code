/**
 * Tree-sitter parser loader — replaces jelly-code's ../tree-sitter/parser-loader.js
 *
 * Loads tree-sitter parsers and languages on demand.
 * Each language binding is lazy-loaded to avoid startup cost for unused languages.
 */

import type Parser from 'tree-sitter';
import { SupportedLanguages } from '@shared';

/** Map from SupportedLanguages enum to tree-sitter npm package names */
const LANGUAGE_PACKAGES: Record<string, string> = {
  [SupportedLanguages.JavaScript]: 'tree-sitter-javascript',
  [SupportedLanguages.TypeScript]: 'tree-sitter-typescript',
  [SupportedLanguages.Python]: 'tree-sitter-python',
  [SupportedLanguages.Java]: 'tree-sitter-java',
  [SupportedLanguages.C]: 'tree-sitter-c',
  [SupportedLanguages.CPlusPlus]: 'tree-sitter-cpp',
  [SupportedLanguages.CSharp]: 'tree-sitter-c-sharp',
  [SupportedLanguages.Go]: 'tree-sitter-go',
  [SupportedLanguages.Ruby]: 'tree-sitter-ruby',
  [SupportedLanguages.Rust]: 'tree-sitter-rust',
  [SupportedLanguages.PHP]: 'tree-sitter-php',
  [SupportedLanguages.Kotlin]: 'tree-sitter-kotlin',
  [SupportedLanguages.Swift]: 'tree-sitter-swift',
  [SupportedLanguages.Dart]: 'tree-sitter-dart',
};

/** Cache for loaded language modules */
const languageCache = new Map<string, unknown>();

/** Cache for loaded parser modules */
const parserCache = new Map<string, unknown>();

/**
 * Check if a tree-sitter parser mapping exists for the given language.
 * Only checks the LANGUAGE_PACKAGES registry — does NOT verify the npm package
 * is installed. Actual availability is confirmed by loadParser() returning non-null.
 */
export function isLanguageAvailable(language: SupportedLanguages | string): boolean {
  return language in LANGUAGE_PACKAGES;
}

/**
 * Load a tree-sitter Language object for the given language.
 * Returns null if the language is not available.
 */
export async function loadLanguage(language: SupportedLanguages | string): Promise<unknown | null> {
  const cached = languageCache.get(language);
  if (cached) return cached;

  const pkg = LANGUAGE_PACKAGES[language];
  if (!pkg) return null;

  try {
    // tree-sitter language packages export a `language` property or default
    const mod = await import(pkg);

    // Handle packages that export multiple languages under named exports
    // tree-sitter-typescript → { typescript, tsx }
    if (pkg === 'tree-sitter-typescript') {
      const tsLang = (mod.default as Record<string, unknown>)?.typescript ?? mod.typescript;
      if (tsLang) { languageCache.set(language, tsLang); return tsLang; }
    }
    // tree-sitter-php → { php_only }
    if (pkg === 'tree-sitter-php') {
      const phpLang = (mod.default as Record<string, unknown>)?.php_only ?? mod.php_only;
      if (phpLang) { languageCache.set(language, phpLang); return phpLang; }
    }

    // Standard export formats:
    // For 0.21.x language packages, the default export IS the Language object (has .name, .language, .nodeTypeInfo).
    // The .language property on it is a getter that serializes as {} — do NOT use it.
    // For some packages, the language may be under mod.language directly.
    const lang = mod.default ?? mod.language ?? mod;

    languageCache.set(language, lang);
    return lang;
  } catch (error) {
    console.warn(`[parser-loader] Failed to load language ${language}:`, error);
    return null;
  }
}

/**
 * Load a tree-sitter Parser with the given language set.
 * Returns null if the language is not available.
 */
export async function loadParser(language: SupportedLanguages | string): Promise<Parser | null> {
  if (!language) {
    console.warn('[parser-loader] loadParser called without language parameter');
    return null;
  }
  const cached = parserCache.get(language);
  if (cached) return cached as Parser;

  const lang = await loadLanguage(language);
  if (!lang) return null;

  try {
    const ParserClass = (await import('tree-sitter')).default;
    const parser = new ParserClass();

    // Set the language on the parser (use any — Language type differs across tree-sitter versions)
    parser.setLanguage(typeof lang === 'function' ? lang() : lang);

    parserCache.set(language, parser);
    return parser;
  } catch (error) {
    console.warn(`[parser-loader] Failed to create parser for ${language}:`, error);
    return null;
  }
}
