import { PROVIDERS, providerForHost } from './providers.js';
import { EDITOR_MESSAGE } from './page-editor.js';
import { parseTarget, sameTarget } from './targets.js';

const SELECTORS = Object.fromEntries(Object.entries(PROVIDERS).map(([id, config]) => [id, config.selectors]));
const state = globalThis.__promptLaterState ||= {
  reservations: new Map(),
  commits: new Map(),
};

function isVisible(element) {
  if (!element || !element.isConnected || element.hidden) return false;
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    current = current.parentElement;
  }
  return element.getClientRects().length > 0;
}

function isEnabled(element) {
  return Boolean(element && !element.disabled && !element.readOnly && element.getAttribute('aria-disabled') !== 'true');
}

function isEditable(element) {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return ['text', 'search'].includes(element.type);
  return element.getAttribute('contenteditable') === 'true';
}

function isEligibleEditor(element) {
  return isVisible(element) && isEnabled(element) && isEditable(element) && !element.closest('dialog,[role="dialog"],[aria-modal="true"],[hidden],[inert],[aria-hidden="true"]');
}

function textOf(element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  return element.innerText || element.textContent || '';
}

function normalized(value) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function editor(provider) {
  for (const selector of SELECTORS[provider].editors) {
    const nodes = [...document.querySelectorAll(selector)].filter(isEligibleEditor)
      .filter(node => !PROVIDERS[provider].enhanced || node.getAttribute('aria-readonly') !== 'true');
    if (nodes.length > 1) throw new Error('Composer controls are ambiguous.');
    if (nodes.length === 1) return nodes[0];
  }
  throw Object.assign(new Error('Composer was not found.'), { code: 'COMPOSER_NOT_FOUND' });
}

async function waitForComposer(provider, url) {
  const deadline = Date.now() + 15000;
  let candidate = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (!targetMatches(url)) throw new Error('The page is not the selected conversation.');
    let composer = null;
    try { composer = editor(provider); } catch (error) {
      if (error.code !== 'COMPOSER_NOT_FOUND') throw error;
    }
    if (composer && normalized(textOf(composer))) throw new Error('The composer already contains a draft; it was left untouched.');
    if (composer && attachments(provider, composer)) throw new Error('Pending attachments must be removed before sending.');
    if (busy(provider)) throw new Error('The provider is still generating a response.');
    const error = alertState();
    if (error) throw new Error(error);
    if (composer !== candidate) { candidate = composer; stableSince = Date.now(); }
    if (candidate && Date.now() - stableSince >= 500) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error('The composer did not become ready within 15 seconds. Open the saved conversation and reschedule.');
}

function scopeFor(composer, provider) {
  const fallback = composer.closest('form') || composer.closest('main') || composer.parentElement;
  const config = PROVIDERS[provider];
  if (!config.enhanced) return fallback;
  const preferred = config.composerScopes ? composer.closest(config.composerScopes) : null;
  if (preferred) return preferred;
  if (!composer.closest('form') && !composer.closest('main')) {
    for (let node = composer.parentElement, depth = 0; node && node !== document.body && node !== document.documentElement && depth < 6; node = node.parentElement, depth += 1) {
      if (config.selectors.sends.some(selector => node.querySelector(selector))) return node;
    }
  }
  return fallback === document.body || fallback === document.documentElement ? null : fallback;
}

function sendScopes(composer, provider) {
  const config = PROVIDERS[provider];
  const scopes = [];
  const primary = scopeFor(composer, provider);
  if (primary) scopes.push(primary);
  // A hydrating page often mounts the send control in a subtree that is not the
  // composer's own form/main, so widen to the nearest ancestor that actually
  // holds a send candidate before giving up.
  for (let node = composer.parentElement, depth = 0;
    node && node !== document.body && node !== document.documentElement && depth < 8;
    node = node.parentElement, depth += 1) {
    if (scopes.includes(node)) continue;
    if (config.selectors.sends.some(selector => node.querySelector(selector))) {
      scopes.push(node);
      break;
    }
  }
  return scopes;
}

