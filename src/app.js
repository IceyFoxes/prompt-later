import { parseTarget } from './targets.js';
import { nextOccurrence, validateSchedule } from './schedules.js';
import { providerLabel } from './providers.js';

const extension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
const $ = id => document.getElementById(id);
const form = $('job-form');
const params = new URLSearchParams(location.search);
const requestedTab = params.get('tab');
const JOB_DISPLAY_LIMIT = 4;
const FINAL_RUN_STATUSES = new Set(['sent', 'skipped', 'blocked', 'uncertain']);
const DRAFT_POLICIES = new Set(['skip', 'send-draft', 'send-both', 'send-scheduled']);
const DEFAULT_DRAFT_POLICY = 'skip';
const VALID_TABS = ['send', 'recurring', 'activity', 'info'];
const state = {
  data: { jobs: [], history: [] },
  tab: VALID_TABS.includes(requestedTab) ? requestedTab : 'send',
  editing: null,
  popup: params.get('popup') === '1',
  sourceTabId: params.has('sourceTabId') && Number.isInteger(Number(params.get('sourceTabId'))) && Number(params.get('sourceTabId')) > 0 ? Number(params.get('sourceTabId')) : null,
  accessTarget: null,
  accessGranted: null,
  accessChecking: false,
  accessPending: false,
  accessGeneration: 0,
  pending: false,
  vault: null,
  loadGeneration: 0,
  expandedJobs: { send: false, recurring: false },
  popupQueueExpanded: false,
  deliveryPending: false,
  activityPending: false,
};

function send(action, payload = {}) {
  if (!extension) return Promise.resolve({ ok: false, error: 'Load this folder as a Chrome/Edge extension.' });
  return chrome.runtime.sendMessage({ type: 'PL_UI', action, payload });
}

