/**
 * Re-export SupportedLanguages from @shared.
 *
 * This file exists because ingestion/call-sites/extract-language-call-site.ts
 * imports from ../../../config/supported-languages.js instead of @shared.
 * It simply re-exports from the canonical source.
 */
export { SupportedLanguages } from '@shared';
