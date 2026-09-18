import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, emptyState, validateState } from '../../src/store.js';
import { Scheduler } from '../../src/scheduler.js';

const target = 'https://chatgpt.com/c/id';
let sequence = 0;

function scheduler(store, now = () => 1000, deliver = async () => ({ outcome: 'sent' })) {
  return new Scheduler({ store, deliver, arm: () => {}, now, newId: () => `test-${++sequence}` });
}

function historical(status = 'sent') {
  return {
    id: `run-${status}`,
    jobId: 'deleted-job',
    url: target,
    provider: 'chatgpt',
    preview: 'Old message',
    dueAt: 1,
    startedAt: 1,
    finishedAt: 2,
    status,
    detail: '',
  };
}

test('invalid URL is rejected without persisted mutation', async () => {
  const store = createMemoryStore();
  const instance = scheduler(store);
  await instance.initialize();
  const before = store.data;
  await assert.rejects(() => instance.upsertJob({
    url: 'https://chatgpt.com/login',
    message: 'x',
    schedule: { type: 'once', at: 5000, timeZone: 'UTC' },
  }));
  assert.deepEqual(store.data, before);
});

test('message blanks and oversized values are rejected', async () => {
  const store = createMemoryStore();
  const instance = scheduler(store);
  await instance.initialize();
  for (const message of ['', ' '.repeat(3), 'x'.repeat(20001)]) {
    await assert.rejects(() => instance.upsertJob({
      url: target,
      message,
      schedule: { type: 'once', at: 5000, timeZone: 'UTC' },
    }));
  }
  assert.deepEqual(store.data, emptyState());
});

test('malformed stored jobs and invalid timestamp or interval data are rejected without reset', () => {
  const invalidJob = {
    version: 1,
    jobs: [{ id: 'x', url: target, provider: 'chatgpt', message: 'x', schedule: { type: 'once', at: 1e100, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 1e100, runId: null, lastOutcome: null, lastDetail: '' }],
    history: [],
  };
  assert.throws(() => validateState(invalidJob));
  const unsafeInterval = { ...invalidJob, jobs: [{ ...invalidJob.jobs[0], schedule: { type: 'interval', everyMs: Number.MAX_SAFE_INTEGER + 1, anchor: 0, timeZone: 'UTC' } }] };
  assert.throws(() => validateState(unsafeInterval));
});

test('nonexistent input IDs do not create jobs', async () => {
  const store = createMemoryStore();
  const instance = scheduler(store);
  await instance.initialize();
  await assert.rejects(() => instance.upsertJob({
    id: 'missing',
    url: target,
    message: 'x',
    schedule: { type: 'once', at: 5000, timeZone: 'UTC' },
  }));
  assert.deepEqual(store.data, emptyState());
});

test('deleting sent and blocked jobs retains history and the store remains usable', async () => {
  let now = 1000;
  const store = createMemoryStore();
  const first = scheduler(store, () => now, async (job, run, mark) => {
    await mark();
    return { outcome: 'sent', detail: 'ack' };
  });
  await first.initialize();
  await first.upsertJob({ url: target, message: 'Sent message', schedule: { type: 'once', at: 1001, timeZone: 'UTC' } });
  now = 2000;
  await first.tick();
  const sentRun = store.data.history[0];
  await first.deleteJob(store.data.jobs[0].id);
  let state = await first.getState();
  assert.equal(state.jobs.length, 0);
  assert.equal(state.history[0].id, sentRun.id);
  const second = scheduler(store, () => now, async (job, run, mark) => {
    await mark();
    return { outcome: 'sent', detail: 'second ack' };
  });
  await second.initialize();
  await second.upsertJob({ url: target, message: 'Second message', schedule: { type: 'once', at: 2001, timeZone: 'UTC' } });
  now = 3000;
  await second.tick();
  assert.equal((await second.getState()).history.at(-1).status, 'sent');
  await second.deleteJob(store.data.jobs[0].id);

  const failed = scheduler(store, () => now, async () => ({ outcome: 'blocked', detail: 'blocked fixture' }));
  await failed.initialize();
  await failed.upsertJob({ url: target, message: 'Failed message', schedule: { type: 'once', at: 3001, timeZone: 'UTC' } });
  now = 4000;
  await failed.tick();
  await failed.deleteJob(store.data.jobs.find(job => job.message === 'Failed message').id);
  state = await failed.getState();
  assert.equal(state.jobs.length, 0);
  assert.equal(state.history.at(-1).status, 'blocked');
});

test('completed recurring jobs and self-contained deleted history validate', () => {
  const completedRecurring = {
    version: 1,
    jobs: [{ id: 'done', url: target, provider: 'chatgpt', message: 'done', schedule: { type: 'interval', everyMs: 3600000, anchor: 0, timeZone: 'UTC' }, missedPolicy: 'skip', createdAt: 1, updatedAt: 2, enabled: false, status: 'completed', nextRunAt: null, runId: null, lastOutcome: 'sent', lastDetail: 'finished' }],
    history: [],
  };
  assert.doesNotThrow(() => validateState(completedRecurring));
  assert.doesNotThrow(() => validateState({ version: 1, jobs: [], history: [historical()] }));
});


test('legacy retry bookkeeping is accepted once and removed from validated state', () => {
  const job = {
    id: 'legacy-retry', url: target, provider: 'chatgpt', message: 'Legacy retry',
    schedule: { type: 'once', at: 5000, timeZone: 'UTC' }, missedPolicy: 'skip',
    createdAt: 1, updatedAt: 1, enabled: true, status: 'scheduled', nextRunAt: 5000,
    runId: null, lastOutcome: null, lastDetail: '', attempts: 2, retryUntil: 60000, failures: 4,
  };
  const state = validateState({ version: 1, jobs: [job], history: [] });
  assert.equal(Object.hasOwn(state.jobs[0], 'attempts'), false);
  assert.equal(Object.hasOwn(state.jobs[0], 'retryUntil'), false);
  assert.equal(Object.hasOwn(state.jobs[0], 'failures'), false);
});
