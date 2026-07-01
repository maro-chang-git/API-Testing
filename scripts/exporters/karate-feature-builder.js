import { classifyAuth } from '../core/auth-header.js';
import { CATEGORY_ORDER, CATEGORY_LABEL } from '../core/case-order.js';
import { getConfig } from '../core/config-loader.js';
import { effectiveBaseUrl, effectiveAuth, effectiveHeaders, effectiveHeaderParams, effectivePathParams, effectiveRequestBody, saveOrDownload } from '../specs-store.js';
import { getTestBody, BODY_KIND } from './body-builder.js';
import { expectedStatuses } from '../core/template-matcher.js';
import { is2xx, is4xx } from '../core/status-utils.js';
import { SSE_DIALECTS } from '../core/response-body-types.js';
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

  // Auth style → header name + a wrapper turning a karate-config var name into the
  // header value expression. Cookie, raw apiKey header (e.g. x-api-key, no Bearer
  // prefix), or Bearer Authorization. `expiredVar` names the config var to use.
  const auth           = effectiveAuth();
  // Auth style (cookie / raw apiKey header / Bearer) + cookie naming is classified
  // once in core/auth-header.js, shared with Postman, Try It and the CLI live-runner.
  // A persisted full `name=value` cookie is sent verbatim — the config var holds the
  // whole string, so the valid clause is just the bare var (Cookie: sessionToken).
  // A bare value is prefixed with the cookie name, which carries across the
  // invalid/expired credentials (whose config values are always bare).
  const { cookieAuth, apiKeyHeader, headerName: authHeaderName, fullCookie, cookieName } = classifyAuth(auth, profile);
  const authWrap       = cookieAuth ? (fullCookie ? (v => v) : (v => `'${cookieName}=' + ${v}`))
                       : apiKeyHeader ? (v => v) : (v => `'Bearer ' + ${v}`);
  const authWrapCred   = cookieAuth ? (v => `'${cookieName}=' + ${v}`)
                       : apiKeyHeader ? (v => v) : (v => `'Bearer ' + ${v}`);
  const validVar       = cookieAuth ? 'sessionToken'   : 'token';
  const expiredVar     = cookieAuth ? 'expiredSession' : 'expiredToken';

  // `in: header` params (e.g. anthropic-version) → Karate map clauses sent on
  // every request. Values come from the persisted Try It edits when present, else
  // each param's schema default/example (effectiveHeaderParams).
  const headerParamClauses = Object.entries(effectiveHeaderParams(method, profile.path, operation))
    .map(([name, value]) => `${mapKey(name)}: ${karateValueLiteral(String(value))}`);

  // Valid-body example: the specs request body (user-edited) or the schema example.
  const exampleObj    = hasBody ? effectiveRequestBody(method, profile.path, operation, spec) : null;
  const validBodyExpr = inlineValidBody(exampleObj);

  const pathParams = pathParamNames(profile.path);

  const lines = [];

  lines.push(`Feature: ${method} ${profile.path} — ${profile.summary || 'API Tests'}`);
  lines.push('');
  lines.push(`  # Endpoint: ${method} ${profile.path}`);
  lines.push(`  # Auth: ${profile.auth_required
    ? `${cookieAuth ? 'session cookie' : apiKeyHeader ? `${authHeaderName} header` : 'Bearer token'} (configured in karate-config.js)`
    : 'none'}`);
  if (operation.externalDocs?.url) lines.push(`  # Doc: ${operation.externalDocs.url}`);
  lines.push('');
  lines.push('  Background:');
  // Shared config (baseUrl, accept, contentType, readTimeout, credentials) comes
  // from karate-config.js — see buildKarateConfig() — so it's set in one place
  // for every feature in the folder instead of hardcoded per file.
  lines.push('    * url baseUrl');
  lines.push('    * configure readTimeout = readTimeout');

  // Default headers applied to every request. The auth Scenario Outline overrides
  // this map per-row (see buildAuthOutline); all others inherit it.
  const defaultAuthClause = profile.auth_required
    ? `${mapKey(authHeaderName)}: ${authWrap(validVar)}`
    : null;
  lines.push(`    * configure headers = ${headersMapExpr({ contentType: hasBody, headerParams: headerParamClauses, auth: defaultAuthClause })}`);

  const pathParamDefaults = effectivePathParams(method, profile.path);
  if (pathParams.length) {
    lines.push('');
    pathParams.forEach(n => {
      const val = pathParamDefaults[n] || `<replace-with-${n}>`;
      lines.push(`    * def ${n} = '${val}'`);
    });
  }

  // Karate payloads read best as one inline object literal (not field-by-field
  // variables — that's a Postman collection-variable idiom that doesn't fit here).
  if (validBodyExpr) {
    lines.push('');
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

    // The auth cases differ only by credential + expected status, so they fold into
    // a single data-driven Scenario Outline instead of one near-identical copy each.
    if (cat === 'auth') {
      buildAuthOutline(cases, profile, method, hasBody, { authHeaderName, authWrap: authWrapCred, expiredVar, headerParamClauses }, lines);
      lines.push('');
      return;
    }

    // The 405 cases (one per disallowed method) likewise collapse into one outline;
    // any other negative case keeps its own Scenario (distinct body / status).
    const outlineCases    = cases.filter(tc => tc.disallowed_method);
    const individualCases = cases.filter(tc => !tc.disallowed_method);

    individualCases.forEach(tc => {
      buildScenario(tc, profile, method, hasBody, validBodyExpr, exampleObj, lines);
      lines.push('');
    });

    if (outlineCases.length) {
      buildMethodNotAllowedOutline(outlineCases, profile, lines);
      lines.push('');
    }
  });

  // Write the shared config beside the feature (once — preserves user edits).
  await ensureKarateConfigFile(swaggerId, buildKarateConfig(spec, cookieAuth));
  return download(lines.join('\n'), method, profile.path, swaggerId);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

