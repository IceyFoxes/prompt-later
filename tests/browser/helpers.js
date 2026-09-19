import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureForNew } from './provider-fixtures.js';
import { buildSync } from 'esbuild';

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
  const busyAfterFirstClickScript = Number(options.busyAfterFirstClickMs) > 0
    ? `window.__fixtureSendClicks = (window.__fixtureSendClicks || 0) + 1; if (window.__fixtureSendClicks === 1) { const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop generating'); document.body.append(stop); setTimeout(() => stop.remove(), ${Number(options.busyAfterFirstClickMs)}); }`
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
      ${busyAfterFirstClickScript}
      ${alertScript}
    }));
  `;
  // Models how ChatGPT and Claude really behave: the send control is rendered
  // from the composer framework's own state, and that state is seeded empty when
  // the framework attaches - it does not adopt text already sitting in the DOM.
  // `hydrateOnDemand` defers that attachment to window.__hydrate() so a test can
  // place it after insertion. `detachedComposer` additionally keeps the composer
  // out of any form/main, so the send control only turns up in a shared ancestor.
  if (options.hydrateOnDemand || options.detachedComposer) {
    const sendHtml = options.missingSend ? '' : `<button ${sendAttribute}>${sendLabel}</button>`;
    const body = options.detachedComposer
      ? `<main><div id="messages"></div></main><div id="composer-root"><div id="composer-input">${editorMarkup}${modal}</div><div id="composer-actions"></div></div>`
      : `<main>${editorMarkup}${modal}<div id="composer-actions"></div><div id="messages"></div></main>`;
    return `<!doctype html><html><body>${body}<script>
      const editor = document.querySelector('textarea,[contenteditable="true"]');
      const read = () => editor?.value === undefined ? editor?.innerText || '' : editor?.value || '';
      const row = document.querySelector('#composer-actions');
      let stateText = '';
      const sync = () => {
        const existing = row.querySelector('button');
        if (!stateText.trim()) { if (existing) existing.remove(); return; }
        if (existing) return;
        row.insertAdjacentHTML('beforeend', ${JSON.stringify(sendHtml)});
        const button = row.querySelector('button');
        if (button) button.addEventListener('click', () => {
          ${ackScript}
          ${clearScript}
          ${busyAfterFirstClickScript}
          stateText = read();
          sync();
          ${alertScript}
        });
      };
      const attach = () => {
        editor.addEventListener('input', () => { stateText = read(); sync(); });
        window.__fixtureHydrated = true;
        sync();
      };
      if (${Boolean(options.hydrateOnDemand)}) window.__hydrate = attach;
      else window.addEventListener('load', attach);
    </script></body></html>`;
  }
  if (options.composerDelayMs > 0) {
    const markup = `${editorMarkup}${modal}${sendMarkup}<div id="messages"></div>`;
    const remount = Number(options.composerRemountMs) || 0;
    return `<!doctype html><html><body><main></main><script>
      const mount = () => {
        document.querySelector('main').innerHTML = ${JSON.stringify(markup)};
        window.__fixtureMounts = (window.__fixtureMounts || 0) + 1;
        ${script}
      };
      window.addEventListener('load', () => {
        window.__fixtureLoadedAt = performance.now();
        setTimeout(() => {
          mount();
          if (${remount} > 0) setTimeout(mount, ${remount});
        }, ${Number(options.composerDelayMs)});
      });
    </script></body></html>`;
  }
  return `<!doctype html><html><body><main>${editorMarkup}${modal}${sendMarkup}<div id="messages"></div></main><script>${script}</script></body></html>`;
}

export async function openExtension(options = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-later-extension-'));
  fs.cpSync(path.join(root, 'dist'), copy, { recursive: true });
  buildSync({ entryPoints: [path.join(root, 'tests/browser/vault-fixture.js')], bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', outfile: path.join(copy, 'vault-fixture.js') });
  const manifestPath = path.join(copy, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-later-profile-'));
  return launchExtension(copy, profile, options);
}

async function launchExtension(copy, profile, options) {
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
        const fixture = options.fixture || {};
        if (fixture.responseDelayMs > 0 && (!fixture.responseDelayPath || fixture.responseDelayPath === url.pathname)) {
          await new Promise(resolve => setTimeout(resolve, Number(fixture.responseDelayMs)));
        }
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixtureFor(url.hostname, fixture) });
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
  await page.locator(options.allowLocked ? '#scheduler-view:visible, #vault-panel:visible' : '#scheduler-view').first().waitFor({ state: 'visible' });
  return { context, page, worker, id, copy, profile, options };
}

export async function restartExtension(environment) {
  await environment.context.close();
  const next = await launchExtension(environment.copy, environment.profile, { ...environment.options, allowLocked: true });
  Object.assign(environment, next);
  return environment;
}

export async function closeExtension(environment) {
  await environment.context.close();
  fs.rmSync(environment.copy, { recursive: true, force: true });
  fs.rmSync(environment.profile, { recursive: true, force: true });
}

export async function tickFromPage(page) {
  const revision = () => page.evaluate(async () => (await chrome.storage.local.get('prompt-later.vault.v1'))['prompt-later.vault.v1']?.iv);
  const before = await revision();
  await page.evaluate(() => chrome.alarms.create('prompt-later:due', { when: Date.now() }));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const stored = await readState(page);
    const changed = await revision() !== before;
    const busy = stored.jobs.some(job => job.status === 'running');
    const due = stored.jobs.some(job => job.enabled && job.status === 'scheduled' && job.nextRunAt <= Date.now());
    if (changed && !busy && !due) return stored;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Prompt Later alarm did not drain the due fixture.');
}

export async function readState(page) {
  return page.evaluate(async () => {
    const module = await import(chrome.runtime.getURL('vault-fixture.js'));
    return module.readState();
  });
}

export async function writeState(page, state) {
  return page.evaluate(async value => {
    const module = await import(chrome.runtime.getURL('vault-fixture.js'));
    return module.writeState(value);
  }, state);
}

export async function dueState(page, predicate = () => true) {
  const state = await readState(page);
  const job = state.jobs.find(predicate);
  if (!job) throw new Error('Fixture job not found.');
  const dueAt = Date.now() - 1000;
  job.nextRunAt = dueAt;
  if (job.schedule.type === 'once') job.schedule.at = dueAt;
  await writeState(page, state);
}
