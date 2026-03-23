import chalk from 'chalk';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

const EXTERNAL_DEPENDENCY_HINTS: RegExp[] = [
  /\bcloudflare\b/i,
  /\bapi\b/i,
  /\btoken\b/i,
  /\boauth\b/i,
  /\bworkers?\b/i,
  /\bkv\b/i,
  /\bd1\b/i,
  /\br2\b/i,
  /\bvectorize\b/i,
];

const LOCAL_SKILL_DIR_CANDIDATES = ['.agents/skills'];
const REMOTE_SKILL_DISCOVERY_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  'target',
  '.cache',
]);
const KNOWN_SKILL_REPO_ALIASES: Record<string, { target: string; reason: string }> = {
  'vercel-labs/skills': {
    target: 'vercel-labs/agent-skills',
    reason:
      'mapped `vercel-labs/skills` to `vercel-labs/agent-skills` because the former is installer tooling, not a skill bundle.',
  },
};

export interface DiscoveredSkill {
  name: string;
  description: string;
  rawFilePath?: string;
  skillFilePath?: string;
  skillDirPath?: string;
  hasSkillFile: boolean;
  noApiLikely: boolean;
  reason?: string;
}

export interface DiscoverSkillsOptions {
  projectPath?: string;
}

export interface InstallSkillsOptions {
  projectPath?: string;
  name?: string;
  allowExternal?: boolean;
  force?: boolean;
  dryRun?: boolean;
  codexHome?: string;
  repo?: string;
  ref?: string;
}

export interface InstallSkillsResult {
  installed: string[];
  linked: string[];
  copied: string[];
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
  codexSkillsDir: string;
  notices: string[];
}

function resolveProjectPath(projectPath?: string): string {
  if (projectPath && projectPath.trim().length > 0) {
    return resolve(projectPath.trim());
  }
  return process.cwd();
}

function resolveCodexSkillsDir(codexHome?: string): string {
  const home =
    codexHome?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(homedir(), '.codex');
  return join(home, 'skills');
}

function normalizeGitHubRepoSlug(input: string): string | undefined {
  const trimmed = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!trimmed) return undefined;

  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (urlMatch) {
    return `${urlMatch[1]}/${urlMatch[2]}`.toLowerCase();
  }

  const slugMatch = trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (slugMatch) {
    return `${slugMatch[1]}/${slugMatch[2]}`.toLowerCase();
  }

  return undefined;
}

export function resolveKnownSkillRepoAlias(input: string): { resolved: string; reason?: string } {
  const slug = normalizeGitHubRepoSlug(input);
  if (!slug) {
    return { resolved: input.trim() };
  }
  const alias = KNOWN_SKILL_REPO_ALIASES[slug];
  if (!alias) {
    return { resolved: slug };
  }
  return { resolved: alias.target, reason: alias.reason };
}

interface SkillSourceContext {
  discoveryRoot: string;
  forceCopyInstall: boolean;
  notices: string[];
  cleanup?: () => void;
}