function accessibleLabel(button) {
  return (button.getAttribute('aria-label') || button.textContent || '').trim();
}

function sendEnabled(provider, element) {
  if (!isEnabled(element)) return false;
  if (!PROVIDERS[provider].enhanced) return true;
  const disabled = '[disabled],[aria-disabled="true"],[data-disabled="true"],.disabled,.stop-button';
  return !element.closest(disabled)
    && !element.querySelector(disabled)
    && !/^(stop|stop generating|stop response|stop responding|cancel|attach|upload|voice)$/i.test(accessibleLabel(element));
}

function sendButton(provider, composer, info) {
  const scopes = sendScopes(composer, provider);
  for (const [index, scope] of scopes.entries()) {
    for (const selector of SELECTORS[provider].sends) {
      const candidates = [...scope.querySelectorAll(selector)].filter(isVisible);
      if (candidates.length > 1) throw new Error('Send controls are ambiguous.');
      // A single disabled match must not end the search: later selectors or a
      // wider scope may hold the control the page actually wired up.
      if (candidates.length === 1) {
        if (sendEnabled(provider, candidates[0])) return candidates[0];
        if (info) info.disabled = true;
      }
    }
    if (index > 0) continue;
    const fallback = [...scope.querySelectorAll('button')]
      .filter(isVisible)
      .filter(button => /^(send|send message|send prompt|submit message)$/i.test(accessibleLabel(button)));
    if (fallback.length > 1) throw new Error('Send controls are ambiguous.');
    if (fallback.length === 1) {
      if (sendEnabled(provider, fallback[0])) return fallback[0];
      if (info) info.disabled = true;
    }
  }
  return null;
}

function alertState() {
  const phrases = /\b(rate limit|usage limit|limit reached|too many requests|failed to send|unable to send|something went wrong|try again)\b/i;
  const alert = [...document.querySelectorAll('[role="alert"]')]
    .filter(isVisible)
    .find(node => phrases.test(node.textContent || ''));
  return alert ? 'A visible page error or rate limit is present.' : '';
}

function attachments(provider, composer) {
  const scope = scopeFor(composer, provider);
  if (!scope) return false;
  return [...scope.querySelectorAll('input[type="file"]')].some(input => input.files?.length)
    || [...scope.querySelectorAll('button')]
      .filter(isVisible)
      .some(button => /remove (file|attachment)/i.test(accessibleLabel(button)));
}

function busy(provider) {
  const config = PROVIDERS[provider];
  const enhanced = config?.busySelectors?.some(selector => [...document.querySelectorAll(selector)].some(isVisible));
  return Boolean(enhanced) || [...document.querySelectorAll('button,[role="button"]')]
    .filter(isVisible)
    .some(element => {
      const testId = element.getAttribute('data-testid') || '';
      const label = element.getAttribute('aria-label') || element.textContent || '';
      return /stop|cancel-generation|stop-generation/i.test(testId)
        || /^(stop generating|stop response|stop streaming|cancel generation)$/i.test(label.trim());
    }) || [...document.querySelectorAll('[data-is-streaming="true"]')].some(isVisible);
}

function matchingUsers(provider, message) {
  const config = PROVIDERS[provider];
  const nodes = [...new Set(SELECTORS[provider].users.flatMap(selector => [...document.querySelectorAll(selector)]))]
    .filter(isVisible)
    .filter(node => !config.enhanced || !node.closest('form,[contenteditable],textarea,input,nav,aside,dialog,[role="dialog"]'))
    .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
  return nodes.filter(node => {
    const textNode = config.userTextSelector ? node.querySelector(config.userTextSelector) || node : node;
    return normalized(textOf(textNode)) === normalized(message);
  });
}

function targetMatches(url) {
  try {
    const target = parseTarget(url);
    return sameTarget(location.href, target.url);
  } catch {
    return false;
  }
}

