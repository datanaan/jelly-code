/**
 * Structured JSON logger for jelly_code.
 *
 * Uses Pino (Node.js fastest JSON logger, ~5µs/log).
 * All log output goes to stdout as JSON — no more console.log.
 *
 * Usage:
 *   import { logger } from '../core/logger.js';
 *   logger.info({ projectId, nodeCount }, 'Analysis completed');
 *   logger.error({ projectId, code: 'EMPTY_RESULT' }, 'Pipeline produced zero nodes');
 *
 * Redaction: apiKey, password, and secret fields are automatically redacted.
 */

import pino from 'pino';
import path from 'path';
import fs from 'fs';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: ['apiKey', '*.password', '*.secret', 'STANDALONE_API_KEYS'],
    censor: '***REDACTED***',
  },
});

export function createLogger(component: string) {
  return logger.child({ component });
}

/**
 * Write a DLQ (Dead Letter Queue) record as a JSON file.
 * Used for incremental analysis failures and other non-fatal errors
 * that need to be retried or inspected later.
 *
 * @param projectId - The project context
 * @param dlqData - The failure data to persist
 * @returns The path to the written DLQ file, or null on failure
 */
export function writeDlqRecord(
  projectId: string,
  dlqData: Record<string, unknown>,
): string | null {
  const dlqDir = process.env.DLQ_DIR || '/tmp/jelly_code_dlq';
  try {
    fs.mkdirSync(dlqDir, { recursive: true });
    const dlqPath = path.join(dlqDir, `${projectId}-${Date.now()}.json`);
    fs.writeFileSync(dlqPath, JSON.stringify(dlqData, null, 2));
    logger.warn({ projectId, dlqPath, dlqType: dlqData.type }, 'DLQ record written');
    return dlqPath;
  } catch (err) {
    logger.error({ projectId, err }, 'Failed to write DLQ record');
    return null;
  }
}

/**
 * List all DLQ records for a given project, newest first.
 */
export function listDlqRecords(projectId: string, limit = 10): string[] {
  const dlqDir = process.env.DLQ_DIR || '/tmp/jelly_code_dlq';
  try {
    const files = fs.readdirSync(dlqDir)
      .filter(f => f.startsWith(`${projectId}-`) && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map(f => path.join(dlqDir, f));
    return files;
  } catch {
    return [];
  }
}