function cloneGitHubRepo(params: { repoSlug: string; ref?: string }): { checkoutPath: string; cleanup: () => void } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mudcode-skill-repo-'));
  const checkoutPath = join(tempRoot, 'repo');
  const cloneUrl = `https://github.com/${params.repoSlug}.git`;
  const args = ['clone', '--depth', '1'];
  const ref = params.ref?.trim();
  if (ref) {
    args.push('--branch', ref);
  }
  args.push(cloneUrl, checkoutPath);

  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    const stderr =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr
        : '';
    const detail = stderr.trim().split('\n').slice(-1)[0] || (error instanceof Error ? error.message : String(error));
    throw new Error(`failed to clone ${cloneUrl}${ref ? `@${ref}` : ''}: ${detail}`);
  }

  return {
    checkoutPath,
    cleanup: () => {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

function resolveSkillSource(projectPath: string, options: InstallSkillsOptions): SkillSourceContext {
  const repoInput = options.repo?.trim();
  if (!repoInput) {
    return {
      discoveryRoot: projectPath,
      forceCopyInstall: false,
      notices: [],
    };
  }

  const localPath = resolve(projectPath, repoInput);
  if (existsSync(localPath)) {
    return {
      discoveryRoot: localPath,
      forceCopyInstall: false,
      notices: [`using local skill source: ${localPath}`],
    };
  }

  const aliased = resolveKnownSkillRepoAlias(repoInput);
  const repoSlug = normalizeGitHubRepoSlug(aliased.resolved);
  if (!repoSlug) {
    throw new Error(`unsupported --repo value: ${repoInput}`);
  }
  const cloned = cloneGitHubRepo({ repoSlug, ref: options.ref });
  const notices = [`cloned skill source: https://github.com/${repoSlug}${options.ref?.trim() ? ` @ ${options.ref.trim()}` : ''}`];
  if (aliased.reason) {
    notices.unshift(aliased.reason);
  }
  return {
    discoveryRoot: cloned.checkoutPath,
    forceCopyInstall: true,
    notices,
    cleanup: cloned.cleanup,
  };
}

function parseSkillLine(line: string): { name: string; description: string; filePath?: string } | undefined {
  const match = line
    .trim()
    .match(/^- ([A-Za-z0-9._-]+):\s*(.+?)(?:\s+\(file:\s*(.+?)\))?$/);
  if (!match) return undefined;
  const name = (match[1] || '').trim();
  const description = (match[2] || '').trim();
  const filePath = (match[3] || '').trim() || undefined;
  if (!name || !description) return undefined;
  return { name, description, filePath };
}

function resolveSkillPath(rawPath: string | undefined, projectPath: string): string | undefined {
  if (!rawPath || rawPath.trim().length === 0) return undefined;
  const trimmed = rawPath.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(projectPath, trimmed);
}

function resolveSkillFilePath(resolvedPath: string | undefined): { filePath?: string; dirPath?: string } {
  if (!resolvedPath) return {};
  if (resolvedPath.endsWith('/SKILL.md') || resolvedPath.endsWith('\\SKILL.md')) {
    return { filePath: resolvedPath, dirPath: dirname(resolvedPath) };
  }
  return { filePath: join(resolvedPath, 'SKILL.md'), dirPath: resolvedPath };
}

function summarizeSkillDescription(skillText: string | undefined): string | undefined {
  if (!skillText) return undefined;
  const frontmatterDescription = skillText.match(/^description:\s*["']?(.+?)["']?\s*$/im);
  if (frontmatterDescription && frontmatterDescription[1]?.trim()) {
    return frontmatterDescription[1].trim();
  }
  const lines = skillText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '---') continue;
    if (trimmed.startsWith('#')) continue;
    if (/^[a-z0-9._-]+:\s+/i.test(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

function detectExternalDependencyRisk(input: {
  name: string;
  description: string;
  skillText?: string;
}): { noApiLikely: boolean; reason?: string } {
  const corpus = `${input.name}\n${input.description}\n${input.skillText || ''}`;
  for (const pattern of EXTERNAL_DEPENDENCY_HINTS) {
    if (pattern.test(corpus)) {
      return {
        noApiLikely: false,
        reason: `external dependency hint matched: ${pattern.source}`,
      };
    }
  }
  return { noApiLikely: true };
}

function loadSkillText(skillFilePath: string | undefined): string | undefined {
  if (!skillFilePath || !existsSync(skillFilePath)) return undefined;
  try {
    return readFileSync(skillFilePath, 'utf-8').slice(0, 4000);
  } catch {
    return undefined;
  }
}

function buildDiscoveredSkill(params: {
  projectPath: string;
  name: string;
  description: string;
  rawFilePath?: string;
  resolvedPath?: string;
}): DiscoveredSkill {
  const resolvedRawPath =
    params.resolvedPath ||
    resolveSkillPath(params.rawFilePath, params.projectPath);
  const { filePath, dirPath } = resolveSkillFilePath(resolvedRawPath);
  const hasSkillFile = !!filePath && existsSync(filePath);
  const skillText = loadSkillText(filePath);
  const risk = detectExternalDependencyRisk({
    name: params.name,
    description: params.description,
    skillText,
  });
  return {
    name: params.name,
    description: params.description,
    rawFilePath: params.rawFilePath,
    skillFilePath: filePath,
    skillDirPath: dirPath,
    hasSkillFile,
    noApiLikely: hasSkillFile && risk.noApiLikely,
    reason: !hasSkillFile ? 'SKILL.md not found' : risk.reason,
  };
}

function discoverSkillsFromAgents(projectPath: string, content: string): DiscoveredSkill[] {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => /^###\s+Available skills\b/i.test(line.trim()));
  if (start < 0) return [];

  const discovered: DiscoveredSkill[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed) || /^###\s+/.test(trimmed)) break;
    const parsed = parseSkillLine(line);
    if (!parsed) continue;
    discovered.push(
      buildDiscoveredSkill({
        projectPath,
        name: parsed.name,
        description: parsed.description,
        rawFilePath: parsed.filePath,
      }),
    );
  }
  return discovered;
}

function discoverSkillsFromLocalDirs(projectPath: string, knownNames: Set<string>): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  for (const candidate of LOCAL_SKILL_DIR_CANDIDATES) {
    const baseDir = resolve(projectPath, candidate);
    if (!existsSync(baseDir)) continue;

    let entries: Array<{ name: string | Buffer; isDirectory: () => boolean }> = [];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = String(entry.name).trim();
      if (!name) continue;
      if (knownNames.has(name.toLowerCase())) continue;

      const skillDir = join(baseDir, name);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const skillText = loadSkillText(skillFile);
      const description =
        summarizeSkillDescription(skillText) ||
        `Local skill from ${join(candidate, name, 'SKILL.md')}`;
      discovered.push(
        buildDiscoveredSkill({
          projectPath,
          name,
          description,
          resolvedPath: skillFile,
        }),
      );
      knownNames.add(name.toLowerCase());
    }
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name));
  return discovered;
}

function discoverSkillsFromRecursiveSkillFiles(projectPath: string, knownNames: Set<string>): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  const stack: string[] = [projectPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Array<{ name: string | Buffer; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }> = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryName = String(entry.name);
      const nextPath = join(current, entryName);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (REMOTE_SKILL_DISCOVERY_EXCLUDED_DIRS.has(entryName)) continue;
        stack.push(nextPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (entryName !== 'SKILL.md') continue;

      const skillDir = dirname(nextPath);
      const skillName = basename(skillDir);
      const normalizedName = skillName.toLowerCase();
      if (!skillName || knownNames.has(normalizedName)) continue;

      const skillText = loadSkillText(nextPath);
      const relPath = relative(projectPath, nextPath);
      const description =
        summarizeSkillDescription(skillText) ||
        `Skill from ${relPath.length > 0 ? relPath : nextPath}`;

      discovered.push(
        buildDiscoveredSkill({
          projectPath,
          name: skillName,
          description,
          rawFilePath: relPath.length > 0 ? relPath : nextPath,
          resolvedPath: nextPath,
        }),
      );
      knownNames.add(normalizedName);
    }
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name));
  return discovered;
}

