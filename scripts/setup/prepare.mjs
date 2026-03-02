import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const tsupBin = process.platform === 'win32'
  ? resolve('node_modules', '.bin', 'tsup.cmd')
  : resolve('node_modules', '.bin', 'tsup');

if (!existsSync(tsupBin)) {
  console.log('ℹ️ Skipping prepare build: local tsup is not installed.');
  console.log('   This is expected for production-only installs.');
  process.exit(0);
}

const result = spawnSync(tsupBin, [], { stdio: 'inherit' });
if (result.error) {
  console.error(`❌ prepare build failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
