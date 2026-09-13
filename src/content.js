import { parseTarget, sameTarget } from './targets.js';

const SELECTORS = {
  chatgpt: {
    editors: ['#prompt-textarea', '[data-testid="composer-text-input"]'],
    sends: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
    ],
    users: ['[data-message-author-role="user"]'],
  },
  claude: {
    editors: [
      '[data-testid="chat-input"][contenteditable="true"]',
      '[data-testid="composer"] [contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
    ],
    sends: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
    ],
    users: ['[data-testid="user-message"]', '[data-testid="user-message-content"]'],
  },
  devin: {
    editors: [
      'textarea[placeholder*="Devin" i]',
      '[role="textbox"][contenteditable="true"]',
      'main textarea',
    ],
    sends: [
      'button[data-testid="send-message-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
    ],
    users: ['[data-message-role="user"]', '[data-role="user"]', '[data-testid="user-message"]'],
  },
};

const state = globalThis.__promptLaterState ||= {
  reservations: new Map(),
  commits: new Map(),
};
const providerForHost = host => {
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  if (host === 'claude.ai') return 'claude';
  if (host === 'app.devin.ai') return 'devin';
  return null;
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
    const nodes = [...document.querySelectorAll(selector)].filter(isEligibleEditor);
    if (nodes.length > 1) throw new Error('Composer controls are ambiguous.');
    if (nodes.length === 1) return nodes[0];
  }
  throw new Error('Composer was not found.');
}

function scopeFor(composer) {
  return composer.closest('form') || composer.closest('main') || composer.parentElement;
}

function accessibleLabel(button) {
  return (button.getAttribute('aria-label') || button.textContent || '').trim();
}

function sendButton(provider, composer) {
  const scope = scopeFor(composer);
  if (!scope) return null;
  for (const selector of SELECTORS[provider].sends) {
    const candidates = [...scope.querySelectorAll(selector)].filter(isVisible);
    if (candidates.length > 1) throw new Error('Send controls are ambiguous.');
    if (candidates.length === 1) return isEnabled(candidates[0]) ? candidates[0] : null;
  }
  const form = composer.closest('form');
  if (!form) return null;
  const fallback = [...form.querySelectorAll('button')]
    .filter(isVisible)
    .filter(button => /^(send|send message|send prompt|submit message)$/i.test(accessibleLabel(button)));
  if (fallback.length > 1) throw new Error('Send controls are ambiguous.');
  return fallback.length === 1 && isEnabled(fallback[0]) ? fallback[0] : null;
}

function alertState() {
  const phrases = /\b(rate limit|usage limit|limit reached|too many requests|failed to send|unable to send|something went wrong|try again)\b/i;
  const alert = [...document.querySelectorAll('[role="alert"]')]
    .filter(isVisible)
    .find(node => phrases.test(node.textContent || ''));
  return alert ? 'A visible page error or rate limit is present.' : '';
}

function attachments(composer) {
  const scope = scopeFor(composer);
  if (!scope) return false;
  return [...scope.querySelectorAll('input[type="file"]')].some(input => input.files?.length)
    || [...scope.querySelectorAll('button')]
      .filter(isVisible)
      .some(button => /remove (file|attachment)/i.test(accessibleLabel(button)));
}

function busy() {
  return [...document.querySelectorAll('button,[role="button"]')]
    .filter(isVisible)
    .some(element => {
      const testId = element.getAttribute('data-testid') || '';
      const label = element.getAttribute('aria-label') || element.textContent || '';
      return /stop|cancel-generation|stop-generation/i.test(testId)
        || /^(stop generating|stop response|stop streaming|cancel generation)$/i.test(label.trim());
    }) || [...document.querySelectorAll('[data-is-streaming="true"]')].some(isVisible);
}

function matchingUsers(provider, message) {
  const nodes = [...new Set(SELECTORS[provider].users.flatMap(selector => [...document.querySelectorAll(selector)]))]
    .filter(isVisible)
    .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
  return nodes.filter(node => normalized(textOf(node)) === normalized(message));
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
  const busyState = busy();
  const attachmentState = attachments(composer);
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
  if (attachments(composer)) throw new Error('Pending attachments must be removed before sending.');
  if (busy()) throw new Error('The provider is still generating a response.');
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

async function waitForButton(provider, composer) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const button = sendButton(provider, composer);
    if (button) return button;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
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
  if (busy() || attachments(composer) || alertState()) throw new Error('The page is no longer ready to send.');
  if (!insert(composer, message)) throw new Error('Message insertion was not acknowledged; the message remains in the composer.');
  const button = await waitForButton(provider, composer);
  if (!button) throw new Error('The explicit send control was not found; the message remains in the composer.');
  if (!targetMatches(url) || !composer.isConnected || editor(provider) !== composer
      || normalized(textOf(composer)) !== normalized(message) || busy() || attachments(composer) || alertState()) {
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
      if (message.type === 'PL_INSPECT') return inspection(currentProvider);
      if (message.type === 'PL_PREPARE') return preflight(currentProvider, message.message, message.runId, message.url);
      return commitOnce(currentProvider, message);
    })();
    work.then(respond, error => respond({ outcome: 'blocked', status: 'blocked', detail: error.message }));
    return true;
  });
}
