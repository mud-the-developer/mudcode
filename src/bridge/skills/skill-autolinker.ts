import { readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface SkillAutoLinkerMatch {
  name: string;
  description: string;
  filePath?: string;
}

export interface SkillAutoLinkResult {
  prompt: string;
  matchedSkill?: SkillAutoLinkerMatch;
}

interface ParsedSkillEntry extends SkillAutoLinkerMatch {
  normalizedName: string;
  normalizedCorpus: string;
}

interface SkillCacheEntry {
  mtimeMs: number;
  skills: ParsedSkillEntry[];
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'about',
  'your',
  'their',
  'just',
  'have',
  'has',
  'will',
  'then',
  'when',
  'what',
  'where',
  'which',
  'would',
  'could',
  'should',
  'are',
  'you',
  'use',
  'using',
  'task',
  'help',
]);

export class SkillAutoLinker {
  private readonly enabled: boolean;
  private readonly maxPromptLength: number;
  private readonly cache = new Map<string, SkillCacheEntry>();

  constructor() {
    this.enabled = this.resolveEnabled();
    this.maxPromptLength = this.resolveMaxPromptLength();
  }

  augmentPrompt(params: {
    agentType: string;
    projectPath: string;
    prompt: string;
  }): SkillAutoLinkResult {
    if (!this.enabled) return { prompt: params.prompt };
    if (params.agentType !== 'codex') return { prompt: params.prompt };
    if (!params.projectPath || params.prompt.trim().length === 0) return { prompt: params.prompt };

    const skills = this.getSkillsFromAgentsFile(params.projectPath);
    if (skills.length === 0) return { prompt: params.prompt };
    if (this.hasExplicitSkillMention(params.prompt, skills)) return { prompt: params.prompt };

    const best = this.findBestSkillMatch(params.prompt, skills);
    if (!best) return { prompt: params.prompt };

    const hint = this.buildAutoSkillHint(best);
    const augmented = `${params.prompt.trimEnd()}\n\n${hint}`;
    if (augmented.length > this.maxPromptLength) {
      return { prompt: params.prompt };
    }
    return {
      prompt: augmented,
      matchedSkill: {
        name: best.name,
        description: best.description,
        filePath: best.filePath,
      },
    };
  }

  private resolveEnabled(): boolean {
    const raw = process.env.MUDCODE_CODEX_AUTO_SKILL_LINK;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveMaxPromptLength(): number {
    const fromEnv = Number(process.env.MUDCODE_CODEX_AUTO_SKILL_MAX_PROMPT || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 500 && fromEnv <= 20000) {
      return Math.trunc(fromEnv);
    }
    return 10000;
  }

  private getSkillsFromAgentsFile(projectPath: string): ParsedSkillEntry[] {
    const agentsPath = join(projectPath, 'AGENTS.md');
    let stats: { mtimeMs: number };
    try {
      stats = statSync(agentsPath);
    } catch {
      return [];
    }

    const cached = this.cache.get(agentsPath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.skills;
    }

    let content = '';
    try {
      content = readFileSync(agentsPath, 'utf-8');
    } catch {
      return [];
    }

    const skills = this.parseAvailableSkills(content);
    this.cache.set(agentsPath, { mtimeMs: stats.mtimeMs, skills });
    return skills;
  }

  private parseAvailableSkills(content: string): ParsedSkillEntry[] {
    const lines = content.split('\n');
    const start = lines.findIndex((line) => /^###\s+Available skills\b/i.test(line.trim()));
    if (start < 0) return [];

    const parsed: ParsedSkillEntry[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] || '';
      const trimmed = line.trim();
      if (/^###\s+/.test(trimmed) || /^##\s+/.test(trimmed)) break;
      const match = trimmed.match(/^- ([A-Za-z0-9._-]+):\s*(.+?)(?:\s+\(file:\s*(.+?)\))?$/);
      if (!match) continue;

      const name = (match[1] || '').trim();
      const description = (match[2] || '').trim();
      const filePath = (match[3] || '').trim() || undefined;
      if (!name || !description) continue;

      const corpus = `${name} ${description}`.toLowerCase();
      parsed.push({
        name,
        description,
        filePath,
        normalizedName: name.toLowerCase(),
        normalizedCorpus: corpus,
      });
    }
    return parsed;
  }

  private hasExplicitSkillMention(prompt: string, skills: ParsedSkillEntry[]): boolean {
    const lower = prompt.toLowerCase();
    if (/\bskill\b/i.test(prompt) && /\$[a-z0-9._-]+/i.test(prompt)) return true;
    return skills.some((skill) => {
      const escaped = this.escapeRegExp(skill.name);
      return new RegExp(`\\$${escaped}\\b`, 'i').test(prompt) || new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
    });
  }

  private findBestSkillMatch(prompt: string, skills: ParsedSkillEntry[]): ParsedSkillEntry | undefined {
    const normalized = prompt.toLowerCase();
    const tokens = this.tokenizePrompt(normalized);
    if (tokens.length === 0) return undefined;

    let bestScore = 0;
    let best: ParsedSkillEntry | undefined;

    for (const skill of skills) {
      let score = 0;
      if (normalized.includes(`$${skill.normalizedName}`)) score += 100;
      if (new RegExp(`\\b${this.escapeRegExp(skill.normalizedName)}\\b`, 'i').test(normalized)) score += 50;

      for (const token of tokens) {
        if (token.length < 2) continue;
        if (skill.normalizedCorpus.includes(token)) {
          score += token.length >= 7 ? 3 : 2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }

    if (!best) return undefined;
    return bestScore >= 6 ? best : undefined;
  }

  private tokenizePrompt(prompt: string): string[] {
    const words = prompt
      .replace(/[`"'()[\]{}<>:;,.!?/\\|+=*~^%$#@-]/g, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 1 && !STOPWORDS.has(word));
    return words.slice(0, 40);
  }

  private buildAutoSkillHint(skill: ParsedSkillEntry): string {
    const fileHint = skill.filePath ? ` (file: ${skill.filePath})` : '';
    return `[mudcode auto-skill] Use skill "${skill.name}"${fileHint}. Task summary: ${skill.description}`;
  }

  private escapeRegExp(raw: string): string {
    return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
