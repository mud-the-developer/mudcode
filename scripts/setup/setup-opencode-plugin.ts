#!/usr/bin/env tsx

import { installOpencodePlugin } from '../../src/opencode/plugin-installer.js';

function main(): void {
  try {
    const pluginPath = installOpencodePlugin();
    console.log(`✅ OpenCode plugin installed at: ${pluginPath}`);
    console.log('ℹ️ Restart opencode session to load the plugin.');
  } catch (error) {
    console.error(`❌ Failed to install OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
