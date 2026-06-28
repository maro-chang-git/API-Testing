import { isCookieAuth } from '../tryit/request-core.js';
import { CATEGORY_ORDER, CATEGORY_LABEL } from '../core/case-order.js';
import { getConfig } from '../core/config-loader.js';
import { effectiveBaseUrl, effectiveAuth, effectiveHeaders, effectivePathParams, effectiveRequestBody, saveOrDownload } from '../specs-store.js';
import { getTestBody, BODY_KIND } from './body-builder.js';
import { expectedStatuses } from '../core/template-matcher.js';
import { is2xx, is4xx } from '../core/status-utils.js';
import { normalizeAssertion, pathParamNames, methodHasBody, filenameSlug } from './export-shared.js';

/**
 * Builds a Karate .feature file from the current endpoint state
 * and triggers a file download.
 *
 * @param {object} profile   - endpoint profile from template-matcher
 * @param {object} operation - swagger operation object
 * @param {object} spec      - full swagger spec
 * @param {Array}  testCases - matched test cases
 */
export async function exportKarate(profile, operation, spec, testCases, swaggerId) {
  const method     = profile.method;
  const hasBody    = methodHasBody(method);
  const cookieAuth = isCookieAuth(profile.auth_type);

  // Valid-body example: the specs request body (user-edited) or the schema example.
  const exampleObj = hasBody ? effectiveRequestBody(method, profile.path, operation, spec) : null;
  const { bodyVars, validBodyExpr } = buildBodyVars(exampleObj);

  const pathParams = pathParamNames(profile.path);

  const lines = [];

  lines.push(`Feature: ${method} ${profile.path} — ${profile.summary || 'API Tests'}`);
  lines.push('');
  lines.push(`  # Endpoint: ${method} ${profile.path}`);
  lines.push(`  # Auth: ${profile.auth_required
    ? `${cookieAuth ? 'session cookie' : 'Bearer token'} (configured in karate-config.js)`
    : 'none'}`);
  if (operation.externalDocs?.url) lines.push(`  # Doc: ${operation.externalDocs.url}`);
  lines.push('');
  lines.push('  Background:');
  // Shared config (baseUrl, accept, contentType, readTimeout, credentials) comes
  // from karate-config.js — see buildKarateConfig() — so it's set in one place
  // for every feature in the folder instead of hardcoded per file.
  lines.push('    * url baseUrl');
  lines.push('    * configure readTimeout = readTimeout');

  // Default headers applied to every request. Auth-category scenarios override
  // this map (see authHeaderOverride); all others inherit it.
  const defaultAuthClause = profile.auth_required
    ? (cookieAuth ? `Cookie: 'session=' + sessionToken` : `Authorization: 'Bearer ' + token`)
    : null;
  lines.push(`    * configure headers = ${headersMapExpr({ contentType: hasBody, auth: defaultAuthClause })}`);

  const pathParamDefaults = effectivePathParams(method, profile.path);
  if (pathParams.length) {
    lines.push('');
    pathParams.forEach(n => {
      const val = pathParamDefaults[n] || `<replace-with-${n}>`;
      lines.push(`    * def ${n} = '${val}'`);
    });
  }

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

  // Write the shared config beside the feature (once — preserves user edits).
  await ensureKarateConfigFile(swaggerId, buildKarateConfig(spec, cookieAuth));
  return download(lines.join('\n'), method, profile.path, swaggerId);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

function buildScenario(tc, profile, method, hasBody, validBodyExpr, exampleObj, cookieAuth, lines) {
  const reqMethod  = tc.disallowed_method ?? method;
  const reqHasBody = tc.disallowed_method ? methodHasBody(reqMethod) : hasBody;

  lines.push(`  @${tc.id} @${tc.category}`);
  lines.push(`  Scenario: ${tc.id} — ${tc.purpose}`);

  // Accept / Content-Type / valid auth are inherited from the Background
  // `configure headers`. Auth-category cases re-configure that map to send a
  // missing / invalid / expired credential; everything else inherits it as-is.
  const authOverride = authHeaderOverride(tc, cookieAuth, reqHasBody);
  if (authOverride) lines.push(`    ${authOverride}`);

  lines.push(`    Given path ${buildKaratePath(profile.path)}`);

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

// Auth-category scenarios re-`configure headers` to override the Background
// default with a bad credential (or none). Returns the override step, or null
// when the case should keep the Background headers (every non-auth case).
function authHeaderOverride(tc, cookieAuth, reqHasBody) {
  if (tc.category !== 'auth') return null;
  let authClause = null;
  if (tc.auth_status === 'invalid') {
    authClause = cookieAuth ? `Cookie: 'session=' + invalidToken` : `Authorization: 'Bearer ' + invalidToken`;
  } else if (tc.auth_status === 'expired') {
    authClause = cookieAuth ? `Cookie: 'session=' + expiredSession` : `Authorization: 'Bearer ' + expiredToken`;
  }
  // 'missing' (and the 403 insufficient-permissions case) send no auth header.
  return `* configure headers = ${headersMapExpr({ contentType: reqHasBody, auth: authClause })}`;
}

// A Karate JS map literal for `configure headers`, e.g.
//   ({ Accept: accept, 'Content-Type': contentType, Authorization: 'Bearer ' + token })
// `accept` / `contentType` and the credentials resolve to karate-config.js vars.
function headersMapExpr({ contentType, auth }) {
  const parts = [`Accept: accept`];
  if (contentType) parts.push(`'Content-Type': contentType`);
  if (auth) parts.push(auth);
  return `({ ${parts.join(', ')} })`;
}

// ── Assertions ─────────────────────────────────────────────────────────────────

function buildKarateAssertions(tc, method, lines) {
  const statuses = expectedStatuses(tc.expected_status);
  const primary  = statuses[0];
  const folded   = tc.generatedAssertions ?? [];

  if (tc.assertion) {
    const line = karateAssertLine(tc.assertion);
    if (line) lines.push(`    ${line}`);
  } else if (is2xx(primary)) {
    // A folded array-root assertion will assert `response == '#array'`; skip the
    // generic object match so the scenario doesn't contradict itself.
    if (!folded.some(a => a.kind === 'array-root')) lines.push(`    * match response == '#object'`);
    if (method === 'POST' && statuses.includes(201)) {
      lines.push(`    * match response.id == '#notnull'`);
    }
  } else if (is4xx(primary)) {
    lines.push(`    * match response == '#object'`);
    lines.push(`    * assert response.message != null || response.error != null || response.detail != null`);
  }

  // Folded-in assertions derived from an observed response body.
  for (const a of folded) {
    const line = karateAssertLine(a);
    if (line) lines.push(`    ${line}`);
  }
}

function karateAssertLine(a) {
  const n = normalizeAssertion(a);
  if (!n) return null;
  switch (n.kind) {
    case 'array-root': return `* match response == '#array'`;
    case 'field':      return `* match response.${n.path} == '#notnull'`;
    case 'count':      return `* match response.${n.path} == '#array'`;
    case 'item-field': return `* match response.${n.collKey}[0].${n.path} == '#notnull'`;
    default:           return null;
  }
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

// ── Shared config (karate-config.js) ───────────────────────────────────────────

// Renders a karate-config.js for the export folder. Karate loads it before every
// Scenario and the returned map becomes global variables (baseUrl, accept,
// contentType, readTimeout, credentials) for every .feature beside it — so the
// per-file Background can stay free of hardcoded URLs and tokens.
function buildKarateConfig(spec, cookieAuth) {
  const baseUrl = effectiveBaseUrl(spec);
  const headers = effectiveHeaders();
  const auth    = effectiveAuth();
  const readTimeout = 60000;

  const validCred   = auth.token        || (cookieAuth ? '<replace-with-valid-session-token>'   : '<replace-with-valid-bearer-token>');
  const expiredCred = auth.expiredToken || (cookieAuth ? '<replace-with-expired-session-token>' : '<replace-with-expired-bearer-token>');
  const invalidCred = auth.invalidTokenValue || 'invalid_token_tampered_xyz';

  const authLines = cookieAuth
    ? [
        `    sessionToken:   ${karateValueLiteral(validCred)},`,
        `    expiredSession: ${karateValueLiteral(expiredCred)},`,
        `    invalidToken:   ${karateValueLiteral(invalidCred)},`,
      ]
    : [
        `    token:        ${karateValueLiteral(validCred)},`,
        `    expiredToken: ${karateValueLiteral(expiredCred)},`,
        `    invalidToken: ${karateValueLiteral(invalidCred)},`,
      ];

  return [
    `/**`,
    ` * Shared Karate configuration — loaded automatically before every Scenario.`,
    ` * The returned map is exposed as global variables to every .feature in this`,
    ` * folder. Edit the base URL / credentials below for your environment.`,
    ` *`,
    ` * Generated once by the API test tool and NOT overwritten on later exports,`,
    ` * so edits made here are safe. Switch environments with -Dkarate.env=<name>.`,
    ` */`,
    `function fn() {`,
    `  var env = karate.env || 'dev';`,
    ``,
    `  var config = {`,
    `    baseUrl:     ${karateValueLiteral(baseUrl)},`,
    `    accept:      ${karateValueLiteral(headers.accept)},`,
    `    contentType: ${karateValueLiteral(headers.contentType)},`,
    `    readTimeout: ${readTimeout},`,
    ...authLines,
    `  };`,
    ``,
    `  // Per-environment overrides — run with: mvn test -Dkarate.env=staging`,
    `  if (env === 'staging') {`,
    `    // config.baseUrl = 'https://staging.example.com';`,
    `  }`,
    ``,
    `  karate.configure('connectTimeout', 30000);`,
    ``,
    `  return config;`,
    `}`,
    ``,
  ].join('\n');
}

// Writes karate-config.js beside the feature files — but only when it's absent,
// so hand-edited credentials / URLs survive re-exports. Falls back to a browser
// download when the dev server isn't running.
async function ensureKarateConfigFile(swaggerId, content) {
  const relPath = `output/${swaggerId}/karate/karate-config.js`;
  try {
    const res = await fetch(relPath, { cache: 'no-store' });
    if (res.ok) return;   // already present — keep the user's edits
  } catch {
    // dev server down — fall through to save (which itself falls back to download)
  }
  await saveOrDownload(relPath, 'karate-config.js', content, 'application/javascript');
}

// ── Download ──────────────────────────────────────────────────────────────────

// Writes the feature to output/{id}/karate/ via the dev-server save endpoint,
// falling back to a browser download when it isn't running.
function download(content, method, path, swaggerId) {
  const filename = `karate-${method.toLowerCase()}-${filenameSlug(path)}.feature`;
  return saveOrDownload(`output/${swaggerId}/karate/${filename}`, filename, content, 'text/plain');
}
