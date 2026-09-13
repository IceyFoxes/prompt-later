import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/scheduler.js';
import { createMemoryStore, emptyState } from '../../src/store.js';

const target = 'https://chatgpt.com/c/fixture';
let sequence = 0;
const id = () => `id-${++sequence}`;

function once(at, extra = {}) {
  return {
    id: 'job-1',
    url: target,
    provider: 'chatgpt',
    message: 'Hello',
    schedule: { type: 'once', at, timeZone: 'UTC' },
    missedPolicy: 'run-once',
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
    status: 'scheduled',
    nextRunAt: at,
    runId: null,
    lastOutcome: null,
    lastDetail: '',
    ...extra,
  };
}

function make(initial = { ...emptyState(), jobs: [once(900)] }, deliver = async () => ({ outcome: 'sent', detail: 'ack' }), now = () => 1000) {
  const store = createMemoryStore(initial);
  const arms = [];
  const scheduler = new Scheduler({
    store,
    deliver,
    arm: value => arms.push(value),
    now,
    newId: id,
  });
  return { scheduler, store, arms };
}

test('persists checking then dispatching before delivery and retains completed one-off', async () => {
  const phases = [];
  const environment = make(undefined, async (job, run, mark) => {
    phases.push(environment.store.data.history.at(-1).status);
    await mark();
    phases.push(environment.store.data.history.at(-1).status);
    return { outcome: 'sent', detail: 'ack' };
  });
  await environment.scheduler.initialize();
  await environment.scheduler.tick();
  assert.deepEqual(phases, ['checking', 'dispatching']);
  assert.equal(environment.store.data.jobs[0].status, 'completed');
  assert.equal(environment.store.data.history[0].status, 'sent');
});

test('recurring jobs advance after the finished timestamp', async () => {
  const job = once(900, {
    schedule: { type: 'interval', everyMs: 60000, anchor: 0, timeZone: 'UTC' },
  });
  const environment = make({ ...emptyState(), jobs: [job] }, async (savedJob, run, mark) => { await mark(); return { outcome: 'sent', detail: '' }; }, () => 1500);
  await environment.scheduler.initialize();
  await environment.scheduler.tick();
  assert.equal(environment.store.data.jobs[0].nextRunAt, 60000);
  assert.equal(environment.store.data.jobs[0].status, 'scheduled');
});

test('concurrent ticks deliver one run', async () => {
  let calls = 0;
  const environment = make(undefined, async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { outcome: 'sent', detail: '' };
  });
  await environment.scheduler.initialize();
  await Promise.all([environment.scheduler.tick(), environment.scheduler.tick()]);
  assert.equal(calls, 1);
});

test('failure before dispatch retains job for attention', async () => {
  const environment = make(undefined, async () => ({ outcome: 'blocked', detail: 'draft exists' }));
  await environment.scheduler.initialize();
  await environment.scheduler.tick();
  assert.equal(environment.store.data.jobs[0].status, 'needs-attention');
  assert.equal(environment.store.data.history[0].status, 'blocked');
});

test('failure after dispatch is uncertain and is not retried', async () => {
  let calls = 0;
  const environment = make(undefined, async (job, run, mark) => {
    calls += 1;
    await mark();
    throw new Error('lost');
  });
  await environment.scheduler.initialize();
  await environment.scheduler.tick();
  await environment.scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(environment.store.data.jobs[0].lastOutcome, 'uncertain');
});

test('restart makes interrupted state uncertain and does not deliver', async () => {
  const interrupted = once(900, { status: 'running', runId: 'run-old' });
  const activeRun = {
    id: 'run-old',
    jobId: 'job-1',
    url: target,
    provider: 'chatgpt',
    preview: 'Hello',
    dueAt: 1,
    startedAt: 1,
    finishedAt: null,
    status: 'dispatching',
    detail: '',
  };
  let calls = 0;
  const environment = make({ ...emptyState(), jobs: [interrupted], history: [activeRun] }, async () => {
    calls += 1;
    return { outcome: 'sent' };
  });
  await environment.scheduler.initialize();
  assert.equal(environment.store.data.jobs[0].status, 'needs-attention');
  assert.equal(environment.store.data.history[0].status, 'uncertain');
  await environment.scheduler.tick();
  assert.equal(calls, 0);
});

test('missed skip does not send and run-once sends one overdue recurrence', async () => {
  let calls = 0;
  const skipped = make({ ...emptyState(), jobs: [once(900, { missedPolicy: 'skip' })] }, async () => {
    calls += 1;
    return { outcome: 'sent' };
  }, () => 1000 + 6 * 60000);
  await skipped.scheduler.initialize();
  await skipped.scheduler.tick();
  assert.equal(calls, 0);
  assert.equal(skipped.store.data.history[0].status, 'skipped');

  const recurringJob = once(0, {
    missedPolicy: 'run-once',
    schedule: { type: 'interval', everyMs: 60000, anchor: 0, timeZone: 'UTC' },
  });
  const sent = make({ ...emptyState(), jobs: [recurringJob] }, async (job, run, mark) => {
    calls += 1;
    await mark();
    return { outcome: 'sent' };
  }, () => 1000 + 6 * 60000);
  await sent.scheduler.initialize();
  await sent.scheduler.tick();
  assert.equal(calls, 1);
  assert.ok(sent.store.data.jobs[0].nextRunAt > 1000 + 6 * 60000);
});

