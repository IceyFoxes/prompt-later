import { nextOccurrence, validateSchedule } from './schedules.js';
import { pruneHistory, validateState } from './store.js';
import { parseTarget } from './targets.js';
import { isTemporary, RETRY_DELAYS, RETRY_WINDOW } from './outcomes.js';

const LATE_LIMIT = 5 * 60 * 1000;
const ACTIVE_RUNS = new Set(['checking', 'dispatching']);
const copy = value => structuredClone(value);
const isRecurring = job => job.schedule.type !== 'once';

export class Scheduler {
  constructor({ store, deliver, arm, now = Date.now, newId = () => crypto.randomUUID() }) {
    this.store = store;
    this.deliver = deliver;
    this.arm = arm;
    this.now = now;
    this.newId = newId;
    this.state = null;
    this.initialized = false;
    this.lock = Promise.resolve();
    this.inFlight = null;
  }

  _mutate(mutator) {
    const operation = this.lock.then(async () => {
      const draft = validateState(await this.store.read());
      const result = await mutator(draft);
      pruneHistory(draft);
      await this.store.write(draft);
      this.state = copy(draft);
      await this._armLocked();
      return result === undefined ? undefined : copy(result);
    });
    this.lock = operation.catch(() => {});
    return operation;
  }

  async _armLocked() {
    const times = (this.state?.jobs || [])
      .filter(job => job.enabled && job.status === 'scheduled' && Number.isFinite(job.nextRunAt))
      .map(job => job.nextRunAt);
    const next = times.length ? Math.max(this.now() + 1000, Math.min(...times)) : null;
    await this.arm(next);
  }

  async initialize() {
    if (this.initialized) return;
    await this._mutate(async draft => {
      const now = this.now();
      const knownRunIds = new Set(draft.history.map(run => run.id));
      const jobsByRun = new Map(draft.jobs.filter(job => job.runId && knownRunIds.has(job.runId)).map(job => [job.runId, job]));
      for (const job of draft.jobs) {
        if (!['running', 'checking', 'dispatching'].includes(job.status)) continue;
        job.status = 'needs-attention';
        job.enabled = false;
        job.nextRunAt = null;
        job.lastOutcome = 'uncertain';
        job.lastDetail = 'A previous run was interrupted before completion.';
        job.updatedAt = now;
        const run = draft.history.find(item => item.id === job.runId);
        if (run && ACTIVE_RUNS.has(run.status)) {
          run.status = 'uncertain';
          run.finishedAt = now;
          run.detail = job.lastDetail;
        }
        job.runId = null;
      }
      for (const run of draft.history) {
        if (ACTIVE_RUNS.has(run.status) && !jobsByRun.has(run.id)) {
          run.status = 'uncertain';
          run.finishedAt = now;
          run.detail = 'An interrupted run had no matching saved job.';
        }
      }
    });
    this.initialized = true;
  }

  async getState() {
    await this.lock;
    return copy(await this.store.read());
  }