function buildScenario(tc, profile, method, hasBody, validBodyExpr, exampleObj, lines) {
  lines.push(`  @${tc.id} @${tc.category}`);
  lines.push(`  Scenario: ${tc.id} — ${tc.purpose}`);

  // Accept / Content-Type / valid auth are all inherited from the Background
  // `configure headers`; these per-case scenarios only vary the request body.
  lines.push(`    Given path ${buildKaratePath(profile.path)}`);

  if (hasBody) buildKarateBodyLines(tc, validBodyExpr, exampleObj).forEach(l => lines.push(l));

  lines.push(`    When method ${method.toLowerCase()}`);
  // Karate's `status` step takes a single code; when a case accepts several,
  // match the built-in responseStatus against the allowed set.
  const statuses = expectedStatuses(tc.expected_status);
  if (statuses.length === 1) {
    lines.push(`    Then status ${statuses[0]}`);
  } else {
    lines.push(`    Then match [${statuses.join(', ')}] contains responseStatus`);
  }
  lines.push(`    * assert responseTime < ${getConfig().responseTimeThresholdMs}`);

  buildKarateAssertions(tc, method, lines);
}

// ── Scenario Outlines (data-driven groups) ─────────────────────────────────────

// All 405 cases differ only by the disallowed HTTP verb, so they collapse into a
// single Scenario Outline. A 405 is decided at the method layer, so no request
// body is sent regardless of the verb.
function buildMethodNotAllowedOutline(cases, profile, lines) {
  lines.push(`  @negative @method-not-allowed`);
  lines.push(`  Scenario Outline: <id> — Return 405 when an HTTP method is not allowed (<verb>)`);
  lines.push(`    Given path ${buildKaratePath(profile.path)}`);
  lines.push(`    When method <verb>`);
  // Honour the template's expected_status set (TPL-NEG-009 = [405, 404]) instead
  // of hardcoding 405 — a server may legitimately answer 404 for an unrouted
  // method. Match responseStatus against the row's allowed set, like the auth
  // outline and the regular scenarios.
  lines.push(`    Then match [<status>] contains responseStatus`);
  lines.push(`    * assert responseTime < ${getConfig().responseTimeThresholdMs}`);
  lines.push(`    * match response == '#object'`);
  lines.push(`    * assert response.message != null || response.error != null || response.detail != null`);
  lines.push('');
  lines.push(`    Examples:`);
  const rows = cases.map(tc => [
    tc.id,
    tc.disallowed_method.toLowerCase(),
    expectedStatuses(tc.expected_status).join(', '),
  ]);
  renderExamplesTable(['id', 'verb', 'status'], rows).forEach(l => lines.push(l));
}

