import { afterEach, describe, expect, it } from 'vitest';
import { formatDiscordOutput, wrapDiscordCodeblock } from '../../../src/bridge/formatting/discord-output-formatter.js';

describe('formatDiscordOutput', () => {
  afterEach(() => {
    delete process.env.AGENT_DISCORD_OUTPUT_CODEBLOCK_LANG;
    delete process.env.AGENT_DISCORD_OUTPUT_MULTILINE_CODEBLOCK;
    delete process.env.AGENT_DISCORD_OUTPUT_STRIP_MUDCODE_BLOCKS;
    delete process.env.AGENT_DISCORD_OUTPUT_DEDUPE_REPEATED_LINES;
    delete process.env.AGENT_DISCORD_OUTPUT_CONCLUSION_ONLY;
  });

  it('keeps single-line output as plain text', () => {
    expect(formatDiscordOutput('hello world')).toEqual({
      text: 'hello world',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('keeps multiline plain text unfenced by default', () => {
    expect(formatDiscordOutput('line1\nline2')).toEqual({
      text: 'line1\nline2',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('strips ANSI and trims extra whitespace/blank lines', () => {
    const raw = '\u001b[31mline1\u001b[0m  \n\n\nline2\t \n';
    expect(formatDiscordOutput(raw)).toEqual({
      text: 'line1\n\nline2',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('respects configured codeblock language when valid', () => {
    process.env.AGENT_DISCORD_OUTPUT_CODEBLOCK_LANG = 'md';
    expect(formatDiscordOutput('```md\na\nb\n```')).toEqual({
      text: 'a\nb',
      useCodeblock: true,
      language: 'md',
    });
  });

  it('can force multiline codeblock wrapping via env', () => {
    process.env.AGENT_DISCORD_OUTPUT_MULTILINE_CODEBLOCK = 'true';
    expect(formatDiscordOutput('line1\nline2')).toEqual({
      text: 'line1\nline2',
      useCodeblock: true,
      language: 'text',
    });
  });

  it('wraps chunk text as a Discord code block', () => {
    expect(wrapDiscordCodeblock('x\ny', 'text')).toBe('```text\nx\ny\n```');
  });

  it('strips mudcode control blocks by default', () => {
    const raw =
      'final summary\n' +
      '[mudcode longtask-report]\n' +
      'Execution policy for long tasks...\n' +
      '[/mudcode longtask-report]\n' +
      '[mudcode supervisor-orchestrator-guard]\n' +
      'You are the supervisor in orchestrator mode.\n' +
      '[/mudcode supervisor-orchestrator-guard]\n' +
      'done';
    expect(formatDiscordOutput(raw)).toEqual({
      text: 'final summary\n\ndone',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('can keep mudcode control blocks when stripping is disabled', () => {
    process.env.AGENT_DISCORD_OUTPUT_STRIP_MUDCODE_BLOCKS = 'false';
    const raw = 'a\n[mudcode longtask-report]\npolicy\n[/mudcode longtask-report]\nb';
    expect(formatDiscordOutput(raw)).toEqual({
      text: 'a\n[mudcode longtask-report]\npolicy\n[/mudcode longtask-report]\nb',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('dedupes repeated noisy lines by default and appends omission note', () => {
    const raw = [
      'summary line',
      'same long repeated sentence that should be compacted in discord output',
      'same long repeated sentence that should be compacted in discord output',
      'same long repeated sentence that should be compacted in discord output',
      'next line',
    ].join('\n');
    expect(formatDiscordOutput(raw)).toEqual({
      text:
        'summary line\n' +
        'same long repeated sentence that should be compacted in discord output\n' +
        'next line\n\n' +
        '...[repeated lines omitted: 2]',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('can disable repeated-line dedupe via env', () => {
    process.env.AGENT_DISCORD_OUTPUT_DEDUPE_REPEATED_LINES = 'false';
    const raw = [
      'same long repeated sentence that should be compacted in discord output',
      'same long repeated sentence that should be compacted in discord output',
      'same long repeated sentence that should be compacted in discord output',
    ].join('\n');
    expect(formatDiscordOutput(raw)).toEqual({
      text: raw,
      useCodeblock: false,
      language: 'text',
    });
  });

  it('extracts concise conclusion-only summary for longtask final reports by default', () => {
    const raw = [
      '1) Need your check',
      'none',
      '',
      '2) Changes',
      '- BridgeHookServer에 route-level dedupe를 추가했습니다.',
      '- hook-server.ts (/home/mud/repo/mudcode_v2/src/bridge/runtime/hook-server.ts)',
      '- hook-server.test.ts (/home/mud/repo/mudcode_v2/tests/bridge/runtime/hook-server.test.ts)',
      '',
      '3) Verification',
      '- bun run test -- tests/bridge/runtime/hook-server.test.ts -> PASS',
      '- bun run typecheck -> PASS',
      '- bun run build -> PASS',
    ].join('\n');

    expect(formatDiscordOutput(raw)).toEqual({
      text:
        '1) Need your check\n' +
        'none\n\n' +
        '2) Changes\n' +
        'BridgeHookServer에 route-level dedupe를 추가했습니다. / hook-server.ts (/home/mud/repo/mudcode_v2/src/bridge/runtime/hook-server.ts) (+1 more)\n\n' +
        '3) Verification\n' +
        'bun run test -- tests/bridge/runtime/hook-server.test.ts -> PASS / bun run typecheck -> PASS (+1 more)',
      useCodeblock: false,
      language: 'text',
    });
  });

  it('can disable conclusion-only extraction via env', () => {
    process.env.AGENT_DISCORD_OUTPUT_CONCLUSION_ONLY = 'false';
    const verificationLines = Array.from({ length: 120 }, (_, index) => `- verify ${index + 1}`);
    const raw = [
      '1) Need your check',
      'none',
      '',
      '2) Changes',
      '- change A',
      '',
      '3) Verification',
      ...verificationLines,
    ].join('\n');

    expect(formatDiscordOutput(raw)).toEqual({
      text: raw,
      useCodeblock: false,
      language: 'text',
    });
  });
});
