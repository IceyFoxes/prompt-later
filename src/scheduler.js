import { nextOccurrence, validateSchedule } from './schedules.js';
import { draftPolicyOf, pruneHistory, validateDraftPolicy, validateState } from './store.js';
import { parseTarget } from './targets.js';
import { REASONS } from './outcomes.js';

const LATE_LIMIT = 5 * 60 * 1000;
const ACTIVE_RUNS = new Set(['checking', 'dispatching']);
const copy = value => structuredClone(value);
const isRecurring = job => job.schedule.type !== 'once';

function setAttention(job) {
  job.nextRunAt = null;
  job.status = 'needs-attention';
  job.enabled = false;
}

function advanceRecurring(job, after) {
  if (!isRecurring(job)) return false;
  const next = nextOccurrence(job.schedule, after);
  if (!Number.isFinite(next)) return false;
  job.nextRunAt = next;
  job.status = 'scheduled';
  job.enabled = true;
  return true;
}

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
      const jobsByRun = new Map(draft.jobs.filter(job => job.runId).map(job => [job.runId, job]));
      for (const job of draft.jobs) {
        if (!['running', 'checking', 'dispatching'].includes(job.status)) continue;
        const run = draft.history.find(item => item.id === job.runId);
        job.runId = null;
        job.updatedAt = now;
        if (run?.status === 'checking') {
          // Checking is durably before the commit/click boundary. Requeue the
          // same occurrence and let its ordinary late policy decide whether it
          // should still run after the restart.
          run.status = 'blocked';
          run.finishedAt = now;
          run.detail = 'The previous attempt was interrupted before sending.';
          job.lastOutcome = 'blocked';
          job.lastDetail = run.detail;
          job.status = 'scheduled';
          job.enabled = true;
          job.nextRunAt = run.dueAt;
        } else {
          // Dispatching means a click may have happened. Never repeat that
          // occurrence; a recurring job may continue with its next occurrence.
          const detail = 'The previous attempt was interrupted after sending may have started.';
          if (run && ACTIVE_RUNS.has(run.status)) {
            run.status = 'uncertain';
            run.finishedAt = now;
            run.detail = detail;
          }
          job.lastOutcome = 'uncertain';
          job.lastDetail = detail;
          if (!advanceRecurring(job, now)) setAttention(job);
        }
      }
      for (const run of draft.history) {
        if (!ACTIVE_RUNS.has(run.status) || jobsByRun.has(run.id)) continue;
        run.status = run.status === 'checking' ? 'blocked' : 'uncertain';
        run.finishedAt = now;
        run.detail = run.status === 'blocked'
          ? 'An interrupted pre-send attempt had no matching saved job.'
          : 'An interrupted send had no matching saved job.';
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

  async updateSettings(input) {
    return this._mutate(async draft => {
      draft.settings = { draftPolicy: validateDraftPolicy(input?.draftPolicy) };
      return draft.settings;
    });
  }

  async clearActivity() {
    return this._mutate(async draft => {
      const before = draft.history.length;
      // Active rows are part of an in-flight delivery and must remain available
      // to finish or recover safely. Everything finalized is user-clearable.
      draft.history = draft.history.filter(run => ACTIVE_RUNS.has(run.status));
      return { removed: before - draft.history.length };
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
        if (!advanceRecurring(job, Math.max(finishedAt, run.dueAt))) {
          job.nextRunAt = null;
          job.status = 'completed';
          job.enabled = false;
        }
      } else {
        const continueRecurring = !(result?.reason === REASONS.DRAFT && draftPolicyOf(draft) === 'stop')
          && advanceRecurring(job, Math.max(finishedAt, run.dueAt));
        if (!continueRecurring) setAttention(job);
      }
    });
  }

  async _skip(jobSnapshot, runSnapshot) {
    return this._mutate(async draft => {
      const job = draft.jobs.find(item => item.id === jobSnapshot.id);
      const run = draft.history.find(item => item.id === runSnapshot.id);
      if (!job || !run || job.runId !== runSnapshot.id) return;
      const now = this.now();
      run.status = 'skipped';
      run.finishedAt = now;
      run.detail = 'Skipped because it was more than 5 minutes late.';
      job.lastOutcome = 'skipped';
      job.lastDetail = run.detail;
      job.runId = null;
      job.updatedAt = now;
      if (!advanceRecurring(job, now)) {
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
