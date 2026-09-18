// Shared vocabulary for why a delivery did not complete. These codes are kept
// separate from user-facing wording so behavior never depends on matching text.
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

export function withReason(message, reason, extra = {}) {
  return Object.assign(new Error(message), { reason, ...extra });
}
