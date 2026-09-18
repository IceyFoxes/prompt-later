import { parseTarget } from './targets.js';
import { validateSchedule } from './schedules.js';
import { MAX_ATTEMPTS } from './outcomes.js';
import { PROVIDERS } from './providers.js';

export const STORAGE_KEY = 'prompt-later.v1';
export const VERSION = 1;
const JOB_STATUSES = new Set(['scheduled', 'paused', 'running', 'checking', 'dispatching', 'completed', 'needs-attention']);
const RUN_STATUSES = new Set(['checking', 'dispatching', 'sent', 'skipped', 'blocked', 'uncertain']);
const FINAL_RUNS = new Set(['sent', 'skipped', 'blocked', 'uncertain']);

// 'wait' postpones a run while the composer holds text; 'stop' asks for
// attention immediately instead. Absent settings mean the default, so data saved
// before this existed stays byte-identical on read.
export const DRAFT_POLICIES = new Set(['wait', 'stop']);
export const DEFAULT_DRAFT_POLICY = 'wait';

export const draftPolicyOf = state => state?.settings?.draftPolicy || DEFAULT_DRAFT_POLICY;

export function validateDraftPolicy(value) {
  if (!DRAFT_POLICIES.has(value)) throw new Error('Choose how a draft in the composer should be handled.');
  return value;
}

function validateSettings(settings) {
  if (settings === undefined) return undefined;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Prompt Later data has invalid settings.');
  if (Object.keys(settings).some(key => !['draftPolicy', 'checked'].includes(key))) throw new Error('Prompt Later data has unknown settings.');
  if (!DRAFT_POLICIES.has(settings.draftPolicy)) throw new Error('Prompt Later data has an invalid draft policy.');
  if (settings.checked === undefined) return { draftPolicy: settings.draftPolicy };
  if (!settings.checked || typeof settings.checked !== 'object' || Array.isArray(settings.checked)) throw new Error('Prompt Later data has invalid provider checks.');
  for (const [provider, at] of Object.entries(settings.checked)) {
    if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('Prompt Later data records a check for an unknown provider.');
    finiteTimestamp(at, 'provider check time');
  }
  return { draftPolicy: settings.draftPolicy, checked: { ...settings.checked } };
}

export function emptyState() {
  return { version: VERSION, jobs: [], history: [] };
}

function clone(value) {
  return structuredClone(value);
}

function finiteTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new Error(`Prompt Later data has an invalid ${label}.`);
  }
}

function validateJob(job, ids) {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id || ids.has(job.id)) {
    throw new Error('Prompt Later data has invalid or duplicate job IDs.');
  }
  ids.add(job.id);
  if (typeof job.url !== 'string') throw new Error('Prompt Later data has an invalid target URL.');
  const target = parseTarget(job.url);
  if (target.url !== job.url || target.provider !== job.provider) throw new Error('Prompt Later data has a noncanonical target.');
  if (typeof job.message !== 'string' || !job.message.trim() || job.message.length > 20000) throw new Error('Prompt Later data has an invalid message.');
  const schedule = validateSchedule(job.schedule, Date.now(), { allowPast: true });
  if (typeof job.missedPolicy !== 'string' || !['skip', 'run-once'].includes(job.missedPolicy)) throw new Error('Prompt Later data has an invalid missed policy.');
  finiteTimestamp(job.createdAt, 'createdAt');
  finiteTimestamp(job.updatedAt, 'updatedAt');
  if (typeof job.enabled !== 'boolean' || !JOB_STATUSES.has(job.status) || (job.runId !== null && typeof job.runId !== 'string') || (job.lastOutcome !== null && !RUN_STATUSES.has(job.lastOutcome)) || typeof job.lastDetail !== 'string') throw new Error('Prompt Later data has invalid job state.');
  if (job.nextRunAt !== null) finiteTimestamp(job.nextRunAt, 'nextRunAt');
  // Retry bookkeeping was added later, so data saved before it is read as clean.
  const attempts = job.attempts === undefined ? 0 : job.attempts;
  const retryUntil = job.retryUntil === undefined ? null : job.retryUntil;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MAX_ATTEMPTS) throw new Error('Prompt Later data has an invalid retry count.');
  if (retryUntil !== null) finiteTimestamp(retryUntil, 'retryUntil');
  if (attempts === 0 !== (retryUntil === null)) throw new Error('Prompt Later data has inconsistent retry state.');
  const failures = job.failures === undefined ? 0 : job.failures;
  if (!Number.isInteger(failures) || failures < 0) throw new Error('Prompt Later data has an invalid failure count.');
  if (['running', 'checking', 'dispatching'].includes(job.status) && !job.runId) throw new Error('Prompt Later data has an active job without a run ID.');
  if (job.status === 'scheduled' && (!job.enabled || job.nextRunAt === null)) throw new Error('Prompt Later data has an invalid scheduled job.');
  if (job.status === 'paused' && (job.enabled || job.nextRunAt !== null)) throw new Error('Prompt Later data has an invalid paused job.');
  if (job.status === 'completed' && (job.enabled || job.nextRunAt !== null || job.runId !== null)) {
    throw new Error('Prompt Later data has an invalid completed job.');
  }
  if (job.status === 'needs-attention' && job.enabled) throw new Error('Prompt Later data has an enabled attention job.');
  return { ...job, schedule };
}

