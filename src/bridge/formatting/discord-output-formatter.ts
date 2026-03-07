import { stripAnsi, stripOuterCodeblock } from '../../capture/parser.js';

const NORMALIZE_LINE_ENDINGS_REGEX = /\r\n?/g;
const TRAILING_LINE_WHITESPACE_REGEX = /[ \t]+$/gm;
const EXCESS_BLANK_LINES_REGEX = /\n{3,}/g;
const MUDCODE_CONTROL_BLOCK_REGEX =
  /\[mudcode [^\]\n]+\][\s\S]*?\[\/mudcode [^\]\n]+\]\s*/gim;
const MUDCODE_ORPHAN_TAG_REGEX = /^\s*\[\/?mudcode [^\]\n]+\]\s*$/gim;

const TRUE_BOOL_TOKENS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOL_TOKENS = new Set(['0', 'false', 'no', 'off']);
const REPEATED_LINE_GLOBAL_LIMIT = 2;
const REPEATED_LINE_MIN_LENGTH = 20;
const CONCLUSION_SECTION_LINE_MAX = 220;
const CONCLUSION_SECTION_PREVIEW_LINES = 2;

function normalizeLineEndings(text: string): string {
  return text.replace(NORMALIZE_LINE_ENDINGS_REGEX, '\n');
}

function trimLineTrailingWhitespace(text: string): string {
  return text.replace(TRAILING_LINE_WHITESPACE_REGEX, '');
}

function collapseExcessBlankLines(text: string): string {
  return text.replace(EXCESS_BLANK_LINES_REGEX, '\n\n');
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
  if (TRUE_BOOL_TOKENS.has(normalized)) return true;
  if (FALSE_BOOL_TOKENS.has(normalized)) return false;
  return false;
}

function resolveStripMudcodeControlBlocks(): boolean {
  const raw = process.env.AGENT_DISCORD_OUTPUT_STRIP_MUDCODE_BLOCKS;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_BOOL_TOKENS.has(normalized)) return true;
  if (FALSE_BOOL_TOKENS.has(normalized)) return false;
  return true;
}

function resolveRepeatedLineDedupeEnabled(): boolean {
  const raw = process.env.AGENT_DISCORD_OUTPUT_DEDUPE_REPEATED_LINES;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_BOOL_TOKENS.has(normalized)) return true;
  if (FALSE_BOOL_TOKENS.has(normalized)) return false;
  return true;
}

function resolveConclusionOnlyEnabled(): boolean {
  const raw = process.env.AGENT_DISCORD_OUTPUT_CONCLUSION_ONLY;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_BOOL_TOKENS.has(normalized)) return true;
  if (FALSE_BOOL_TOKENS.has(normalized)) return false;
  return true;
}

type ConclusionSectionKey = 'need' | 'changes' | 'verification';

interface ConclusionSectionSpec {
  key: ConclusionSectionKey;
  title: string;
  headingRegex: RegExp;
}

