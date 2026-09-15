import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { optionalHostPermissions } from '../../src/providers.js';
import { compareVersions, validateReleaseMetadata, versionParts } from '../../scripts/verify-release.mjs';
import { submitRelease, validateSubmission } from '../../scripts/submit-release.mjs';

const version = '0.3.0';
const manifest = { name: 'Prompt Later', version, manifest_version: 3, minimum_chrome_version: '120', permissions: ['storage', 'alarms', 'activeTab', 'scripting'], optional_host_permissions: optionalHostPermissions(), content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" } };
const pkg = { version };
const lock = { version, packages: { '': { version } } };
const archive = Buffer.from('Synthetic package bytes; all store requests are mocked.');
const itemId = 'abcdefghijklmnopabcdefghijklmnop';
const name = `publishers/test-publisher/items/${itemId}`;
const listing = { status: 'ready', privacyStatus: 'ready', visibility: 'unlisted', supportEmail: 'support@example.test', privacyUrl: 'https://example.test/privacy' };
const env = {
  CWS_PUBLISH_ENABLED: 'true', GITHUB_REPOSITORY: 'IceyFoxes/prompt-later', GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag',
  GITHUB_REF: `refs/tags/v${version}`, RELEASE_TAG: `v${version}`, CWS_PUBLISHER_ID: 'test-publisher', CWS_EXTENSION_ID: itemId,
  CWS_WORKLOAD_IDENTITY_PROVIDER: 'projects/123456789/locations/global/workloadIdentityPools/test-pool/providers/test-provider',
  CWS_SERVICE_ACCOUNT: 'publisher@test-project.iam.gserviceaccount.com', CWS_ACCESS_TOKEN: 'synthetic-access-token',
  EXPECTED_SHA256: createHash('sha256').update(archive).digest('hex'),
};
const input = changes => ({ env: { ...env }, listing: { ...listing }, version, archive, ...changes });
const baseStatus = { name, itemId, publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.2.0', deployPercentage: 100 }] } };
const uploadOk = { name, itemId, crxVersion: version, uploadState: 'SUCCEEDED' };
const pending = { name, itemId, state: 'PENDING_REVIEW' };
const confirmed = { ...baseStatus, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: version }] } };

function responses(values) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-access-token');
      assert(url.startsWith('https://chromewebstore.googleapis.com/'));
      const value = values.shift();
      if (value instanceof Error) throw value;
      assert.notEqual(value, undefined, 'unexpected network request');
      return value?.httpError ? { ok: false, status: value.httpError } : { ok: true, status: 200, json: async () => structuredClone(value) };
    },
  };
}

test('release versions, tags, and optional permissions are checked without changing policy', () => {
  assert.equal(validateReleaseMetadata(manifest, pkg, lock, 'v0.3.0'), version);
  assert.deepEqual(versionParts('2.1'), [2, 1, 0, 0]);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  for (const invalid of ['1.0.0-beta', '01.2.3', '1.2.3.4.5', '65536.0', '-1.0', '1e2.0']) assert.throws(() => versionParts(invalid));
  for (const [modified, packageValue, lockValue, tag] of [
    [manifest, { version: '0.2.0' }, lock, 'v0.3.0'], [manifest, pkg, { ...lock, version: '0.2.0' }, 'v0.3.0'],
    [manifest, pkg, lock, 'v0.3.1'], [{ ...manifest, host_permissions: ['<all_urls>'] }, pkg, lock, 'v0.3.0'],
    [{ ...manifest, permissions: [...manifest.permissions, 'tabs'] }, pkg, lock, 'v0.3.0'],
    [{ ...manifest, optional_host_permissions: [] }, pkg, lock, 'v0.3.0'],
    [{ ...manifest, externally_connectable: { matches: ['https://example.test/*'] } }, pkg, lock, 'v0.3.0'],
  ]) assert.throws(() => validateReleaseMetadata(modified, packageValue, lockValue, tag));
});

test('submission is disabled by default and rejects incomplete setup before any network call', async () => {
  const badInputs = [
    input({ env: { ...env, CWS_PUBLISH_ENABLED: undefined } }), input({ env: { ...env, GITHUB_EVENT_NAME: 'pull_request' } }),
    input({ env: { ...env, GITHUB_REPOSITORY: 'other/repo' } }), input({ env: { ...env, GITHUB_REF: 'refs/heads/main' } }),
    input({ env: { ...env, RELEASE_TAG: 'v0.2.0' } }), input({ env: { ...env, CWS_EXTENSION_ID: '../bad' } }),
    input({ env: { ...env, CWS_PUBLISHER_ID: 'bad/path' } }), input({ env: { ...env, CWS_WORKLOAD_IDENTITY_PROVIDER: '' } }),
    input({ env: { ...env, CWS_SERVICE_ACCOUNT: 'personal@example.test' } }), input({ env: { ...env, EXPECTED_SHA256: '0'.repeat(64) } }),
    input({ listing: { ...listing, status: 'draft' } }), input({ listing: { ...listing, privacyStatus: 'draft' } }),
    input({ listing: { ...listing, privacyStatus: undefined } }), input({ listing: { ...listing, supportEmail: null } }),
    input({ listing: { ...listing, privacyUrl: null } }), input({ listing: { ...listing, privacyUrl: 'http://example.test/privacy' } }),
    input({ listing: { ...listing, privacyUrl: 'https://user:password@example.test/privacy' } }),
  ];
  for (const invalid of badInputs) {
    assert.throws(() => validateSubmission(invalid));
    const network = responses([]);
    await assert.rejects(() => submitRelease({ ...invalid, ...network }));
    assert.equal(network.calls.length, 0);
  }
});

