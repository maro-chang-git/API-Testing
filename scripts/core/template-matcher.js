/**
 * Inspects a swagger operation and classifies it so templates can be matched.
 *
 * Returns an "endpoint profile":
 * {
 *   method, path, summary, auth_type,
 *   auth_required, has_path_params, has_query_params, has_body,
 *   endpoint_type: "list" | "detail" | "action"
 * }
 */
export function profileEndpoint(path, method, operation, spec) {
  const params = operation.parameters || [];

  const hasPathParams  = /\{[^}]+\}/.test(path);
  const hasQueryParams = params.some(p => p.in === 'query');
  const hasBody        = params.some(p => p.in === 'body') ||
                         !!operation.requestBody;

  // Security may be declared on the operation, or globally on the spec (applies
  // to every operation unless the operation overrides it — including with an
  // empty `security: []` that disables it). A `{}` entry in the requirement
  // list means anonymous access is allowed, so auth is only *required* when at
  // least one requirement exists and none of them is empty.
  const secDef = operation.security ?? spec?.security;
  const reqs   = Array.isArray(secDef) ? secDef : (secDef ? [secDef] : []);
  const authRequired = reqs.length > 0 && reqs.every(r => r && Object.keys(r).length > 0);
  const firstScheme = reqs.find(r => r && Object.keys(r).length > 0);
  const authType = firstScheme ? Object.keys(firstScheme)[0] : null;

  // Classify GET endpoints: list vs detail
  let endpointType = 'action';
  if (method === 'GET') {
    endpointType = hasPathParams ? 'detail' : 'list';
  }

  return {
    method: method.toUpperCase(),
    path,
    summary: operation.summary || '',
    auth_type: authType || 'none',
    auth_required: authRequired,
    has_path_params: hasPathParams,
    has_query_params: hasQueryParams,
    has_body: hasBody,
    endpoint_type: endpointType,
  };
}

/**
 * Given an endpoint profile and the full templates array,
 * returns the matched templates as concrete test cases.
 *
 * Each case gets a STABLE id derived from its template id (see testCaseId) —
 * never from its position in the matched/filtered list. Results are persisted
 * as resultsStore[endpointKey][tc.id], so a template that matches an endpoint
 * must map to the same id every time, regardless of which templates happen to
 * match or how the table is currently filtered/sorted; otherwise saved results
 * can no longer be found.
 */
export function matchTemplates(profile, templates) {
  const matched = templates.filter(tpl => {
    const a = tpl.applies_to;

    if (!a.methods.includes(profile.method)) return false;
    if (a.auth_required   && !profile.auth_required)    return false;
    if (a.endpoint_type   && a.endpoint_type !== profile.endpoint_type) return false;
    if (a.has_path_params && !profile.has_path_params)  return false;
    if (a.has_query_params && !profile.has_query_params) return false;
    if (a.has_body        && !profile.has_body)         return false;

    return true;
  });

  return matched.map(tpl => ({
    id: testCaseId(tpl.id),
    template_id: tpl.id,
    method: profile.method,
    endpoint: profile.path,
    summary: profile.summary,
    auth_type: profile.auth_type,
    auth_status: tpl.auth_status,
    category: tpl.category,
    tag: tpl.tag,
    purpose: tpl.purpose,
    expected_status: tpl.expected_status,
    notes: tpl.notes,
  }));
}

/**
 * Stable per-endpoint test-case id derived from the template id.
 *
 * The persisted result key is endpointKey + this id — i.e. effectively
 * "template_id + endpoint key" — and a template matches any given endpoint at
 * most once, so the template id alone makes the id unique within an endpoint.
 * The "TPL-" prefix is swapped for "TC-" to keep the familiar id style
 * (e.g. TPL-HP-003 → TC-HP-003).
 */
export function testCaseId(templateId) {
  return 'TC-' + String(templateId).replace(/^TPL-?/i, '');
}

/**
 * Looks up a single operation from a swagger spec by path + method.
 * Returns null if not found.
 */
export function getOperation(spec, path, method) {
  return spec?.paths?.[path]?.[method.toLowerCase()] ?? null;
}

/**
 * Normalises a test case's `expected_status` into a non-empty array of numbers.
 *
 * `expected_status` may be a single number or an array — a case can legitimately
 * accept several HTTP statuses (e.g. DELETE → 200 or 204, a validation error →
 * 400 or 422). The FIRST entry is treated as the "primary" status, used when a
 * single value is needed (body-kind selection, 2xx/4xx-shaped assertions); the
 * full list is used wherever a status is compared (pass/fail, export assertions).
 */
export function expectedStatuses(expectedStatus) {
  return (Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus])
    .filter(s => s !== null && s !== undefined);
}