// The auth cases share one request shape and differ only by the credential sent and
// the expected status. Each Examples row supplies the Authorization/Cookie value via
// a Karate embedded expression (`#(...)`), with `#(null)` driving the missing-header
// case; the configure-headers step adds the credential only when it isn't null.
function buildAuthOutline(cases, profile, method, hasBody, { authHeaderName, authWrap, expiredVar, headerParamClauses = [] }, lines) {
  const extra = headerParamClauses.length ? `, ${headerParamClauses.join(', ')}` : '';
  const base  = (hasBody ? `Accept: accept, 'Content-Type': contentType` : `Accept: accept`) + extra;

  lines.push(`  @auth`);
  lines.push(`  Scenario Outline: <id> — <desc>`);
  lines.push(`    * configure headers = (authValue == null ? ({ ${base} }) : ({ ${base}, ${mapKey(authHeaderName)}: authValue }))`);
  lines.push(`    Given path ${buildKaratePath(profile.path)}`);
  if (hasBody) lines.push(`    And request validBody`);
  lines.push(`    When method ${method.toLowerCase()}`);
  // Match responseStatus against the row's allowed set (e.g. [403, 401]) so the
  // auth outline honours multi-status templates like the regular scenarios do.
  lines.push(`    Then match [<status>] contains responseStatus`);
  lines.push(`    * assert responseTime < ${getConfig().responseTimeThresholdMs}`);
  lines.push(`    * match response == '#object'`);
  lines.push(`    * assert response.message != null || response.error != null || response.detail != null`);
  lines.push('');
  lines.push(`    Examples:`);
  const rows = cases.map(tc => [
    tc.id,
    authValueCell(tc.auth_status, authWrap, expiredVar),
    expectedStatuses(tc.expected_status).join(', '),
    String(tc.purpose).replace(/\|/g, '/'),
  ]);
  renderExamplesTable(['id', 'authValue', 'status', 'desc'], rows).forEach(l => lines.push(l));
}

// The Examples cell for an auth row's credential, as a Karate embedded expression
// resolving against the karate-config.js vars. Missing / insufficient-permission
// cases send no credential (`#(null)`).
function authValueCell(authStatus, authWrap, expiredVar) {
  if (authStatus === 'invalid') return `#(${authWrap('invalidToken')})`;
  if (authStatus === 'expired') return `#(${authWrap(expiredVar)})`;
  return `#(null)`;
}

