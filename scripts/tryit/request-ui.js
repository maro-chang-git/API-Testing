import { getConfig } from '../core/config-loader.js';
import { expectedStatuses } from '../core/template-matcher.js';
import * as specsStore from '../specs-store.js';
import { validateResponse } from './schema-validator.js';
import { isCookieAuth, buildRequestUrl, buildRequestHeaders, buildRequestBody } from './request-core.js';
import { classifyAuth } from '../core/auth-header.js';
import { isEventStream, parseEventStream } from './sse-parser.js';

let _profile   = null;   // endpoint profile from template-matcher
let _operation = null;   // raw swagger operation object
let _spec      = null;   // full swagger spec (for basePath/host)

let _swaggerId = null;   // current swagger id — scopes the sticky Try It session
let _session   = null;   // sticky base URL (incl. proxy toggle) + auth carried
                         // across endpoint switches within one swagger; dropped
                         // when the swagger changes. { baseUrl, authType,
                         // authValue, authKey }

let _activeTc         = null;   // test case currently being run
let _onSaveResult     = null;   // callback(tcId, {actual_status, elapsed, passed})
let _onResponse       = null;   // callback({status, body}) fired after a successful response
let _lastResponse     = null;   // { status, body, elapsed } of the most recent send (for baseline capture)

export function setOnResponse(fn) { _onResponse = fn; }

// ── Response tab switcher (runs once at module load; DOM is ready for ES modules) ──
document.getElementById('rb-response')?.addEventListener('click', e => {
  const btn = e.target.closest('.rb-res-tab');
  if (!btn) return;
  const tab = btn.dataset.resTab;
  document.querySelectorAll('.rb-res-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const panes = { body: 'rb-res-body', headers: 'rb-res-headers', schema: 'rb-res-schema' };
  Object.entries(panes).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === tab ? '' : 'none';
  });
});

// ── Static Try It controls + delegated dynamic buttons (bound once at load) ──
// Replaces the former inline onclick / window.__rb* globals. Static controls are
// wired directly; buttons rendered on demand (header rows, the active-TC banner,
// the save-result button) are reached via event delegation on stable containers.
document.getElementById('rb-auth-type')?.addEventListener('change', () => toggleAuthInput());
document.getElementById('rb-add-header-btn')?.addEventListener('click', () => addHeaderRow());
document.getElementById('rb-send-btn')?.addEventListener('click', () => sendRequest());
document.getElementById('rb-baseline-btn')?.addEventListener('click', () => saveBaseline());
document.getElementById('rb-proxy-btn')?.addEventListener('click', () => {
  const inp = document.getElementById('rb-base-url');
  const proxy = location.origin + '/proxy?url=';
  if (inp && !inp.value.startsWith(proxy)) inp.value = proxy + inp.value;
});

// Remove a custom header row (rows are added dynamically).
document.getElementById('rb-headers-list')?.addEventListener('click', e => {
  if (e.target.closest('.rb-remove-btn')) e.target.closest('.rb-header-row')?.remove();
});

// Clear the active-TC banner (re-rendered each run).
document.getElementById('rb-active-tc')?.addEventListener('click', e => {
  if (e.target.closest('.rb-clear-tc')) clearActiveTc();
});

// Save a run result (the comparison block is re-rendered each send; the result
// values ride along on data-* attributes of the button).
document.getElementById('rb-tc-comparison')?.addEventListener('click', e => {
  const btn = e.target.closest('.rb-save-result-btn');
  if (!btn) return;
  saveResult(Number(btn.dataset.actualStatus), Number(btn.dataset.elapsed), btn.dataset.passed === 'true');
});

// ── Public API ────────────────────────────────────────────────────────────────

