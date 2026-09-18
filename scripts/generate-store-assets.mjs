import fs from 'node:fs';
import path from 'node:path';
import { nextOccurrence } from '../src/schedules.js';
import { closeExtension, openExtension, root, tickFromPage, writeState } from '../tests/browser/helpers.js';

const directory = path.join(root, 'store');
const images = path.join(directory, 'images');
const listing = JSON.parse(fs.readFileSync(path.join(directory, 'listing.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const draft = listing.status !== 'ready';
const policyDraft = listing.privacyStatus !== 'ready';
const styles = 'body{margin:0;background:#f6f7fb;color:#172034;font:16px/1.65 system-ui,sans-serif}main{max-width:850px;margin:40px auto;padding:32px;background:white;border:1px solid #e2e5ef;border-radius:16px}h1,h2{line-height:1.25}h1{color:#4038b4}h2{margin-top:32px;font-size:21px}a{color:#5b55e7}.draft{padding:14px;background:#fff4db;border:1px solid #f0d18a;border-radius:8px}.description{white-space:pre-line}.muted{color:#67738b}dt{font-weight:700;margin-top:16px}dd{margin:4px 0 0}@media(max-width:700px){main{margin:12px;padding:20px}}';
function document(title, body, isDraft = draft) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:">${isDraft ? '<meta name="robots" content="noindex">' : ''}<title>${escape(title)}</title><style>${styles}</style></head><body><main>${isDraft ? '<p class="draft"><strong>Draft — not ready for submission.</strong> Publisher contact and hosting details must be completed before publishing.</p>' : ''}${body}</main></body></html>`;
}
const contact = listing.supportEmail
  ? `<p>Contact: <a href="mailto:${encodeURIComponent(listing.supportEmail)}">${escape(listing.supportEmail)}</a></p>`
  : '<p class="draft">A public support email has not been set. This policy remains a draft.</p>';
const policy = `<h1>Prompt Later privacy policy</h1>${listing.privacySections.map(section => `<section><h2>${escape(section.heading)}</h2>${section.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}</section>`).join('')}${contact}`;
const policyPage = document('Prompt Later privacy policy', policy, policyDraft);
if (!policyDraft && (typeof listing.supportEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(listing.supportEmail))) throw new Error('A public support email is required before publishing the policy.');
fs.writeFileSync(path.join(directory, 'privacy.html'), policyPage);
const details = `<h1>${escape(listing.title)}</h1><p class="muted">${escape(listing.price)} · ${escape(listing.visibility)} beta draft</p><h2>Store description</h2><p class="description">${escape(listing.description)}</p><h2>Single purpose</h2><p>${escape(listing.singlePurpose)}</p><h2>Permission justifications</h2><dl>${Object.entries(listing.permissionJustifications).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}</dl><h2>Remote code</h2><p>${escape(listing.remoteCode)}</p><h2>Reviewer instructions</h2><ol>${listing.testInstructions.map(instruction => `<li>${escape(instruction)}</li>`).join('')}</ol><h2>Privacy</h2><p><a href="privacy.html">Read the privacy-policy draft</a></p>${contact}`;
fs.writeFileSync(path.join(directory, 'index.html'), document('Prompt Later store draft', details));
if (process.argv.includes('--policy-site')) {
  if (policyDraft) throw new Error('Approve the privacy policy before exporting the public site.');
  const site = path.join(root, 'artifacts/prompt-later-site');
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), policyPage);
  fs.writeFileSync(path.join(site, 'privacy.html'), policyPage);
  fs.writeFileSync(path.join(site, '.nojekyll'), '');
}
if (process.argv.includes('--pages-only')) process.exit(0);
fs.mkdirSync(images, { recursive: true });
fs.copyFileSync(path.join(root, 'dist/icons/icon128.png'), path.join(images, 'icon128.png'));

const samplePath = path.join(directory, 'demo-state.json');
let capture;
if (fs.existsSync(samplePath)) {
  capture = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
} else {
  const capturedAt = Date.now();
  const common = { missedPolicy: 'skip', createdAt: capturedAt, updatedAt: capturedAt, enabled: true, status: 'scheduled', runId: null, lastOutcome: null, lastDetail: '' };
  const once = { type: 'once', at: capturedAt + 5 * 3600000, timeZone: 'UTC' };
  const weekdays = { type: 'cron', expression: '0 7 * * 1-5', preset: 'weekdays', timeZone: 'UTC' };
  capture = {
    capturedAt,
    state: {
      version: 1,
      jobs: [
        { ...common, id: 'demo-once', provider: 'chatgpt', url: 'https://chatgpt.com/c/demo-conversation', message: 'Continue reviewing the remaining changes and summarize any issues.', schedule: once, nextRunAt: once.at },
        { ...common, id: 'demo-weekdays', provider: 'claude', url: 'https://claude.ai/chat/demo-morning', message: 'Review the open tasks and suggest the first three priorities for today.', schedule: weekdays, nextRunAt: nextOccurrence(weekdays, capturedAt) },
      ],
      history: [],
    },
  };
  fs.writeFileSync(samplePath, `${JSON.stringify(capture, null, 2)}\n`);
}

const environment = await openExtension();
try {
  const { page, context } = environment;
  await tickFromPage(page);
  await page.evaluate(() => chrome.alarms.clearAll());
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.setFixedTime(new Date(capture.capturedAt));
  await writeState(page, capture.state);
  const [once, weekdays] = capture.state.jobs;
  await page.locator('#job-list').getByText(once.message, { exact: true }).waitFor();
  await page.locator('#url').fill(once.url);
  await page.locator('#message').fill(once.message);
  await page.screenshot({ path: path.join(images, 'send-later.png') });
  await page.locator('[data-tab="recurring"]').click();
  await page.locator('#recurrence').selectOption('weekdays');
  await page.locator('#timezone').fill('UTC');
  await page.locator('#recurring-time').fill('07:00');
  await page.locator('#url').fill(weekdays.url);
  await page.locator('#message').fill(weekdays.message);
  await page.locator('#job-list').getByText(weekdays.message, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(images, 'recurring.png') });
  await page.locator('#privacy-settings > summary').click();
  await page.locator('#privacy-title').getByText('Automatic device protection', { exact: true }).waitFor();
  await page.locator('#privacy-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(images, 'privacy-settings.png') });
  const promo = await context.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  const icon = fs.readFileSync(path.join(images, 'icon128.png')).toString('base64');
  await promo.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;width:440px;height:280px;background:#f6f7fb;color:#172034;font-family:system-ui,sans-serif}main{padding:26px 30px;border:1px solid #e2e5ef;height:280px;background:linear-gradient(135deg,#fff,#f0efff)}header{display:flex;align-items:center;gap:12px;font-weight:750;font-size:30px}img{width:42px;height:42px}h1{font-size:23px;line-height:1.3;margin:20px 0 10px;color:#4038b4}p{font-size:16px;line-height:1.55;margin:0;max-width:360px}footer{margin-top:18px;font-size:13px;font-weight:650;color:#5b55e7}</style></head><body><main><header><img src="data:image/png;base64,${icon}" alt="">Prompt Later</header><h1>Send later for AI chats</h1><p>Choose a conversation. Pick a time. Save a prompt.</p><footer>Free · Local-first</footer></main></body></html>`);
  await promo.screenshot({ path: path.join(images, 'small-promo.png') });
  await promo.close();
} finally {
  await closeExtension(environment);
}
console.log('Generated draft store pages, a 128px icon, a 440x280 promo image, and three 1280x800 fixture screenshots.');
console.log('Demo inputs are frozen in store/demo-state.json. No live provider messages were sent.');
