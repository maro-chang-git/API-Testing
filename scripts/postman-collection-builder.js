import { buildExampleFromSchema } from './request-builder.js';

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
  const baseUrl = `${spec.schemes?.[0] ?? 'https'}://${spec.host}${spec.basePath ?? ''}`;

  const bodyParam   = (operation.parameters ?? []).find(p => p.in === 'body');
  const bodyExample = hasBody && bodyParam?.schema
    ? JSON.stringify(buildExampleFromSchema(bodyParam.schema, spec), null, 2)
    : null;

  const queryParams = (operation.parameters ?? [])
    .filter(p => p.in === 'query')
    .map(p => ({ key: p.name, value: '', description: p.description ?? '', disabled: true }));

  const pathParamNames = [...profile.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

  const folders = buildFolders(testCases, profile, method, hasBody, bodyExample, queryParams, pathParamNames);

  const collection = {
    info: {
      name: `${method} ${profile.path} — ${profile.summary || 'API Tests'}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: folders,
    variable: [
      { key: 'baseUrl',       value: baseUrl, type: 'string' },
      { key: 'token',         value: '',      type: 'string', description: 'Valid bearer token' },
      { key: 'expired_token', value: '',      type: 'string', description: 'An expired bearer token for auth tests' },
      ...pathParamNames.map(n => ({ key: n, value: '', type: 'string' })),
    ],
  };

  download(collection, method, profile.path);
}

// ── Folders ───────────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ['happy_path', 'positive', 'negative', 'auth', 'boundary'];
const CATEGORY_LABEL = {
  happy_path: 'Happy Path',
  positive:   'Positive',
  negative:   'Negative',
  auth:       'Auth',
  boundary:   'Boundary',
};

function buildFolders(testCases, profile, method, hasBody, bodyExample, queryParams, pathParamNames) {
  return CATEGORY_ORDER
    .map(cat => {
      const items = testCases
        .filter(tc => tc.category === cat)
        .map(tc => buildItem(tc, profile, method, hasBody, bodyExample, queryParams, pathParamNames));
      if (!items.length) return null;
      return { name: CATEGORY_LABEL[cat], item: items };
    })
    .filter(Boolean);
}

// ── Request item ──────────────────────────────────────────────────────────────

function buildItem(tc, profile, method, hasBody, bodyExample, queryParams, pathParamNames) {
  const headers = buildHeaders(tc, profile, hasBody);
  const url     = buildUrl(profile, queryParams, pathParamNames);
  const request = {
    method,
    header: headers,
    url,
    ...(hasBody && bodyExample ? {
      body: { mode: 'raw', raw: bodyExample, options: { raw: { language: 'json' } } },
    } : {}),
  };

  return {
    name: `${tc.id} — ${tc.purpose}`,
    request,
    event: [{
      listen: 'test',
      script: {
        exec: [
          `pm.test('Status code is ${tc.expected_status}', function () {`,
          `  pm.response.to.have.status(${tc.expected_status});`,
          `});`,
        ],
        type: 'text/javascript',
      },
    }],
  };
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
  if (tc.category === 'auth') {
    if (tc.auth_status === 'invalid')  return { key: 'Authorization', value: 'Bearer invalid_token_tampered_xyz' };
    if (tc.auth_status === 'expired')  return { key: 'Authorization', value: 'Bearer {{expired_token}}' };
    return null; // missing → no header
  }
  if (profile.auth_required) return { key: 'Authorization', value: 'Bearer {{token}}' };
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
