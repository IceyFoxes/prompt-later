import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { optionalHostPermissions } from '../src/providers.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function versionParts(version) {
  assert.equal(typeof version, 'string', 'Extension version must be a string.');
  assert.match(version, /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/, 'Use a numeric Chrome extension version.');
  const parts = version.split('.').map(Number);
  assert(parts.every(part => Number.isInteger(part) && part <= 65535), 'Version components must be at most 65535.');
  return [...parts, ...Array(4 - parts.length).fill(0)];
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

export function validateReleaseMetadata(manifest, pkg, lock, tag = '') {
  versionParts(manifest.version);
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Release versions must have three numeric components.');
  assert.equal(pkg.version, manifest.version, 'Package and manifest versions differ.');
  assert.equal(lock.version, manifest.version, 'Lockfile and manifest versions differ.');
  assert.equal(lock.packages?.['']?.version, manifest.version, 'Lockfile root version differs.');
  assert.equal(manifest.manifest_version, 3, 'Only Manifest V3 is supported.');
  assert.equal(manifest.name, 'Prompt Later — AI Chat Scheduler');
  assert.equal(manifest.short_name, 'Prompt Later');
  assert.equal(manifest.minimum_chrome_version, '120');
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'activeTab', 'scripting']);
  assert.deepEqual(manifest.optional_host_permissions, optionalHostPermissions());
  assert.equal(manifest.host_permissions, undefined, 'Provider access must remain optional.');
  assert.equal(manifest.externally_connectable, undefined, 'External extension messaging is not supported.');
  assert.equal(manifest.content_security_policy?.extension_pages, "script-src 'self'; object-src 'none'");
  if (tag) assert.equal(tag, `v${manifest.version}`, 'Release tag must match the packaged version exactly.');
  return manifest.version;
}

export function readReleaseMetadata(tag = '') {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  return validateReleaseMetadata(read('manifest.json'), read('package.json'), read('package-lock.json'), tag);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tag = process.env.RELEASE_TAG || '';
    const version = readReleaseMetadata(tag);
    if (tag) {
      execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: root, stdio: 'pipe' });
    }
    console.log(`Release metadata verified for ${version}${tag ? ' on main history' : ''}.`);
  } catch {
    console.error('Release metadata, version tag, or main-branch ancestry check failed. No package was submitted.');
    process.exitCode = 1;
  }
}
