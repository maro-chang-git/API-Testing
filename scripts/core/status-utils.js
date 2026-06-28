/**
 * HTTP status-code helpers — single source for status classification and the
 * 2xx / 4xx range checks that the table renderer, body-builder and both
 * exporters all need.
 */

/** CSS class for a status badge: 5xx / 4xx / everything-else (treated as 2xx). */
export function statusClass(code) {
  if (code >= 500) return 's5xx';
  if (code >= 400) return 's4xx';
  return 's2xx';
}

/** True for a 2xx success status. */
export function is2xx(code) {
  return code >= 200 && code < 300;
}

/** True for a 4xx client-error status. */
export function is4xx(code) {
  return code >= 400 && code < 500;
}
