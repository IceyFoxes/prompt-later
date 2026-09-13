import { parseTarget } from './targets.js';
import { nextOccurrence, validateSchedule } from './schedules.js';

const extension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
const $ = id => document.getElementById(id);
const form = $('job-form');
const params = new URLSearchParams(location.search);
const state = {
  data: { jobs: [], history: [] },
  tab: params.get('tab') || 'send',
  editing: null,
  popup: params.get('popup') === '1',
  sourceTabId: params.has('sourceTabId') && Number.isInteger(Number(params.get('sourceTabId'))) && Number(params.get('sourceTabId')) > 0 ? Number(params.get('sourceTabId')) : null,
  pending: false,
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

function setStatus(value, error = false) {
  text($('form-status'), value);
  $('form-status').className = `status ${error ? 'error' : 'success'}`;
}

function setPending(value) {
  state.pending = value;
  $('save').disabled = value || !extension;
  $('check').disabled = value || !extension;
  $('current-tab').disabled = value || !extension;
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
  $('once-fields').hidden = state.tab === 'recurring';
  $('activity-view').hidden = state.tab !== 'activity';
  $('form-view').hidden = state.tab === 'activity';
}

function previewSchedule() {
  if (state.tab !== 'recurring') return;
  try {
    const now = Date.now();
    const schedule = readSchedule(now, true);
    const next = nextOccurrence(schedule, now);
    text($('next-preview'), next
      ? `Next occurrence: ${new Date(next).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: schedule.timeZone })} (${schedule.timeZone})`
      : 'No future occurrence.');
  } catch (error) {
    text($('next-preview'), error.message);
  }
}

function renderTabs() {
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
  });
  $('list-title').textContent = state.tab === 'recurring' ? 'Recurring messages' : state.tab === 'activity' ? 'Activity' : 'Saved messages';
  syncFormVisibility();
}

function clearForm() {
  state.editing = null;
  form.reset();
  $('timezone').value = timezone();
  $('when').value = '5h';
  $('recurrence').value = 'interval';
  $('interval-hours').value = '5';
  $('recurring-time').value = '07:00';
  $('cron').value = '0 7 * * 1-5';
  $('cancel-edit').hidden = true;
  $('save').textContent = 'Save scheduled message';
  showTarget();
  syncFormVisibility();
  previewSchedule();
}

function fillJob(job) {
  state.editing = job.id;
  $('url').value = job.url;
  $('message').value = job.message;
  $('missed-policy').value = job.missedPolicy;
  $('cancel-edit').hidden = false;
  $('save').textContent = 'Update scheduled message';
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

function providerLabel(provider) {
  return provider === 'chatgpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : 'Devin (experimental)';
}

function statusLabel(job) {
  if (job.status === 'needs-attention') return 'Needs attention';
  if (job.status === 'paused') return 'Paused';
  return job.status;
}

function jobCard(job) {
  const card = document.createElement('article');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const provider = document.createElement('strong');
  provider.textContent = providerLabel(job.provider);
  const status = document.createElement('span');
  status.className = `chip ${job.status === 'needs-attention' ? 'attention' : ''}`;
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
  meta.textContent = job.nextRunAt
    ? `${formatAbsolute(job.nextRunAt, job.schedule.timeZone)} (${job.schedule.timeZone}) · ${formatCountdown(job.nextRunAt)}`
    : `${job.lastDetail || (job.status === 'completed' ? 'Completed' : 'Paused')} (${job.schedule.timeZone})`;
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
    if (!confirm('Delete this saved message?')) return;
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
  return item;
}

function renderJobs() {
  const list = $('job-list');
  list.replaceChildren();
  const isActivity = state.tab === 'activity';
  document.querySelector('.list-panel').hidden = isActivity;
  list.hidden = isActivity;
  document.querySelector('.list-heading').hidden = isActivity;
  document.querySelector('.privacy').hidden = isActivity;
  const jobs = state.data.jobs.filter(job => state.tab === 'recurring'
    ? job.schedule.type !== 'once'
    : state.tab === 'send' ? job.schedule.type === 'once' : false);
  $('job-count').textContent = `${jobs.length}`;
  if (state.tab !== 'activity') {
    if (!jobs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.tab === 'recurring' ? 'No recurring messages saved.' : 'No one-off messages saved.';
      list.append(empty);
    } else {
      jobs.forEach(job => list.append(jobCard(job)));
    }
  }
  const activity = $('activity-list');
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

async function load() {
  const result = await send('GET_STATE');
  if (result.ok) {
    state.data = result.data;
    renderJobs();
  } else {
    setStatus(result.error, true);
    if (!extension) $('preview-note').hidden = false;
  }
}

async function currentTab() {
  const result = await send('CURRENT_TAB', { sourceTabId: state.sourceTabId });
  if (!result.ok || !result.data?.url) return;
  state.sourceTabId = result.data.id;
  try {
    const target = parseTarget(result.data.url);
    $('url').value = target.url;
    showTarget(target);
  } catch {
    $('url').value = '';
    showTarget();
  }
}

async function requestAccess(target, denialMessage) {
  const granted = await chrome.permissions.request({ origins: [`${target.origin}/*`] });
  if (!granted) throw new Error(denialMessage);
}

async function checkPage() {
  if (state.pending) return;
  try {
    const target = parseTarget($('url').value);
    setPending(true);
    await requestAccess(target, 'Site access was not granted. Nothing was opened or sent.');
    const result = await send('CHECK_TARGET', { url: target.url });
    if (!result.ok) throw new Error(result.error);
    const blocked = result.data?.status === 'blocked';
    setStatus(`${result.data?.detail || 'Page checked.'} This action does not send.`, blocked);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setPending(false);
  }
}

async function save(event) {
  event.preventDefault();
  if (state.pending) return;
  try {
    const payload = readForm();
    const target = parseTarget(payload.url);
    setPending(true);
    await requestAccess(target, 'Site access was not granted. Nothing was scheduled.');
    const result = await send('UPSERT_JOB', payload);
    if (!result.ok) throw new Error(result.error);
    setStatus(state.editing ? 'Message updated.' : 'Message scheduled.');
    clearForm();
    await load();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setPending(false);
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
  setStatus('');
  renderTabs();
  renderJobs();
  previewSchedule();
}

document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', switchTab));
form.addEventListener('submit', save);
$('current-tab').addEventListener('click', currentTab);
$('check').addEventListener('click', checkPage);
$('cancel-edit').addEventListener('click', clearForm);
$('dashboard-link').addEventListener('click', openDashboard);
$('when').addEventListener('change', syncFormVisibility);
$('recurrence').addEventListener('change', updateRecurringFields);
$('interval-hours').addEventListener('input', previewSchedule);
$('recurring-time').addEventListener('input', previewSchedule);
$('cron').addEventListener('input', previewSchedule);
$('timezone').addEventListener('input', previewSchedule);
$('url').addEventListener('input', updateTargetPreview);
if (extension) chrome.storage.onChanged.addListener(load);
else {
  $('preview-note').hidden = false;
  $('save').disabled = true;
  $('check').disabled = true;
}
if (state.popup) document.body.classList.add('popup');
populateTimezones();
clearForm();
renderTabs();
load().then(() => {
  if (state.popup || state.sourceTabId) return currentTab();
});
setInterval(() => {
  document.querySelectorAll('[data-next]').forEach(node => {
    if (node.dataset.next) {
      node.textContent = `${formatAbsolute(Number(node.dataset.next), node.dataset.zone)} (${node.dataset.zone}) · ${formatCountdown(Number(node.dataset.next))}`;
    }
  });
}, 30000);
