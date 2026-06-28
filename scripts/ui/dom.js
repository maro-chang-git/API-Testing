/**
 * Small DOM helpers shared across the UI modules.
 */

/** HTML-escape a value for safe interpolation into an innerHTML string. */
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
