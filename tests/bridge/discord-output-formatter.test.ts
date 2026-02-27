import { afterEach, describe, expect, it } from 'vitest';
import { formatDiscordOutput, wrapDiscordCodeblock } from '../../src/bridge/discord-output-formatter.js';

describe('formatDiscordOutput', () => {
  afterEach(() => {
    delete process.env.AGENT_DISCORD_OUTPUT_CODEBLOCK_LANG;
    delete process.env.AGENT_DISCORD_OUTPUT_MULTILINE_CODEBLOCK;
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
});
