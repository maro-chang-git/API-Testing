import { buildExampleFromSchema, getRequestBodySchema, getBaseUrl, isCookieAuth } from './request-builder.js';

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

  const folders = buildFolders(testCases, profile, method, hasBody, { validBody, literalBody }, queryParams, pathParamNames);

  // Assemble collection variables, de-duplicating by key. Only the (many) valid
  // body fields are exposed here; failing payloads are hardcoded in their requests.
  const variable = [];
  const seen = new Set();
  const addVar = v => { if (!seen.has(v.key)) { seen.add(v.key); variable.push(v); } };
  addVar({ key: 'baseUrl',       value: baseUrl, type: 'string' });
  addVar({ key: 'token',         value: '',      type: 'string', description: 'Valid bearer token' });
  addVar({ key: 'expired_token', value: '',      type: 'string', description: 'An expired bearer token for auth tests' });
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

const CATEGORY_ORDER = ['happy_path', 'positive', 'negative', 'auth', 'boundary', 'generated'];
const CATEGORY_LABEL = {
  happy_path: 'Happy Path',
  positive:   'Positive',
  negative:   'Negative',
  auth:       'Auth',
  boundary:   'Boundary',
  generated:  'Generated (from response)',
};

function buildFolders(testCases, profile, method, hasBody, bodies, queryParams, pathParamNames) {
  return CATEGORY_ORDER
    .map(cat => {
      const items = testCases
        .filter(tc => tc.category === cat)
        .map(tc => buildItem(tc, profile, method, hasBody, bodies, queryParams, pathParamNames));
      if (!items.length) return null;
      return { name: CATEGORY_LABEL[cat], item: items };
    })
    .filter(Boolean);
}

// ── Request item ──────────────────────────────────────────────────────────────

function buildItem(tc, profile, method, hasBody, bodies, queryParams, pathParamNames) {
  const headers = buildHeaders(tc, profile, hasBody);
  const url     = buildUrl(profile, queryParams, pathParamNames);

  // Success cases use the {{field}} collection variables; failure cases keep a
  // hardcoded literal payload (only a few specific bad values matter per case).
  const is2xx   = tc.expected_status >= 200 && tc.expected_status < 300;
  const rawBody = is2xx ? bodies.validBody : bodies.literalBody;

  const request = {
    method,
    header: headers,
    url,
    ...(hasBody && rawBody ? {
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

// Build the per-case test blocks. EVERY case gets a real script:
//   • status code   (always)
//   • response time (always)
//   • for generated cases: the observed field / shape assertion
//   • for template cases: category / status-aware body assertions
// Each block is an array of lines forming one pm.test(...).
function buildTestBlocks(tc) {
  const status = tc.expected_status;
  const blocks = [
    [
      `pm.test('Status code is ${status}', function () {`,
      `  pm.response.to.have.status(${status});`,
      `});`,
    ],
    [
      `pm.test('Response time is below 3000ms', function () {`,
      `  pm.expect(pm.response.responseTime).to.be.below(3000);`,
      `});`,
    ],
  ];

  if (tc.assertion) {
    const block = assertionBlock(tc.assertion);
    if (block) blocks.push(block);
  } else {
    blocks.push(...templateBlocks(tc, status));
  }
  return blocks;
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

// Category / status-aware assertions for template-generated cases.
function templateBlocks(tc, status) {
  const out = [];
  const is2xx = status >= 200 && status < 300;
  const is4xx = status >= 400 && status < 500;

  if (is2xx) {
    out.push([
      `pm.test('Response body is valid JSON', function () {`,
      `  pm.response.to.have.jsonBody();`,
      `});`,
    ]);
    if (tc.method === 'POST' && status === 201) {
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
  const authHeader = resolveAuthHeader(tc, profile);
  return [
    { key: 'Accept', value: 'application/json' },
    ...(hasBody ? [{ key: 'Content-Type', value: 'application/json' }] : []),
    ...(authHeader ? [authHeader] : []),
  ];
}

function resolveAuthHeader(tc, profile) {
  const cookieAuth = isCookieAuth(profile.auth_type);
  if (tc.category === 'auth') {
    if (tc.auth_status === 'invalid')  return cookieAuth
      ? { key: 'Cookie',        value: 'session=invalid_token_tampered_xyz' }
      : { key: 'Authorization', value: 'Bearer invalid_token_tampered_xyz' };
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
