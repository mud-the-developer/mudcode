import { stripAnsi, stripOuterCodeblock } from '../capture/parser.js';

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function trimLineTrailingWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function collapseExcessBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

function resolveCodeblockLanguage(): string {
  const raw = process.env.AGENT_DISCORD_OUTPUT_CODEBLOCK_LANG;
  if (!raw) return 'text';
  const normalized = raw.trim().toLowerCase();
  return /^[a-z0-9_+-]{1,20}$/.test(normalized) ? normalized : 'text';
}

function resolveMultilineCodeblockMode(): boolean {
  const raw = process.env.AGENT_DISCORD_OUTPUT_MULTILINE_CODEBLOCK;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return false;
}

export interface DiscordOutputFormatResult {
  text: string;
  useCodeblock: boolean;
  language: string;
}

/**
 * Discord-specific output normalization.
 * - strips ANSI escapes
 * - normalizes trailing whitespace / blank-line runs
 * - removes one outer code fence if present (we wrap per-chunk later)
 */
export function formatDiscordOutput(text: string): DiscordOutputFormatResult {
  const stripped = stripAnsi(normalizeLineEndings(text));
  const normalized = collapseExcessBlankLines(trimLineTrailingWhitespace(stripped)).trim();
  if (normalized.length === 0) {
    return { text: '', useCodeblock: false, language: resolveCodeblockLanguage() };
  }

  const unfenced = stripOuterCodeblock(normalized).trim();
  const hadOuterCodeblock = unfenced !== normalized;
  const forceMultilineCodeblock = resolveMultilineCodeblockMode();
  return {
    text: unfenced,
    // Default: preserve codeblock only when agent already produced fenced output.
    // Optional env can force previous multiline=>codeblock behavior.
    useCodeblock: hadOuterCodeblock || (forceMultilineCodeblock && unfenced.includes('\n')),
    language: resolveCodeblockLanguage(),
  };
}

export function wrapDiscordCodeblock(content: string, language: string): string {
  return `\`\`\`${language}\n${content}\n\`\`\``;
}
