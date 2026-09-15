import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { compareVersions, readReleaseMetadata, root } from './verify-release.mjs';

class SubmissionError extends Error {}
const ensure = (condition, message) => { if (!condition) throw new SubmissionError(message); };
const digest = archive => createHash('sha256').update(archive).digest('hex');
const progressing = state => state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS';

export function validateSubmission({ env, listing, version, archive }) {
  ensure(env.CWS_PUBLISH_ENABLED === 'true', 'Store submission is disabled. Complete setup and approve the beta first.');
  ensure(env.GITHUB_REPOSITORY === 'IceyFoxes/prompt-later' && env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF === `refs/tags/v${version}`
    && env.RELEASE_TAG === `v${version}`, 'Only a version-tag push in the approved repository may submit a release.');
  ensure(listing?.status === 'ready' && listing.privacyStatus === 'ready' && ['unlisted', 'public'].includes(listing.visibility), 'The store listing or privacy policy is still a draft. Review both before submission.');
  ensure(typeof listing.supportEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(listing.supportEmail), 'Set the approved public support email in the store listing.');
  let privacy;
  try { privacy = new URL(listing.privacyUrl); } catch { throw new SubmissionError('Set the public HTTPS privacy-policy URL in the store listing.'); }
  ensure(privacy.protocol === 'https:' && !privacy.username && !privacy.password && !privacy.port, 'The privacy policy must use HTTPS without URL credentials or a custom port.');
  ensure(typeof env.CWS_PUBLISHER_ID === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(env.CWS_PUBLISHER_ID), 'Set the Chrome Web Store publisher ID.');
  ensure(typeof env.CWS_EXTENSION_ID === 'string' && /^[a-p]{32}$/.test(env.CWS_EXTENSION_ID), 'Set the 32-letter Chrome extension ID.');
  ensure(typeof env.CWS_WORKLOAD_IDENTITY_PROVIDER === 'string' && /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(env.CWS_WORKLOAD_IDENTITY_PROVIDER), 'Configure the Google Workload Identity provider first.');
  ensure(typeof env.CWS_SERVICE_ACCOUNT === 'string' && /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(env.CWS_SERVICE_ACCOUNT), 'Configure the linked publisher service account first.');
  ensure(Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= 20 * 1024 * 1024, 'The extension archive is missing or exceeds the release size limit.');
  ensure(typeof env.EXPECTED_SHA256 === 'string' && /^[a-f0-9]{64}$/.test(env.EXPECTED_SHA256)
    && digest(archive) === env.EXPECTED_SHA256, 'The archive digest does not match the tested build.');
  return { name: `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`, itemId: env.CWS_EXTENSION_ID, version };
}

function identity(response, target) {
  ensure(response?.name === target.name && response.itemId === target.itemId, 'The store response did not identify the expected extension. Check the dashboard before retrying.');
}

