#!/usr/bin/env node

import os from 'os';

const platformMap = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};
const archMap = {
  x64: 'x64',
  arm64: 'arm64',
};

const platform = platformMap[os.platform()] || os.platform();
const arch = archMap[os.arch()] || os.arch();

if ((platform !== 'darwin' && platform !== 'linux' && platform !== 'windows') || (arch !== 'x64' && arch !== 'arm64')) {
  console.warn(`[mudcode] No prebuilt binary available for ${platform}/${arch}.`);
  console.warn('[mudcode] You can still run from source with Node + Bun installed.');
}