export function initRequestBuilder(profile, operation, spec, swaggerId) {
  // Carry session-level Try It fields (base URL incl. proxy toggle, auth) across
  // endpoint switches within the same swagger, so the user doesn't re-enter them
  // for every endpoint. Stash the outgoing endpoint's values before re-rendering;
  // on a different swagger, drop the session so its fields don't leak across APIs.
  if (swaggerId === _swaggerId) captureSession();
  else _session = null;
  _swaggerId = swaggerId;

  _profile   = profile;
  _operation = operation;
  _spec      = spec;
  _activeTc  = null;

  renderEndpointInfo();
  renderPathParams();
  renderQueryParams();
  renderBodySection();
  resetHeadersList();
  renderDefaultHeaders();
  renderHeaderParams();
  // Auth last: renderAuthSection() pre-fills the token and inserts the read-only
  // Authorization "auto-auth" header row. It must run AFTER resetHeadersList()
  // (which clears the list) so a pre-filled token's header survives into the
  // request — otherwise the field shows the token but no Authorization is sent.
  renderAuthSection();
  clearActiveTcBanner();
  clearResponse();
}

export function runTestCase(tc, onSaveResult) {
  _activeTc      = tc;
  _onSaveResult  = onSaveResult;

  renderActiveTcBanner(tc);
  applyAuthPreset(tc);
  clearResponse();
}

export function clearActiveTc() {
  _activeTc     = null;
  _onSaveResult = null;
  clearActiveTcBanner();
}

export function resetRequestBuilder() {
  _profile   = null;
  _operation = null;
  _spec      = null;
  _activeTc  = null;
  document.getElementById('rb-method-badge').textContent = '';
  document.getElementById('rb-method-badge').className   = 'badge';
  document.getElementById('rb-path-display').textContent = '';
  document.getElementById('rb-summary-text').textContent = 'Select an endpoint to begin.';
  document.getElementById('rb-base-url').value           = '';
  document.getElementById('rb-path-params').innerHTML    = '<p class="rb-empty">Select an endpoint first.</p>';
  document.getElementById('rb-query-params').innerHTML   = '<p class="rb-empty">Select an endpoint first.</p>';
  document.getElementById('rb-body-section').style.display = 'none';
  resetHeadersList();
  clearActiveTcBanner();
  clearResponse();
}

// Snapshot the session-level fields (base URL incl. proxy, auth) of the endpoint
// currently shown, so they can be restored on the next endpoint of this swagger.
// Skipped when no endpoint is rendered (e.g. after a tag change cleared the panel)
// so a blank panel can't wipe a good session. Auth-test presets (missing/invalid/
// expired) are not captured, so a tampered or empty token never becomes sticky.
function captureSession() {
  if (!_profile) return;
  const sess = _session || {};
  sess.baseUrl = document.getElementById('rb-base-url').value;
  if (!(_activeTc && _activeTc.category === 'auth')) {
    sess.authType  = document.getElementById('rb-auth-type').value;
    sess.authValue = document.getElementById('rb-auth-value').value;
    sess.authKey   = document.getElementById('rb-auth-key').value;
  }
  _session = sess;
}

// ── Active TC banner ──────────────────────────────────────────────────────────

function renderActiveTcBanner(tc) {
  const banner = document.getElementById('rb-active-tc');
  banner.style.display = '';
  banner.innerHTML = `
    <span class="rb-tc-id">${tc.id}</span>
    <span class="rb-tc-purpose">${escHtml(tc.purpose)}</span>
    <span class="rb-tc-expected">Expected: <strong>${expectedStatuses(tc.expected_status).join(' or ')}</strong></span>
    <button class="rb-clear-tc">✕ Clear</button>
  `;
}

function clearActiveTcBanner() {
  const banner = document.getElementById('rb-active-tc');
  if (banner) banner.style.display = 'none';
}

// ── Auth preset from test case ────────────────────────────────────────────────

function applyAuthPreset(tc) {
  const authType  = document.getElementById('rb-auth-type');
  const authValue = document.getElementById('rb-auth-value');
  const cookieAuth = isCookieAuth(_profile?.auth_type);

  if (tc.category === 'auth') {
    if (tc.auth_status === 'missing') {
      authType.value  = 'none';
      authValue.value = '';
    } else if (tc.auth_status === 'invalid') {
      authType.value  = cookieAuth ? 'cookie' : 'bearer';
      const inv = getConfig().auth.invalidTokenValue;
      authValue.value = cookieAuth ? `session=${inv}` : inv;
    } else if (tc.auth_status === 'expired') {
      authType.value  = cookieAuth ? 'cookie' : 'bearer';
      authValue.value = '';
      authValue.placeholder = cookieAuth ? 'Paste an expired cookie here' : 'Paste an expired token here';
    }
    toggleAuthInput();
    updateAutoAuthHeader();
  }
}

