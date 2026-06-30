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
 *
 * HEAD and OPTIONS are never probed (auto-served with GET / answered 200/204 by
 * CORS preflight); when a path already defines every probe verb the NEG-009 case
 * is dropped instead of forced onto an unreliable method.
 */

// The methods we actively probe for a 405. HEAD and OPTIONS are deliberately
// excluded: HEAD is auto-served alongside GET and OPTIONS is answered 200/204
// by CORS preflight, so probing either for 405 yields false positives. They are
// still honored as "covered" when a path declares them (see expandMethodNotAllowed),
// and when an endpoint already defines every probe verb the NEG-009 case is
// skipped rather than forced onto an unreliable method.
export const ALL_HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'];

/**
 * @param {Array<object>} cases          - matched test cases
 * @param {Array<string>} allowedMethods - HTTP methods defined on the path (any case)
 * @returns {Array<object>} cases with TPL-NEG-009 expanded per disallowed method
 */
export function expandMethodNotAllowed(cases, allowedMethods) {
  const allowed = new Set(allowedMethods.map(m => m.toUpperCase()));
  const disallowed = ALL_HTTP_METHODS.filter(m => !allowed.has(m));
  // When every probe verb is already defined, `disallowed` is empty and the
  // flatMap below maps TPL-NEG-009 to [] — i.e. the case is skipped. We do NOT
  // fall back to OPTIONS (servers answer it 200/204, a false-positive 405).

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
