import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GEMINI_AFTER_AGENT_HOOK_FILENAME,
  GEMINI_HOOK_NAME,
  getGeminiHookSourcePath,
  installGeminiHook,
  removeGeminiHook,
} from '../../src/gemini/hook-installer.js';

describe('gemini hook installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mudcode-gemini-hook-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source hook file exists', () => {
    expect(existsSync(getGeminiHookSourcePath())).toBe(true);
  });

  it('installGeminiHook copies hook and updates settings.json', () => {
    const hookPath = installGeminiHook(undefined, tempDir);
    const settingsPath = join(tempDir, 'settings.json');

    expect(hookPath).toBe(join(tempDir, 'mudcode-hooks', GEMINI_AFTER_AGENT_HOOK_FILENAME));
    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const mode = statSync(hookPath).mode & 0o755;
    expect(mode).toBe(0o755);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ matcher?: string; hooks?: Array<{ name?: string; command?: string }> }>;
      };
    };

    const groups = settings.hooks?.AfterAgent || [];
    const wildcardGroup = groups.find((group) => group.matcher === '*' || group.matcher === '');
    expect(wildcardGroup).toBeDefined();
    expect(wildcardGroup?.hooks).toContainEqual(
      expect.objectContaining({
        name: GEMINI_HOOK_NAME,
        type: 'command',
        command: `'${hookPath}'`,
      })
    );
  });

  it('installGeminiHook is idempotent for settings hook entry', () => {
    const firstPath = installGeminiHook(undefined, tempDir);
    const secondPath = installGeminiHook(undefined, tempDir);
    expect(secondPath).toBe(firstPath);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ hooks?: Array<{ name?: string }> }>;
      };
    };

    const entries = (settings.hooks?.AfterAgent || [])
      .flatMap((group) => group.hooks || [])
      .filter((hook) => hook.name === GEMINI_HOOK_NAME);
    expect(entries).toHaveLength(1);
  });

  it('removeGeminiHook removes hook file and settings entry', () => {
    const hookPath = installGeminiHook(undefined, tempDir);
    const removed = removeGeminiHook(tempDir);

    expect(removed).toBe(true);
    expect(existsSync(hookPath)).toBe(false);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ hooks?: Array<{ name?: string }> }>;
      };
    };

    const hasHook = (settings.hooks?.AfterAgent || [])
      .flatMap((group) => group.hooks || [])
      .some((hook) => hook.name === GEMINI_HOOK_NAME);
    expect(hasHook).toBe(false);
  });
});