function resetHeadersList() {
  document.getElementById('rb-headers-list').innerHTML = '';
}

// ── Sections ──────────────────────────────────────────────────────────────────

function renderEndpointInfo() {
  // Prefer the sticky session base URL (keeps the user's 🔗 Proxy choice across
  // endpoint switches); fall back to the resolved spec/config/specs value.
  const baseUrl = _session?.baseUrl || specsStore.effectiveBaseUrl(_spec);
  document.getElementById('rb-base-url').value         = baseUrl;
  document.getElementById('rb-method-badge').textContent  = _profile.method;
  document.getElementById('rb-method-badge').className    = `badge method-${_profile.method}`;
  document.getElementById('rb-path-display').textContent  = _profile.path;
  document.getElementById('rb-summary-text').textContent  = _operation.summary ?? '';
}

function renderPathParams() {
  const container = document.getElementById('rb-path-params');
  const matches   = [..._profile.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

  if (matches.length === 0) {
    container.innerHTML = '<p class="rb-empty">No path parameters.</p>';
    return;
  }

  // Seed each input from the endpoint's specs (falls back to config / blank).
  const seed = specsStore.effectivePathParams(_profile.method, _profile.path);
  container.innerHTML = matches.map(name => `
    <div class="rb-param-row">
      <label class="rb-param-name">{${name}}</label>
      <input type="text" class="rb-param-input" data-param="${name}" value="${escHtml(seed[name] || '')}" placeholder="value" />
    </div>
  `).join('');
}

function renderQueryParams() {
  const container = document.getElementById('rb-query-params');
  const params    = (_operation.parameters ?? []).filter(p => p.in === 'query');

  if (params.length === 0) {
    container.innerHTML = '<p class="rb-empty">No query parameters.</p>';
    return;
  }

  container.innerHTML = params.map(p => `
    <div class="rb-param-row">
      <label class="rb-param-name">${p.name}${p.required ? ' <span class="rb-required">*</span>' : ''}</label>
      <input type="text" class="rb-param-input" data-query="${p.name}"
             placeholder="${p.description ?? p.type ?? ''}" />
    </div>
  `).join('');
}

function renderAuthSection() {
  const typeSel = document.getElementById('rb-auth-type');
  const valEl   = document.getElementById('rb-auth-value');
  const keyEl   = document.getElementById('rb-auth-key');

  // Pre-fill from the specs auth when the endpoint requires auth and a token is
  // configured; otherwise leave it as "none" for the user to fill in. The auth
  // style is a best-effort guess from where the credential goes — editable here.
  // Restore the auth chosen on a previous endpoint of this swagger (sticky across
  // switches, even before Save Specs). Falls through to the specs-derived default
  // on the first endpoint of a swagger (when there is no session yet).
  if (_session?.authType) {
    typeSel.value = _session.authType;
    valEl.value   = _session.authValue || '';
    keyEl.value   = _session.authKey || '';
    toggleAuthInput();
    return;
  }

  const auth = specsStore.effectiveAuth();
  if (_profile?.auth_required && auth.token) {
    // Auth style is classified once in core/auth-header.js (shared with the
    // exporters + CLI). Query apiKey isn't a header, so it's handled separately.
    const { cookieAuth, apiKeyHeader } = classifyAuth(auth, _profile);
    typeSel.value = auth.in === 'query' ? 'api_key_query'
                  : cookieAuth          ? 'cookie'
                  : apiKeyHeader        ? 'api_key_header'
                  :                       'bearer';
    valEl.value = typeSel.value === 'cookie' ? `session=${auth.token}` : auth.token;
    // For a header apiKey scheme, seed the header name from the spec (e.g. x-api-key).
    keyEl.value = typeSel.value === 'api_key_header' ? (auth.name || 'X-API-Key') : '';
  } else {
    typeSel.value = 'none';
    valEl.value   = '';
    keyEl.value   = '';
  }
  toggleAuthInput();
}

function renderBodySection() {
  const hasBody = ['POST','PUT','PATCH'].includes(_profile.method);
  document.getElementById('rb-body-section').style.display = hasBody ? '' : 'none';
  if (!hasBody) return;

  // Pre-fill from the specs request body (user-edited) or the schema example.
  const example = specsStore.effectiveRequestBody(_profile.method, _profile.path, _operation, _spec);

  document.getElementById('rb-body').value = (example !== null && example !== undefined)
    ? JSON.stringify(example, null, 2)
    : '{\n  \n}';
}

// Schema → example builders (getRequestBodySchema / buildExampleFromSchema /
// getResponseExample) and response-schema validation now live in
// tryit/schema-validator.js — DOM-free and unit-tested.

// Renders the endpoint's `in: header` parameters as editable, pre-filled header
// rows, so spec-required headers like `anthropic-version` are actually sent.
// Values come from specsStore.effectiveHeaderParams — the persisted Try It edits
// when present, otherwise each param's schema default/example (which also surfaces
// any custom headers the user saved). They're tagged data-header-param (editable +
// removable, unlike the readonly Accept/Content-Type defaults) and re-rendered on
// every endpoint switch.
function renderHeaderParams() {
  const list = document.getElementById('rb-headers-list');
  list.querySelectorAll('[data-header-param]').forEach(el => el.remove());

  const params = specsStore.effectiveHeaderParams(_profile.method, _profile.path, _operation);
  const names = Object.keys(params);
  if (!names.length) return;

  // Place them after the default headers (the first non-default row, or the end).
  const anchor = [...list.children].find(el => !el.dataset.defaultHeader) ?? null;
  for (const name of names) {
    const row = makeHeaderRow(name, String(params[name]), false);
    row.dataset.headerParam = '1';
    list.insertBefore(row, anchor);
  }
}

function renderDefaultHeaders() {
  const list    = document.getElementById('rb-headers-list');
  const hasBody = ['POST','PUT','PATCH'].includes(_profile.method);

  // Clear previous default headers; keep any user-added ones
  list.querySelectorAll('[data-default-header]').forEach(el => el.remove());

  const headers = specsStore.effectiveHeaders();
  const defaults = [
    ['Accept', headers.accept],
    ...(hasBody ? [['Content-Type', headers.contentType]] : []),
  ];

  // Prepend defaults (insert before first child)
  defaults.reverse().forEach(([key, val]) => {
    const row = makeHeaderRow(key, val, true);
    list.insertBefore(row, list.firstChild);
  });
}

// ── Auth toggle ───────────────────────────────────────────────────────────────

export function toggleAuthInput() {
  const type  = document.getElementById('rb-auth-type').value;
  const row   = document.getElementById('rb-auth-value-row');
  const input = document.getElementById('rb-auth-value');
  const keyRow = document.getElementById('rb-auth-key-row');

  if (type === 'none') {
    row.style.display    = 'none';
    keyRow.style.display = 'none';
    updateAutoAuthHeader();
    return;
  }

  row.style.display = '';
  input.placeholder = {
    bearer:         'eyJhbGciOiJIUzI1NiJ9...',
    api_key_header: 'your-api-key',
    api_key_query:  'your-api-key',
    cookie:         'session=abc123; token=xyz',
    basic:          'username:password',
  }[type] ?? '';

  keyRow.style.display = (type === 'api_key_header') ? '' : 'none';

  updateAutoAuthHeader();

  // Live-update the auth header row as the user types the value
  input.oninput = updateAutoAuthHeader;
  document.getElementById('rb-auth-key').oninput = updateAutoAuthHeader;
}

// Inserts/updates a read-only "auto" header row driven by the auth selection
function updateAutoAuthHeader() {
  const type  = document.getElementById('rb-auth-type').value;
  const value = document.getElementById('rb-auth-value').value.trim();
  const key   = document.getElementById('rb-auth-key').value.trim();

  // Remove previous auto-auth row
  const list = document.getElementById('rb-headers-list');
  list.querySelectorAll('[data-auto-auth]').forEach(el => el.remove());

  if (type === 'none' || !value) return;

  // Both are assigned on every branch below; the `else` returns early.
  let headerKey, headerVal;

  if (type === 'bearer') {
    headerKey = 'Authorization';
    headerVal = `Bearer ${value}`;
  } else if (type === 'api_key_header') {
    headerKey = key || 'X-API-Key';
    headerVal = value;
  } else if (type === 'basic') {
    headerKey = 'Authorization';
    headerVal = `Basic ${btoa(value)}`;
  } else if (type === 'cookie') {
    headerKey = 'Cookie';
    headerVal = value;
  } else {
    return; // api_key_query — no header
  }

  const row = makeHeaderRow(headerKey, headerVal, true, 'auto-auth');
  // Insert after default headers (before first non-default row)
  const firstCustom = [...list.children].find(el => !el.dataset.defaultHeader && !el.dataset.autoAuth);
  list.insertBefore(row, firstCustom ?? null);
}

// ── Headers editor ────────────────────────────────────────────────────────────

function makeHeaderRow(key, value, auto = false, kind = 'default') {
  const row = document.createElement('div');
  row.className = `rb-header-row${auto ? ' rb-header-auto' : ''}`;
  if (kind === 'auto-auth')             row.dataset.autoAuth      = '1';
  else if (auto && kind === 'default')  row.dataset.defaultHeader = '1';

  row.innerHTML = `
    <input type="text" class="rb-header-key" value="${escHtml(key)}"   ${auto ? 'readonly' : 'placeholder="Header name"'} />
    <input type="text" class="rb-header-val" value="${escHtml(value)}" ${auto ? 'readonly' : 'placeholder="Value"'} />
    ${auto
      ? `<span class="rb-auto-badge">${kind === 'auto-auth' ? 'auth' : 'default'}</span>`
      : `<button class="rb-remove-btn">✕</button>`
    }
  `;
  return row;
}

export function addHeaderRow(key = '', value = '') {
  const row = makeHeaderRow(key, value, false);
  document.getElementById('rb-headers-list').appendChild(row);
}

// ── Send request ──────────────────────────────────────────────────────────────

export async function sendRequest() {
  if (!_profile || !_spec) return;

  const btn = document.getElementById('rb-send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  clearResponse();

  try {
    const url     = buildUrl();
    const headers = buildHeaders();
    const body    = buildBody();

    const start = performance.now();
    const res   = await fetch(url, {
      method:  _profile.method,
      headers,
      body,
      // Don't follow redirects silently — expose them
      redirect: 'follow',
    });
    const elapsed = Math.round(performance.now() - start);

    const rawText     = await res.text();
    const contentType = res.headers.get('content-type') || '';
    // Route response handling by the endpoint's response body type. 'sse' forces
    // SSE parsing; 'json' (or unset) also sniffs the body so a mislabeled stream is
    // still caught (belt-and-suspenders). ndjson / text / binary are shown raw.
    const bodyType = _profile.response_body_type || 'json';
    const dialect  = _profile.sse_dialect || 'generic';
    const isSse    = bodyType === 'sse' || (bodyType === 'json' && isEventStream(contentType, rawText));
    const stream   = isSse ? parseEventStream(rawText, dialect) : null;

    let prettyBody = rawText;
    if (!stream && bodyType === 'json') {
      try { prettyBody = JSON.stringify(JSON.parse(rawText), null, 2); } catch { /* not JSON — keep raw text */ }
    }

    showResponse({
      status:  res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body:    prettyBody,
      elapsed,
      url,
      stream,
      bodyType,
    });
  } catch (err) {
    const isNetworkFail = err.message === 'Failed to fetch' || err.message?.includes('NetworkError');
    showError(err.message, isNetworkFail);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Request';
  }
}

// ── URL / headers / body builders ─────────────────────────────────────────────
// These thin wrappers read the current input values from the DOM and delegate
// the actual composition to the pure helpers in tryit/request-core.js.

function buildUrl() {
  const pathParams = {};
  document.querySelectorAll('#rb-path-params [data-param]').forEach(el => { pathParams[el.dataset.param] = el.value; });
  const queryParams = {};
  document.querySelectorAll('#rb-query-params [data-query]').forEach(el => { queryParams[el.dataset.query] = el.value; });

  return buildRequestUrl(_profile.path, {
    baseUrl:     document.getElementById('rb-base-url').value,
    pathParams,
    queryParams,
    auth: {
      type:  document.getElementById('rb-auth-type').value,
      key:   document.getElementById('rb-auth-key').value,
      value: document.getElementById('rb-auth-value').value,
    },
  });
}

function buildHeaders() {
  const headerRows = [...document.querySelectorAll('#rb-headers-list .rb-header-row')].map(row => ({
    key: row.querySelector('.rb-header-key').value.trim(),
    val: row.querySelector('.rb-header-val').value.trim(),
  }));
  return buildRequestHeaders(headerRows, {
    baseUrl:     document.getElementById('rb-base-url').value,
    proxyOrigin: location.origin,
  });
}

function buildBody() {
  return buildRequestBody(_profile.method, document.getElementById('rb-body').value);
}

// ── Response display ──────────────────────────────────────────────────────────

function showResponse({ status, statusText, headers, body, elapsed, url, stream = null, bodyType = 'json' }) {
  const panel = document.getElementById('rb-response');
  panel.style.display = '';

  // Remember the latest response so it can be captured as a baseline snapshot.
  _lastResponse = { status, body, elapsed };
  const baselineNotice = document.getElementById('rb-baseline-notice');
  if (baselineNotice) { baselineNotice.style.display = 'none'; baselineNotice.textContent = ''; }

  const cls = status >= 500 ? 's5xx' : status >= 400 ? 's4xx' : 's2xx';
  document.getElementById('rb-res-status').innerHTML =
    `<span class="status ${cls}">${status}</span> ${escHtml(statusText)} <span class="rb-elapsed">${elapsed}ms</span>`;

  document.getElementById('rb-res-url').textContent = url;

  document.getElementById('rb-res-headers').textContent =
    headers.map(([k,v]) => `${k}: ${v}`).join('\n');

  const bodyEl = document.getElementById('rb-res-body');
  if (stream) {
    // Show the reconstructed message first (what the user cares about), then the
    // raw frames for inspection.
    const head = stream.text
      ? `▼ Reconstructed text (${stream.count} events)\n${stream.text}\n\n▼ Raw stream\n`
      : `▼ Raw stream (${stream.count} events)\n`;
    bodyEl.textContent = head + body;
    bodyEl.className   = 'rb-res-pane';
  } else {
    bodyEl.textContent = body;
    bodyEl.className   = 'rb-res-pane' + (isJson(body) ? ' json' : '');
  }

  // Only a JSON body is schema-validatable. SSE / NDJSON / text / binary show an
  // info note instead (matching the endpoint's response body type).
  if (stream) {
    const schemaEl = document.getElementById('rb-res-schema');
    if (schemaEl) schemaEl.innerHTML =
      schemaMsg('info', `Streaming response (text/event-stream) — ${stream.count} events; JSON-schema validation not applicable.`);
  } else if (bodyType !== 'json') {
    const schemaEl = document.getElementById('rb-res-schema');
    if (schemaEl) schemaEl.innerHTML =
      schemaMsg('info', `Response body type is ${bodyType.toUpperCase()} — JSON-schema validation not applicable.`);
  } else {
    validateResponseSchema(status, body);
  }

  // If a test case is active, show comparison + save button. A case may accept
  // several statuses (e.g. 200 or 204) — it passes if the actual is any of them.
  if (_activeTc) {
    const passed = expectedStatuses(_activeTc.expected_status).includes(status);
    showTcComparison(_activeTc, status, elapsed, passed);
  } else {
    hideTcComparison();
  }

  // Let the app derive data-driven test cases from this live response.
  _onResponse?.({ status, body, stream });
}

function showTcComparison(tc, actualStatus, elapsed, passed) {
  const el = document.getElementById('rb-tc-comparison');
  el.style.display = '';
  el.className = `rb-tc-comparison ${passed ? 'tc-pass' : 'tc-fail'}`;
  el.innerHTML = `
    <div class="rb-tc-verdict">
      <span class="rb-verdict-icon">${passed ? '✅' : '❌'}</span>
      <span class="rb-verdict-label">${passed ? 'PASS' : 'FAIL'}</span>
      <span class="rb-verdict-detail">
        Expected <strong>${expectedStatuses(tc.expected_status).join(' or ')}</strong> — Got <strong>${actualStatus}</strong>
      </span>
    </div>
    <button class="rb-save-result-btn" data-actual-status="${actualStatus}" data-elapsed="${elapsed}" data-passed="${passed}">
      Save Result to TC-${tc.id.replace('TC-','')}
    </button>
  `;
}

function hideTcComparison() {
  const el = document.getElementById('rb-tc-comparison');
  if (el) el.style.display = 'none';
}

function showError(msg, isNetworkFail = false) {
  const panel = document.getElementById('rb-response');
  panel.style.display = '';
  document.getElementById('rb-res-status').innerHTML =
    `<span class="status s5xx">${isNetworkFail ? 'Request failed (could not reach the API)' : 'Network Error'}</span>`;
  document.getElementById('rb-res-url').textContent = '';
  document.getElementById('rb-res-headers').textContent = '';
  const errBodyEl = document.getElementById('rb-res-body');
  errBodyEl.className = 'rb-res-pane';
  // An opaque `Failed to fetch` is indistinguishable from JS — it covers CORS,
  // a blank/scheme-only Base URL, mixed content, and an unreachable server
  // alike. Don't blame CORS alone; surface the current Base URL (the most
  // common culprit) and list every candidate cause.
  if (isNetworkFail) {
    const baseUrl = document.getElementById('rb-base-url')?.value ?? '';
    errBodyEl.textContent =
      `Request failed — could not reach the API (${msg}).\n\n` +
      `No HTTP status was returned, so this is a connection-level failure, not a\n` +
      `server response. Likely causes:\n\n` +
      `  1. Empty or scheme-only Base URL — current value: "${baseUrl}".\n` +
      `     A host-less spec yields just "https://". Check the Base URL field (top-left).\n\n` +
      `  2. CORS — the API sent no Access-Control-Allow-Origin header.\n` +
      `     Click 🔗 Proxy to route through the local dev-server proxy\n` +
      `     (${location.origin}/proxy?url= + original URL; requires devserver.py),\n` +
      `     or point Base URL at a local instance.\n\n` +
      `  3. Mixed content — an https:// page cannot call an http:// API.\n\n` +
      `  4. Server unreachable — DNS failure, connection refused, or TLS error.`;
  } else {
    errBodyEl.textContent = msg;
  }
}

export function saveResult(actualStatus, elapsed, passed) {
  if (!_activeTc || !_onSaveResult) return;
  _onSaveResult(_activeTc.id, { actual_status: actualStatus, elapsed, passed, tested_at: new Date().toISOString() });
  // Update banner to reflect saved
  const banner = document.getElementById('rb-active-tc');
  const savedTag = banner.querySelector('.rb-tc-saved');
  if (!savedTag) {
    const span = document.createElement('span');
    span.className = 'rb-tc-saved';
    span.textContent = 'Saved';
    banner.querySelector('.rb-clear-tc')?.before(span);
  }
}

function clearResponse() {
  const panel = document.getElementById('rb-response');
  panel.style.display = 'none';
  hideTcComparison();
  _lastResponse = null;
  const notice = document.getElementById('rb-gen-notice');
  if (notice) { notice.style.display = 'none'; notice.innerHTML = ''; }
  const baselineNotice = document.getElementById('rb-baseline-notice');
  if (baselineNotice) { baselineNotice.style.display = 'none'; baselineNotice.textContent = ''; }
}

// Captures the valid bearer/cookie/api-key token currently entered in the Try It
// auth field into the specs model, so Save Specs persists it and switching
// endpoints keeps it. Auth-test presets (missing / invalid / expired) are skipped
// so a tampered or expired token never overwrites the real one.
export function captureTryItAuth() {
  if (_activeTc && _activeTc.category === 'auth') return;
  const type  = document.getElementById('rb-auth-type')?.value;
  const value = document.getElementById('rb-auth-value')?.value.trim();
  if (!type || type === 'none' || !value) return;
  const token = type === 'cookie' ? value.replace(/^session=/, '') : value;
  specsStore.setAuthToken(token);
}

// Captures the editable header rows currently in the Try It tab into the endpoint
// specs (the `in: header` param rows + any custom rows the user added), skipping
// the readonly Accept/Content-Type defaults and the auto-auth row (auth is captured
// separately). Called on Save Specs so the edited headers persist and both
// exporters emit them.
export function captureTryItHeader() {
  if (!_profile) return;
  const headerParams = {};
  document.querySelectorAll('#rb-headers-list .rb-header-row').forEach(row => {
    if (row.dataset.defaultHeader || row.dataset.autoAuth) return;
    const key = row.querySelector('.rb-header-key')?.value.trim();
    const val = row.querySelector('.rb-header-val')?.value.trim() ?? '';
    if (key) headerParams[key] = val;
  });
  specsStore.setHeaderParams(_profile.method, _profile.path, headerParams);
}

// Captures the base URL currently entered in the Try It tab into the swagger
// specs, stripping the local dev-server proxy prefix so the real target host is
// persisted, not the .../proxy?url= wrapper. Called on Save Specs.
export function captureTryItBaseUrl() {
  const raw = document.getElementById('rb-base-url')?.value?.trim();
  if (!raw) return;
  const proxyPrefix = `${location.origin}/proxy?url=`;
  const url = raw.startsWith(proxyPrefix) ? raw.slice(proxyPrefix.length) : raw;
  if (url) specsStore.setBaseUrl(url);
}

// Captures the request body currently in the Try It editor into the endpoint
// specs (only for body methods, and only when it parses as JSON). Called on
// Save Specs so the edited body becomes the source of truth for exports.
export function captureTryItBody() {
  if (!_profile || !['POST', 'PUT', 'PATCH'].includes(_profile.method)) return;
  const raw = document.getElementById('rb-body')?.value;
  if (raw == null) return;
  let body;
  try { body = JSON.parse(raw); } catch { return; }   // skip invalid JSON
  specsStore.setRequestBody(_profile.method, _profile.path, body);
}

// Records the most recent response as the current endpoint's baseline and
// persists the specs file. Wired to the "Save as baseline" button via app.js.
export async function saveBaseline() {
  const notice = document.getElementById('rb-baseline-notice');
  if (!_profile || !_lastResponse) {
    if (notice) { notice.style.display = ''; notice.textContent = '📌 Send a request first, then record its response as a baseline.'; }
    return;
  }

  let body = _lastResponse.body;
  try { body = JSON.parse(_lastResponse.body); } catch { /* keep raw text */ }

  specsStore.setBaseline(_profile.method, _profile.path, {
    status: _lastResponse.status,
    responseTime: _lastResponse.elapsed,
    body,
    recordedAt: new Date().toISOString(),
  });

  const ok = await specsStore.saveSpecs();
  if (notice) {
    notice.style.display = '';
    notice.textContent = ok
      ? `📌 Baseline saved (${_lastResponse.status} · ${_lastResponse.elapsed}ms) for ${_profile.method} ${_profile.path}.`
      : `📌 Baseline saved to browser storage (dev server offline). Start devserver.py and Save Specs to also write output/specs.json.`;
  }
}

// ── Schema validation ─────────────────────────────────────────────────────────

// Thin DOM renderer over the pure validateResponse() in tryit/schema-validator.js.
function validateResponseSchema(status, body) {
  const el = document.getElementById('rb-res-schema');
  if (!el) return;

  const { kind, message, errors } = validateResponse(_operation, _spec, status, body);
  el.innerHTML = schemaMsg(kind, message) + (errors.length
    ? `<ul class="rb-schema-errors">${errors.map(e => `<li><code>${escHtml(e.path)}</code> — ${escHtml(e.msg)}</li>`).join('')}</ul>`
    : '');
}

function schemaMsg(kind, text) {
  const icon  = kind === 'pass' ? '✅' : kind === 'fail' ? '❌' : 'ℹ️';
  const cls   = kind === 'pass' ? 'rb-schema-pass' : kind === 'fail' ? 'rb-schema-fail' : 'rb-schema-info';
  return `<div class="rb-schema-summary ${cls}">${icon} ${escHtml(text)}</div>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isJson(str) {
  try { JSON.parse(str); return true; } catch { return false; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
