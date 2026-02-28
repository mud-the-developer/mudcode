import { mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync, existsSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkills, installSkills } from '../../../src/cli/commands/skills.js';

function createProjectWithSkills(options: { includeAvailableSkillsSection?: boolean } = {}): { projectPath: string } {
  const includeAvailableSkillsSection = options.includeAvailableSkillsSection ?? true;
  const projectPath = mkdtempSync(join(tmpdir(), 'mudcode-skills-'));
  const localSkill = join(projectPath, '.agents/skills/rebuild-restart-daemon');
  const cloudSkill = join(projectPath, '.agents/skills/cloudflare');

  mkdirSync(localSkill, { recursive: true });
  mkdirSync(cloudSkill, { recursive: true });
  writeFileSync(join(localSkill, 'SKILL.md'), '# Rebuild\nUse local scripts only.', 'utf-8');
  writeFileSync(join(cloudSkill, 'SKILL.md'), '# Cloudflare\nRequires API token.', 'utf-8');

  if (includeAvailableSkillsSection) {
    writeFileSync(
      join(projectPath, 'AGENTS.md'),
      [
        '# AGENTS',
        '### Available skills',
        '- rebuild-restart-daemon: Rebuild and restart local daemon skill. (file: ./.agents/skills/rebuild-restart-daemon/SKILL.md)',
        '- cloudflare: Cloudflare platform skill using API token. (file: ./.agents/skills/cloudflare/SKILL.md)',
      ].join('\n'),
      'utf-8',
    );
  } else {
    writeFileSync(join(projectPath, 'AGENTS.md'), '# AGENTS\n\n## Release\n- test only', 'utf-8');
  }
  return { projectPath };
}

describe('skills command helpers', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers skills and marks external dependency risk', () => {
    const { projectPath } = createProjectWithSkills();
    dirs.push(projectPath);

    const skills = discoverSkills({ projectPath });
    expect(skills.map((s) => s.name)).toEqual(['rebuild-restart-daemon', 'cloudflare']);
    expect(skills.find((s) => s.name === 'rebuild-restart-daemon')?.noApiLikely).toBe(true);
    expect(skills.find((s) => s.name === 'cloudflare')?.noApiLikely).toBe(false);
  });

  it('installs only local/no-api skills by default', () => {
    const { projectPath } = createProjectWithSkills();
    dirs.push(projectPath);
    const codexHome = mkdtempSync(join(tmpdir(), 'mudcode-codex-home-'));
    dirs.push(codexHome);

    const result = installSkills({ projectPath, codexHome });
    expect(result.installed).toContain('rebuild-restart-daemon');
    expect(result.installed).not.toContain('cloudflare');

    const target = join(codexHome, 'skills', 'rebuild-restart-daemon');
    expect(existsSync(target)).toBe(true);
    const stat = lstatSync(target);
    expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
  });

  it('falls back to .agents/skills when AGENTS Available skills section is missing', () => {
    const { projectPath } = createProjectWithSkills({ includeAvailableSkillsSection: false });
    dirs.push(projectPath);

    const skills = discoverSkills({ projectPath });
    expect(skills.map((s) => s.name)).toEqual(['cloudflare', 'rebuild-restart-daemon']);
    expect(skills.find((s) => s.name === 'rebuild-restart-daemon')?.noApiLikely).toBe(true);
    expect(skills.find((s) => s.name === 'cloudflare')?.noApiLikely).toBe(false);
  });

  it('installs external-risk skill when explicitly requested with allowExternal', () => {
    const { projectPath } = createProjectWithSkills();
    dirs.push(projectPath);
    const codexHome = mkdtempSync(join(tmpdir(), 'mudcode-codex-home-'));
    dirs.push(codexHome);

    const result = installSkills({
      projectPath,
      codexHome,
      name: 'cloudflare',
      allowExternal: true,
    });
    expect(result.installed).toEqual(['cloudflare']);
    const target = join(codexHome, 'skills', 'cloudflare');
    expect(existsSync(target)).toBe(true);
    const stat = lstatSync(target);
    expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
  });

  it('keeps existing identical symlink as skipped already installed', () => {
    const { projectPath } = createProjectWithSkills();
    dirs.push(projectPath);
    const codexHome = mkdtempSync(join(tmpdir(), 'mudcode-codex-home-'));
    dirs.push(codexHome);

    const first = installSkills({ projectPath, codexHome });
    expect(first.installed).toContain('rebuild-restart-daemon');

    const second = installSkills({ projectPath, codexHome });
    expect(second.installed).toEqual([]);
    expect(second.skipped.some((s) => s.name === 'rebuild-restart-daemon' && /already installed/i.test(s.reason))).toBe(true);

    const target = join(codexHome, 'skills', 'rebuild-restart-daemon');
    if (lstatSync(target).isSymbolicLink()) {
      const linkPath = readlinkSync(target);
      expect(linkPath.length).toBeGreaterThan(0);
    }
  });
});
