import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillAutoLinker } from '../../src/bridge/skill-autolinker.js';

describe('SkillAutoLinker', () => {
  const dirs: string[] = [];
  const previousToggle = process.env.MUDCODE_CODEX_AUTO_SKILL_LINK;

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    process.env.MUDCODE_CODEX_AUTO_SKILL_LINK = previousToggle;
  });

  it('auto-links best matching skill from AGENTS.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'mudcode-skill-autolink-'));
    dirs.push(root);
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        '# AGENTS',
        '### Available skills',
        '- cloudflare: Cloudflare Workers and Pages deployment skill. (file: /tmp/skills/cloudflare/SKILL.md)',
        '- rebuild-restart-daemon: Rebuild and restart local daemon skill. (file: /tmp/skills/restart/SKILL.md)',
      ].join('\n'),
      'utf-8',
    );

    const linker = new SkillAutoLinker();
    const result = linker.augmentPrompt({
      agentType: 'codex',
      projectPath: root,
      prompt: 'Please rebuild and restart the daemon now.',
    });

    expect(result.matchedSkill?.name).toBe('rebuild-restart-daemon');
    expect(result.prompt).toContain('[mudcode auto-skill]');
    expect(result.prompt).toContain('rebuild-restart-daemon');
  });

  it('keeps prompt unchanged when skill is explicitly mentioned', () => {
    const root = mkdtempSync(join(tmpdir(), 'mudcode-skill-autolink-'));
    dirs.push(root);
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        '# AGENTS',
        '### Available skills',
        '- cloudflare: Cloudflare Workers and Pages deployment skill. (file: /tmp/skills/cloudflare/SKILL.md)',
      ].join('\n'),
      'utf-8',
    );

    const linker = new SkillAutoLinker();
    const rawPrompt = '$cloudflare skill 써서 pages 설정 체크해줘';
    const result = linker.augmentPrompt({
      agentType: 'codex',
      projectPath: root,
      prompt: rawPrompt,
    });

    expect(result.matchedSkill).toBeUndefined();
    expect(result.prompt).toBe(rawPrompt);
  });

  it('can be disabled by env toggle', () => {
    process.env.MUDCODE_CODEX_AUTO_SKILL_LINK = '0';
    const root = mkdtempSync(join(tmpdir(), 'mudcode-skill-autolink-'));
    dirs.push(root);
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        '# AGENTS',
        '### Available skills',
        '- rebuild-restart-daemon: Rebuild and restart local daemon skill. (file: /tmp/skills/restart/SKILL.md)',
      ].join('\n'),
      'utf-8',
    );

    const linker = new SkillAutoLinker();
    const rawPrompt = 'daemon 재시작하고 빌드해줘';
    const result = linker.augmentPrompt({
      agentType: 'codex',
      projectPath: root,
      prompt: rawPrompt,
    });

    expect(result.matchedSkill).toBeUndefined();
    expect(result.prompt).toBe(rawPrompt);
  });
});
