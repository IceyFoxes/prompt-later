import { Cron } from 'croner';

export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function asTime(value) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time) || !Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) {
    return null;
  }
  return time;
}

export function nextOccurrence(schedule, after) {
  if (schedule.type === 'once') {
    return schedule.at > after ? schedule.at : null;
  }
  if (schedule.type === 'interval') {
    const steps = Math.max(0, Math.floor((after - schedule.anchor) / schedule.everyMs) + 1);
    const next = schedule.anchor + steps * schedule.everyMs;
    return Number.isSafeInteger(next) && Number.isFinite(new Date(next).getTime()) ? next : null;
  }
  const cron = new Cron(schedule.expression, {
    paused: true,
    timezone: schedule.timeZone,
    legacyMode: true,
  });
  try {
    return cron.nextRun(new Date(after))?.getTime() ?? null;
  } finally {
    cron.stop();
  }
}

export function validateSchedule(input, now = Date.now(), options = {}) {
  if (!input || typeof input !== 'object' || !validTimeZone(input.timeZone)) {
    throw new Error('Choose a valid IANA time zone.');
  }
  if (input.type === 'once') {
    const at = asTime(input.at);
    if (at === null || (!options.allowPast && at <= now)) {
      throw new Error('Choose a future time.');
    }
    return { type: 'once', at, timeZone: input.timeZone };
  }
  if (input.type === 'interval') {
    const everyMs = Number(input.everyMs);
    const anchor = asTime(input.anchor);
    if (!Number.isSafeInteger(everyMs) || everyMs < 60000 || anchor === null) {
      throw new Error('Choose a valid interval of at least one minute.');
    }
    const normalized = { type: 'interval', everyMs, anchor, timeZone: input.timeZone };
    if (!nextOccurrence(normalized, now)) {
      throw new Error('The schedule has no future occurrence.');
    }
    return normalized;
  }
  if (input.type === 'cron') {
    if (typeof input.expression !== 'string' || input.expression.trim().split(/\s+/).length !== 5) {
      throw new Error('Cron must use exactly five fields.');
    }
    if (input.preset !== undefined && !['daily', 'weekdays'].includes(input.preset)) {
      throw new Error('Unknown schedule preset.');
    }
    const expression = input.expression.trim();
    const normalized = { type: 'cron', expression, timeZone: input.timeZone };
    try {
      if (!nextOccurrence(normalized, now)) {
        throw new Error('The schedule has no future occurrence.');
      }
    } catch (error) {
      throw new Error(`Invalid cron schedule: ${error.message}`);
    }
    if (input.preset) normalized.preset = input.preset;
    return normalized;
  }
  throw new Error('Choose a schedule type.');
}

export function scheduleLabel(schedule) {
  if (schedule.type === 'once') return 'Once';
  if (schedule.type === 'interval') return `Every ${Math.round(schedule.everyMs / 3600000 * 10) / 10} hours`;
  if (schedule.preset === 'weekdays') return 'Weekdays';
  if (schedule.preset === 'daily') return 'Daily';
  return schedule.expression;
}
