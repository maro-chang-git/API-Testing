import { isCookieAuth } from '../tryit/request-core.js';
import { getConfig } from '../core/config-loader.js';
import { effectiveBaseUrl, effectiveAuth, effectiveHeaders, effectivePathParams, effectiveRequestBody, saveOrDownload } from '../specs-store.js';
import { getTestBody, BODY_KIND } from './body-builder.js';
import { expectedStatuses } from '../core/template-matcher.js';
import { CATEGORY_ORDER, CATEGORY_LABEL } from '../core/case-order.js';
import { is2xx, is4xx } from '../core/status-utils.js';
import { normalizeAssertion, pathParamNames, methodHasBody, filenameSlug } from './export-shared.js';

/**
 * Builds a Postman Collection v2.1 object from the current endpoint state
 * and triggers a file download.
 *
 * @param {object} profile   - endpoint profile from template-matcher
 * @param {object} operation - swagger operation object
 * @param {object} spec      - full swagger spec
 * @param {Array}  testCases - matched test cases
 */
export async function exportPostman(profile, operation, spec, testCases, swaggerId) {
  const method  = profile.method;
  const hasBody = methodHasBody(method);
  const baseUrl = effectiveBaseUrl(spec);

  // Valid-body example: the specs request body (user-edited) or the schema example.
  const exampleObj  = hasBody
    ? effectiveRequestBody(method, profile.path, operation, spec)
    : null;

  // Body renderings:
  //   • validBody   — top-level fields replaced by {{collection variables}}; used by
  //     cases expected to SUCCEED (2xx). These are many, so centralising them as
  //     collection variables lets the user update valid data in one place.
  //   • literalBody — the raw example with hardcoded values; used by cases expected
  //     to FAIL (negative / auth / SQL-injection). Only a few specific bad values
  //     matter per case, so they live inline in the request, not as collection vars.
  const { validBody, literalBody, validVars } = buildBodies(exampleObj);

  const queryParams = (operation.parameters ?? [])
    .filter(p => p.in === 'query')
    .map(p => ({ key: p.name, value: '', description: p.description ?? '', disabled: true }));

  // Spec `in: header` params (e.g. anthropic-version) — sent on every request,
  // seeded from each param's schema default/example.
  const headerParams = (operation.parameters ?? [])
    .filter(p => p.in === 'header')
    .map(p => ({ key: p.name, value: String(p.schema?.default ?? p.schema?.example ?? '') }));

  const pathParams = pathParamNames(profile.path);

  const folders = buildFolders(testCases, profile, method, hasBody, { validBody, literalBody }, queryParams, headerParams, pathParams, exampleObj);

  // Assemble collection variables, de-duplicating by key. Only the (many) valid
  // body fields are exposed here; failing payloads are hardcoded in their requests.
  const variable = [];
  const seen = new Set();
  const addVar = v => { if (!seen.has(v.key)) { seen.add(v.key); variable.push(v); } };
  const auth = effectiveAuth();
  const pathParamDefaults = effectivePathParams(method, profile.path);
  addVar({ key: 'baseUrl',       value: baseUrl,             type: 'string' });
  addVar({ key: 'token',         value: auth.token,          type: 'string', description: 'Valid auth token (Bearer / apiKey / cookie value)' });
  addVar({ key: 'expired_token', value: auth.expiredToken,   type: 'string', description: 'An expired token for auth tests' });
  pathParams.forEach(n => addVar({ key: n, value: pathParamDefaults[n] || '', type: 'string' }));
  validVars.forEach(addVar);

  const collection = {
    info: {
      name: `${method} ${profile.path} — ${profile.summary || 'API Tests'}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: folders,
    variable,
  };

  return download(collection, method, profile.path, swaggerId);
}

// Render a body example two ways: a variabilised valid body ({{field}} collection
// variables) for success cases, and the raw literal example for failing cases
// (hardcoded inline, not exposed as collection variables).
// Only a plain object's top-level fields are variabilised; arrays / scalars /
// nested values are kept inline (nested objects become a JSON-valued variable).
function buildBodies(exampleObj) {
  if (exampleObj == null) return { validBody: null, literalBody: null, validVars: [] };

  const literalBody = JSON.stringify(exampleObj, null, 2);
  if (typeof exampleObj !== 'object' || Array.isArray(exampleObj)) {
    return { validBody: literalBody, literalBody, validVars: [] };
  }

  const validVars = [];
  const entries = Object.entries(exampleObj);
  const lines = entries.map(([key, val], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    const isStr = typeof val === 'string';
    const def = val === null      ? 'null'
      : typeof val === 'object'   ? JSON.stringify(val)
      : isStr                     ? val
      :                             String(val);
    validVars.push({ key, value: def, type: 'string', description: `Request body field: ${key}` });
    // Strings are quoted in the JSON; numbers/booleans/objects substitute raw.
    const ref = isStr ? `"{{${key}}}"` : `{{${key}}}`;
    return `  ${JSON.stringify(key)}: ${ref}${comma}`;
  });

  return { validBody: `{\n${lines.join('\n')}\n}`, literalBody, validVars };
}

// ── Folders ───────────────────────────────────────────────────────────────────

// Category order + labels are single-sourced in core/case-order.js so the table,
// JSON export and both exporters stay in sync.

function buildFolders(testCases, profile, method, hasBody, bodies, queryParams, headerParams, pathParams, exampleObj) {
  return CATEGORY_ORDER
    .map(cat => {
      const items = testCases
        .filter(tc => tc.category === cat)
        .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
        .map(tc => buildItem(tc, profile, method, hasBody, bodies, queryParams, headerParams, pathParams, exampleObj));
      if (!items.length) return null;
      return { name: CATEGORY_LABEL[cat], item: items };
    })
    .filter(Boolean);
}

// ── Request item ──────────────────────────────────────────────────────────────

function buildItem(tc, profile, method, hasBody, bodies, queryParams, headerParams, pathParams, exampleObj) {
  // 405 cases send a disallowed method; all other cases use the endpoint's method.
  const reqMethod  = tc.disallowed_method ?? method;
  const reqHasBody = tc.disallowed_method ? methodHasBody(reqMethod) : hasBody;

  const headers = buildHeaders(tc, profile, reqHasBody, headerParams);
  const url     = buildUrl(profile, queryParams, pathParams);

  const rawBody = selectRawBody(tc, bodies.validBody, exampleObj);

  const request = {
    method: reqMethod,
    header: headers,
    url,
    ...(reqHasBody && rawBody ? {
      body: { mode: 'raw', raw: rawBody, options: { raw: { language: 'json' } } },
    } : {}),
  };

  return {
    name: `${tc.id} — ${tc.purpose}`,
    request,
    event: [{
      listen: 'test',
      script: { exec: buildTestExec(tc), type: 'text/javascript' },
    }],
  };
}

// Converts a body descriptor from body-builder.js into a raw string for Postman.
function selectRawBody(tc, validBody, exampleObj) {
  const { kind, data } = getTestBody(tc, exampleObj);
  switch (kind) {
    case BODY_KIND.EMPTY:    return '{}';
    case BODY_KIND.OBJECT:   return JSON.stringify(data, null, 2);
    case BODY_KIND.MALFORMED: return data;
    default:                 return validBody;
  }
}

// Build the per-case test blocks. EVERY case gets a real script:
//   • status code   (always)
//   • response time (always)
//   • for generated cases: the observed field / shape assertion
//   • for template cases: category / status-aware body assertions
// Each block is an array of lines forming one pm.test(...).
function buildTestBlocks(tc) {
  const statuses = expectedStatuses(tc.expected_status);
  const blocks = [
    statusBlock(statuses),
    [
      `pm.test('Response time is below ${getConfig().responseTimeThresholdMs}ms', function () {`,
      `  pm.expect(pm.response.responseTime).to.be.below(${getConfig().responseTimeThresholdMs});`,
      `});`,
    ],
  ];

  if (tc.assertion) {
    const block = assertionBlock(tc.assertion);
    if (block) blocks.push(block);
  } else {
    blocks.push(...templateBlocks(tc, statuses));
  }

  // Folded-in assertions derived from an observed response body ride along as
  // extra checks on their host case (e.g. a 200 body's field/shape assertions
  // on the happy-path GET case).
  for (const a of tc.generatedAssertions ?? []) {
    const block = assertionBlock(a);
    if (block) blocks.push(block);
  }
  return blocks;
}

// Status assertion: a single status uses pm.response.to.have.status(); a case
// that accepts several uses chai's oneOf against the actual response code.
function statusBlock(statuses) {
  if (statuses.length === 1) {
    return [
      `pm.test('Status code is ${statuses[0]}', function () {`,
      `  pm.response.to.have.status(${statuses[0]});`,
      `});`,
    ];
  }
  return [
    `pm.test('Status code is one of ${statuses.join(', ')}', function () {`,
    `  pm.expect(pm.response.code).to.be.oneOf([${statuses.join(', ')}]);`,
    `});`,
  ];
}

// Flatten the blocks into a Postman exec array (blank line between blocks).
function buildTestExec(tc) {
  return buildTestBlocks(tc).flatMap((b, i) => (i === 0 ? b : ['', ...b]));
}

// Structured view of the same scripts, for display in the UI.
// Returns [{ name, code }] — one entry per pm.test block.
export function getTestScripts(tc) {
  return buildTestBlocks(tc).map(block => {
    const m = block[0].match(/pm\.test\('([^']*)'/);
    return { name: m ? m[1] : 'test', code: block.join('\n') };
  });
}

// Category / status-aware assertions for template-generated cases. The body
// shape is keyed off the primary (first) status; the POST-created check fires
// when 201 is among the accepted statuses.
function templateBlocks(tc, statuses) {
  const out = [];
  const primary = statuses[0];

  if (is2xx(primary)) {
    out.push([
      `pm.test('Response body is valid JSON', function () {`,
      `  pm.response.to.have.jsonBody();`,
      `});`,
    ]);
    if (tc.method === 'POST' && statuses.includes(201)) {
      out.push([
        `pm.test('Created resource is returned with an id', function () {`,
        `  var json = pm.response.json();`,
        `  pm.expect(json).to.be.an('object');`,
        `  pm.expect(json).to.have.property('id');`,
        `});`,
      ]);
    }
  } else if (is4xx(primary)) {
    out.push([
      `pm.test('Error response is valid JSON', function () {`,
      `  pm.response.to.have.jsonBody();`,
      `});`,
    ]);
    out.push([
      `pm.test('Error response includes a message', function () {`,
      `  var json = pm.response.json();`,
      `  pm.expect(json).to.satisfy(function (b) {`,
      `    return !!(b && (b.message || b.error || b.error_description || b.detail || b.errors));`,
      `  });`,
      `});`,
    ]);
  }
  return out;
}

// Assertion block for a generated case's observed shape. Returns lines or null.
function assertionBlock(a) {
  const n = normalizeAssertion(a);
  if (!n) return null;
  const J = '  var json = pm.response.json();';

  switch (n.kind) {
    case 'array-root':
      return [
        `pm.test('Response is an array', function () {`,
        J,
        `  pm.expect(json).to.be.an('array');`,
        `});`,
      ];
    case 'field':
      return [
        `pm.test('Body has field "${n.path}" (${n.jsType})', function () {`,
        J,
        `  pm.expect(json).to.have.property('${n.path}');`,
        ...(n.jsType && n.jsType !== 'null' ? [`  pm.expect(json['${n.path}']).to.be.a('${n.jsType}');`] : []),
        `});`,
      ];
    case 'count':
      return [
        `pm.test('Collection "${n.path}" is an array', function () {`,
        J,
        `  pm.expect(json['${n.path}']).to.be.an('array');`,
        `});`,
      ];
    case 'item-field':
      return [
        `pm.test('Items in "${n.collKey}" have field "${n.path}"', function () {`,
        J,
        `  pm.expect(json['${n.collKey}'][0]).to.have.property('${n.path}');`,
        `});`,
      ];
    default:
      return null;
  }
}

function buildHeaders(tc, profile, hasBody, headerParams = []) {
  const headers = effectiveHeaders();
  const authHeader = resolveAuthHeader(tc, profile);
  return [
    { key: 'Accept', value: headers.accept },
    ...(hasBody ? [{ key: 'Content-Type', value: headers.contentType }] : []),
    ...headerParams,
    ...(authHeader ? [authHeader] : []),
  ];
}

function resolveAuthHeader(tc, profile) {
  const auth         = effectiveAuth();
  const cookieAuth   = isCookieAuth(profile.auth_type);
  const apiKeyHeader = auth.kind === 'apiKey' && auth.in === 'header';
  const invalid      = auth.invalidTokenValue;

  // Header key + value-wrapper for the active auth style: a cookie, a raw apiKey
  // header (e.g. x-api-key — no Bearer prefix), or a Bearer Authorization header.
  const key  = cookieAuth ? 'Cookie' : apiKeyHeader ? (auth.name || 'X-API-Key') : 'Authorization';
  const wrap = cookieAuth ? v => `session=${v}` : apiKeyHeader ? v => `${v}` : v => `Bearer ${v}`;

  if (tc.category === 'auth') {
    if (tc.auth_status === 'invalid')  return { key, value: wrap(invalid) };
    if (tc.auth_status === 'expired')  return { key, value: wrap('{{expired_token}}') };
    return null; // missing → no header
  }
  if (profile.auth_required) return { key, value: wrap('{{token}}') };
  return null;
}

function buildUrl(profile, queryParams, pathParams) {
  const rawPath = profile.path.replace(/\{([^}]+)\}/g, '{{$1}}');
  return {
    raw:  `{{baseUrl}}${rawPath}`,
    host: ['{{baseUrl}}'],
    path: rawPath.replace(/^\//, '').split('/'),
    ...(queryParams.length ? { query:    queryParams } : {}),
    ...(pathParams.length  ? { variable: pathParams.map(n => ({ key: n, value: `{{${n}}}` })) } : {}),
  };
}

// ── Download ──────────────────────────────────────────────────────────────────

// Writes the collection to output/{id}/postman/ via the dev-server save
// endpoint, falling back to a browser download when it isn't running.
function download(collection, method, path, swaggerId) {
  const filename = `postman-${method.toLowerCase()}-${filenameSlug(path)}.json`;
  const content  = JSON.stringify(collection, null, 2);
  return saveOrDownload(`output/${swaggerId}/postman/${filename}`, filename, content, 'application/json');
}
