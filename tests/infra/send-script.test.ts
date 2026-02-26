/**
 * Tests for send-script module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getMudcodeSendScriptSource,
  installMudcodeSendScript,
} from '../../src/infra/send-script.js';

const defaultConfig = { projectName: 'my-project', port: 18470 };

describe('getMudcodeSendScriptSource', () => {
  it('returns a string starting with a shebang', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('hardcodes the project name', () => {
    const source = getMudcodeSendScriptSource({ projectName: 'test-proj', port: 9999 });
    expect(source).toContain('"test-proj"');
  });

  it('hardcodes the port number', () => {
    const source = getMudcodeSendScriptSource({ projectName: 'p', port: 12345 });
    expect(source).toContain('var port     = 12345;');
  });

  it('reads AGENT_DISCORD_AGENT and AGENT_DISCORD_INSTANCE from env vars', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).toContain('AGENT_DISCORD_AGENT');
    expect(source).toContain('AGENT_DISCORD_INSTANCE');
  });

  it('does NOT read AGENT_DISCORD_PROJECT from env vars', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).not.toContain('process.env.AGENT_DISCORD_PROJECT');
  });

  it('does NOT read AGENT_DISCORD_PORT from env vars', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).not.toContain('process.env.AGENT_DISCORD_PORT');
  });

  it('POSTs to /send-files endpoint', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).toContain('/send-files');
    expect(source).toContain('"POST"');
  });

  it('resolves file paths using path.resolve', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).toContain('path.resolve');
  });

  it('sends projectName, agentType, instanceId, and files in payload', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).toContain('projectName');
    expect(source).toContain('agentType');
    expect(source).toContain('instanceId');
    expect(source).toContain('files');
  });

  it('includes a "pre-configured" comment', () => {
    const source = getMudcodeSendScriptSource(defaultConfig);
    expect(source).toContain('Pre-configured by mudcode');
  });
});

describe('installMudcodeSendScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mudcode-send-script-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the script at .mudcode/bin/mudcode-send', () => {
    const scriptPath = installMudcodeSendScript(tempDir, defaultConfig);

    expect(scriptPath).toBe(join(tempDir, '.mudcode', 'bin', 'mudcode-send'));
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('makes the script executable', () => {
    const scriptPath = installMudcodeSendScript(tempDir, defaultConfig);

    const mode = statSync(scriptPath).mode;
    // Check owner-execute bit is set (0o100)
    expect(mode & 0o100).toBeTruthy();
  });

  it('writes the correct script content with hardcoded config', () => {
    const config = { projectName: 'demo', port: 9999 };
    const scriptPath = installMudcodeSendScript(tempDir, config);
    const content = readFileSync(scriptPath, 'utf-8');

    expect(content).toBe(getMudcodeSendScriptSource(config));
    expect(content).toContain('"demo"');
    expect(content).toContain('9999');
  });

  it('is idempotent — overwrites with latest version', () => {
    installMudcodeSendScript(tempDir, defaultConfig);
    const scriptPath = installMudcodeSendScript(tempDir, defaultConfig);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toBe(getMudcodeSendScriptSource(defaultConfig));
  });

  it('creates intermediate directories', () => {
    const scriptPath = installMudcodeSendScript(tempDir, defaultConfig);

    expect(existsSync(join(tempDir, '.mudcode', 'bin'))).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('creates a CommonJS package.json in the bin directory', () => {
    installMudcodeSendScript(tempDir, defaultConfig);

    const pkgJsonPath = join(tempDir, '.mudcode', 'bin', 'package.json');
    expect(existsSync(pkgJsonPath)).toBe(true);

    const content = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    expect(content.type).toBe('commonjs');
  });
});
