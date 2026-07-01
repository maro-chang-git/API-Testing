// DOM-free live HTTP runner — the headless counterpart of request-ui.js#sendRequest.
//
// request-ui.js can't be reused (it reads/writes the DOM at module load), so this
// rebuilds the same request from the pure pieces: request-core (URL/body), the
// shared auth-header classifier, effective* resolvers, then a real fetch (absolute
// URLs pass straight through the fetch shim to the network), SSE parsing, and
// JSON-schema validation. Returns a structured result the commands render.

import { buildRequestUrl, buildRequestBody } from '../../scripts/tryit/request-core.js';
import { classifyAuth } from '../../scripts/core/auth-header.js';
import { isEventStream, parseEventStream } from '../../scripts/tryit/sse-parser.js';
import { validateResponse } from '../../scripts/tryit/schema-validator.js';
import { expectedStatuses } from '../../scripts/core/template-matcher.js';

// Decide the credential a request should send, honoring an auth-category test
// case's preset (missing → none, invalid → tampered value, expired → expired
// token, valid → real token). Returns null when no credential should be sent.
function resolveCredential(auth, profile, tc, tokenOverride) {
  const token = tokenOverride ?? auth.token;
  if (tc?.category === 'auth') {
    if (tc.auth_status === 'missing') return null;
    if (tc.auth_status === 'invalid') return auth.invalidTokenValue || 'invalid_token_tampered_xyz';
    if (tc.auth_status === 'expired') return auth.expiredToken || null;
    return token || null; // 'valid' (e.g. insufficient-permission case) uses the real token
  }
  return profile.auth_required ? (token || null) : null;
}

// Build the auth contribution: either a header { name, value } or a query-param
// entry (for an apiKey-in-query scheme, which request-core appends to the URL).
function resolveAuth(auth, profile, tc, tokenOverride) {
  const cred = resolveCredential(auth, profile, tc, tokenOverride);
  if (!cred) return { header: null, queryAuth: {} };

  if (auth.in === 'query') {
    return { header: null, queryAuth: { type: 'api_key_query', key: auth.name || 'api_key', value: cred } };
  }

  const { cookieAuth, apiKeyHeader, headerName, fullCookie, cookieName } = classifyAuth(auth, profile);
  const value = cookieAuth ? (fullCookie ? cred : `${cookieName}=${cred}`)
    : apiKeyHeader ? cred
    : `Bearer ${cred}`;
  return { header: { name: headerName, value }, queryAuth: {} };
}

/**
 * Fire one live request and assemble a structured result.
 *
 * @param {object} ctx - CLI context (ctx.specsStore, ctx.spec)
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {object} opts.operation
 * @param {object} opts.profile - derived endpoint profile (for auth/body type)
 * @param {object} [opts.tc]    - optional test case (auth preset + pass/fail)
 * @param {object} [opts.overrides] - { baseUrl, token, body, headers:[{key,val}], pathParams, queryParams }
 */
export async function runLive(ctx, { method, path, operation, profile, tc = null, overrides = {} }) {
  const ss = ctx.specsStore;
  const auth = ss.effectiveAuth();

  const baseUrl = overrides.baseUrl ?? ss.effectiveBaseUrl(ctx.spec);
  const pathParams = { ...ss.effectivePathParams(method, path), ...(overrides.pathParams || {}) };
  const queryParams = { ...(overrides.queryParams || {}) };

  const { header: authHeader, queryAuth } = resolveAuth(auth, profile, tc, overrides.token);
  const url = buildRequestUrl(path, { baseUrl, pathParams, queryParams, auth: queryAuth });

  // Headers: spec defaults + in:header params + auth + custom overrides (last wins).
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
  const effHeaders = ss.effectiveHeaders();
  const headers = { Accept: effHeaders.accept };
  if (hasBody) headers['Content-Type'] = effHeaders.contentType;
  Object.assign(headers, ss.effectiveHeaderParams(method, path, operation));
  if (authHeader) headers[authHeader.name] = authHeader.value;
  for (const { key, val } of overrides.headers || []) if (key) headers[key] = val;

  // Body: explicit override (raw text) or the effective example, for body methods.
  let bodyText = overrides.body;
  if (bodyText == null && hasBody) {
    const example = ss.effectiveRequestBody(method, path, operation, ctx.spec);
    if (example != null) bodyText = JSON.stringify(example);
  }
  const body = buildRequestBody(method, bodyText);

  const request = { method: method.toUpperCase(), url, headers, body: body ?? null };

  let response = null, stream = null, schema = null, error = null, ok = false;
  const start = performance.now();
  try {
    const res = await fetch(url, { method: method.toUpperCase(), headers, body, redirect: 'follow' });
    const elapsed = Math.round(performance.now() - start);
    const rawText = await res.text();
    const contentType = res.headers.get('content-type') || '';

    const bodyType = profile.response_body_type || 'json';
    const dialect = profile.sse_dialect || 'generic';
    const isSse = bodyType === 'sse' || (bodyType === 'json' && isEventStream(contentType, rawText));
    stream = isSse ? parseEventStream(rawText, dialect) : null;

    // Only a JSON body is schema-validatable.
    if (!stream && bodyType === 'json') {
      schema = validateResponse(operation, ctx.spec, String(res.status), rawText);
    }

    response = {
      status: res.status,
      statusText: res.statusText,
      elapsed,
      contentType,
      headers: Object.fromEntries(res.headers.entries()),
      body: rawText,
    };
    ok = true;
  } catch (e) {
    error = e.message || String(e);
  }

  // Pass/fail against the test case's expected status, when running one.
  let testCase = null;
  if (tc) {
    const expected = expectedStatuses(tc.expected_status);
    testCase = {
      id: tc.id,
      purpose: tc.purpose,
      expected,
      passed: ok ? expected.includes(response.status) : false,
    };
  }

  return { request, response, stream, schema, testCase, ok, error };
}
