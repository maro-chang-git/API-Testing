import { buildExampleFromSchema, getRequestBodySchema, getBaseUrl, isCookieAuth } from './request-builder.js';
import { getConfig } from './config-loader.js';
import { getTestBody, BODY_KIND } from './body-builder.js';
import { expectedStatuses } from './template-matcher.js';

/**
 * Builds a Postman Collection v2.1 object from the current endpoint state
 * and triggers a file download.
 *
 * @param {object} profile   - endpoint profile from template-matcher
 * @param {object} operation - swagger operation object
 * @param {object} spec      - full swagger spec
 * @param {Array}  testCases - matched test cases
 */
export function exportPostman(profile, operation, spec, testCases) {
  const method  = profile.method;
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const baseUrl = getBaseUrl(spec);

  const bodySchema  = getRequestBodySchema(operation);
  const exampleObj  = hasBody && bodySchema
    ? buildExampleFromSchema(bodySchema, spec)
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

  const pathParamNames = [...profile.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

  const folders = buildFolders(testCases, profile, method, hasBody, { validBody, literalBody }, queryParams, pathParamNames, exampleObj);

  // Assemble collection variables, de-duplicating by key. Only the (many) valid
  // body fields are exposed here; failing payloads are hardcoded in their requests.
  const variable = [];
  const seen = new Set();
  const addVar = v => { if (!seen.has(v.key)) { seen.add(v.key); variable.push(v); } };
  const cfg = getConfig();
  addVar({ key: 'baseUrl',       value: baseUrl,              type: 'string' });
  addVar({ key: 'token',         value: cfg.auth.token,        type: 'string', description: 'Valid bearer token' });
  addVar({ key: 'expired_token', value: cfg.auth.expiredToken, type: 'string', description: 'An expired bearer token for auth tests' });
  pathParamNames.forEach(n => addVar({ key: n, value: '', type: 'string' }));
  validVars.forEach(addVar);

  const collection = {
    info: {
      name: `${method} ${profile.path} — ${profile.summary || 'API Tests'}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: folders,
    variable,
  };

  download(collection, method, profile.path);
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

// Fixed category priority used for ordering test cases everywhere (table + JSON
// export + these Postman folders): happy_path → positive → negative → auth →
// boundary → generated.
export const CATEGORY_ORDER = ['happy_path', 'positive', 'negative', 'auth', 'boundary', 'generated'];
const CATEGORY_LABEL = {
  happy_path: 'Happy Path',
  positive:   'Positive',
  negative:   'Negative',
  auth:       'Auth',
  boundary:   'Boundary',
  generated:  'Generated (from response)',
};

function buildFolders(testCases, profile, method, hasBody, bodies, queryParams, pathParamNames, exampleObj) {
  return CATEGORY_ORDER
    .map(cat => {
      const items = testCases
        .filter(tc => tc.category === cat)
        .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
        .map(tc => buildItem(tc, profile, method, hasBody, bodies, queryParams, pathParamNames, exampleObj));
      if (!items.length) return null;
      return { name: CATEGORY_LABEL[cat], item: items };
    })
    .filter(Boolean);
}

// ── Request item ──────────────────────────────────────────────────────────────

function buildItem(tc, profile, method, hasBody, bodies, queryParams, pathParamNames, exampleObj) {
  // 405 cases send a disallowed method; all other cases use the endpoint's method.
  const reqMethod  = tc.disallowed_method ?? method;
  const reqHasBody = tc.disallowed_method ? ['POST', 'PUT', 'PATCH'].includes(reqMethod) : hasBody;

  const headers = buildHeaders(tc, profile, reqHasBody);
  const url     = buildUrl(profile, queryParams, pathParamNames);

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
  const is2xx = primary >= 200 && primary < 300;
  const is4xx = primary >= 400 && primary < 500;

  if (is2xx) {
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
  } else if (is4xx) {
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
  const J = '  var json = pm.response.json();';

  if (a.kind === 'array-root') {
    return [
      `pm.test('Response is an array', function () {`,
      J,
      `  pm.expect(json).to.be.an('array');`,
      `});`,
    ];
  }
  if (a.kind === 'field' && isSimpleKey(a.path)) {
    return [
      `pm.test('Body has field "${a.path}" (${a.jsType})', function () {`,
      J,
      `  pm.expect(json).to.have.property('${a.path}');`,
      ...(a.jsType && a.jsType !== 'null' ? [`  pm.expect(json['${a.path}']).to.be.a('${a.jsType}');`] : []),
      `});`,
    ];
  }
  if (a.kind === 'count' && isSimpleKey(a.path)) {
    return [
      `pm.test('Collection "${a.path}" is an array', function () {`,
      J,
      `  pm.expect(json['${a.path}']).to.be.an('array');`,
      `});`,
    ];
  }
  if (a.kind === 'item-field') {
    const collKey = parseCollectionKey(a.collection);
    if (collKey && isSimpleKey(a.path)) {
      return [
        `pm.test('Items in "${collKey}" have field "${a.path}"', function () {`,
        J,
        `  pm.expect(json['${collKey}'][0]).to.have.property('${a.path}');`,
        `});`,
      ];
    }
  }
  return null;
}

function isSimpleKey(k) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k); }

function parseCollectionKey(base) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[0\]$/.exec(base || '');
  return m ? m[1] : null;
}

function buildHeaders(tc, profile, hasBody) {
  const cfg = getConfig();
  const authHeader = resolveAuthHeader(tc, profile);
  return [
    { key: 'Accept', value: cfg.headers.accept },
    ...(hasBody ? [{ key: 'Content-Type', value: cfg.headers.contentType }] : []),
    ...(authHeader ? [authHeader] : []),
  ];
}

function resolveAuthHeader(tc, profile) {
  const cookieAuth = isCookieAuth(profile.auth_type);
  const invalid = getConfig().auth.invalidTokenValue;
  if (tc.category === 'auth') {
    if (tc.auth_status === 'invalid')  return cookieAuth
      ? { key: 'Cookie',        value: `session=${invalid}` }
      : { key: 'Authorization', value: `Bearer ${invalid}` };
    if (tc.auth_status === 'expired')  return cookieAuth
      ? { key: 'Cookie',        value: 'session={{expired_token}}' }
      : { key: 'Authorization', value: 'Bearer {{expired_token}}' };
    return null; // missing → no header
  }
  if (profile.auth_required) return cookieAuth
    ? { key: 'Cookie',        value: 'session={{token}}' }
    : { key: 'Authorization', value: 'Bearer {{token}}' };
  return null;
}

function buildUrl(profile, queryParams, pathParamNames) {
  const rawPath = profile.path.replace(/\{([^}]+)\}/g, '{{$1}}');
  return {
    raw:  `{{baseUrl}}${rawPath}`,
    host: ['{{baseUrl}}'],
    path: rawPath.replace(/^\//, '').split('/'),
    ...(queryParams.length    ? { query:    queryParams } : {}),
    ...(pathParamNames.length ? { variable: pathParamNames.map(n => ({ key: n, value: `{{${n}}}` })) } : {}),
  };
}

// ── Download ──────────────────────────────────────────────────────────────────

function download(collection, method, path) {
  const slug = path.replace(/^\//, '').replace(/\//g, '-').replace(/[{}]/g, '').replace(/-+/g, '-');
  const filename = `postman-${method.toLowerCase()}-${slug}.json`;
  const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}
