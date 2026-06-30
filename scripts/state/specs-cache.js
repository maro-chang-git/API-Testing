/**
 * Per-swagger specs document cache, persisted in localStorage.
 *
 * A fallback for the specs `_model` when the dev server is offline: the disk
 * file `output/{id}/specs.json` is the authoritative source of truth and wins
 * on load whenever it's reachable, but when `saveSpecs()` can't reach the
 * server the whole model is mirrored here so edits (baseUrl/auth/headers/body/
 * baseline) survive a reload or swagger switch. A successful disk save clears
 * the entry, so this only ever holds un-persisted (offline) models.
 *
 * Store shape: { [swaggerId] → specs model }
 */
const SPECS_KEY = 'apitest.specs.v1';

/** The cached model for one swagger, or null when absent / unparseable / storage disabled. */
export function loadCachedSpecs(id) {
  try { return (JSON.parse(localStorage.getItem(SPECS_KEY)) || {})[id] || null; }
  catch { return null; }
}

/** Mirrors a swagger's model to localStorage; silently no-ops when storage is unavailable / full. */
export function saveCachedSpecs(id, model) {
  try {
    const all = JSON.parse(localStorage.getItem(SPECS_KEY)) || {};
    all[id] = model;
    localStorage.setItem(SPECS_KEY, JSON.stringify(all));
  } catch { /* storage unavailable or over quota — keep model in memory only */ }
}

/** Drops a swagger's cached model (called after a successful disk save supersedes it). */
export function clearCachedSpecs(id) {
  try {
    const all = JSON.parse(localStorage.getItem(SPECS_KEY)) || {};
    if (id in all) { delete all[id]; localStorage.setItem(SPECS_KEY, JSON.stringify(all)); }
  } catch { /* storage unavailable — nothing to clear */ }
}
