import { buildExampleFromSchema, getRequestBodySchema, getBaseUrl, isCookieAuth } from './request-builder.js';
import { CATEGORY_ORDER } from './postman-collection-builder.js';
import { getConfig } from './config-loader.js';

const CATEGORY_LABEL = {
  happy_path: 'Happy Path',
  positive:   'Positive',
  negative:   'Negative',
  auth:       'Auth',
  boundary:   'Boundary',
  generated:  'Generated (from response)',
};

/**
 * Builds a Karate .feature file from the current endpoint state
 * and triggers a file download.
 *
 * @param {object} profile   - endpoint profile from template-matcher
 * @param {object} operation - swagger operation object
 * @param {object} spec      - full swagger spec
 * @param {Array}  testCases - matched test cases
 */
export function exportKarate(profile, operation, spec, testCases) {
  const method     = profile.method;
  const hasBody    = ['POST', 'PUT', 'PATCH'].includes(method);
  const baseUrl    = getBaseUrl(spec);
  const cookieAuth = isCookieAuth(profile.auth_type);

  const bodySchema  = getRequestBodySchema(operation);
  const exampleObj  = hasBody && bodySchema ? buildExampleFromSchema(bodySchema, spec) : null;
  const literalBody = exampleObj ? JSON.stringify(exampleObj, null, 2) : null;

  const pathParamNames = [...profile.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

  const lines = [];

  lines.push(`Feature: ${method} ${profile.path} — ${profile.summary || 'API Tests'}`);
  lines.push('');
  lines.push('  Background:');
  lines.push(`    * url '${baseUrl}'`);

  const cfg = getConfig();
  if (profile.auth_required) {
    if (cookieAuth) {
      lines.push(`    * def sessionToken   = '${cfg.auth.token        || '<replace-with-valid-session-token>'}'`);
      lines.push(`    * def expiredSession = '${cfg.auth.expiredToken  || '<replace-with-expired-session-token>'}'`);
    } else {
      lines.push(`    * def token        = '${cfg.auth.token        || '<replace-with-valid-bearer-token>'}'`);
      lines.push(`    * def expiredToken = '${cfg.auth.expiredToken  || '<replace-with-expired-bearer-token>'}'`);
    }
  }
  pathParamNames.forEach(n => {
    const val = cfg.pathParams[n] || `<replace-with-${n}>`;
    lines.push(`    * def ${n} = '${val}'`);
  });
  lines.push('');

  CATEGORY_ORDER.forEach(cat => {
    const cases = testCases
      .filter(tc => tc.category === cat)
      .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    if (!cases.length) return;

    const label = CATEGORY_LABEL[cat] ?? cat;
    lines.push(`  # ── ${label} ${'─'.repeat(Math.max(0, 68 - label.length))}`);
    lines.push('');
    cases.forEach(tc => {
      buildScenario(tc, profile, method, hasBody, literalBody, cookieAuth, lines);
      lines.push('');
    });
  });

  download(lines.join('\n'), method, profile.path);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

function buildScenario(tc, profile, method, hasBody, literalBody, cookieAuth, lines) {
  const reqMethod  = tc.disallowed_method ?? method;
  const reqHasBody = tc.disallowed_method ? ['POST', 'PUT', 'PATCH'].includes(reqMethod) : hasBody;

  lines.push(`  @${tc.category}`);
  lines.push(`  Scenario: ${tc.id} — ${tc.purpose}`);
  lines.push(`    Given path ${buildKaratePath(profile.path)}`);
  const cfg = getConfig();
  lines.push(`    And header Accept = '${cfg.headers.accept}'`);
  if (reqHasBody) lines.push(`    And header Content-Type = '${cfg.headers.contentType}'`);

  const authLine = resolveAuthLine(tc, profile, cookieAuth);
  if (authLine) lines.push(`    ${authLine}`);

  if (reqHasBody && literalBody) {
    lines.push(`    And request`);
    lines.push(`    """`);
    literalBody.split('\n').forEach(l => lines.push(`    ${l}`));
    lines.push(`    """`);
  }

  lines.push(`    When method ${reqMethod.toLowerCase()}`);
  lines.push(`    Then status ${tc.expected_status}`);
  lines.push(`    * assert responseTime < ${getConfig().responseTimeThresholdMs}`);

  buildKarateAssertions(tc, method, lines);
}

// Build the path expression for Karate's `Given path` step.
// Each path segment becomes either a quoted string literal or a variable reference.
// e.g. /pets/{petId} → 'pets', petId
function buildKaratePath(path) {
  const segments = path.replace(/^\//, '').split('/').map(seg => {
    const m = /^\{([^}]+)\}$/.exec(seg);
    return m ? m[1] : `'${seg}'`;
  });
  return segments.join(', ');
}

function resolveAuthLine(tc, profile, cookieAuth) {
  const invalid = getConfig().auth.invalidTokenValue;
  if (tc.category === 'auth') {
    if (tc.auth_status === 'invalid') return cookieAuth
      ? `And header Cookie = 'session=${invalid}'`
      : `And header Authorization = 'Bearer ${invalid}'`;
    if (tc.auth_status === 'expired') return cookieAuth
      ? `And header Cookie = 'session=' + expiredSession`
      : `And header Authorization = 'Bearer ' + expiredToken`;
    return null; // missing auth → no header
  }
  if (profile.auth_required) return cookieAuth
    ? `And header Cookie = 'session=' + sessionToken`
    : `And header Authorization = 'Bearer ' + token`;
  return null;
}

// ── Assertions ─────────────────────────────────────────────────────────────────

function buildKarateAssertions(tc, method, lines) {
  const status = tc.expected_status;
  const is2xx  = status >= 200 && status < 300;
  const is4xx  = status >= 400 && status < 500;

  if (tc.assertion) {
    const line = karateAssertLine(tc.assertion);
    if (line) lines.push(`    ${line}`);
    return;
  }

  if (is2xx) {
    lines.push(`    * match response == '#object'`);
    if (method === 'POST' && status === 201) {
      lines.push(`    * match response.id == '#notnull'`);
    }
  } else if (is4xx) {
    lines.push(`    * match response == '#object'`);
    lines.push(`    * assert response.message != null || response.error != null || response.detail != null`);
  }
}

function karateAssertLine(a) {
  if (a.kind === 'array-root') return `* match response == '#array'`;
  if (a.kind === 'field'      && isSimpleKey(a.path)) return `* match response.${a.path} == '#notnull'`;
  if (a.kind === 'count'      && isSimpleKey(a.path)) return `* match response.${a.path} == '#array'`;
  if (a.kind === 'item-field') {
    const collKey = parseCollectionKey(a.collection);
    if (collKey && isSimpleKey(a.path)) return `* match response.${collKey}[0].${a.path} == '#notnull'`;
  }
  return null;
}

function isSimpleKey(k) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k); }

function parseCollectionKey(base) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[0\]$/.exec(base || '');
  return m ? m[1] : null;
}

// ── Download ──────────────────────────────────────────────────────────────────

function download(content, method, path) {
  const slug     = path.replace(/^\//, '').replace(/\//g, '-').replace(/[{}]/g, '').replace(/-+/g, '-');
  const filename = `karate-${method.toLowerCase()}-${slug}.feature`;
  const blob     = new Blob([content], { type: 'text/plain' });
  const url      = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}
