import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, validateSchedule } from '../../src/schedules.js';

const date = value => Date.parse(value);

test('one-off occurrence is strictly future', () => {
  assert.equal(nextOccurrence({ type: 'once', at: 1000, timeZone: 'UTC' }, 999), 1000);
  assert.equal(nextOccurrence({ type: 'once', at: 1000, timeZone: 'UTC' }, 1000), null);
  assert.equal(nextOccurrence({ type: 'once', at: 1000, timeZone: 'UTC' }, 1001), null);
});
test('intervals stay anchored and skip backlog', () => {
  assert.equal(nextOccurrence({ type: 'interval', everyMs: 3600000, anchor: 0, timeZone: 'UTC' }, 5.5 * 3600000), 6 * 3600000);
});
test('UTC cron computes next occurrence', () => {
  assert.equal(nextOccurrence({ type: 'cron', expression: '0 7 * * *', timeZone: 'UTC' }, date('2026-09-14T06:59:00Z')), date('2026-09-14T07:00:00Z'));
});
test('weekday cron skips weekend', () => {
  assert.equal(nextOccurrence({ type: 'cron', expression: '0 7 * * 1-5', timeZone: 'UTC' }, date('2026-09-18T07:00:00Z')), date('2026-09-21T07:00:00Z'));
});
test('daily schedule respects DST in captured zone', () => {
  assert.equal(nextOccurrence({ type: 'cron', expression: '0 7 * * *', timeZone: 'America/New_York' }, date('2026-03-07T12:00:00Z')), date('2026-03-08T11:00:00Z'));
});
test('validation rejects bad schedules and messages', () => {
  assert.throws(() => validateSchedule({ type: 'once', at: Date.now() - 1, timeZone: 'UTC' }, Date.now()));
  assert.throws(() => validateSchedule({ type: 'cron', expression: '0 7 * * * *', timeZone: 'UTC' }, Date.now()));
  assert.throws(() => validateSchedule({ type: 'cron', expression: '0 7 * * *', timeZone: 'Not/AZone' }, Date.now()));
  assert.throws(() => validateSchedule({ type: 'once', at: 1e100, timeZone: 'UTC' }, Date.now()));
  assert.throws(() => validateSchedule({ type: 'interval', everyMs: Number.MAX_SAFE_INTEGER + 1, anchor: 0, timeZone: 'UTC' }, Date.now()));
  assert.throws(() => validateSchedule({ type: 'cron', expression: '0 7 * * *', timeZone: 'UTC', preset: 'unknown' }, Date.now()));
});
