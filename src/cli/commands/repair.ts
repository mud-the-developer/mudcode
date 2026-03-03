import chalk from 'chalk';
import { basename } from 'path';
import { stateManager } from '../../state/index.js';
import { daemonCommand } from './daemon.js';
import { runDoctor } from './doctor.js';
import { healthCommand } from './health.js';

export type RepairMode = 'default' | 'doctor-only' | 'restart-only' | 'verify' | 'deep';

type RepairVerifyProjectResolution = {
  projectName?: string;
  source: 'explicit' | 'cwd' | 'single' | 'none';
};

export function normalizeRepairMode(raw?: string): RepairMode | undefined {
  const value = (raw || '').trim().toLowerCase();
  if (!value || value === 'default') return 'default';
  if (value === 'doctor' || value === 'doctor-only') return 'doctor-only';
  if (value === 'restart' || value === 'restart-only') return 'restart-only';
  if (value === 'verify' || value === 'check') return 'verify';
  if (value === 'deep' || value === 'full') return 'deep';
  return undefined;
}

async function runDoctorFixStep(): Promise<boolean> {
  console.log(chalk.cyan('\n🛠️ Repair step: doctor --fix\n'));
  const result = await runDoctor({ fix: true });
  const failCount = result.issues.filter((issue) => issue.level === 'fail').length;
  const warnCount = result.issues.filter((issue) => issue.level === 'warn').length;
  console.log(
    chalk.gray(
      `doctor summary: ok=${result.ok ? 'yes' : 'no'}, fixes=${result.fixes.length}, warnings=${warnCount}, failures=${failCount}`,
    ),
  );
  if (result.fixes.length > 0) {
    const preview = result.fixes.slice(0, 4).map((fix) => `- ${fix.code}: ${fix.message}`);
    for (const line of preview) {
      console.log(chalk.gray(line));
    }
    if (result.fixes.length > preview.length) {
      console.log(chalk.gray(`- ... ${result.fixes.length - preview.length} more`));
    }
  }
  if (!result.ok) {
    console.log(chalk.red('❌ Doctor step reported failures. Stopping repair flow.'));
    process.exitCode = 1;
    return false;
  }
  console.log(chalk.green('✅ Doctor step completed.'));
  return true;
}

async function runDaemonRestartStep(): Promise<boolean> {
  console.log(chalk.cyan('\n♻️ Repair step: daemon restart\n'));
  try {
    await daemonCommand('restart');
    return true;
  } catch (error) {
    console.log(
      chalk.red(
        `❌ Daemon restart step failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
    return false;
  }
}

function findProjectName(
  projects: ReturnType<typeof stateManager.listProjects>,
  rawName: string,
): string | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  const exact = projects.find((project) => project.projectName === trimmed);
  if (exact) return exact.projectName;
  const lower = trimmed.toLowerCase();
  const caseInsensitive = projects.find((project) => project.projectName.toLowerCase() === lower);
  return caseInsensitive?.projectName;
}

function resolveRepairVerifyProject(rawProject?: string): RepairVerifyProjectResolution {
  const projects = stateManager.listProjects();
  const explicit = rawProject?.trim();
  if (explicit) {
    return {
      projectName: findProjectName(projects, explicit) || explicit,
      source: 'explicit',
    };
  }

  const cwdName = basename(process.cwd());
  const cwdMatch = findProjectName(projects, cwdName);
  if (cwdMatch) {
    return {
      projectName: cwdMatch,
      source: 'cwd',
    };
  }

  if (projects.length === 1) {
    return {
      projectName: projects[0].projectName,
      source: 'single',
    };
  }

  return { source: 'none' };
}

async function runHealthVerifyStep(scope: RepairVerifyProjectResolution): Promise<boolean> {
  console.log(chalk.cyan('\n🩺 Repair step: health verify\n'));
  if (scope.projectName) {
    const scopeHint =
      scope.source === 'cwd'
        ? ' (auto from current directory)'
        : scope.source === 'single'
          ? ' (auto from single configured project)'
          : '';
    console.log(chalk.gray(`health verify scope: ${scope.projectName}${scopeHint}`));
  } else {
    console.log(chalk.gray('health verify scope: all configured projects'));
  }
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await healthCommand({
      captureTest: true,
      captureTestPolls: 4,
      captureTestIntervalMs: 700,
      ...(scope.projectName ? { project: scope.projectName } : {}),
    });
  } catch (error) {
    console.log(
      chalk.red(
        `❌ Health verify step failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
    return false;
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.log(chalk.red('❌ Health verify reported failures.'));
    return false;
  }

  process.exitCode = previousExitCode;
  console.log(chalk.green('✅ Health verify completed.'));
  return true;
}

export async function repairCommand(options: { mode?: string; project?: string } = {}): Promise<void> {
  const mode = normalizeRepairMode(options.mode);
  if (!mode) {
    console.error(chalk.red(`Unknown repair mode: ${options.mode || '(empty)'}`));
    console.log(chalk.gray('Usage: mudcode repair [default|doctor-only|restart-only|verify|deep]'));
    process.exitCode = 1;
    return;
  }

  if (mode === 'doctor-only') {
    await runDoctorFixStep();
    return;
  }

  if (mode === 'restart-only') {
    await runDaemonRestartStep();
    return;
  }

  if (mode === 'verify') {
    const projectScope = resolveRepairVerifyProject(options.project);
    await runHealthVerifyStep(projectScope);
    return;
  }

  if (mode === 'default') {
    const doctorOk = await runDoctorFixStep();
    if (!doctorOk) return;
    await runDaemonRestartStep();
    return;
  }

  const doctorOk = await runDoctorFixStep();
  if (!doctorOk) return;
  const restartOk = await runDaemonRestartStep();
  if (!restartOk) return;
  const projectScope = resolveRepairVerifyProject(options.project);
  await runHealthVerifyStep(projectScope);
}