  async upsertJob(input) {
    return this._mutate(async draft => {
      const now = this.now();
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) {
        throw new Error('Message must contain 1–20,000 characters.');
      }
      const target = parseTarget(input.url);
      const schedule = validateSchedule(input.schedule, now);
      const existing = input.id ? draft.jobs.find(job => job.id === input.id) : null;
      if (input.id && !existing) throw new Error('Job not found.');
      if (existing?.status === 'running') throw new Error('Running jobs cannot be edited.');
      if (!existing && draft.jobs.length >= 100) throw new Error('You can save up to 100 jobs.');
      const enabled = input.enabled !== false;
      const nextRunAt = enabled ? nextOccurrence(schedule, now) : null;
      if (enabled && !Number.isFinite(nextRunAt)) throw new Error('The schedule has no future occurrence.');
      const job = {
        id: existing?.id || this.newId(),
        url: target.url,
        provider: target.provider,
        message: input.message,
        schedule,
        missedPolicy: input.missedPolicy === 'run-once' ? 'run-once' : 'skip',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        enabled,
        status: enabled ? 'scheduled' : 'paused',
        nextRunAt,
        runId: null,
        lastOutcome: null,
        lastDetail: '',
        attempts: 0,
        retryUntil: null,
      };
      if (existing) draft.jobs[draft.jobs.indexOf(existing)] = job;
      else draft.jobs.push(job);
      return job;
    });
  }

  async setEnabled(id, enabled) {
    return this._mutate(async draft => {
      if (typeof enabled !== 'boolean') throw new Error('Enabled must be boolean.');
      const job = draft.jobs.find(item => item.id === id);
      if (!job) throw new Error('Job not found.');
      if (job.status === 'running') throw new Error('Running jobs cannot be paused.');
      job.attempts = 0;
      job.retryUntil = null;
      if (enabled) {
        const next = nextOccurrence(job.schedule, this.now());
        if (!next) throw new Error('Reschedule this one-off job for a future time.');
        job.enabled = true;
        job.status = 'scheduled';
        job.nextRunAt = next;
      } else {
        job.enabled = false;
        job.status = 'paused';
        job.nextRunAt = null;
      }
      job.updatedAt = this.now();
      return job;
    });
  }

  async deleteJob(id) {
    return this._mutate(async draft => {
      const index = draft.jobs.findIndex(item => item.id === id);
      if (index < 0) throw new Error('Job not found.');
      if (draft.jobs[index].status === 'running') throw new Error('Running jobs cannot be deleted.');
      draft.jobs.splice(index, 1);
    });
  }

  async _selectDue() {
    return this._mutate(async draft => {
      const now = this.now();
      const job = draft.jobs
        .filter(item => item.enabled && item.status === 'scheduled' && Number.isFinite(item.nextRunAt) && item.nextRunAt <= now)
        .sort((left, right) => left.nextRunAt - right.nextRunAt)[0];
      if (!job) return null;
      const run = {
        id: this.newId(),
        jobId: job.id,
        url: job.url,
        provider: job.provider,
        preview: job.message.slice(0, 160),
        dueAt: job.nextRunAt,
        startedAt: now,
        finishedAt: null,
        status: 'checking',
        detail: '',
      };
      job.status = 'running';
      job.runId = run.id;
      job.updatedAt = now;
      draft.history.push(run);
      return { job, run };
    });
  }

  async _markDispatching(jobId, runId) {
    return this._mutate(async draft => {
      const job = draft.jobs.find(item => item.id === jobId);
      const run = draft.history.find(item => item.id === runId);
      if (!job || !run || job.runId !== runId || run.status !== 'checking') throw new Error('Run is no longer active.');
      run.status = 'dispatching';
      return true;
    });
  }

  async _finish(jobSnapshot, runSnapshot, result) {
    return this._mutate(async draft => {
      const job = draft.jobs.find(item => item.id === jobSnapshot.id);
      const run = draft.history.find(item => item.id === runSnapshot.id);
      if (!job || !run || job.runId !== runSnapshot.id) return;
      const finishedAt = this.now();
      let outcome = result?.outcome;
      if (outcome === 'sent' && run.status !== 'dispatching') {
        outcome = 'uncertain';
        result = { outcome, detail: 'The send was not durably marked before acknowledgement.' };
      }
      run.status = outcome === 'sent' ? 'sent' : outcome === 'blocked' ? 'blocked' : 'uncertain';
      run.finishedAt = finishedAt;
      run.detail = result?.detail || '';
      job.lastOutcome = run.status;
      job.lastDetail = run.detail;
      job.runId = null;
      job.updatedAt = finishedAt;
      if (outcome === 'sent') {
        job.attempts = 0;
        job.retryUntil = null;
        if (isRecurring(job)) {
          const next = nextOccurrence(job.schedule, Math.max(finishedAt, run.dueAt));
          if (Number.isFinite(next)) {
            job.nextRunAt = next;
            job.status = 'scheduled';
            job.enabled = true;
          } else {
            job.nextRunAt = null;
            job.status = 'completed';
            job.enabled = false;
          }
        } else {
          job.nextRunAt = null;
          job.status = 'completed';
          job.enabled = false;
        }
      } else {
        const retryAt = this._retryAt(job, run, outcome, result, finishedAt);
        if (retryAt === null) {
          job.attempts = 0;
          job.retryUntil = null;
          job.nextRunAt = null;
          job.status = 'needs-attention';
          job.enabled = false;
        } else {
          job.retryUntil = job.retryUntil ?? run.dueAt + RETRY_WINDOW;
          job.attempts = (job.attempts ?? 0) + 1;
          job.nextRunAt = retryAt;
          job.status = 'scheduled';
          job.enabled = true;
        }
      }
    });
  }

  // When the next attempt should happen, or null to stop and ask for attention.
  _retryAt(job, run, outcome, result, now) {
    if (!isTemporary(outcome, result?.reason)) return null;
    const attempts = job.attempts ?? 0;
    if (attempts >= RETRY_DELAYS.length) return null;
    const deadline = job.retryUntil ?? run.dueAt + RETRY_WINDOW;
    const at = now + RETRY_DELAYS[attempts];
    return at <= deadline ? at : null;
  }

  async _skip(jobSnapshot, runSnapshot) {
    return this._mutate(async draft => {
      const job = draft.jobs.find(item => item.id === jobSnapshot.id);
      const run = draft.history.find(item => item.id === runSnapshot.id);
      if (!job || !run || job.runId !== runSnapshot.id) return;
      const now = this.now();
      job.attempts = 0;
      job.retryUntil = null;
      run.status = 'skipped';
      run.finishedAt = now;
      run.detail = 'Skipped because it was more than 5 minutes late.';
      job.lastOutcome = 'skipped';
      job.lastDetail = run.detail;
      job.runId = null;
      job.updatedAt = now;
      if (isRecurring(job)) {
        const next = nextOccurrence(job.schedule, now);
        if (Number.isFinite(next)) {
          job.nextRunAt = next;
          job.status = 'scheduled';
          job.enabled = true;
        } else {
          job.nextRunAt = null;
          job.status = 'completed';
          job.enabled = false;
        }
      } else {
        job.nextRunAt = null;
        job.status = 'completed';
        job.enabled = false;
      }
    });
  }

  async _drain() {
    while (true) {
      const selected = await this._selectDue();
      if (!selected) return;
      const late = this.now() - selected.run.dueAt;
      if (selected.job.missedPolicy === 'skip' && late > LATE_LIMIT) {
        await this._skip(selected.job, selected.run);
        continue;
      }
      let marked = false;
      let result;
      try {
        result = await this.deliver(selected.job, selected.run, async () => {
          await this._markDispatching(selected.job.id, selected.run.id);
          marked = true;
        });
      } catch (error) {
        result = {
          outcome: marked ? 'uncertain' : 'blocked',
          detail: error?.message || 'Delivery failed.',
        };
      }
      await this._finish(selected.job, selected.run, result);
    }
  }

  async tick() {
    await this.lock;
    if (!this.initialized) throw new Error('Scheduler is not initialized.');
    if (!this.inFlight) {
      this.inFlight = this._drain().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }
}
