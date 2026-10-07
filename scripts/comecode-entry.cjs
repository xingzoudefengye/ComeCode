#!/usr/bin/env node
const targets = {
  'linux-x64': '@comecode/runtime-linux-x64',
  'win32-x64': '@comecode/runtime-win-x64',
  'darwin-arm64': '@comecode/runtime-darwin-arm64',
};
const key = `${process.platform}-${process.arch}`;
const packageName = targets[key];
if (!packageName) {
  console.error(`ComeCode does not support ${key}. Supported platforms: ${Object.keys(targets).join(', ')}`);
  process.exit(1);
}
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && (minor < 14 || (minor === 14 && patch < 0)))) {
  console.error('ComeCode requires Node.js 24.14.0 or newer.');
  process.exit(1);
}
let runtime;
try {
  runtime = require.resolve(`${packageName}/comecode.cjs`);
} catch {
  console.error(`ComeCode runtime ${packageName} is not installed for ${key}. Reinstall comecode with npm.`);
  process.exit(1);
}
process.argv[1] = runtime;
require(runtime);