export function discoverSkills(options: DiscoverSkillsOptions = {}): DiscoveredSkill[] {
  const projectPath = resolveProjectPath(options.projectPath);
  const agentsPath = join(projectPath, 'AGENTS.md');
  const discovered: DiscoveredSkill[] = [];
  if (existsSync(agentsPath)) {
    let content = '';
    try {
      content = readFileSync(agentsPath, 'utf-8');
    } catch {
      content = '';
    }
    if (content) {
      discovered.push(...discoverSkillsFromAgents(projectPath, content));
    }
  }

  const knownNames = new Set(discovered.map((skill) => skill.name.toLowerCase()));
  discovered.push(...discoverSkillsFromLocalDirs(projectPath, knownNames));
  return discovered;
}

function findSelectedSkills(skills: DiscoveredSkill[], options: InstallSkillsOptions): DiscoveredSkill[] {
  if (options.name && options.name.trim().length > 0) {
    const target = options.name.trim().toLowerCase();
    return skills.filter((skill) => skill.name.toLowerCase() === target);
  }
  return skills.filter((skill) => {
    if (!skill.hasSkillFile) return false;
    if (options.allowExternal) return true;
    return skill.noApiLikely;
  });
}

function linkOrCopySkill(params: {
  skill: DiscoveredSkill;
  targetPath: string;
  force: boolean;
  dryRun: boolean;
  preferCopy?: boolean;
}): { mode?: 'linked' | 'copied'; skipReason?: string; failReason?: string } {
  const sourceDir = params.skill.skillDirPath;
  if (!sourceDir) {
    return { skipReason: 'missing source skill directory' };
  }

  const targetPath = params.targetPath;
  if (existsSync(targetPath)) {
    try {
      const stat = lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        const real = realpathSync(targetPath);
        if (real === sourceDir) {
          return { skipReason: 'already installed' };
        }
      }
    } catch {
      // Continue to force/skip handling.
    }

    if (!params.force) {
      return { skipReason: 'target already exists (use --force)' };
    }
    if (!params.dryRun) {
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch (error) {
        return {
          failReason: `failed to replace existing target: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }

  if (params.dryRun) {
    return { mode: params.preferCopy ? 'copied' : 'linked' };
  }

  if (params.preferCopy) {
    try {
      cpSync(sourceDir, targetPath, { recursive: true });
      return { mode: 'copied' };
    } catch (copyError) {
      return {
        failReason: `copy failed (${copyError instanceof Error ? copyError.message : String(copyError)})`,
      };
    }
  }

  try {
    symlinkSync(sourceDir, targetPath, 'dir');
    return { mode: 'linked' };
  } catch (error) {
    try {
      cpSync(sourceDir, targetPath, { recursive: true });
      return { mode: 'copied' };
    } catch (copyError) {
      return {
        failReason:
          `link failed (${error instanceof Error ? error.message : String(error)}), ` +
          `copy failed (${copyError instanceof Error ? copyError.message : String(copyError)})`,
      };
    }
  }
}

export function installSkills(options: InstallSkillsOptions = {}): InstallSkillsResult {
  const projectPath = resolveProjectPath(options.projectPath);
  const codexSkillsDir = resolveCodexSkillsDir(options.codexHome);
  const result: InstallSkillsResult = {
    installed: [],
    linked: [],
    copied: [],
    skipped: [],
    failed: [],
    codexSkillsDir,
    notices: [],
  };

  const source = resolveSkillSource(projectPath, options);
  result.notices.push(...source.notices);

  try {
    const discovered = discoverSkills({ projectPath: source.discoveryRoot });
    const knownNames = new Set(discovered.map((skill) => skill.name.toLowerCase()));
    if (options.repo) {
      discovered.push(...discoverSkillsFromRecursiveSkillFiles(source.discoveryRoot, knownNames));
    }

    const selected = findSelectedSkills(discovered, {
      ...options,
      allowExternal: options.repo ? true : options.allowExternal,
    });
    if (options.repo && !options.allowExternal) {
      result.notices.push('remote source install includes external-risk skills by default.');
    }

    if (selected.length === 0) {
      result.skipped.push({
        name: options.name?.trim() || '(none)',
        reason: options.name
          ? 'skill not found or not installable'
          : options.repo
            ? 'no installable skills found in source repo'
            : 'no installable local skills found',
      });
      return result;
    }

    if (!options.dryRun) {
      mkdirSync(codexSkillsDir, { recursive: true });
    }

    for (const skill of selected) {
      const targetPath = join(codexSkillsDir, skill.name);
      const installResult = linkOrCopySkill({
        skill,
        targetPath,
        force: !!options.force,
        dryRun: !!options.dryRun,
        preferCopy: source.forceCopyInstall,
      });

      if (installResult.skipReason) {
        result.skipped.push({ name: skill.name, reason: installResult.skipReason });
        continue;
      }
      if (installResult.failReason) {
        result.failed.push({ name: skill.name, reason: installResult.failReason });
        continue;
      }

      result.installed.push(skill.name);
      if (installResult.mode === 'linked') result.linked.push(skill.name);
      if (installResult.mode === 'copied') result.copied.push(skill.name);
    }

    return result;
  } finally {
    source.cleanup?.();
  }
}

export function skillsListCommand(options: { project?: string; all?: boolean } = {}): void {
  const skills = discoverSkills({ projectPath: options.project });
  if (skills.length === 0) {
    console.log(chalk.gray('No skills found (checked AGENTS.md and .agents/skills).'));
    return;
  }

  const filtered = options.all
    ? skills
    : skills.filter((skill) => skill.hasSkillFile && skill.noApiLikely);

  if (filtered.length === 0) {
    console.log(chalk.yellow('No local/no-api installable skills found.'));
    console.log(chalk.gray('Try: mudcode skill list --all'));
    return;
  }

  console.log(chalk.cyan('\n🧠 Skills\n'));
  for (const skill of filtered) {
    const state = skill.hasSkillFile
      ? skill.noApiLikely ? chalk.green('ready') : chalk.yellow('external-risk')
      : chalk.red('missing');
    const pathLabel = skill.skillFilePath || skill.rawFilePath || '(unknown)';
    console.log(`${chalk.white(`- ${skill.name}`)}  ${state}`);
    console.log(chalk.gray(`  ${skill.description}`));
    console.log(chalk.gray(`  ${pathLabel}`));
    if (skill.reason) {
      console.log(chalk.gray(`  reason: ${skill.reason}`));
    }
  }
  console.log('');
}

export function skillsInstallCommand(options: {
  name?: string;
  project?: string;
  all?: boolean;
  allowExternal?: boolean;
  force?: boolean;
  dryRun?: boolean;
  codexHome?: string;
  repo?: string;
  ref?: string;
} = {}): void {
  const allowExternal = !!options.allowExternal;
  const name = options.name?.trim();
  const installResult = installSkills({
    projectPath: options.project,
    name: name || undefined,
    allowExternal,
    force: !!options.force,
    dryRun: !!options.dryRun,
    codexHome: options.codexHome,
    repo: options.repo,
    ref: options.ref,
  });

  if (installResult.notices.length > 0) {
    for (const notice of installResult.notices) {
      console.log(chalk.gray(`ℹ️ ${notice}`));
    }
  }

  if (installResult.installed.length > 0) {
    const actionLabel = options.dryRun ? 'would install' : 'installed';
    console.log(chalk.green(`✅ ${actionLabel}: ${installResult.installed.join(', ')}`));
    console.log(chalk.gray(`   target: ${installResult.codexSkillsDir}`));
    if (installResult.linked.length > 0) {
      console.log(chalk.gray(`   linked: ${installResult.linked.join(', ')}`));
    }
    if (installResult.copied.length > 0) {
      console.log(chalk.gray(`   copied: ${installResult.copied.join(', ')}`));
    }
  }

  if (installResult.skipped.length > 0) {
    for (const skipped of installResult.skipped) {
      console.log(chalk.yellow(`⚠️ skipped ${skipped.name}: ${skipped.reason}`));
    }
  }

  if (installResult.failed.length > 0) {
    for (const failed of installResult.failed) {
      console.log(chalk.red(`❌ failed ${failed.name}: ${failed.reason}`));
    }
    process.exitCode = 1;
  }
}