function inspection(provider) {
  const composer = editor(provider);
  const draft = normalized(textOf(composer));
  const busyState = busy(provider);
  const attachmentState = attachments(provider, composer);
  const error = alertState();
  if (draft || busyState || attachmentState || error) {
    return {
      status: 'blocked',
      composer: true,
      draft: Boolean(draft),
      busy: busyState,
      attachments: attachmentState,
      error,
      send: Boolean(sendButton(provider, composer)),
      detail: draft ? 'Composer already contains a draft.' : error || 'The page is not ready.',
    };
  }
  return {
    status: 'ready',
    composer: true,
    draft: false,
    busy: false,
    attachments: false,
    error: '',
    send: Boolean(sendButton(provider, composer)),
    detail: 'Composer is ready.',
  };
}

function preflight(provider, message, runId, url) {
  if (state.commits.has(runId)) return { ready: false, detail: 'This run is already being handled.' };
  const previous = state.reservations.get(runId);
  if (previous) {
    if (previous.provider !== provider || previous.message !== message || !sameTarget(previous.url, url)) {
      throw new Error('This run reservation no longer matches.');
    }
    return { ready: true, detail: 'Composer is ready.' };
  }
  const composer = editor(provider);
  if (normalized(textOf(composer))) throw new Error('The composer already contains a draft; it was left untouched.');
  if (attachments(provider, composer)) throw new Error('Pending attachments must be removed before sending.');
  if (busy(provider)) throw new Error('The provider is still generating a response.');
  const error = alertState();
  if (error) throw new Error(error);
  const target = parseTarget(url);
  if (!sameTarget(location.href, target.url)) throw new Error('The page is not the selected conversation.');
  state.reservations.set(runId, {
    runId,
    composer,
    provider,
    url: target.url,
    message,
    baseline: matchingUsers(provider, message).length,
    expires: Date.now() + 30000,
  });
  return { ready: true, detail: 'Composer is ready.' };
}

async function insertPageEditor(composer, message, runId, url) {
  const marker = crypto.randomUUID();
  composer.setAttribute('data-prompt-later-editor', marker);
  try {
    const result = await chrome.runtime.sendMessage({ type: EDITOR_MESSAGE, runId, url, message, marker });
    if (!result?.ok) throw new Error(result?.error || 'The page editor did not acknowledge insertion.');
    return result.data === true && normalized(textOf(composer)) === normalized(message);
  } finally {
    if (composer.getAttribute('data-prompt-later-editor') === marker) composer.removeAttribute('data-prompt-later-editor');
  }
}

function insert(composer, message) {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(composer.constructor.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(composer, message);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const selection = getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(true);
    selection.addRange(range);
    document.execCommand('insertText', false, message);
    if (!normalized(textOf(composer))) {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', message);
      composer.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }));
    }
  }
  return normalized(textOf(composer)) === normalized(message);
}

// A tab that was just reopened finishes loading before its composer framework
// finishes attaching. Text written in that window lands in the DOM but never
// reaches the framework's own state, so the send control - which these sites
// render or enable from that state - never appears. Replay the edit so a
// late-attached framework observes it, without ever changing the final text.
function renotify(composer, message) {
  try {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(composer.constructor.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, message);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection.addRange(range);
      const before = textOf(composer);
      document.execCommand('insertText', false, ' ');
      if (textOf(composer) !== before) document.execCommand('delete');
    }
  } catch { /* fall through to the text check below */ }
  return normalized(textOf(composer)) === normalized(message);
}