test('successful submission uses the tested bytes, requests review, and confirms the expected revision', async () => {
  const network = responses([baseStatus, uploadOk, baseStatus, pending, confirmed]);
  assert.deepEqual(await submitRelease({ ...input(), ...network }), { version, state: 'PENDING_REVIEW' });
  assert.equal(network.calls.length, 5);
  assert(network.calls[1].url.endsWith(`/upload/v2/${name}:upload`));
  assert.equal(network.calls[1].options.method, 'POST');
  assert.equal(network.calls[1].options.body, archive);
  assert.equal(network.calls[1].options.headers['Content-Type'], 'application/zip');
  assert.deepEqual(JSON.parse(network.calls[3].options.body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
  assert(network.calls.every(call => !call.url.includes(env.CWS_ACCESS_TOKEN) && !call.url.includes('cancelSubmission')));
});

test('asynchronous upload completes before review submission', async () => {
  const network = responses([baseStatus, { name, itemId, uploadState: 'IN_PROGRESS' }, { ...baseStatus, lastAsyncUploadState: 'IN_PROGRESS' }, { ...baseStatus, lastAsyncUploadState: 'SUCCEEDED' }, baseStatus, pending, confirmed]);
  let waits = 0;
  const result = await submitRelease({ ...input(), ...network, sleep: async milliseconds => { assert.equal(milliseconds, 2000); waits += 1; } });
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.equal(waits, 2);
  assert(network.calls[5].url.endsWith(':publish'));
});

test('pending review, rejection, policy warnings, competing upload, and version rollback block upload', async () => {
  for (const change of [
    { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }, { submittedItemRevisionStatus: { state: 'STAGED' } },
    { submittedItemRevisionStatus: { state: 'REJECTED' } }, { warned: true }, { takenDown: true }, { lastAsyncUploadState: 'IN_PROGRESS' },
    { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.3.0' }] } },
    { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.4.0' }] } },
    { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [] } }, { itemId: 'p'.repeat(32) },
  ]) {
    const network = responses([{ ...baseStatus, ...change }]);
    await assert.rejects(() => submitRelease({ ...input(), ...network }));
    assert.equal(network.calls.length, 1);
  }
});

test('failed, mismatched, unknown, or timed-out uploads never trigger publication', async () => {
  for (const response of [{ ...uploadOk, uploadState: 'FAILED' }, { ...uploadOk, uploadState: 'NOT_FOUND' }, { ...uploadOk, crxVersion: '9.9.9' }, { ...uploadOk, itemId: 'p'.repeat(32) }, new Error('synthetic-access-token should never leak')]) {
    const network = responses([baseStatus, response]);
    await assert.rejects(() => submitRelease({ ...input(), ...network }), error => !error.message.includes('synthetic-access-token'));
    assert.equal(network.calls.length, 2);
  }
  const network = responses([baseStatus, { name, itemId, uploadState: 'IN_PROGRESS' }]);
  let time = 0;
  await assert.rejects(() => submitRelease({ ...input(), ...network, now: () => { time += 120001; return time; }, sleep: async () => {} }), /Upload success/);
  assert.equal(network.calls.length, 2);
});

test('a competing submission after upload blocks the publish request', async () => {
  const network = responses([baseStatus, uploadOk, confirmed]);
  await assert.rejects(() => submitRelease({ ...input(), ...network }), /already exists/);
  assert.equal(network.calls.length, 3);
});

test('an uncertain publish response is not retried and cannot leak token-bearing errors', async () => {
  const network = responses([baseStatus, uploadOk, baseStatus, new Error('Authorization: Bearer synthetic-access-token')]);
  await assert.rejects(() => submitRelease({ ...input(), ...network }), error => /Submission did not complete/.test(error.message) && !error.message.includes('synthetic-access-token'));
  assert.equal(network.calls.filter(call => call.url.endsWith(':publish')).length, 1);
});

test('a server error or wrong final version never reports a confirmed release', async () => {
  const failed = responses([{ httpError: 401 }]);
  await assert.rejects(() => submitRelease({ ...input(), ...failed }), /HTTP 401/);
  assert.equal(failed.calls.length, 1);
  const mismatch = responses([baseStatus, uploadOk, baseStatus, pending, { ...confirmed, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '9.9.9' }] } }]);
  await assert.rejects(() => submitRelease({ ...input(), ...mismatch }), /not yet confirmed/);
  assert.equal(mismatch.calls.length, 5);
});
