/**
 * Repository Clone Cache Manager
 *
 * Replaces the temp-directory clone strategy with persistent clone directories.
 * Supports `git fetch + reset` incremental updates instead of re-cloning
 * on every analysis run.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { dirname } from 'path';

export interface RepoCacheConfig {
  cacheDir: string;
  fullClone: boolean;
  cloneTimeout: number;
  fetchTimeout: number;
}

export class RepoCacheManager {
  readonly cacheDir: string;
  readonly fullClone: boolean;
  readonly cloneTimeout: number;
  readonly fetchTimeout: number;

  constructor(config: RepoCacheConfig) {
    this.cacheDir = config.cacheDir;
    this.fullClone = config.fullClone;
    this.cloneTimeout = config.cloneTimeout;
    this.fetchTimeout = config.fetchTimeout;

    // Ensure cache root exists
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Ensure a clone exists and is up-to-date.
   *
   * - If the directory already exists: `git fetch --all --prune && git reset --hard origin/HEAD && git clean -fd`
   * - If not: `git clone <gitUrl> <dir>` (full or shallow based on config)
   * - On fetch failure: delete directory and re-clone
   *
   * Returns the local path of the cloned repository.
   */
  async ensureClone(gitUrl: string, _projectId: string): Promise<string> {
    // Validate gitUrl to prevent command injection
    const GIT_URL_RE = /^(https?|git|ssh|file):\/\/[^\s"'`\\;|&$()]+$/;
    if (!GIT_URL_RE.test(gitUrl)) {
      throw new Error(`Invalid gitUrl: contains disallowed characters (possible injection)`);
    }

    const dirName = this.sanitizeUrlToDirName(gitUrl);
    const localPath = `${this.cacheDir}/${dirName}`;

    if (existsSync(localPath) && existsSync(`${localPath}/.git`)) {
      console.log(`[repo-cache] Updating existing clone: ${localPath}`);
      try {
        this.exec(`git fetch --all --prune`, localPath, this.fetchTimeout);
        this.exec(`git reset --hard origin/HEAD`, localPath, 60_000);
        this.exec(`git clean -fd`, localPath, 60_000);
      } catch (fetchError) {
        console.warn(`[repo-cache] Fetch failed, re-cloning: ${fetchError instanceof Error ? fetchError.message : fetchError}`);
        try {
          rmSync(localPath, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
        return this.doClone(gitUrl, localPath);
      }
    } else {
      console.log(`[repo-cache] Cloning ${gitUrl} → ${localPath}`);
      // Ensure parent directory exists
      mkdirSync(dirname(localPath), { recursive: true });
      return this.doClone(gitUrl, localPath);
    }

    return localPath;
  }

  /**
   * Get the current HEAD commit hash of a local clone.
   */
  getHeadCommit(localPath: string): string {
    return this.exec('git rev-parse HEAD', localPath, 10_000).trim();
  }

  /**
   * Get the local path for a git URL without cloning.
   * Returns undefined if not yet cloned.
   */
  getLocalPath(gitUrl: string): string | undefined {
    const dirName = this.sanitizeUrlToDirName(gitUrl);
    const localPath = `${this.cacheDir}/${dirName}`;
    return existsSync(localPath) && existsSync(`${localPath}/.git`) ? localPath : undefined;
  }

  /**
   * Convert a git URL to a deterministic directory name.
   *
   * - Strip protocol prefix
   * - Replace non-alphanumeric chars with `-`
   * - Truncate to 60 chars + append md5(url)[:8] for uniqueness
   */
  sanitizeUrlToDirName(url: string): string {
    let cleaned = url
      .replace(/^file:\/\//, '')   // file:///path or file://host/path
      .replace(/^https?:\/\//, '')
      .replace(/^git:\/\//, '')
      .replace(/^ssh:\/\//, '')
      .replace(/^git@/, '')
      .replace(/\.git$/, '');

    // Replace non-safe chars with dash
    cleaned = cleaned.replace(/[^a-zA-Z0-9._-]/g, '-');

    // Remove leading/trailing dashes and collapse multiple dashes
    cleaned = cleaned.replace(/-+/g, '-').replace(/^-|-$/g, '');

    // Truncate and append hash for uniqueness
    const hash = createHash('md5').update(url).digest('hex').slice(0, 8);
    if (cleaned.length > 60) {
      cleaned = cleaned.slice(0, 60);
    }

    return `${cleaned}-${hash}`;
  }

  private doClone(gitUrl: string, localPath: string): string {
    const depthArg = this.fullClone ? '' : '--depth 1';
    this.exec(`git clone ${depthArg} "${gitUrl}" "${localPath}"`, undefined, this.cloneTimeout);
    return localPath;
  }

  private exec(cmd: string, cwd: string | undefined, timeout: number): string {
    return execSync(cmd, {
      cwd: cwd || undefined,
      stdio: 'pipe',
      timeout,
      encoding: 'utf-8',
    });
  }
}