test('paused never delivers, recurrence resumes in the future, and expired once cannot resume', async () => {
  let calls = 0;
  const future = once(5000, { enabled: false, status: 'paused', nextRunAt: null });
  const environment = make({ ...emptyState(), jobs: [future] }, async () => {
    calls += 1;
    return { outcome: 'sent' };
  }, () => 1000);
  await environment.scheduler.initialize();
  await environment.scheduler.tick();
  assert.equal(calls, 0);
  await environment.scheduler.setEnabled('job-1', true);
  assert.equal(environment.store.data.jobs[0].nextRunAt, 5000);

  const expired = once(500, { enabled: false, status: 'paused', nextRunAt: null });
  const expiredEnvironment = make({ ...emptyState(), jobs: [expired] }, async () => ({ outcome: 'sent' }), () => 1000);
  await expiredEnvironment.scheduler.initialize();
  await assert.rejects(() => expiredEnvironment.scheduler.setEnabled('job-1', true));
});

test('running edit, delete, and toggle are rejected', async () => {
  const job = once(900, { status: 'running', runId: 'active' });
  const run = {
    id: 'active',
    jobId: 'job-1',
    url: target,
    provider: 'chatgpt',
    message: 'Hello',
    preview: 'Hello',
    dueAt: 1,
    startedAt: 1,
    finishedAt: null,
    status: 'checking',
    detail: '',
  };
  const environment = make({ ...emptyState(), jobs: [job], history: [run] });
  await assert.rejects(() => environment.scheduler.upsertJob({ id: 'job-1', url: target, message: 'edit', schedule: { type: 'once', at: 5000, timeZone: 'UTC' } }));
  await assert.rejects(() => environment.scheduler.deleteJob('job-1'));
  await assert.rejects(() => environment.scheduler.setEnabled('job-1', false));
});

test('failed upsert persistence leaves no ghost job and subsequent tick does not deliver', async () => {
  const base = createMemoryStore();
  let rejectWrite = false;
  const store = {
    read: () => base.read(),
    write: state => rejectWrite ? Promise.reject(new Error('storage unavailable')) : base.write(state),
  };
  let calls = 0;
  const scheduler = new Scheduler({ store, deliver: async () => { calls += 1; return { outcome: 'sent' }; }, arm: () => {}, now: () => 1000, newId: () => 'job' });
  await scheduler.initialize();
  rejectWrite = true;
  await assert.rejects(() => scheduler.upsertJob({ url: target, message: 'ghost', schedule: { type: 'once', at: 5000, timeZone: 'UTC' } }));
  rejectWrite = false;
  assert.deepEqual(await base.read(), emptyState());
  await scheduler.tick();
  assert.equal(calls, 0);
});

test('mark persistence failure blocks before delivery and failed final persistence stays recoverable', async () => {
  const base = createMemoryStore({ ...emptyState(), jobs: [once(900)] });
  let writes = 0;
  const store = {
    read: () => base.read(),
    write: state => {
      writes += 1;
      if (writes === 3) return Promise.reject(new Error('mark unavailable'));
      if (writes === 4) return Promise.reject(new Error('finish unavailable'));
      return base.write(state);
    },
  };
  let calls = 0;
  const scheduler = new Scheduler({
    store,
    deliver: async (job, run, mark) => {
      calls += 1;
      await mark();
      return { outcome: 'sent' };
    },
    arm: () => {},
    now: () => 1000,
    newId: () => 'run',
  });
  await scheduler.initialize();
  await assert.rejects(() => scheduler.tick());
  assert.equal(calls, 1);
  assert.equal(base.data.jobs[0].status, 'running');
  assert.equal(base.data.history[0].status, 'checking');
});

test('history pruning retains active runs and only the latest 200 final runs', async () => {
  const history = Array.from({ length: 205 }, (_, index) => ({
    id: `final-${index}`,
    jobId: 'job-1',
    url: target,
    provider: 'chatgpt',
    preview: 'x',
    dueAt: 1,
    startedAt: 1,
    finishedAt: 2,
    status: 'sent',
    detail: '',
  }));
  history.push({ id: 'active', jobId: 'job-1', url: target, provider: 'chatgpt', preview: 'x', dueAt: 1, startedAt: 1, finishedAt: null, status: 'checking', detail: '' });
  const environment = make({ ...emptyState(), jobs: [once(5000)], history }, async () => ({ outcome: 'sent' }), () => 1000);
  await environment.scheduler.initialize();
  const result = environment.store.data;
  assert.equal(result.history.filter(run => run.status === 'uncertain' || run.status === 'checking' || run.status === 'dispatching').length, 1);
  assert.equal(result.history.filter(run => ['sent', 'skipped', 'blocked', 'uncertain'].includes(run.status)).length, 200);
});

test('unknown state version remains unchanged', async () => {
  const bad = { version: 999, jobs: [], history: [] };
  const store = createMemoryStore(bad);
  const scheduler = new Scheduler({ store, deliver: async () => ({ outcome: 'sent' }), arm: () => {}, newId: id });
  await assert.rejects(() => scheduler.initialize());
  assert.deepEqual(store.data, bad);
});
