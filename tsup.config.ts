import { cpSync } from 'fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon-entry.ts', 'bin/mudcode.ts', 'bin/tui.tsx'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  onSuccess: async () => {
    cpSync('src/claude/plugin', 'dist/claude/plugin', { recursive: true });
    cpSync('src/gemini/hook', 'dist/gemini/hook', { recursive: true });
    cpSync('src/opencode/plugin', 'dist/opencode/plugin', { recursive: true });
  },
});
