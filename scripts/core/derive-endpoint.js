// Pure endpoint → test-cases derivation, shared by the browser app (app.js) and
// the CLI. This is the DOM-free heart of app.js#deriveAndRenderEndpoint: it
// profiles the operation, layers the persisted per-endpoint overrides
// (auth-required, request type, response body type, SSE dialect) on top, matches
// the template library, and expands the 405 case into one per disallowed method.
//
// Keeping it in one place means the table, the exports and the CLI all see the
// exact same matched cases for a given endpoint + specs state.

import { profileEndpoint, matchTemplates } from './template-matcher.js';
import { expandMethodNotAllowed } from './case-expander.js';
import { detectResponseBodyType, sniffSseDialect } from './response-body-types.js';
import { responseSchema } from '../tryit/schema-validator.js';

// The endpoint's 2xx response media types (for response-body-type auto-detection).
function responseContentTypes(operation) {
  const responses = operation?.responses ?? {};
  const out = [];
  for (const [code, resp] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(code)) continue;
    if (resp?.content) out.push(...Object.keys(resp.content));
  }
  return out;
}

function twoxxResponse(operation) {
  const responses = operation?.responses ?? {};
  const code = Object.keys(responses).find((c) => /^2\d\d$/.test(c));
  return code ? responses[code] : null;
}

// Best-effort SSE dialect from the effective host / header names / 2xx schema shape.
function sniffDialect(method, path, operation, spec, specsStore) {
  let host = '';
  try { host = new URL(specsStore.effectiveBaseUrl(spec)).host; } catch { /* relative/blank base */ }
  const headerNames = Object.keys(specsStore.effectiveHeaderParams(method, path, operation) ?? {});
  const schema = responseSchema(twoxxResponse(operation) ?? {});
  const schemaHasChoices = !!schema?.properties?.choices;
  return sniffSseDialect({ host, headerNames, schemaHasChoices });
}

/**
 * Profiles an endpoint with the persisted overrides applied, matches templates,
 * and expands the 405 case. Returns { profile, cases }.
 *
 * @param {string} method
 * @param {string} path
 * @param {object} operation  - the swagger operation object
 * @param {object} spec       - the full (dereferenced) swagger spec
 * @param {object} specsStore - the specs-store module (effective* resolvers)
 * @param {Array}  templates  - the template library (data/templates.json)
 */
export function deriveEndpointCases(method, path, operation, spec, specsStore, templates) {
  const profile = profileEndpoint(path, method, operation, spec);

  // Honor a per-endpoint auth-required override from specs.json (set by Try It
  // auth discovery or hand-edited) — the spec often marks auth as optional when
  // the endpoint really enforces it.
  profile.auth_required = specsStore.effectiveAuthRequired(method, path, profile.auth_required);

  // Request type is a manual, per-endpoint selection (no spec auto-detection); it
  // gates which templates match and drives the request-side handler seam.
  const requestType = specsStore.effectiveRequestType(method, path);
  profile.request_type = requestType;

  // Response body type drives the 2xx success assertions (exporters + Try It).
  // Auto-detected from the spec's 2xx content type (with a request-type hint),
  // overridable per endpoint in specs.json.
  const autoBodyType = detectResponseBodyType(responseContentTypes(operation), requestType);
  const bodyType = specsStore.effectiveResponseBodyType(method, path, autoBodyType);
  profile.response_body_type = bodyType;
  profile.sse_dialect = bodyType === 'sse'
    ? specsStore.effectiveSseDialect(method, path, sniffDialect(method, path, operation, spec, specsStore))
    : null;

  let cases = matchTemplates(profile, templates);

  // Expand TPL-NEG-009 into one case per disallowed method (every standard HTTP
  // method not defined on this path in the spec) so each unsupported method is
  // exercised. Each gets a method-suffixed id so its result persists independently.
  const allowedOnPath = Object.keys(spec.paths?.[path] ?? {});
  cases = expandMethodNotAllowed(cases, allowedOnPath);

  return { profile, cases };
}