function available(status, target) {
  identity(status, target);
  ensure(!status.takenDown && !status.warned, 'The store reports a policy warning or takedown. Resolve it in the dashboard first.');
  ensure(!status.submittedItemRevisionStatus || status.submittedItemRevisionStatus.state === 'CANCELLED', 'A submission, review, or rejection already exists. Resolve it in the dashboard; automation will not cancel it.');
  const published = status.publishedItemRevisionStatus;
  if (published) {
    ensure(['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(published.state)
      && Array.isArray(published.distributionChannels) && published.distributionChannels.length > 0, 'The published revision could not be verified.');
    for (const channel of published.distributionChannels) {
      let newer = false;
      try { newer = compareVersions(target.version, channel.crxVersion) > 0; } catch {}
      ensure(newer, 'The release version must be newer than every published version.');
    }
  }
}

export async function submitRelease({ env, listing, version, archive, fetcher = fetch, sleep = delay, now = Date.now }) {
  const target = validateSubmission({ env, listing, version, archive });
  ensure(typeof env.CWS_ACCESS_TOKEN === 'string' && env.CWS_ACCESS_TOKEN.length > 0
    && !/[\r\n]/.test(env.CWS_ACCESS_TOKEN), 'A short-lived publisher access token is required.');
  const statusPath = `v2/${target.name}:fetchStatus`;
  async function request(resource, phase, method = 'GET', body, contentType) {
    let response;
    try {
      response = await fetcher(`https://chromewebstore.googleapis.com/${resource}`, {
        method,
        headers: { Authorization: `Bearer ${env.CWS_ACCESS_TOKEN}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new SubmissionError(`${phase} did not complete reliably. Inspect the developer dashboard before retrying; no automatic retry was made.`);
    }
    ensure(response.ok, `${phase} returned HTTP ${Number(response.status)}. Inspect the developer dashboard before retrying.`);
    try { return await response.json(); } catch { throw new SubmissionError(`${phase} returned an unreadable response. Inspect the dashboard before retrying.`); }
  }
  const before = await request(statusPath, 'Status check');
  available(before, target);
  ensure(!progressing(before.lastAsyncUploadState), 'Another upload is in progress. Wait for it in the developer dashboard.');
  const upload = await request(`upload/v2/${target.name}:upload`, 'Upload', 'POST', archive, 'application/zip');
  identity(upload, target);
  if (upload.crxVersion !== undefined) ensure(upload.crxVersion === version, 'The uploaded version does not match the tested release. Nothing was submitted for review.');
  let uploadState = upload.uploadState;
  const deadline = now() + 120000;
  while (progressing(uploadState) && now() < deadline) {
    await sleep(2000);
    const status = await request(statusPath, 'Upload status check');
    available(status, target);
    uploadState = status.lastAsyncUploadState;
  }
  ensure(uploadState === 'SUCCEEDED', 'Upload success was not confirmed. Check the dashboard; nothing was submitted for review.');
  const current = await request(statusPath, 'Pre-submission status check');
  available(current, target);
  ensure(!progressing(current.lastAsyncUploadState), 'Another upload started before submission. Check the dashboard.');
  const result = await request(`v2/${target.name}:publish`, 'Submission', 'POST', JSON.stringify({
    publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true,
  }), 'application/json');
  identity(result, target);
  ensure(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(result.state)
    && !(result.warningInfo?.warnings?.length), 'The submission outcome needs attention. Inspect the dashboard; no retry was made.');
  const final = await request(statusPath, 'Submission confirmation');
  identity(final, target);
  const revision = result.state === 'PUBLISHED' || result.state === 'PUBLISHED_TO_TESTERS'
    ? final.publishedItemRevisionStatus : final.submittedItemRevisionStatus;
  ensure(revision?.state === result.state && Array.isArray(revision.distributionChannels)
    && revision.distributionChannels.some(channel => channel.crxVersion === version), 'The store accepted a request, but the expected revision is not yet confirmed. Inspect the dashboard before retrying.');
  return { version, state: result.state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    ensure(process.argv.length === 3 && ['--preflight', '--submit'].includes(mode), 'Use --preflight or explicitly request --submit.');
    const env = process.env;
    const input = {
      env,
      version: readReleaseMetadata(env.RELEASE_TAG || ''),
      listing: JSON.parse(fs.readFileSync(path.join(root, 'store/listing.json'), 'utf8')),
      archive: fs.readFileSync(path.join(root, 'release/prompt-later.zip')),
    };
    validateSubmission(input);
    if (mode === '--preflight') console.log('Local release preflight passed. No store API requests were made.');
    else {
      const result = await submitRelease(input);
      console.log(`Chrome Web Store confirmed ${result.version} as ${result.state}. Review and publication are controlled by the store.`);
    }
  } catch (error) {
    console.error(error instanceof SubmissionError ? error.message : 'Release preflight or submission failed. Inspect the workflow and developer dashboard before retrying.');
    process.exitCode = 1;
  }
}
