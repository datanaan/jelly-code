import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadCredential, maskCredential } from '../../../src/core/resilience/credential-loader.js';

describe('CredentialLoader', () => {
  const ORIG_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIG_ENV }; });

  it('uses apiKey directly when provided', () => {
    expect(loadCredential({ apiKey: 'sk-abc123' })).toBe('sk-abc123');
  });

  it('uses apiKeyEnv to read from env var', () => {
    process.env.MY_LLM_KEY = 'sk-from-env';
    expect(loadCredential({ apiKeyEnv: 'MY_LLM_KEY' })).toBe('sk-from-env');
  });

  it('uses apiKeyFile to read from file', async () => {
    const tmpFile = `/tmp/test-cred-${Date.now()}.txt`;
    await import('fs/promises').then(fs => fs.writeFile(tmpFile, 'sk-from-file\n'));
    expect(await loadCredential({ apiKeyFile: tmpFile })).toBe('sk-from-file');
  });

  it('priority: apiKeyFile > apiKeyEnv > apiKey', async () => {
    process.env.MY_KEY_ENV = 'env-value';
    const tmpFile = `/tmp/test-cred-prio-${Date.now()}.txt`;
    await import('fs/promises').then(fs => fs.writeFile(tmpFile, 'file-value'));
    expect(await loadCredential({
      apiKey: 'direct-value', apiKeyEnv: 'MY_KEY_ENV', apiKeyFile: tmpFile,
    })).toBe('file-value');
  });

  it('returns undefined when no credential configured', () => {
    expect(loadCredential({})).toBeUndefined();
  });

  // ─── CK-28: 凭证降级场景 ────────────────────────────────

  it('CK-28: apiKeyFile 不存在时降级到 apiKeyEnv', async () => {
    process.env.MY_LLM_KEY = 'sk-from-env';
    const result = loadCredential({
      apiKeyFile: '/nonexistent-key-file.txt',
      apiKeyEnv: 'MY_LLM_KEY',
      apiKey: 'fallback-key',
    });
    expect(result).toBe('sk-from-env');
  });

  it('CK-28: apiKeyFile 和 apiKeyEnv 都不存在时使用 apiKey', () => {
    const result = loadCredential({
      apiKeyFile: '/nonexistent-key-file.txt',
      apiKeyEnv: 'NONEXISTENT_ENV_VAR',
      apiKey: 'direct-fallback',
    });
    expect(result).toBe('direct-fallback');
  });

  it('CK-28: 文件不存在 + 无降级时返回 undefined（不崩溃）', () => {
    const result = loadCredential({
      apiKeyFile: '/nonexistent-key-file.txt',
    });
    expect(result).toBeUndefined();
  });

  it('maskCredential redacts middle of key', () => {
    expect(maskCredential('sk-abcdef1234567890')).toBe('sk-***7890');
    expect(maskCredential('short')).toBe('***');
    expect(maskCredential(undefined)).toBeUndefined();
  });
});
