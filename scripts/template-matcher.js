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
export function profileEndpoint(path, method, operation) {
  const params = operation.parameters || [];

  const hasPathParams  = /\{[^}]+\}/.test(path);
  const hasQueryParams = params.some(p => p.in === 'query');
  const hasBody        = params.some(p => p.in === 'body') ||
                         !!operation.requestBody;

  const secDef = operation.security;
  const authRequired = Array.isArray(secDef) ? secDef.length > 0 : !!secDef;
  const authType = authRequired && secDef?.[0]
    ? Object.keys(secDef[0])[0]
    : null;

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
 * Each generated test case gets a sequential id like TC-001, TC-002, …
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

  return matched.map((tpl, i) => ({
    id: `TC-${String(i + 1).padStart(3, '0')}`,
    template_id: tpl.id,
    method: profile.method,
    endpoint: profile.path,
    summary: profile.summary,
    auth_type: profile.auth_type,
    auth_status: tpl.auth_status,
    category: tpl.category,
    purpose: tpl.purpose,
    expected_status: tpl.expected_status,
    notes: tpl.notes,
  }));
}

/**
 * Looks up a single operation from a swagger spec by path + method.
 * Returns null if not found.
 */
export function getOperation(spec, path, method) {
  return spec?.paths?.[path]?.[method.toLowerCase()] ?? null;
}