async function waitForButton(provider, composer, message) {
  const started = Date.now();
  const info = { disabled: false };
  let ambiguous = null;
  let nudges = 0;
  // Bounded so that this wait plus the acknowledgement poll stays inside the
  // page-call timeout: overrunning it would turn a clean 'blocked' into
  // 'uncertain'.
  while (Date.now() - started < 6000) {
    info.disabled = false;
    try {
      const button = sendButton(provider, composer, info);
      if (button) return { button, disabled: false };
      ambiguous = null;
    } catch (error) {
      // Duplicate controls are common while a page hydrates; only report the
      // ambiguity if it is still there when the budget runs out.
      ambiguous = error;
    }
    if (Date.now() - started >= (nudges + 1) * 1000 && nudges < 5) {
      nudges += 1;
      if (!renotify(composer, message)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (ambiguous) throw ambiguous;
  return { button: null, disabled: info.disabled };
}

async function commit(provider, url, runId, message, record) {
  const reservation = state.reservations.get(runId);
  if (!reservation || reservation.expires < Date.now() || reservation.runId !== runId
      || reservation.provider !== provider || reservation.message !== message || !sameTarget(reservation.url, url)) {
    throw new Error('The preparation expired or no longer matches this run.');
  }
  if (!targetMatches(url)) throw new Error('The conversation changed before sending.');
  const composer = editor(provider);
  if (composer !== reservation.composer || !composer.isConnected) throw new Error('The composer changed before sending.');
  if (normalized(textOf(composer))) throw new Error('The composer changed before sending; the message remains in the composer.');
  if (busy(provider) || attachments(provider, composer) || alertState()) throw new Error('The page is no longer ready to send.');
  const inserted = PROVIDERS[provider].insertion === 'tiptap' && !(composer instanceof HTMLTextAreaElement) && !(composer instanceof HTMLInputElement)
    ? await insertPageEditor(composer, message, runId, url)
    : insert(composer, message);
  if (!inserted) throw new Error('Message insertion was not acknowledged; the message remains in the composer.');
  const { button, disabled } = await waitForButton(provider, composer, message);
  if (!button) {
    throw new Error(disabled
      ? 'The send control stayed disabled; the message remains in the composer.'
      : 'The explicit send control was not found; the message remains in the composer.');
  }
  if (!targetMatches(url) || !composer.isConnected || editor(provider) !== composer
      || normalized(textOf(composer)) !== normalized(message) || busy(provider) || attachments(provider, composer) || alertState()
      || !sendEnabled(provider, button)
      || (PROVIDERS[provider].enhanced && sendButton(provider, composer) !== button)) {
    throw new Error('The page changed before sending; the message remains in the composer.');
  }
  record.clicked = true;
  button.click();
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (!targetMatches(url)) return { outcome: 'uncertain', detail: 'The conversation changed after clicking send.' };
    if (alertState()) return { outcome: 'uncertain', detail: 'The site reported an error after clicking send.' };
    if (matchingUsers(provider, message).length > reservation.baseline
        && composer.isConnected && !normalized(textOf(composer))) {
      return { outcome: 'sent', detail: 'The site acknowledged submission.' };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { outcome: 'uncertain', detail: 'The site did not acknowledge submission.' };
}

function commitOnce(provider, message) {
  const existing = state.commits.get(message.runId);
  if (existing) return existing.promise;
  const record = { clicked: false, promise: null };
  state.commits.set(message.runId, record);
  record.promise = (async () => {
    try {
      return await commit(provider, message.url, message.runId, message.message, record);
    } catch (error) {
      return { outcome: record.clicked ? 'uncertain' : 'blocked', detail: error.message };
    } finally {
      state.reservations.delete(message.runId);
    }
  })();
  return record.promise;
}

function provider() {
  return providerForHost(location.hostname);
}

if (!globalThis.__promptLaterListeners) {
  globalThis.__promptLaterListeners = true;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id || !['PL_INSPECT', 'PL_PREPARE', 'PL_COMMIT'].includes(message?.type)) return false;
    const currentProvider = provider();
    const work = (async () => {
      if (!currentProvider || !targetMatches(message.url)) return { status: 'blocked', detail: 'The page is not the selected conversation.' };
      if (message.waitForComposer === true && message.type !== 'PL_COMMIT') {
        await waitForComposer(currentProvider, message.url);
        if (!targetMatches(message.url)) return { status: 'blocked', detail: 'The page is not the selected conversation.' };
      }
      if (message.type === 'PL_INSPECT') return inspection(currentProvider);
      if (message.type === 'PL_PREPARE') return preflight(currentProvider, message.message, message.runId, message.url);
      return commitOnce(currentProvider, message);
    })();
    work.then(respond, error => respond({ outcome: 'blocked', status: 'blocked', detail: error.message }));
    return true;
  });
}
