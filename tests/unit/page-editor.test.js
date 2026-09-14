import test from 'node:test';
import assert from 'node:assert/strict';
import { editorJobFor, EDITOR_MESSAGE } from '../../src/page-editor.js';
import { validateState } from '../../src/store.js';

const url = 'https://grok.com/c/12345678-1234-1234-1234-123456789abc';
const message = 'Grok fixture';
const state = {
  version: 1,
  jobs: [{ id: 'job-grok', url, provider: 'grok', message, schedule: { type: 'once', at: 5000, timeZone: 'UTC' }, missedPolicy: 'run-once', createdAt: 1, updatedAt: 1, enabled: true, status: 'running', nextRunAt: 5000, runId: 'run-grok', lastOutcome: null, lastDetail: '' }],
  history: [{ id: 'run-grok', jobId: 'job-grok', url, provider: 'grok', preview: message, dueAt: 5000, startedAt: 4000, finishedAt: null, status: 'dispatching', detail: '' }],
};
const sender = { id: 'ext', frameId: 0, url, tab: { id: 22, url } };
const messageFor = (overrides = {}) => ({ type: EDITOR_MESSAGE, runId: 'run-grok', url, message, marker: 'marker-1', ...overrides });

test('editorJobFor authorizes only matching top-frame active Grok delivery', () => {
  assert.equal(editorJobFor(messageFor(), sender, state, 'ext'), state.jobs[0]);
  for (const [name, changes] of [
    ['wrong extension', { sender: { ...sender, id: 'other' } }],
    ['wrong frame', { sender: { ...sender, frameId: 1 } }],
    ['no tab', { sender: { ...sender, tab: undefined } }],
    ['app sender URL', { sender: { ...sender, url: 'chrome-extension://ext/app.html' } }],
    ['other conversation', { sender: { ...sender, url: 'https://grok.com/c/22345678-1234-1234-1234-123456789abc', tab: { id: 22, url } } }],
    ['other provider', { message: messageFor({ url: 'https://chatgpt.com/c/abc12345' }), state: { ...state, jobs: [{ ...state.jobs[0], url: 'https://chatgpt.com/c/abc12345', provider: 'chatgpt' }] } }],
    ['different prompt', { message: messageFor({ message: 'other' }) }],
    ['different run', { message: messageFor({ runId: 'other' }) }],
    ['bad marker', { message: messageFor({ marker: 'bad marker' }) }],
    ['checking run', { state: { ...state, history: [{ ...state.history[0], status: 'checking' }] } }],
    ['completed job', { state: { ...state, jobs: [{ ...state.jobs[0], status: 'completed', enabled: false, runId: null, nextRunAt: null }] } }],
    ['disabled job', { state: { ...state, jobs: [{ ...state.jobs[0], enabled: false }] } }],
    ['different job id', { state: { ...state, history: [{ ...state.history[0], jobId: 'other-job' }] } }],
    ['wrong tab URL', { sender: { ...sender, tab: { id: 22, url: 'https://grok.com/c/22345678-1234-1234-1234-123456789abc' } } }],
    ['empty marker', { message: messageFor({ marker: '' }) }],
    ['oversized marker', { message: messageFor({ marker: 'x'.repeat(65) }) }],
    ['wrong message type', { message: messageFor({ type: 'PL_UI' }) }],
  ]) {
    const result = editorJobFor(changes.message || messageFor(), changes.sender || sender, changes.state || state, 'ext');
    assert.equal(result, null, name);
  }
});

test('legacy GPT and Claude state validates without migration', () => {
  const legacy = {
    version: 1,
    jobs: [
      { id: 'gpt', url: 'https://chatgpt.com/c/abc12345', provider: 'chatgpt', message: 'gpt', schedule: { type: 'once', at: 5000, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 5000, runId: null, lastOutcome: null, lastDetail: '' },
      { id: 'claude', url: 'https://claude.ai/chat/abc12345', provider: 'claude', message: 'claude', schedule: { type: 'cron', expression: '0 7 * * *', timeZone: 'UTC', preset: 'daily' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 5000, runId: null, lastOutcome: null, lastDetail: '' },
    ],
    history: [{ id: 'old-run', jobId: 'deleted-job', url: 'https://chatgpt.com/c/old-conversation', provider: 'chatgpt', preview: 'Earlier prompt', dueAt: 2, startedAt: 3, finishedAt: 4, status: 'sent', detail: 'The site acknowledged submission.' }],
  };
  assert.deepEqual(validateState(legacy), legacy);
});