const CONCLUSION_SECTION_SPECS: ConclusionSectionSpec[] = [
  {
    key: 'need',
    title: 'Need your check',
    headingRegex:
      /^\s*(?:\d+[\.\)]\s*)?(?:\*\*)?\s*(need your check|manual check|need check|확인 필요|체크 필요)(?:\*\*)?\b/i,
  },
  {
    key: 'changes',
    title: 'Changes',
    headingRegex: /^\s*(?:\d+[\.\)]\s*)?(?:\*\*)?\s*(changes?|deltas?|변경(?:사항)?|수정(?:사항)?)(?:\*\*)?\b/i,
  },
  {
    key: 'verification',
    title: 'Verification',
    headingRegex: /^\s*(?:\d+[\.\)]\s*)?(?:\*\*)?\s*(verification|tests?|검증|테스트)(?:\*\*)?\b/i,
  },
];

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 1)}…`;
}

function summarizeConclusionBody(lines: string[]): string {
  const cleaned = lines
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[\.\)]\s+/, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
  if (cleaned.length === 0) return 'none';

  const preview = cleaned
    .slice(0, CONCLUSION_SECTION_PREVIEW_LINES)
    .map((line) => truncateWithEllipsis(line, CONCLUSION_SECTION_LINE_MAX));
  const suffix = cleaned.length > CONCLUSION_SECTION_PREVIEW_LINES ? ` (+${cleaned.length - CONCLUSION_SECTION_PREVIEW_LINES} more)` : '';
  return `${preview.join(' / ')}${suffix}`;
}

function extractConclusionOnlyReport(text: string): string {
  if (text.length < 280) return text;
  const lines = text.split('\n');

  const sectionIndexByKey = new Map<ConclusionSectionKey, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 120) continue;

    for (const spec of CONCLUSION_SECTION_SPECS) {
      if (sectionIndexByKey.has(spec.key)) continue;
      if (spec.headingRegex.test(trimmed)) {
        sectionIndexByKey.set(spec.key, index);
      }
    }
  }

  const needIndex = sectionIndexByKey.get('need');
  const changesIndex = sectionIndexByKey.get('changes');
  const verificationIndex = sectionIndexByKey.get('verification');
  if (
    needIndex === undefined ||
    changesIndex === undefined ||
    verificationIndex === undefined ||
    !(needIndex < changesIndex && changesIndex < verificationIndex)
  ) {
    return text;
  }

  const needSummary = summarizeConclusionBody(lines.slice(needIndex + 1, changesIndex));
  const changesSummary = summarizeConclusionBody(lines.slice(changesIndex + 1, verificationIndex));
  const verificationSummary = summarizeConclusionBody(lines.slice(verificationIndex + 1));
  return [
    '1) Need your check',
    needSummary,
    '',
    '2) Changes',
    changesSummary,
    '',
    '3) Verification',
    verificationSummary,
  ].join('\n');
}

function stripMudcodeControlBlocks(text: string): string {
  if (!resolveStripMudcodeControlBlocks()) return text;
  if (!text.includes('[mudcode')) return text;

  // Remove supervisor/longtask instruction blocks that were injected into prompts.
  const withoutBlocks = text.replace(MUDCODE_CONTROL_BLOCK_REGEX, '\n');

  // Clean up orphan tag lines if only one side was captured.
  return withoutBlocks.replace(MUDCODE_ORPHAN_TAG_REGEX, '');
}

function dedupeRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const globalSeen = new Map<string, number>();
  const kept: string[] = [];
  let previousKey = '';
  let omitted = 0;

  for (const line of lines) {
    const compact = line.replace(/\s+/g, ' ').trim().toLowerCase();
    if (compact.length === 0) {
      previousKey = '';
      kept.push(line);
      continue;
    }

    if (compact === previousKey) {
      omitted += 1;
      continue;
    }

    const count = globalSeen.get(compact) || 0;
    if (compact.length >= REPEATED_LINE_MIN_LENGTH && count >= REPEATED_LINE_GLOBAL_LIMIT) {
      omitted += 1;
      previousKey = compact;
      continue;
    }

    globalSeen.set(compact, count + 1);
    kept.push(line);
    previousKey = compact;
  }

  const compacted = collapseExcessBlankLines(kept.join('\n')).trim();
  if (compacted.length === 0) return '';
  if (omitted <= 0) return compacted;
  return `${compacted}\n\n...[repeated lines omitted: ${omitted}]`;
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
  const stripped = stripMudcodeControlBlocks(stripAnsi(normalizeLineEndings(text)));
  const normalized = collapseExcessBlankLines(trimLineTrailingWhitespace(stripped)).trim();
  if (normalized.length === 0) {
    return { text: '', useCodeblock: false, language: resolveCodeblockLanguage() };
  }

  const unfenced = stripOuterCodeblock(normalized).trim();
  const conclusionOnly =
    !resolveMultilineCodeblockMode() && resolveConclusionOnlyEnabled()
      ? extractConclusionOnlyReport(unfenced)
      : unfenced;
  const hadOuterCodeblock = unfenced !== normalized;
  const compacted =
    !hadOuterCodeblock && resolveRepeatedLineDedupeEnabled()
      ? dedupeRepeatedLines(conclusionOnly)
      : conclusionOnly;
  const forceMultilineCodeblock = resolveMultilineCodeblockMode();
  return {
    text: compacted,
    // Default: preserve codeblock only when agent already produced fenced output.
    // Optional env can force previous multiline=>codeblock behavior.
    useCodeblock: hadOuterCodeblock || (forceMultilineCodeblock && compacted.includes('\n')),
    language: resolveCodeblockLanguage(),
  };
}

export function wrapDiscordCodeblock(content: string, language: string): string {
  return `\`\`\`${language}\n${content}\n\`\`\``;
}
