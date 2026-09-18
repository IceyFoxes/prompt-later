// Shared vocabulary for why a delivery did not complete. The scheduler uses this
// to decide whether waiting will help, so the codes matter more than the wording.
export const REASONS = {
  DRAFT: 'draft',
  ATTACHMENTS: 'attachments',
  BUSY: 'busy',
  PAGE_ALERT: 'page-alert',
  COMPOSER_MISSING: 'composer-missing',
  COMPOSER_NOT_READY: 'composer-not-ready',
  SEND_NOT_FOUND: 'send-not-found',
  SEND_DISABLED: 'send-disabled',
  INSERTION_FAILED: 'insertion-failed',
  PAGE_RACE: 'page-race',
  TARGET_MISMATCH: 'target-mismatch',
  RESERVATION_STALE: 'reservation-stale',
  TAB_LOAD_TIMEOUT: 'tab-load-timeout',
  PAGE_UNRESPONSIVE: 'page-unresponsive',
  AMBIGUOUS_CONTROLS: 'ambiguous-controls',
  PERMISSION_MISSING: 'permission-missing',
};

// Waiting cannot fix these: the page is structurally not what we expect, or the
// user has to act. Everything else that failed before clicking is worth retrying.
const PERMANENT = new Set([REASONS.AMBIGUOUS_CONTROLS, REASONS.PERMISSION_MISSING]);

export function isTemporary(outcome, reason) {
  // Only outcomes that provably never clicked send may be retried. 'uncertain'
  // means the click may have landed, so retrying it could post twice.
  if (outcome !== 'blocked') return false;
  return !PERMANENT.has(reason);
}

// A page that is still loading, still replying, or briefly rate limited is
// usually fine within a minute or two, so attempts are quick and close together.
// The window is measured from the original due time and matches the five minutes
// after which a missed run is already considered too late to send, so retrying
// can never push a message past the point the schedule itself calls stale.
export const RETRY_DELAYS = [30 * 1000, 60 * 1000, 2 * 60 * 1000];
export const RETRY_WINDOW = 5 * 60 * 1000;
export const MAX_ATTEMPTS = RETRY_DELAYS.length;

export function withReason(message, reason, extra = {}) {
  return Object.assign(new Error(message), { reason, ...extra });
}