function text(node, value) {
  node.textContent = value;
}

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function localValue(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isUnlocked() {
  return state.vault?.configured === true && state.vault.unavailable === false;
}

function accessStatus(value, error = false) {
  text($('permission-status'), value);
  $('permission-status').className = `status ${error ? 'error' : 'success'}`;
}

function renderAccessGate() {
  const visible = isUnlocked() && (state.accessChecking || (state.accessTarget && state.accessGranted === false));
  $('permission-panel').hidden = !visible;
  $('scheduler-view').hidden = !isUnlocked() || visible;
  if (!visible) return;
  const resolving = state.accessChecking || !state.accessTarget;
  $('permission-actions').hidden = resolving;
  $('permission-allow').disabled = resolving || state.accessPending;
  $('permission-dismiss').disabled = resolving || state.accessPending;
  if (resolving) {
    $('permission-title').textContent = 'Checking site access…';
    $('permission-description').textContent = 'Checking whether Prompt Later can use the selected conversation.';
    return;
  }
  $('permission-title').textContent = `Allow ${state.accessTarget.label} access`;
  $('permission-description').textContent = `Prompt Later needs access to ${state.accessTarget.origin} to check this conversation and send scheduled messages. Access is limited to this site and can be removed in Chrome settings.`;
  $('permission-allow').textContent = `Allow ${state.accessTarget.label}`;
}

function clearAccessTarget() {
  state.accessGeneration += 1;
  state.accessTarget = null;
  state.accessGranted = null;
  state.accessChecking = false;
  accessStatus('');
  renderAccessGate();
}

async function permissionGranted(target) {
  return Boolean(extension && await chrome.permissions.contains({ origins: [`${target.origin}/*`] }));
}

async function selectAccessTarget(target, blocking = false) {
  const generation = ++state.accessGeneration;
  state.accessTarget = target;
  state.accessGranted = null;
  state.accessChecking = blocking;
  accessStatus('');
  renderAccessGate();
  let granted = false;
  try {
    granted = await permissionGranted(target);
  } catch {}
  if (generation !== state.accessGeneration) return false;
  state.accessChecking = false;
  state.accessGranted = granted;
  renderAccessGate();
  return granted;
}

async function requireAccess(target) {
  const generation = ++state.accessGeneration;
  state.accessTarget = target;
  let granted = false;
  try {
    granted = await permissionGranted(target);
  } catch {}
  if (generation !== state.accessGeneration) return false;
  state.accessGranted = granted;
  state.accessChecking = false;
  renderAccessGate();
  return granted;
}

function setStatus(value, tone = '') {
  const normalizedTone = tone === true ? 'error' : tone || (value ? 'success' : '');
  text($('form-status'), value);
  $('form-status').className = `status${normalizedTone ? ` ${normalizedTone}` : ''}`;
}

function setPending(value) {
  state.pending = value;
  const disabled = value || !extension || !isUnlocked();
  $('save').disabled = disabled;
  $('check').disabled = disabled;
  $('current-tab').disabled = disabled;
}

function showTarget(target) {
  const chip = $('provider-chip');
  chip.replaceChildren();
  if (!target) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const label = document.createElement('span');
  label.textContent = target.label;
  chip.append(label);
  if (target.experimental) {
    const badge = document.createElement('small');
    badge.textContent = ' Experimental';
    chip.append(badge);
  }
}

function updateMessageCount() {
  const length = $('message').value.length;
  $('message-count').textContent = `${length.toLocaleString()} / 20,000`;
}

function updateTargetPreview() {
  try {
    showTarget(parseTarget($('url').value));
  } catch {
    showTarget();
  }
}

function populateTimezones() {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  $('zones').replaceChildren();
  for (const zone of zones) {
    const option = document.createElement('option');
    option.value = zone;
    $('zones').append(option);
  }
}

function existingJob() {
  return state.editing ? state.data.jobs.find(job => job.id === state.editing) : null;
}

function intervalAnchor(now, hours) {
  const existing = existingJob();
  if (existing?.schedule.type === 'interval' && Number(existing.schedule.everyMs) === hours * 3600000) {
    return existing.schedule.anchor;
  }
  return now + hours * 3600000;
}

function readSchedule(now = Date.now(), forPreview = false) {
  const zone = $('timezone').value.trim() || timezone();
  const mode = $('recurrence').value;
  if (mode === 'interval') {
    const hours = Number($('interval-hours').value);
    return validateSchedule({
      type: 'interval',
      everyMs: hours * 3600000,
      anchor: intervalAnchor(now, hours),
      timeZone: zone,
    }, forPreview ? now - 1 : now);
  }
  if (mode === 'daily' || mode === 'weekdays') {
    const [hour, minute] = $('recurring-time').value.split(':').map(Number);
    return validateSchedule({
      type: 'cron',
      expression: `${minute} ${hour} * * ${mode === 'weekdays' ? '1-5' : '*'}`,
      timeZone: zone,
      preset: mode,
    }, now - 1);
  }
  return validateSchedule({ type: 'cron', expression: $('cron').value, timeZone: zone }, now - 1);
}

function readForm() {
  const now = Date.now();
  const target = parseTarget($('url').value);
  showTarget(target);
  let schedule;
  if (state.tab === 'recurring') {
    schedule = readSchedule(now);
  } else {
    const value = $('when').value;
    const at = value === '5h' ? now + 5 * 3600000 : value === '1m' ? now + 60000 : Date.parse($('custom-time').value);
    schedule = validateSchedule({ type: 'once', at, timeZone: timezone() }, now);
  }
  const message = $('message').value;
  if (!message.trim() || message.length > 20000) throw new Error('Message must contain 1–20,000 characters.');
  return {
    id: state.editing || undefined,
    url: target.url,
    message,
    schedule,
    missedPolicy: $('missed-policy').value,
  };
}

function syncFormVisibility() {
  text($('once-zone'), `Times use ${timezone()}.`);
  const mode = $('when').value;
  const recurrence = $('recurrence').value;
  $('custom-time-field').hidden = mode !== 'custom';
  $('interval-field').hidden = recurrence !== 'interval';
  $('recurring-time-field').hidden = !['daily', 'weekdays'].includes(recurrence);
  $('cron-field').hidden = recurrence !== 'cron';
  $('recurring-fields').hidden = state.tab !== 'recurring';
  $('once-fields').hidden = state.tab !== 'send';
  $('activity-view').hidden = state.tab !== 'activity';
  $('info-view').hidden = state.tab !== 'info';
  $('form-view').hidden = !['send', 'recurring'].includes(state.tab);
}

function previewSchedule() {
  if (state.tab !== 'recurring') return;
  try {
    const now = Date.now();
    const schedule = readSchedule(now, true);
    const next = nextOccurrence(schedule, now);
    const formatted = next ? new Date(next).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: schedule.timeZone }) : '';
    text($('next-preview'), next
      ? state.popup ? `Next: ${formatted} · ${schedule.timeZone}. Open dashboard to change timezone.` : `Next occurrence: ${formatted} (${schedule.timeZone})`
      : 'No future occurrence.');
  } catch (error) {
    text($('next-preview'), error.message);
  }
}

