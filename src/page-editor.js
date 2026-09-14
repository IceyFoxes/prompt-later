import { PROVIDERS } from './providers.js';
import { parseTarget, sameTarget } from './targets.js';

export const EDITOR_MESSAGE = 'PL_INSERT_EDITOR';

export function editorJobFor(message, sender, state, extensionId) {
  if (message?.type !== EDITOR_MESSAGE || sender?.id !== extensionId || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id) || typeof sender.url !== 'string'
      || typeof message.marker !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.marker)) return null;
  const job = state?.jobs?.find(item => item.status === 'running' && item.enabled && item.runId === message.runId
    && item.url === message.url && item.message === message.message);
  if (!job || !state.history.some(run => run.id === job.runId && run.jobId === job.id && run.status === 'dispatching')) return null;
  try {
    const target = parseTarget(job.url);
    return PROVIDERS[target.provider].insertion === 'tiptap'
      && sameTarget(sender.url, job.url) && sameTarget(sender.tab.url, job.url) ? job : null;
  } catch {
    return null;
  }
}

export function insertTiptapText({ url, message, marker }) {
  try {
    if (typeof message !== 'string' || !message.trim() || message.length > 20000
        || typeof marker !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(marker)) return false;
    const target = new URL(url);
    const onTarget = () => {
      const current = new URL(location.href);
      return target.origin === 'https://grok.com' && current.origin === target.origin
        && current.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, '');
    };
    if (!onTarget()) return false;
    const matches = [...document.querySelectorAll('[data-prompt-later-editor]')]
      .filter(node => node.getAttribute('data-prompt-later-editor') === marker);
    if (matches.length !== 1) return false;
    const composer = matches[0];
    const normalize = text => String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const usable = () => {
      if (!composer.isConnected || !composer.matches('.ProseMirror[contenteditable="true"]')
          || composer.closest('dialog,[role="dialog"],[aria-modal="true"],[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"],[aria-readonly="true"]')
          || !composer.getClientRects().length) return false;
      for (let node = composer; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      }
      return true;
    };
    const editor = composer.editor;
    if (!editor || editor.view?.dom !== composer || editor.isEditable !== true
        || typeof editor.getText !== 'function' || typeof editor.commands?.focus !== 'function'
        || typeof editor.commands?.insertContent !== 'function') return false;
    const empty = () => !normalize(composer.innerText || composer.textContent) && !normalize(editor.getText());
    if (!usable() || !empty()) return false;
    editor.commands.focus();
    if (!onTarget() || !usable() || !empty()) return false;
    const content = message.split(/\r?\n/).map(text => ({
      type: 'paragraph', content: text ? [{ type: 'text', text }] : [],
    }));
    if (editor.commands.insertContent(content) === false) return false;
    return onTarget() && usable() && normalize(editor.getText()) === normalize(message)
      && normalize(composer.innerText || composer.textContent) === normalize(message);
  } catch {
    return false;
  }
}