// Renders an aligned Karate Examples table (header row + data rows).
function renderExamplesTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => `      | ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [fmt(headers), ...rows.map(fmt)];
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

// A Karate JS map literal for `configure headers`, e.g.
//   ({ Accept: accept, 'Content-Type': contentType, Authorization: 'Bearer ' + token })
// `accept` / `contentType` and the credentials resolve to karate-config.js vars.
function headersMapExpr({ contentType, headerParams = [], auth }) {
  const parts = [`Accept: accept`];
  if (contentType) parts.push(`'Content-Type': contentType`);
  parts.push(...headerParams);
  if (auth) parts.push(auth);
  return `({ ${parts.join(', ')} })`;
}

// Quote a header name as a JS map key when it isn't a bare identifier (e.g.
// x-api-key → 'x-api-key'); Authorization / Cookie stay unquoted.
function mapKey(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;
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
    // Route the 2xx body assertions by the endpoint's response body type.
    switch (tc.response_body_type) {
      case 'sse':       karateSseAssertions(tc, lines); break;
      case 'ndjson':    karateNdjsonAssertions(lines);  break;
      case 'text':      lines.push(`    * match responseType == 'string'`);
                        lines.push(`    * assert response.length > 0`); break;
      case 'binary':    lines.push(`    * assert responseBytes.length > 0`);
                        lines.push(`    * match responseHeaders['Content-Type'][0] == '#present'`); break;
      default:          // 'json' (and undefined) — the regular object/shape checks.
        // A folded array-root assertion will assert `response == '#array'`; skip the
        // generic object match so the scenario doesn't contradict itself.
        if (!folded.some(a => a.kind === 'array-root')) lines.push(`    * match response == '#object'`);
        if (method === 'POST' && statuses.includes(201)) {
          lines.push(`    * match response.id == '#notnull'`);
        }
    }
  } else if (is4xx(primary)) {
    lines.push(`    * match response == '#object'`);
    lines.push(`    * assert response.message != null || response.error != null || response.detail != null`);
    if (tc.category === 'security') {
      lines.push(`    # Security: injection payloads must not be reflected unescaped`);
      lines.push(`    * assert JSON.stringify(response).indexOf('<script>') == -1`);
      lines.push(`    * assert JSON.stringify(response).indexOf('DROP TABLE') == -1`);
      lines.push(`    * assert JSON.stringify(response).indexOf('/etc/passwd') == -1`);
    }
  }

  // Folded-in assertions derived from an observed response body.
  for (const a of folded) {
    const line = karateAssertLine(a);
    if (line) lines.push(`    ${line}`);
  }
}

// SSE (text/event-stream): the body is a raw string of `data:` frames. Assert the
// stream shape, plus the dialect's terminal marker + a delta-path token when a
// concrete dialect is known. Karate can't reconstruct the streamed text, so the
// delta-token `contains` is the closest proxy for "non-empty streamed content".
function karateSseAssertions(tc, lines) {
  lines.push(`    * match responseType == 'string'`);
  lines.push(`    * match response contains 'data:'`);
  const d = SSE_DIALECTS[tc.sse_dialect];
  if (d?.terminal) lines.push(`    * match response contains '${d.terminal}'`);
  const token = sseDeltaToken(tc.sse_dialect);
  if (token) lines.push(`    * match response contains '${token}'`);
}

// A token that must appear in the raw SSE body for the given dialect's delta path
// (proxy for "the stream carried incremental content").
function sseDeltaToken(dialect) {
  if (dialect === 'openai')    return 'content';
  if (dialect === 'anthropic') return 'content_block_delta';
  return null;
}

// NDJSON: a raw string of newline-delimited JSON. Assert ≥1 non-empty line and
// that the first one parses as JSON (`* json` throws on invalid input).
function karateNdjsonAssertions(lines) {
  lines.push(`    * match responseType == 'string'`);
  lines.push(`    * def ndjsonLines = response.trim().split('\\n')`);
  lines.push(`    * assert ndjsonLines.length >= 1`);
  lines.push(`    * json ndjsonFirst = ndjsonLines[0]`);
  lines.push(`    * match ndjsonFirst == '#present'`);
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

// ── Valid body ──────────────────────────────────────────────────────────────────

// The right-hand side for the Background's `* def validBody`. Plain objects render
// as a single inline Karate JSON literal; arrays / scalars fall back to raw JSON.
// Returns null when the endpoint sends no body.
function inlineValidBody(exampleObj) {
  if (exampleObj == null) return null;
  if (typeof exampleObj !== 'object' || Array.isArray(exampleObj)) {
    return JSON.stringify(exampleObj);
  }
  return karateInlineJson(exampleObj);
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
    // A dev server may answer a missing file with an SPA index.html (200 text/html);
    // only treat the config as present when the response is actually a JS file, so
    // we don't silently skip writing it. Real edits are preserved either way.
    const ct = res.headers.get('content-type') || '';
    if (res.ok && !/html/i.test(ct)) return;   // already present — keep the user's edits
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