function validateRun(run, ids) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || !run.id || ids.has(run.id)) throw new Error('Prompt Later data has invalid or duplicate run IDs.');
  ids.add(run.id);
  if (typeof run.jobId !== 'string' || typeof run.url !== 'string' || typeof run.provider !== 'string' || typeof run.preview !== 'string' || !RUN_STATUSES.has(run.status) || typeof run.detail !== 'string') throw new Error('Prompt Later data has an invalid run.');
  const target = parseTarget(run.url);
  if (target.provider !== run.provider) throw new Error('Prompt Later data has a mismatched run provider.');
  finiteTimestamp(run.dueAt, 'dueAt');
  finiteTimestamp(run.startedAt, 'startedAt');
  if (run.finishedAt !== null) finiteTimestamp(run.finishedAt, 'finishedAt');
  if (run.status === 'checking' || run.status === 'dispatching') {
    if (run.finishedAt !== null) throw new Error('Prompt Later data has an active run with a finish time.');
  } else if (run.finishedAt === null) {
    throw new Error('Prompt Later data has a final run without a finish time.');
  }
  return clone(run);
}

export function validateState(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.jobs) || !Array.isArray(value.history)) {
    throw new Error('Prompt Later data is unreadable or from an unsupported version.');
  }
  if (value.jobs.length > 100) throw new Error('Prompt Later data exceeds the saved job limit.');
  const jobIds = new Set();
  const runIds = new Set();
  const jobs = value.jobs.map(job => validateJob(job, jobIds));
  const history = value.history.map(run => validateRun(run, runIds));
  const settings = validateSettings(value.settings);
  return settings === undefined ? { version: VERSION, jobs, history } : { version: VERSION, jobs, history, settings };
}

export function pruneHistory(state) {
  const finals = state.history.filter(run => FINAL_RUNS.has(run.status));
  if (finals.length <= 200) return;
  const keep = new Set(finals.slice(-200).map(run => run.id));
  state.history = state.history.filter(run => !FINAL_RUNS.has(run.status) || keep.has(run.id));
}

export function createChromeStore(chromeApi) {
  return {
    async read() {
      const result = await chromeApi.storage.local.get(STORAGE_KEY);
      if (!(STORAGE_KEY in result)) return emptyState();
      return validateState(result[STORAGE_KEY]);
    },
    async write(state) {
      await chromeApi.storage.local.set({ [STORAGE_KEY]: clone(state) });
    },
  };
}

export function createMemoryStore(initial) {
  let data = initial === undefined ? emptyState() : clone(initial);
  return {
    async read() {
      return validateState(data);
    },
    async write(state) {
      data = validateState(state);
    },
    get data() {
      return clone(data);
    },
  };
}
