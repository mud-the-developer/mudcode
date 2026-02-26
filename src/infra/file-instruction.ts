/**
 * Install file-handling instructions for each agent type.
 *
 * When a Discord user sends files, mudcode downloads them and appends
 * `[file:/absolute/path]` markers to the message text. These instructions
 * teach agents how to recognize and read those markers.
 *
 * Injection strategies per agent:
 *   - Claude Code: Writes a CLAUDE.md snippet in the project's
 *     `.mudcode/` directory and references it via `--append-system-prompt`.
 *     Falls back to CLAUDE.md at project root if the agent will read it
 *     automatically.  We use `.mudcode/CLAUDE.md` so we don't pollute the
 *     user's own CLAUDE.md.
 *   - OpenCode: Appends an instruction block to `.opencode/instructions.md`
 *     in the project directory (OpenCode reads this automatically).
 *   - Generic: Places a `.mudcode/FILE_INSTRUCTIONS.md` that the agent
 *     can discover via file listing or be told about.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Start marker embedded in instruction blocks. */
const MUDCODE_FILE_MARKER = '<!-- mudcode:file-instructions -->';

/** End marker — allows us to find and replace the section on updates. */
const MUDCODE_FILE_MARKER_END = '<!-- /mudcode:file-instructions -->';

/** Legacy marker for backward-compatible detection. */
const MUDCODE_IMAGE_MARKER_LEGACY = '<!-- mudcode:image-instructions -->';

/**
 * All known start markers (current + legacy).
 */
const ALL_START_MARKERS = [MUDCODE_FILE_MARKER, MUDCODE_IMAGE_MARKER_LEGACY];

/**
 * Replace the mudcode instruction section in existing file content, or
 * append if not found.
 *
 * Handles:
 * - New format (start + end markers): replace between markers
 * - Old format (start marker only, no end marker): replace from start marker to EOF
 * - Legacy marker: replace from legacy marker to EOF
 * - No marker: append
 */
function replaceOrAppendSection(existing: string, newSection: string): string {
  // Try each known start marker
  for (const marker of ALL_START_MARKERS) {
    const startIdx = existing.indexOf(marker);
    if (startIdx === -1) continue;

    const endIdx = existing.indexOf(MUDCODE_FILE_MARKER_END, startIdx);
    if (endIdx !== -1) {
      // Found both start and end markers — replace the section
      const before = existing.substring(0, startIdx);
      const after = existing.substring(endIdx + MUDCODE_FILE_MARKER_END.length);
      return (before + newSection + after).replace(/\n{3,}/g, '\n\n');
    }

    // Only start marker found (old format) — replace from marker to EOF
    const before = existing.substring(0, startIdx);
    return (before + newSection).replace(/\n{3,}/g, '\n\n');
  }

  // No marker found — append
  return existing + '\n' + newSection;
}

/**
 * The instruction text that teaches agents how to handle `[file:...]` markers.
 */
