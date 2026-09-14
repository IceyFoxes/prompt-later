import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureForNew } from './provider-fixtures.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function fixtureFor(host, options = {}) {
  const editorTag = host === 'claude.ai'
    ? `<div data-testid="chat-input" contenteditable="true">${options.draft || ''}</div>`
    : host === 'app.devin.ai'
      ? `<textarea placeholder="Devin message" ${options.readOnly ? 'readonly' : ''}>${options.draft || ''}</textarea>`
      : `<textarea id="prompt-textarea" ${options.readOnly ? 'readonly' : ''}>${options.draft || ''}</textarea>`;
  const editorMarkup = options.missingEditor ? '' : editorTag.repeat(options.editors || 1);
  const sendAttribute = host === 'claude.ai'
    ? 'aria-label="Send message"'
    : host === 'app.devin.ai'
      ? 'data-testid="send-message-button"'
      : 'aria-label="Send"';
  const sendLabel = host === 'claude.ai' ? 'Send message' : 'Send';
  const sendMarkup = options.missingSend
    ? ''
    : Array.from({ length: options.sends || 1 }, () => `<button ${sendAttribute} ${options.disabledSend ? 'disabled' : ''}>${sendLabel}</button>`).join('');
  const userAttribute = host === 'claude.ai'
    ? 'node.dataset.testid="user-message"'
    : host === 'app.devin.ai'
      ? 'node.dataset.messageRole="user"'
      : 'node.dataset.messageAuthorRole="user"';
  const modal = options.modalEditor ? `<dialog open>${editorTag}</dialog>` : '';
  const alertScript = options.postClickAlert
    ? "const alert = document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Something went wrong'; document.body.append(alert);"
    : '';
  const busyScript = options.busyOnInput
    ? "const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop generating'); document.body.append(stop);"
    : '';
  const attachmentScript = options.pendingAttachmentOnInput
    ? "const attachment = document.createElement('button'); attachment.setAttribute('aria-label', 'Remove attachment'); document.querySelector('main').append(attachment);"
    : '';
  const routeChangeScript = options.urlChangeOnInput
    ? "history.pushState({}, '', '/c/changed');"
    : '';
  const nestedUser = host === 'claude.ai'
    ? "node.textContent = ''; const child = document.createElement('span'); child.dataset.testid = 'user-message-content'; child.textContent = read(); node.append(child);"
    : '';
  const ackScript = options.noAck
    ? ''
    : `const node = document.createElement('div'); ${userAttribute}; node.textContent = read(); ${nestedUser} document.querySelector('#messages').append(node);`;
  const clearScript = options.noClear
    ? ''
    : "if (editor?.value === undefined) editor.innerText = ''; else editor.value = '';";
  const script = `
    const editor = document.querySelector('textarea,[contenteditable="true"]');
    const read = () => editor?.value === undefined ? editor?.innerText || '' : editor?.value || '';
    if (editor) editor.addEventListener('input', () => {
      document.querySelectorAll('button').forEach(button => { button.disabled = !read(); });
      ${busyScript}
      ${attachmentScript}
      ${routeChangeScript}
    });
    document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
      ${ackScript}
      ${clearScript}
      if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
      ${alertScript}
    }));
  `;
  return `<!doctype html><html><body><main>${editorMarkup}${modal}${sendMarkup}<div id="messages"></div></main><script>${script}</script></body></html>`;
}

export async function openExtension(options = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-later-extension-'));
  fs.cpSync(path.join(root, 'dist'), copy, { recursive: true });
  const manifestPath = path.join(copy, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-later-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    serviceWorkers: 'block',
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'https:') {
      const newFixture = fixtureForNew(url.hostname, options.fixture || {});
      if (newFixture) return route.fulfill({ status: 200, contentType: 'text/html', body: newFixture });
      if (['chatgpt.com', 'claude.ai', 'app.devin.ai'].includes(url.hostname)) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixtureFor(url.hostname, options.fixture || {}) });
      }
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') return route.abort();
    return route.continue();
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${options.path || 'app.html'}`);
  return { context, page, worker, id, copy, profile };
}

export async function closeExtension(environment) {
  await environment.context.close();
  fs.rmSync(environment.copy, { recursive: true, force: true });
  fs.rmSync(environment.profile, { recursive: true, force: true });
}

export async function tickFromPage(page) {
  const pageUrl = new URL(page.url());
  const origin = pageUrl.origin === 'null'
    ? `${pageUrl.protocol}//${pageUrl.host}`
    : pageUrl.origin;
  let worker = page.context().serviceWorkers().find(candidate => candidate.url().startsWith(`${origin}/`));
  if (!worker) {
    worker = await page.context().waitForEvent('serviceworker', {
      predicate: candidate => candidate.url().startsWith(`${origin}/`),
    });
  }
  try {
    return await worker.evaluate(async () => {
      const module = await import(chrome.runtime.getURL('worker.js'));
      await module.ready;
      return module.scheduler.tick();
    });
  } catch (error) {
    if (!String(error?.message || error).includes('import() is disallowed')) throw error;
    return worker.evaluate(async () => {
      const initial = (await chrome.storage.local.get('prompt-later.v1'))['prompt-later.v1'];
      chrome.alarms.create('prompt-later:due', { when: Date.now() });
      const started = Date.now();
      while (Date.now() - started < 25000) {
        const stored = (await chrome.storage.local.get('prompt-later.v1'))['prompt-later.v1'];
        const changed = stored?.history?.length > initial?.history?.length
          || stored?.jobs?.some((job, index) => job.status !== initial?.jobs?.[index]?.status);
        const running = stored?.jobs?.some(job => job.status === 'running');
        if (!running && (changed || initial?.jobs?.every(job => job.status !== 'scheduled'))) return stored;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Prompt Later alarm did not drain the due fixture.');
    });
  }
}

export async function dueState(page, predicate = () => true) {
  const state = await page.evaluate(async () => (await chrome.storage.local.get('prompt-later.v1'))['prompt-later.v1']);
  const job = state.jobs.find(predicate);
  if (!job) throw new Error('Fixture job not found.');
  const dueAt = Date.now() - 1000;
  job.nextRunAt = dueAt;
  if (job.schedule.type === 'once') job.schedule.at = dueAt;
  await page.evaluate(value => chrome.storage.local.set({ 'prompt-later.v1': value }), state);
}
