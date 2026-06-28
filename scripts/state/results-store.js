/**
 * Per-endpoint test results, persisted in localStorage.
 *
 * Store shape: { endpointKey → { tcId → { actual_status, elapsed, passed, tested_at } } }
 * The endpoint key is `swagger|method|path`, so results survive switching between
 * endpoints and swaggers and are restored when one is re-selected.
 */
const RESULTS_KEY = 'apitest.results.v1';

/** Loads the whole store, or {} when absent / unparseable / storage disabled. */
export function loadResultsStore() {
  try { return JSON.parse(localStorage.getItem(RESULTS_KEY)) || {}; }
  catch { return {}; }
}

/** Persists the whole store; silently no-ops when storage is unavailable / full. */
export function saveResultsStore(store) {
  try { localStorage.setItem(RESULTS_KEY, JSON.stringify(store)); }
  catch { /* storage unavailable or over quota — keep results in memory only */ }
}

/** Stable key identifying an endpoint's result map within the store. */
export function endpointKey(swagger, method, path) {
  return `${swagger}|${method}|${path}`;
}
