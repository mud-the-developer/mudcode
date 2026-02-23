#!/usr/bin/env tsx

import { installGeminiHook } from '../src/gemini/hook-installer.js';

function main(): void {
  try {
    const hookPath = installGeminiHook();
    console.log(`✅ Gemini CLI hook installed at: ${hookPath}`);
    console.log('ℹ️ Gemini sessions launched by mudcode will use this hook automatically.');
  } catch (error) {
    console.error(`❌ Failed to install Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
