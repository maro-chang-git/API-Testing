// Auth auto-promotion: when a live request returns 401 or 403 on an endpoint that
// was not marked auth-required, flip the flag, persist it, and return the updated
// case list so callers can report the change.
//
// This mirrors scripts/app.js#enableAuthCases (browser), which does the same in
// the DOM path. Extracted here so both request.js and explore.js share it.

import { deriveEndpointCases } from '../../scripts/core/derive-endpoint.js';

/**
 * Returns true when the status indicates the server enforces authentication.
 */
export function isAuthEnforced(status) {
  return status === 401 || status === 403;
}

/**
 * If the response status is 401/403 and the endpoint was not already auth-required,
 * flips auth_required in the specs model, saves, re-derives the full case list, and
 * returns { promoted: true, newCases }.  Otherwise returns { promoted: false }.
 *
 * @param {object} ctx
 * @param {string} method
 * @param {string} path
 * @param {object} operation
 * @param {object} profile     - the profile object from deriveEndpointCases (mutated in place)
 * @param {number} status      - the live response status
 * @param {Array}  templates
 */
export async function maybePromoteAuth(ctx, method, path, operation, profile, status, templates) {
  if (!isAuthEnforced(status) || profile.auth_required) return { promoted: false };

  profile.auth_required = true;
  ctx.specsStore.setAuthRequired(method, path, true);
  await ctx.specsStore.saveSpecs();

  // Re-derive so the newly matched auth cases are included.
  const { cases: newCases } = deriveEndpointCases(method, path, operation, ctx.spec, ctx.specsStore, templates);
  const addedCount = newCases.filter((c) => c.category === 'auth').length;

  return { promoted: true, addedAuthCases: addedCount, newCases };
}