function renderTabs() {
  document.body.dataset.tab = state.tab;
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    const selected = tab.dataset.tab === state.tab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $('form-view').setAttribute('aria-labelledby', state.tab === 'recurring' ? 'tab-recurring' : 'tab-send');
  const panelLabel = state.tab === 'activity' ? 'activity-title' : state.tab === 'info' ? 'info-title' : 'view-title';
  document.querySelector('.form-panel').setAttribute('aria-labelledby', panelLabel);
  $('view-eyebrow').textContent = state.tab === 'recurring' ? 'Automation' : 'New schedule';
  $('view-title').textContent = state.tab === 'recurring' ? 'Set a recurring message' : 'Send a message later';
  $('view-description').textContent = state.tab === 'recurring'
    ? 'Create a reliable rhythm with an interval, daily time, or custom schedule.'
    : 'Choose the conversation, write your prompt, and decide when it should go.';
  $('list-title').textContent = state.tab === 'recurring' ? 'Recurring messages' : state.tab === 'activity' ? 'Activity' : 'Saved messages';
  syncFormVisibility();
}

function clearForm() {
  state.editing = null;
  resetCheckButton();
  form.reset();
  $('timezone').value = timezone();
  $('when').value = '5h';
  $('recurrence').value = 'daily';
  $('interval-hours').value = '5';
  $('recurring-time').value = '07:00';
  $('cron').value = '0 7 * * 1-5';
  $('cancel-edit').hidden = true;
  $('save-label').textContent = 'Save scheduled message';
  updateMessageCount();
  showTarget();
  clearAccessTarget();
  syncFormVisibility();
  previewSchedule();
}

