let _profile   = null;   // endpoint profile from template-matcher
let _operation = null;   // raw swagger operation object
let _spec      = null;   // full swagger spec (for basePath/host)

let _activeTc         = null;   // test case currently being run
let _onSaveResult     = null;   // callback(tcId, {actual_status, elapsed, passed})

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

// ── Public API ────────────────────────────────────────────────────────────────

export function initRequestBuilder(profile, operation, spec) {
  _profile   = profile;
  _operation = operation;
  _spec      = spec;
  _activeTc  = null;

  renderEndpointInfo();
  renderPathParams();
  renderQueryParams();
  renderAuthSection();
  renderBodySection();
  resetHeadersList();
  renderDefaultHeaders();
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

// ── Active TC banner ──────────────────────────────────────────────────────────

function renderActiveTcBanner(tc) {
  const banner = document.getElementById('rb-active-tc');
  banner.style.display = '';
  banner.innerHTML = `
    <span class="rb-tc-id">${tc.id}</span>
    <span class="rb-tc-purpose">${escHtml(tc.purpose)}</span>
    <span class="rb-tc-expected">Expected: <strong>${tc.expected_status}</strong></span>
    <button class="rb-clear-tc" onclick="window.__rbClearActiveTc()">✕ Clear</button>
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

  if (tc.category === 'auth') {
    if (tc.auth_status === 'missing') {
      authType.value  = 'none';
      authValue.value = '';
    } else if (tc.auth_status === 'invalid') {
      authType.value  = 'bearer';
      authValue.value = 'invalid_token_tampered_xyz';
    } else if (tc.auth_status === 'expired') {
      authType.value  = 'bearer';
      authValue.value = '';
      authValue.placeholder = 'Paste an expired token here';
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
  const baseUrl = `${_spec.schemes?.[0] ?? 'https'}://${_spec.host}${_spec.basePath ?? ''}`;
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

  container.innerHTML = matches.map(name => `
    <div class="rb-param-row">
      <label class="rb-param-name">{${name}}</label>
      <input type="text" class="rb-param-input" data-param="${name}" placeholder="value" />
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
  document.getElementById('rb-auth-type').value  = 'none';
  document.getElementById('rb-auth-value').value = '';
  document.getElementById('rb-auth-key').value   = '';
  toggleAuthInput();
}

function renderBodySection() {
  const hasBody = ['POST','PUT','PATCH'].includes(_profile.method);
  document.getElementById('rb-body-section').style.display = hasBody ? '' : 'none';
  if (!hasBody) return;

  const bodyParam = (_operation.parameters ?? []).find(p => p.in === 'body');
  const example   = bodyParam?.schema
    ? buildExampleFromSchema(bodyParam.schema, _spec)
    : null;

  document.getElementById('rb-body').value = example !== null
    ? JSON.stringify(example, null, 2)
    : '{\n  \n}';
}

// ── Schema → example builder ──────────────────────────────────────────────────

export function buildExampleFromSchema(schema, spec, _visited = new Set()) {
  if (!schema) return null;

  // Resolve $ref
  if (schema.$ref) {
    const defName = schema.$ref.replace(/^#\/definitions\//, '');
    if (_visited.has(defName)) return {};   // break circular refs
    _visited = new Set(_visited).add(defName);
    return buildExampleFromSchema(spec?.definitions?.[defName] ?? {}, spec, _visited);
  }

  // Inline example wins
  if (schema.example !== undefined) return schema.example;

  const type = schema.type;

  if (type === 'object' || schema.properties) {
    const obj = {};
    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      obj[key] = buildExampleFromSchema(propSchema, spec, _visited);
    }
    return obj;
  }

  if (type === 'array') {
    const item = schema.items ? buildExampleFromSchema(schema.items, spec, _visited) : 'string';
    return [item];
  }

  return primitiveExample(type, schema.format, schema.enum);
}

function primitiveExample(type, format, enumVals) {
  if (enumVals?.length) return enumVals[0];

  switch (type) {
    case 'integer':
    case 'number':   return format === 'float' || format === 'double' ? 0.0 : 0;
    case 'boolean':  return false;
    case 'string':
      switch (format) {
        case 'uuid':      return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
        case 'date':      return '2024-01-01';
        case 'date-time': return '2024-01-01T00:00:00Z';
        case 'email':     return 'user@example.com';
        case 'uri':       return 'https://example.com';
        case 'password':  return 'secret';
        default:          return 'string';
      }
    default: return null;
  }
}

function renderDefaultHeaders() {
  const list    = document.getElementById('rb-headers-list');
  const hasBody = ['POST','PUT','PATCH'].includes(_profile.method);

  // Clear previous default headers; keep any user-added ones
  list.querySelectorAll('[data-default-header]').forEach(el => el.remove());

  const defaults = [
    ['Accept', 'application/json'],
    ...(hasBody ? [['Content-Type', 'application/json']] : []),
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

  let headerKey = '';
  let headerVal = '';

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
      : `<button class="rb-remove-btn" onclick="this.closest('.rb-header-row').remove()">✕</button>`
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

    const rawText    = await res.text();
    let   prettyBody = rawText;
    try { prettyBody = JSON.stringify(JSON.parse(rawText), null, 2); } catch {}

    showResponse({
      status:  res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body:    prettyBody,
      elapsed,
      url,
    });
  } catch (err) {
    const isCors = err.message === 'Failed to fetch' || err.message?.includes('NetworkError');
    showError(err.message, isCors);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Request';
  }
}

// ── URL / headers / body builders ─────────────────────────────────────────────

function buildUrl() {
  const baseUrl = document.getElementById('rb-base-url').value.trim().replace(/\/$/, '');

  // Replace path params
  let path = _profile.path;
  document.querySelectorAll('#rb-path-params [data-param]').forEach(el => {
    path = path.replace(`{${el.dataset.param}}`, encodeURIComponent(el.value.trim() || `{${el.dataset.param}}`));
  });

  // Collect query params
  const qp = new URLSearchParams();
  document.querySelectorAll('#rb-query-params [data-query]').forEach(el => {
    if (el.value.trim()) qp.set(el.dataset.query, el.value.trim());
  });

  // Auth as query param
  const authType  = document.getElementById('rb-auth-type').value;
  const authValue = document.getElementById('rb-auth-value').value.trim();
  if (authType === 'api_key_query' && authValue) {
    const keyName = document.getElementById('rb-auth-key').value.trim() || 'api_key';
    qp.set(keyName, authValue);
  }

  const qs = qp.toString();
  return baseUrl + path + (qs ? '?' + qs : '');
}

function buildHeaders() {
  const headers = {};

  // Read all header rows (default, auto-auth, and custom) in DOM order.
  // Later rows win on duplicate keys, so user-added rows override defaults.
  document.querySelectorAll('#rb-headers-list .rb-header-row').forEach(row => {
    const key = row.querySelector('.rb-header-key').value.trim();
    const val = row.querySelector('.rb-header-val').value.trim();
    if (key) headers[key] = val;
  });

  // api_key_query auth is not a header — handled in buildUrl()
  return headers;
}

function buildBody() {
  if (!['POST','PUT','PATCH'].includes(_profile.method)) return undefined;
  return document.getElementById('rb-body').value.trim() || undefined;
}

// ── Response display ──────────────────────────────────────────────────────────

function showResponse({ status, statusText, headers, body, elapsed, url }) {
  const panel = document.getElementById('rb-response');
  panel.style.display = '';

  const cls = status >= 500 ? 's5xx' : status >= 400 ? 's4xx' : 's2xx';
  document.getElementById('rb-res-status').innerHTML =
    `<span class="status ${cls}">${status}</span> ${escHtml(statusText)} <span class="rb-elapsed">${elapsed}ms</span>`;

  document.getElementById('rb-res-url').textContent = url;

  document.getElementById('rb-res-headers').textContent =
    headers.map(([k,v]) => `${k}: ${v}`).join('\n');

  const bodyEl = document.getElementById('rb-res-body');
  bodyEl.textContent = body;
  bodyEl.className   = 'rb-res-pane' + (isJson(body) ? ' json' : '');

  validateResponseSchema(status, body);

  // If a test case is active, show comparison + save button
  if (_activeTc) {
    const passed = status === _activeTc.expected_status;
    showTcComparison(_activeTc, status, elapsed, passed);
  } else {
    hideTcComparison();
  }
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
        Expected <strong>${tc.expected_status}</strong> — Got <strong>${actualStatus}</strong>
      </span>
    </div>
    <button class="rb-save-result-btn" onclick="window.__rbSaveResult(${actualStatus}, ${elapsed}, ${passed})">
      Save Result to TC-${tc.id.replace('TC-','')}
    </button>
  `;
}

function hideTcComparison() {
  const el = document.getElementById('rb-tc-comparison');
  if (el) el.style.display = 'none';
}

function showError(msg, isCors = false) {
  const panel = document.getElementById('rb-response');
  panel.style.display = '';
  document.getElementById('rb-res-status').innerHTML =
    `<span class="status s5xx">${isCors ? 'CORS Blocked' : 'Network Error'}</span>`;
  document.getElementById('rb-res-url').textContent = '';
  document.getElementById('rb-res-headers').textContent = '';
  const errBodyEl = document.getElementById('rb-res-body');
  errBodyEl.className = 'rb-res-pane';
  errBodyEl.textContent = isCors
    ? `CORS policy blocked this request (${msg}).\n\nTo fix:\n  1. Change the Base URL (top-left) to a local instance of the API,\n     e.g. http://localhost:8080/api/v1\n\n  2. Or prefix the Base URL with a CORS proxy:\n     https://corsproxy.io/? + original URL\n\n  3. Or install a browser extension that disables CORS checks\n     (e.g. "CORS Unblock" for Chrome/Firefox — for dev use only).`
    : msg;
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
}

// ── Schema validation ─────────────────────────────────────────────────────────

function validateResponseSchema(status, body) {
  const el = document.getElementById('rb-res-schema');
  if (!el) return;

  if (!_operation?.responses) {
    el.innerHTML = schemaMsg('none', `No response definitions in spec.`);
    return;
  }

  const resDef = _operation.responses[status] ?? _operation.responses['default'];
  if (!resDef) {
    el.innerHTML = schemaMsg('none', `No schema defined for status ${status}.`);
    return;
  }

  const rawSchema = resDef.schema;
  if (!rawSchema) {
    el.innerHTML = schemaMsg('none', `Response ${status} has no schema (status-only response).`);
    return;
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    el.innerHTML = schemaMsg('none', `Response body is not JSON — cannot validate schema.`);
    return;
  }

  const schema = resolveSchemaRef(rawSchema, _spec);
  const errors = [];
  validateValue(parsed, schema, _spec, 'response', errors);

  if (errors.length === 0) {
    el.innerHTML = schemaMsg('pass', `Schema valid — all fields match the spec for status ${status}.`);
  } else {
    el.innerHTML = schemaMsg('fail', `${errors.length} issue${errors.length > 1 ? 's' : ''} found for status ${status}:`)
      + `<ul class="rb-schema-errors">${errors.map(e => `<li><code>${escHtml(e.path)}</code> — ${escHtml(e.msg)}</li>`).join('')}</ul>`;
  }
}

function resolveSchemaRef(schema, spec) {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.replace(/^#\/definitions\//, '');
  return spec?.definitions?.[name] ?? schema;
}

function validateValue(value, schema, spec, path, errors, visited = new Set()) {
  if (!schema) return;

  // Resolve $ref (with circular ref guard)
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/definitions\//, '');
    if (visited.has(name)) return;
    visited = new Set(visited).add(name);
    schema = spec?.definitions?.[name];
    if (!schema) return;
  }

  const type = schema.type;

  // Type check
  if (type && value !== null && value !== undefined) {
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const expectedJs = type === 'integer' ? 'number' : type;
    if (actual !== expectedJs) {
      errors.push({ path, msg: `expected ${type}, got ${actual}` });
      return; // no point descending into wrong type
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      errors.push({ path, msg: `expected integer, got float` });
    }
  }

  if (value === null || value === undefined) return;

  // Object: check required + recurse into properties
  if ((type === 'object' || schema.properties) && typeof value === 'object' && !Array.isArray(value)) {
    const required = schema.required ?? [];
    for (const req of required) {
      if (!(req in value)) {
        errors.push({ path: `${path}.${req}`, msg: `required field missing` });
      }
    }
    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value) {
        validateValue(value[key], propSchema, spec, `${path}.${key}`, errors, visited);
      }
    }
    return;
  }

  // Array: check items
  if (type === 'array' && Array.isArray(value) && schema.items) {
    value.slice(0, 10).forEach((item, i) => {
      validateValue(item, schema.items, spec, `${path}[${i}]`, errors, visited);
    });
  }
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
