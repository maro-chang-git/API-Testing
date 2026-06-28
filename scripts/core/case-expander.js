/**
 * Expands the special "method not allowed" template (TPL-NEG-009) into one
 * concrete case per HTTP method the endpoint does NOT define — so a GET-only
 * path yields POST / PUT / PATCH / DELETE cases, each exercising a method the
 * server should reject with 405.
 *
 * Each expanded case gets a method-suffixed id (e.g. TC-NEG-009-POST) so its
 * result persists independently in the localStorage results store. The function
 * is pure: it takes the matched cases plus the methods the spec defines on the
 * path and returns a new array, leaving non-NEG-009 cases untouched.
 */

// Standard methods we probe for a 405. (OPTIONS is the fallback when an endpoint
// already defines every one of these, so there is nothing left to disallow.)
export const ALL_HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'];

/**
 * @param {Array<object>} cases          - matched test cases
 * @param {Array<string>} allowedMethods - HTTP methods defined on the path (any case)
 * @returns {Array<object>} cases with TPL-NEG-009 expanded per disallowed method
 */
export function expandMethodNotAllowed(cases, allowedMethods) {
  const allowed = new Set(allowedMethods.map(m => m.toUpperCase()));
  const disallowed = ALL_HTTP_METHODS.filter(m => !allowed.has(m));
  if (!disallowed.length) disallowed.push('OPTIONS');

  return cases.flatMap(tc =>
    tc.template_id === 'TPL-NEG-009'
      ? disallowed.map(m => ({
          ...tc,
          id: `${tc.id}-${m}`,
          method: m,
          disallowed_method: m,
          purpose: `${tc.purpose} (${m})`,
        }))
      : [tc]
  );
}