function fillJob(job) {
  state.editing = job.id;
  resetCheckButton();
  $('url').value = job.url;
  $('message').value = job.message;
  updateMessageCount();
  $('missed-policy').value = job.missedPolicy;
  $('cancel-edit').hidden = false;
  $('save-label').textContent = 'Update scheduled message';
  if (job.schedule.type === 'once') {
    state.tab = 'send';
    $('when').value = 'custom';
    $('custom-time').value = localValue(job.schedule.at > Date.now() ? job.schedule.at : Date.now() + 5 * 3600000);
  } else {
    state.tab = 'recurring';
    $('timezone').value = job.schedule.timeZone;
    if (job.schedule.type === 'interval') {
      $('recurrence').value = 'interval';
      $('interval-hours').value = Math.max(1, Math.round(job.schedule.everyMs / 3600000));
    } else {
      $('recurrence').value = job.schedule.preset || 'cron';
      $('cron').value = job.schedule.expression;
      const parts = job.schedule.expression.split(' ');
      $('recurring-time').value = `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
    }
  }
  renderTabs();
  syncFormVisibility();
  updateTargetPreview();
  void selectAccessTarget(parseTarget(job.url));
  previewSchedule();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatAbsolute(timestamp, zone) {
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(timestamp));
}

function formatCountdown(timestamp) {
  const delta = timestamp - Date.now();
  if (delta <= 0) return 'Due';
  const minutes = Math.round(delta / 60000);
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}


function statusLabel(job) {
  if (job.status === 'needs-attention') return 'Needs attention';
  if (job.status === 'paused') return 'Paused';
  if (job.status === 'completed') return 'Submitted';
  return job.status;
}

function confirmAction({ title, description, confirmLabel }) {
  const dialog = $('confirmation-dialog');
  if (dialog.open || typeof dialog.showModal !== 'function') return Promise.resolve(false);
  text($('confirmation-title'), title);
  text($('confirmation-description'), description);
  text($('confirmation-accept'), confirmLabel);
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    const finish = () => {
      dialog.removeEventListener('close', finish);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', finish);
    dialog.showModal();
  });
}

function jobCard(job) {
  const card = document.createElement('article');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const provider = document.createElement('strong');
  provider.textContent = providerLabel(job.provider);
  const status = document.createElement('span');
  status.className = `chip job-status job-status-${job.status}`;
  status.textContent = statusLabel(job);
  head.append(provider, status);
  const message = document.createElement('div');
  message.className = 'message';
  message.textContent = job.message;
  const link = document.createElement('a');
  link.className = 'url';
  link.href = job.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = job.url;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.dataset.next = job.nextRunAt || '';
  meta.dataset.zone = job.schedule.timeZone;
  const when = job.nextRunAt
    ? `${formatAbsolute(job.nextRunAt, job.schedule.timeZone)} (${job.schedule.timeZone}) · ${formatCountdown(job.nextRunAt)}`
    : `${job.lastDetail || (job.status === 'completed' ? 'Completed' : 'Paused')} (${job.schedule.timeZone})`;
  meta.textContent = when;
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const running = job.status === 'running';
  const edit = document.createElement('button');
  edit.className = 'secondary';
  const needsReschedule = job.status === 'needs-attention' || (job.schedule.type === 'once' && (!job.enabled || !job.nextRunAt));
  edit.textContent = needsReschedule ? 'Reschedule' : 'Edit';
  edit.disabled = running;
  edit.addEventListener('click', () => fillJob(job));
  const toggle = document.createElement('button');
  toggle.className = 'secondary';
  toggle.textContent = job.enabled ? 'Pause' : 'Resume';
  toggle.disabled = running || (job.status === 'completed' && job.schedule.type === 'once');
  toggle.addEventListener('click', async () => {
    const result = await send('SET_ENABLED', { id: job.id, enabled: !job.enabled });
    if (!result.ok) setStatus(result.error, true);
    else await load();
  });
  const remove = document.createElement('button');
  remove.className = 'secondary danger';
  remove.textContent = 'Delete';
  remove.disabled = running;
  remove.addEventListener('click', async () => {
    if (!(await confirmAction({
      title: 'Delete saved message?',
      description: 'This removes the saved message. Its activity history will remain.',
      confirmLabel: 'Delete',
    }))) return;
    const result = await send('DELETE_JOB', { id: job.id });
    if (!result.ok) setStatus(result.error, true);
    else await load();
  });
  actions.append(edit);
  if (!(job.status === 'completed' && job.schedule.type === 'once')) actions.append(toggle);
  actions.append(remove);
  card.append(head, message, link, meta, actions);
  return card;
}

function activityCard(run) {
  const item = document.createElement('article');
  item.className = 'card';
  const heading = document.createElement('strong');
  heading.className = `activity-status activity-status-${run.status}`;
  heading.textContent = run.status === 'sent' ? 'Sent' : run.status === 'skipped' ? 'Skipped' : run.status === 'uncertain' ? 'Uncertain' : run.status === 'checking' ? 'Preparing' : run.status === 'dispatching' ? 'Sending' : 'Needs attention';
  const provider = document.createElement('div');
  provider.textContent = `${providerLabel(run.provider)} · ${new Date(run.startedAt).toLocaleString()}`;
  const link = document.createElement('a');
  link.href = run.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = run.url;
  const preview = document.createElement('div');
  preview.className = 'message';
  preview.textContent = run.preview;
  const detail = document.createElement('div');
  detail.className = 'meta';
  detail.textContent = run.detail || 'No detail.';
  item.append(heading, provider, link, preview, detail);
  if (FINAL_RUN_STATUSES.has(run.status)) {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const remove = document.createElement('button');
    remove.className = 'secondary danger';
    remove.textContent = 'Delete';
    remove.disabled = state.activityPending;
    remove.addEventListener('click', () => deleteActivity(run.id));
    actions.append(remove);
    item.append(actions);
  }
  return item;
}

function renderJobs() {
  const list = $('job-list');
  const listToggle = $('job-list-toggle');
  const queueToggle = $('popup-queue-toggle');
  list.replaceChildren();
  const isActivity = state.tab === 'activity';
  const isInfo = state.tab === 'info';
  document.querySelector('.list-panel').hidden = isActivity || isInfo;
  list.hidden = isActivity || isInfo || (state.popup && !state.popupQueueExpanded);
  listToggle.hidden = true;
  queueToggle.hidden = !state.popup || isActivity || isInfo;
  queueToggle.textContent = state.popupQueueExpanded ? 'Hide' : 'Show';
  queueToggle.setAttribute('aria-expanded', String(state.popupQueueExpanded));
  document.querySelector('.list-heading').hidden = isActivity || isInfo;
  const jobs = state.data.jobs.filter(job => state.tab === 'recurring'
    ? job.schedule.type !== 'once'
    : state.tab === 'send' ? job.schedule.type === 'once' : false);
  $('job-count').textContent = `${jobs.length}`;
  if (!isActivity && !isInfo) {
    if (!jobs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.tab === 'recurring' ? 'No recurring messages saved.' : 'No one-off messages saved.';
      list.append(empty);
    } else {
      const expanded = state.expandedJobs[state.tab];
      const displayLimit = state.popup ? 2 : JOB_DISPLAY_LIMIT;
      const visibleJobs = expanded ? jobs : jobs.slice(0, displayLimit);
      visibleJobs.forEach(job => list.append(jobCard(job)));
      if (jobs.length > displayLimit && (!state.popup || state.popupQueueExpanded)) {
        listToggle.hidden = false;
        listToggle.textContent = expanded ? 'Show fewer' : `Show all ${jobs.length}`;
        listToggle.setAttribute('aria-expanded', String(expanded));
      }
    }
  }
  const activity = $('activity-list');
  const clearActivityButton = $('clear-activity');
  const finalizedActivity = state.data.history.filter(run => FINAL_RUN_STATUSES.has(run.status));
  clearActivityButton.hidden = finalizedActivity.length === 0;
  clearActivityButton.disabled = state.activityPending;
  activity.replaceChildren();
  if (!state.data.history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No activity yet.';
    activity.append(empty);
  } else {
    state.data.history.slice().reverse().forEach(run => activity.append(activityCard(run)));
  }
}

function toggleJobList() {
  if (!['send', 'recurring'].includes(state.tab)) return;
  state.expandedJobs[state.tab] = !state.expandedJobs[state.tab];
  renderJobs();
  if (!state.expandedJobs[state.tab]) document.querySelector('.list-heading').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function settlePopupLayout() {
  if (!state.popup) return;
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function togglePopupQueue() {
  if (!state.popup || !['send', 'recurring'].includes(state.tab)) return;
  state.popupQueueExpanded = !state.popupQueueExpanded;
  if (!state.popupQueueExpanded) state.expandedJobs[state.tab] = false;
  renderJobs();
  settlePopupLayout();
}

function activityStatus(value, error = false) {
  text($('activity-status'), value);
  $('activity-status').className = `status ${error ? 'error' : 'success'}`;
}

async function deleteActivity(id) {
  if (state.activityPending || !isUnlocked() || !state.data.history.some(run => run.id === id && FINAL_RUN_STATUSES.has(run.status))) return;
  if (!(await confirmAction({
    title: 'Delete activity?',
    description: 'This removes only this activity entry. Its saved message will remain.',
    confirmLabel: 'Delete',
  }))) return;
  state.activityPending = true;
  renderJobs();
  activityStatus('Deleting…');
  try {
    const result = await send('DELETE_ACTIVITY', { id });
    if (!result?.ok) throw new Error(result?.error || 'Activity could not be deleted.');
    await load();
    activityStatus('Activity deleted.');
  } catch (error) {
    activityStatus(error?.message || 'Activity could not be deleted.', true);
  } finally {
    state.activityPending = false;
    renderJobs();
  }
}

async function clearActivity() {
  if (state.activityPending || !isUnlocked() || !state.data.history.some(run => FINAL_RUN_STATUSES.has(run.status))) return;
  if (!(await confirmAction({
    title: 'Clear all activity?',
    description: 'This removes all completed activity entries. Active deliveries will remain.',
    confirmLabel: 'Clear All',
  }))) return;
  state.activityPending = true;
  renderJobs();
  activityStatus('Clearing…');
  try {
    const result = await send('CLEAR_ACTIVITY');
    if (!result?.ok) throw new Error(result?.error || 'Activity could not be cleared.');
    await load();
    activityStatus('Activity cleared.');
  } catch (error) {
    activityStatus(error?.message || 'Activity could not be cleared.', true);
  } finally {
    state.activityPending = false;
    renderJobs();
  }
}

function clearSchedulerView() {
  state.data = { jobs: [], history: [] };
  state.pending = false;
  clearForm();
  setStatus('');
  renderJobs();
}

const DRAFT_CHECK_WARNINGS = {
  'send-draft': 'Page ready. The existing draft will be sent instead of the scheduled message.',
  'send-both': 'Page ready. The existing draft will be sent first; the scheduled message will wait until the provider is idle.',
  'send-scheduled': 'Page ready. The existing draft will be replaced by the scheduled message.',
};

const DRAFT_POLICY_HINTS = {
  skip: 'Preserve the draft and skip this occurrence. Recurring schedules stay active; one-off messages need attention.',
  'send-draft': 'Send the existing composer text and skip the scheduled message for this occurrence.',
  'send-both': 'Send the existing composer text, wait for the provider to become idle, then send the scheduled message. A partial send is not retried.',
  'send-scheduled': 'Erase the existing composer text and send the scheduled message. The overwritten draft cannot be restored.',
};

function persistedDraftPolicy() {
  const policy = state.data?.settings?.draftPolicy;
  return DRAFT_POLICIES.has(policy) ? policy : DEFAULT_DRAFT_POLICY;
}

function renderDeliverySettings() {
  const visible = isUnlocked();
  $('delivery-settings').hidden = !visible;
  const policy = persistedDraftPolicy();
  const select = $('draft-policy');
  if (!state.deliveryPending && document.activeElement !== select) select.value = policy;
  select.disabled = !visible || state.deliveryPending;
  text($('draft-policy-hint'), DRAFT_POLICY_HINTS[select.value] || DRAFT_POLICY_HINTS[DEFAULT_DRAFT_POLICY]);
}

async function changeDraftPolicy() {
  if (state.deliveryPending || !isUnlocked()) return;
  const select = $('draft-policy');
  const previous = persistedDraftPolicy();
  const chosen = select.value;
  state.deliveryPending = true;
  state.data.settings = { draftPolicy: chosen };
  text($('delivery-status'), '');
  $('delivery-status').className = 'status';
  renderDeliverySettings();
  if (chosen === 'send-scheduled' && !(await confirmAction({
    title: 'Replace existing drafts?',
    description: 'This can permanently erase text already in a provider composer and send the scheduled message instead.',
    confirmLabel: 'Use Replace',
  }))) {
    state.data.settings = { draftPolicy: previous };
    state.deliveryPending = false;
    renderDeliverySettings();
    return;
  }
  try {
    const result = await send('UPDATE_SETTINGS', { draftPolicy: chosen });
    if (!result?.ok) throw new Error(result?.error || 'Delivery setting could not be saved.');
    if (DRAFT_POLICIES.has(result.data?.draftPolicy)) state.data.settings = { draftPolicy: result.data.draftPolicy };
    await load();
    text($('delivery-status'), 'Saved.');
    $('delivery-status').className = 'status success';
  } catch (error) {
    state.data.settings = { draftPolicy: previous };
    text($('delivery-status'), error?.message || 'Delivery setting could not be saved.');
    $('delivery-status').className = 'status error';
  } finally {
    state.deliveryPending = false;
    renderDeliverySettings();
  }
}

function renderPrivacySettings() {
  $('privacy-settings').hidden = !isUnlocked();
}

function renderVault(status, error = '') {
  const unavailable = Boolean(error) || !status;
  state.vault = status ? { ...status, unavailable } : null;
  $('vault-panel').hidden = !unavailable;
  $('vault-title').textContent = 'Saved data unavailable';
  $('vault-description').textContent = 'Try again to open your saved data. Nothing has been reset.';
  $('vault-retry').hidden = !error;
  text($('vault-status'), error);
  renderPrivacySettings();
  renderDeliverySettings();
  if (unavailable) clearSchedulerView();
  renderAccessGate();
  setPending(state.pending);
}

async function load() {
  const generation = ++state.loadGeneration;
  let status = null;
  try {
    const result = await send('GET_VAULT_STATUS');
    if (generation !== state.loadGeneration) return;
    if (!result?.ok) throw new Error(result?.error || 'Could not read vault status.');
    status = result.data;
    if (!status || status.configured !== true || status.mode !== 'device'
        || typeof status.legacyData !== 'boolean') throw new Error('The vault status is unreadable.');
    const data = await send('GET_STATE');
    if (generation !== state.loadGeneration) return;
    if (!data?.ok) throw new Error(data?.error || 'Could not read saved messages.');
    const captureSource = !isUnlocked() && (state.popup || state.sourceTabId);
    state.data = data.data;
    renderVault(status);
    renderJobs();
    if (captureSource) await currentTab(true);
  } catch (error) {
    if (generation === state.loadGeneration) renderVault(status, error?.message || 'Could not read saved messages.');
  }
}

function showCurrentTabDialog() {
  const dialog = $('current-tab-dialog');
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    alert('Start or open a conversation so it has its own conversation URL, then try again.');
  }
}

async function currentTab(blocking = false, reportInvalid = false) {
  if (!isUnlocked()) return;
  let result;
  try {
    result = await send('CURRENT_TAB', { sourceTabId: state.sourceTabId });
  } catch {
    if (reportInvalid) showCurrentTabDialog();
    else await load();
    return;
  }
  if (!result.ok || !result.data?.url || !isUnlocked()) {
    clearAccessTarget();
    if (reportInvalid && isUnlocked()) showCurrentTabDialog();
    return;
  }
  state.sourceTabId = result.data.id;
  try {
    const target = parseTarget(result.data.url);
    resetCheckButton();
    $('url').value = target.url;
    showTarget(target);
    await selectAccessTarget(target, blocking);
  } catch {
    resetCheckButton();
    $('url').value = '';
    showTarget();
    clearAccessTarget();
    if (reportInvalid) showCurrentTabDialog();
  }
}

async function grantAccess() {
  if (!state.accessTarget || state.accessChecking || state.accessPending || !isUnlocked()) return;
  const target = state.accessTarget;
  state.accessPending = true;
  accessStatus('');
  renderAccessGate();
  try {
    const granted = await chrome.permissions.request({ origins: [`${target.origin}/*`] });
    if (target !== state.accessTarget) return;
    state.accessGranted = granted;
    if (!granted) {
      accessStatus('Access was not granted. Nothing was scheduled or sent.', true);
      return;
    }
    setStatus(`${target.label} access granted. You can schedule this conversation.`);
  } catch (error) {
    if (target === state.accessTarget) accessStatus(error?.message || 'Site access could not be requested.', true);
  } finally {
    state.accessPending = false;
    renderAccessGate();
  }
  if (target === state.accessTarget && state.accessGranted) $('message').focus();
}

function dismissAccess() {
  if (state.accessPending || state.accessChecking) return;
  $('url').value = '';
  showTarget();
  clearAccessTarget();
  setStatus('Choose an existing conversation before scheduling.');
  $('url').focus();
}

async function syncUrlAccess() {
  if (!isUnlocked()) return;
  try {
    await selectAccessTarget(parseTarget($('url').value));
  } catch {
    clearAccessTarget();
  }
}

function resetCheckButton() {
  const button = $('check');
  button.classList.remove('check-success');
  button.textContent = 'Check page';
}

async function checkPage() {
  if (state.pending || !isUnlocked()) return;
  try {
    const target = parseTarget($('url').value);
    setPending(true);
    resetCheckButton();
    if (!(await requireAccess(target))) return;
    const result = await send('CHECK_TARGET', { url: target.url });
    if (!result.ok) throw new Error(result.error);
    const data = result.data || {};
    const policy = persistedDraftPolicy();
    const draftReady = data.status === 'blocked' && data.draft === true && data.busy === false
      && data.attachments === false && !data.error && DRAFT_CHECK_WARNINGS[policy];
    if (draftReady) {
      setStatus(DRAFT_CHECK_WARNINGS[policy], 'warning');
      $('check').classList.add('check-success');
      $('check').textContent = '✓ Ready with draft';
    } else if (data.status === 'blocked') {
      setStatus(data.detail || 'Page is not ready.', true);
    } else {
      setStatus('');
      $('check').classList.add('check-success');
      $('check').textContent = '✓ Page ready';
    }
  } catch (error) {
    resetCheckButton();
    setStatus(error.message, true);
  } finally {
    setPending(false);
  }
}

async function save(event) {
  event.preventDefault();
  if (state.pending || !isUnlocked()) return;
  try {
    const payload = readForm();
    const target = parseTarget(payload.url);
    setPending(true);
    if (!(await requireAccess(target))) return;
    setStatus('Saving message…');
    const result = await send('UPSERT_JOB', payload);
    if (!result.ok) throw new Error(result.error);
    const saved = state.editing ? 'Message updated.' : 'Message scheduled.';
    clearForm();
    await load();
    setStatus(`${saved}${await draftWarning(target)}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setPending(false);
  }
}

// Text sitting in the composer now is the most common reason a scheduled
// message does not go out, so say so while the user is still looking.
async function draftWarning(target) {
  try {
    const result = await send('CHECK_TARGET', { url: target.url, openIfMissing: false });
    if (!result.ok || result.data?.draft !== true) return '';
    const policy = persistedDraftPolicy();
    const provider = providerLabel(target.provider);
    if (policy === 'send-draft') return ` ${provider} has text in its composer right now. If it is still there when this runs, the existing draft will be sent instead of the scheduled message for that occurrence.`;
    if (policy === 'send-both') return ` ${provider} has text in its composer right now. If it is still there when this runs, the draft will be sent first, then the scheduled message will be sent after the provider becomes idle.`;
    if (policy === 'send-scheduled') return ` ${provider} has text in its composer right now. If it is still there when this runs, the draft will be replaced by the scheduled message.`;
    return ` ${provider} has text in its composer right now. If it is still there when this runs, a recurring schedule will continue with its next occurrence and a one-off message will need your attention.`;
  } catch {
    return '';
  }
}

async function openDashboard(event) {
  if (!state.popup || !extension) return;
  event.preventDefault();
  const query = state.sourceTabId ? `?sourceTabId=${encodeURIComponent(state.sourceTabId)}` : '';
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('app.html')}${query}` });
  window.close();
}

function updateRecurringFields() {
  syncFormVisibility();
  previewSchedule();
}

function switchTab(event) {
  const next = event.currentTarget.dataset.tab;
  if (next !== state.tab && state.editing) clearForm();
  state.tab = next;
  if (state.popup) {
    state.popupQueueExpanded = false;
    state.expandedJobs.send = false;
    state.expandedJobs.recurring = false;
  }
  setStatus('');
  activityStatus('');
  renderTabs();
  renderJobs();
  previewSchedule();
  settlePopupLayout();
}

function navigateTabs(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(event.currentTarget);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

document.querySelectorAll('[role="tab"]').forEach(tab => {
  tab.addEventListener('click', switchTab);
  tab.addEventListener('keydown', navigateTabs);
});
$('permission-allow').addEventListener('click', grantAccess);
$('permission-dismiss').addEventListener('click', dismissAccess);
$('vault-retry').addEventListener('click', load);
$('draft-policy').addEventListener('change', changeDraftPolicy);
form.addEventListener('submit', save);
$('current-tab').addEventListener('click', () => currentTab(false, true));
$('current-tab-dialog').addEventListener('click', event => {
  if (event.target === $('current-tab-dialog')) $('current-tab-dialog').close();
});
$('confirmation-dialog').addEventListener('click', event => {
  if (event.target === $('confirmation-dialog')) $('confirmation-dialog').close('cancel');
});
$('check').addEventListener('click', checkPage);
$('clear-activity').addEventListener('click', clearActivity);
$('cancel-edit').addEventListener('click', clearForm);
$('job-list-toggle').addEventListener('click', toggleJobList);
$('popup-queue-toggle').addEventListener('click', togglePopupQueue);
$('dashboard-link').addEventListener('click', openDashboard);
$('when').addEventListener('change', syncFormVisibility);
$('recurrence').addEventListener('change', updateRecurringFields);
$('interval-hours').addEventListener('input', previewSchedule);
$('recurring-time').addEventListener('input', previewSchedule);
$('cron').addEventListener('input', previewSchedule);
$('timezone').addEventListener('input', previewSchedule);
$('url').addEventListener('input', () => { resetCheckButton(); updateTargetPreview(); });
$('url').addEventListener('change', syncUrlAccess);
$('message').addEventListener('input', updateMessageCount);
if (extension) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' || area === 'session') && Object.keys(changes).some(key => ['prompt-later.vault.v1', 'prompt-later.vault-next.v1', 'prompt-later.vault-session.v1', 'prompt-later.v1'].includes(key))) load();
  });
  if (chrome.permissions?.onRemoved) chrome.permissions.onRemoved.addListener(permissions => {
    if (state.accessTarget && permissions.origins?.includes(`${state.accessTarget.origin}/*`)) void selectAccessTarget(state.accessTarget);
  });
} else {
  $('preview-note').hidden = false;
  $('save').disabled = true;
  $('check').disabled = true;
}
if (state.popup) { document.body.classList.add('popup'); document.documentElement.classList.add('popup-root'); }
$('dashboard-link').hidden = !state.popup;
populateTimezones();
clearForm();
if (state.popup || state.sourceTabId) {
  state.accessChecking = true;
  renderAccessGate();
}
renderTabs();
load();
setInterval(() => {
  document.querySelectorAll('[data-next]').forEach(node => {
    if (node.dataset.next) {
      node.textContent = `${formatAbsolute(Number(node.dataset.next), node.dataset.zone)} (${node.dataset.zone}) · ${formatCountdown(Number(node.dataset.next))}`;
    }
  });
}, 30000);
