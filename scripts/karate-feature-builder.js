import { buildExampleFromSchema, getRequestBodySchema, getBaseUrl, isCookieAuth } from './request-builder.js';
import { CATEGORY_ORDER } from './postman-collection-builder.js';
import { getConfig } from './config-loader.js';
import { getTestBody, BODY_KIND } from './body-builder.js';
import { expectedStatuses } from './template-matcher.js';

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

  const bodySchema = getRequestBodySchema(operation);
  const exampleObj = hasBody && bodySchema ? buildExampleFromSchema(bodySchema, spec) : null;
  const { bodyVars, validBodyExpr } = buildBodyVars(exampleObj);

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

  if (bodyVars.length) {
    lines.push('');
    bodyVars.forEach(({ key, value }) => lines.push(`    * def ${key} = ${karateValueLiteral(value)}`));
    lines.push(`    * def validBody = ${validBodyExpr}`);
  }
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
      buildScenario(tc, profile, method, hasBody, validBodyExpr, exampleObj, cookieAuth, lines);
      lines.push('');
    });
  });

  download(lines.join('\n'), method, profile.path);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

function buildScenario(tc, profile, method, hasBody, validBodyExpr, exampleObj, cookieAuth, lines) {
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

  if (reqHasBody) buildKarateBodyLines(tc, validBodyExpr, exampleObj).forEach(l => lines.push(l));

  lines.push(`    When method ${reqMethod.toLowerCase()}`);
  // Karate's `status` step takes a single code; when a case accepts several,
  // assert the built-in responseStatus is one of them instead.
  const statuses = expectedStatuses(tc.expected_status);
  if (statuses.length === 1) {
    lines.push(`    Then status ${statuses[0]}`);
  } else {
    lines.push(`    Then assert ${statuses.map(s => `responseStatus == ${s}`).join(' || ')}`);
  }
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
  const statuses = expectedStatuses(tc.expected_status);
  const primary  = statuses[0];
  const is2xx    = primary >= 200 && primary < 300;
  const is4xx    = primary >= 400 && primary < 500;

  if (tc.assertion) {
    const line = karateAssertLine(tc.assertion);
    if (line) lines.push(`    ${line}`);
    return;
  }

  if (is2xx) {
    lines.push(`    * match response == '#object'`);
    if (method === 'POST' && statuses.includes(201)) {
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

// ── Per-scenario request body ─────────────────────────────────────────────────

// Converts a body descriptor from body-builder.js into Karate step lines.
// OBJECT bodies with very long string values use a JS expression variable
// (e.g. `('a'.repeat(1001))`) to avoid embedding thousands of characters inline.
function buildKarateBodyLines(tc, validBodyExpr, exampleObj) {
  if (!validBodyExpr) return [];

  const { kind, data } = getTestBody(tc, exampleObj);

  switch (kind) {
    case BODY_KIND.EMPTY:
      return [`    And request {}`];

    case BODY_KIND.MALFORMED:
      return [`    And request '${data}'`];

    case BODY_KIND.OBJECT: {
      const entries    = Object.entries(data);
      const strEntries = entries.filter(([, v]) => typeof v === 'string');
      const maxStrLen  = strEntries.length
        ? Math.max(...strEntries.map(([, v]) => v.length))
        : 0;

      // Avoid inlining very long strings — express them via a JS variable instead.
      if (maxStrLen > 200) {
        const strParts    = strEntries.map(([k]) => `${k}: longStr`);
        const nonStrParts = entries
          .filter(([, v]) => typeof v !== 'string')
          .map(([k, v]) => `${k}: ${karateValueLiteral(v)}`);
        return [
          `    * def longStr = ('a'.repeat(${maxStrLen}))`,
          `    And request ({ ${[...strParts, ...nonStrParts].join(', ')} })`,
        ];
      }

      return [`    And request ${karateInlineJson(data)}`];
    }

    default:
      return [`    And request validBody`];
  }
}

// Serialises a plain object as a single-line Karate JSON literal.
function karateInlineJson(obj) {
  const pairs = Object.entries(obj).map(([k, v]) => {
    const val = typeof v === 'string'
      ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      : JSON.stringify(v);
    return `${k}: ${val}`;
  });
  return `{ ${pairs.join(', ')} }`;
}

// ── Body variables ────────────────────────────────────────────────────────────

// Mirrors postman-collection-builder's buildBodies():
// Decomposes a plain object into individual field variables and a JS object
// expression that composes them. Non-object bodies (arrays, scalars) fall back
// to a single `validBody` def holding the raw value.
function buildBodyVars(exampleObj) {
  if (exampleObj == null) return { bodyVars: [], validBodyExpr: null };

  if (typeof exampleObj !== 'object' || Array.isArray(exampleObj)) {
    return { bodyVars: [], validBodyExpr: JSON.stringify(exampleObj) };
  }

  const entries  = Object.entries(exampleObj);
  const bodyVars = entries.map(([key, value]) => ({ key, value }));
  const fields   = entries.map(([key]) => `${key}: ${key}`).join(', ');
  return { bodyVars, validBodyExpr: `({ ${fields} })` };
}

// Format a JS value as a Karate `def` right-hand side.
function karateValueLiteral(val) {
  if (val === null)             return 'null';
  if (typeof val === 'string')  return `'${val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof val === 'object')  return JSON.stringify(val);
  return String(val);
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