export function getFileInstructionText(projectPath?: string): string {
  const filesDir = projectPath
    ? `${projectPath}/.mudcode/files/`
    : '.mudcode/files/';

  const binDir = projectPath
    ? `${projectPath}/.mudcode/bin/`
    : '.mudcode/bin/';

  return `${MUDCODE_FILE_MARKER}
## Mudcode — Discord/Slack Bridge

You are connected to a Discord/Slack channel through **mudcode**.

### Sending files to Discord — use \`mudcode-send\`

The \`mudcode-send\` command is **pre-configured and ready to use**.
**Do NOT explore the project or check settings before running it. Just run it immediately.**

\`\`\`bash
${binDir}mudcode-send ${filesDir}example.png
\`\`\`

Multiple files: \`${binDir}mudcode-send ${filesDir}a.png ${filesDir}b.pdf\`

- All arguments must be absolute paths
- Save generated files to \`${filesDir}\` before sending
- **Do NOT include absolute file paths in your response text** — just describe what you sent
- Supported send formats: PNG, JPEG, GIF, WebP, SVG, BMP, PDF, DOCX, PPTX, XLSX, CSV, JSON, TXT

### The \`${filesDir}\` directory — ALWAYS CHECK HERE FIRST

This is the **shared file workspace** for receiving and sending files.
When asked to send a file, you **MUST list the files in \`${filesDir}\` first** — it is almost certainly already there.

### Receiving files from Discord

File attachments are downloaded and referenced as: \`[file:/absolute/path/to/file.pdf]\`
When you see \`[file:...]\` markers, you MUST read the file at that path.
Supported formats: PNG, JPEG, GIF, WebP, PDF, DOCX, PPTX, XLSX, CSV, JSON, TXT.

### Python dependencies for document processing

Use a venv for document processing libraries (\`pymupdf\`, \`python-pptx\`, \`openpyxl\`, \`python-docx\`):

\`\`\`bash
python3 -m venv ${filesDir}.venv
source ${filesDir}.venv/bin/activate
pip install <package>
\`\`\`

Reuse the existing venv if \`${filesDir}.venv\` exists. Never install
packages globally outside of a venv.
${MUDCODE_FILE_MARKER_END}
`;
}

/**
 * Install file instructions for Claude Code.
 *
 * Claude Code automatically reads CLAUDE.md files in the project tree.
 * We write to `{projectPath}/.mudcode/CLAUDE.md` so we don't interfere
 * with the user's own CLAUDE.md at the project root.
 *
 * Since this file is fully owned by mudcode, we always overwrite with
 * the latest instruction content.
 */
export function installFileInstructionForClaude(projectPath: string): void {
  const mudcodeDir = join(projectPath, '.mudcode');
  mkdirSync(mudcodeDir, { recursive: true });

  const claudeMdPath = join(mudcodeDir, 'CLAUDE.md');
  const instruction = getFileInstructionText(projectPath);

  // .mudcode/CLAUDE.md is fully owned by mudcode — always overwrite.
  writeFileSync(claudeMdPath, instruction, 'utf-8');
}

/**
 * Install file instructions for OpenCode.
 *
 * OpenCode reads `{projectPath}/.opencode/instructions.md` automatically
 * as system-level instructions. This file may contain user content, so
 * we replace only the mudcode section.
 */
export function installFileInstructionForOpencode(projectPath: string): void {
  const opencodeDir = join(projectPath, '.opencode');
  mkdirSync(opencodeDir, { recursive: true });

  const instructionsPath = join(opencodeDir, 'instructions.md');
  const instruction = getFileInstructionText(projectPath);

  if (existsSync(instructionsPath)) {
    const existing = readFileSync(instructionsPath, 'utf-8');
    writeFileSync(instructionsPath, replaceOrAppendSection(existing, instruction), 'utf-8');
  } else {
    writeFileSync(instructionsPath, instruction, 'utf-8');
  }
}

/**
 * Install file instructions for any generic agent.
 *
 * Places the instructions at `{projectPath}/.mudcode/FILE_INSTRUCTIONS.md`
 * where agents can discover them. Fully owned by mudcode — always overwrite.
 */
export function installFileInstructionGeneric(projectPath: string): void {
  const mudcodeDir = join(projectPath, '.mudcode');
  mkdirSync(mudcodeDir, { recursive: true });

  const instructionPath = join(mudcodeDir, 'FILE_INSTRUCTIONS.md');
  const instruction = getFileInstructionText(projectPath);

  // Fully owned by mudcode — always overwrite.
  writeFileSync(instructionPath, instruction, 'utf-8');
}

/**
 * Install file-handling instructions appropriate for the given agent type.
 */
export function installFileInstruction(projectPath: string, agentType: string): void {
  switch (agentType) {
    case 'claude':
      installFileInstructionForClaude(projectPath);
      break;
    case 'opencode':
      installFileInstructionForOpencode(projectPath);
      break;
    default:
      installFileInstructionGeneric(projectPath);
      break;
  }
}
