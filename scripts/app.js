import { loadManifest, loadSwagger, getTagsFromSpec, getEndpointsByTag } from './swagger-loader.js';
import { profileEndpoint, matchTemplates, getOperation, expectedStatuses } from './template-matcher.js';
import { initRequestBuilder, resetRequestBuilder, toggleAuthInput, addHeaderRow, sendRequest, runTestCase, clearActiveTc, saveResult, setOnResponse } from './request-builder.js';
import { exportPostman, getTestScripts, CATEGORY_ORDER } from './postman-collection-builder.js';
import { exportKarate } from './karate-feature-builder.js';
import { loadConfig } from './config-loader.js';
import { generateTestCasesFromResponse } from './response-test-generator.js';

let templates       = [];
let currentSpec     = null;
let currentProfile  = null;
let currentOperation = null;
let matchedCases    = [];
let sortCol = 'id';
let sortDir = 1;
let expandedRows = new Set();   // tc ids whose detail panel is open

// Order test cases by fixed category priority (happy_path → positive → … →
// generated), then by id within a category. Shared by the table and the JSON
// export so both read in the same order as the Postman collection's folders.
const categoryRank = c => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? CATEGORY_ORDER.length : i;
};
const compareTestCases = (a, b) =>
  (categoryRank(a.category) - categoryRank(b.category)) ||
  String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

// ── Results store (persisted per endpoint in localStorage) ─────────────────────
// resultsStore: { endpointKey → { tcId → { actual_status, elapsed, passed, tested_at } } }
// `results` always points at the current endpoint's map, so writes flow into the store.
const RESULTS_KEY = 'apitest.results.v1';
let resultsStore       = loadResultsStore();
let results            = {};
let currentEndpointKey = null;

function loadResultsStore() {
  try { return JSON.parse(localStorage.getItem(RESULTS_KEY)) || {}; }
  catch { return {}; }
}

function persistResults() {
  try { localStorage.setItem(RESULTS_KEY, JSON.stringify(resultsStore)); }
  catch { /* storage unavailable or over quota — keep results in memory only */ }
}

function endpointKey(method, path) {
  const swagger = document.getElementById('f-swagger').value;
  return `${swagger}|${method}|${path}`;
}

// Expose request-builder callbacks to inline onclick handlers
window.__rbToggleAuth    = toggleAuthInput;
window.__rbAddHeader     = () => addHeaderRow();
window.__rbSend          = sendRequest;
window.__rbClearActiveTc = () => { clearActiveTc(); };
window.__rbSaveResult    = (actualStatus, elapsed, passed) => {
  saveResult(actualStatus, elapsed, passed);
};

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const [manifest, tplData] = await Promise.all([
    loadManifest(),
    fetch('data/templates.json').then(r => r.json()),
    loadConfig(),
  ]);

  templates = tplData.templates;

  populateSwaggerSelect(manifest);
  bindFilters();
  bindTabs();
  setOnResponse(handleTryItResponse);
  renderTable([]);
  renderSummary([]);

  if (manifest.length > 0) {
    const first = manifest[0];
    document.getElementById('f-swagger').value = `${first.id}|${first.file}`;
    await onSwaggerChange(first.file);
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(`tab-${tab}`)?.classList.add('active');
}

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Response sub-tabs handled in request-builder.js module-level listener
}

// ── Swagger / Tag / Endpoint cascade ─────────────────────────────────────────

function populateSwaggerSelect(manifest) {
  const sel = document.getElementById('f-swagger');
  manifest.forEach(s => sel.appendChild(new Option(s.title, `${s.id}|${s.file}`)));
}

async function onSwaggerChange(file) {
  currentSpec = await loadSwagger(file);
  currentProfile = null;
  matchedCases = [];

  const tagSel = document.getElementById('f-tag');
  tagSel.innerHTML = '<option value="">All Tags</option>';
  getTagsFromSpec(currentSpec).forEach(tag => tagSel.appendChild(new Option(tag, tag)));
  tagSel.disabled = false;

  populateEndpoints(null);
  document.getElementById('f-endpoint').disabled = false;

  setExportVisible(false);
  renderTable([]);
  renderSummary([]);
  resetRequestBuilder();
  setPlaceholder('Select a Tag and Endpoint to generate test cases');
}

function populateEndpoints(tag) {
  const sel = document.getElementById('f-endpoint');
  sel.innerHTML = '<option value="">— Select Endpoint —</option>';
  if (!currentSpec) return;

  getEndpointsByTag(currentSpec, tag).forEach(({ path, methods }) => {
    methods.forEach(method => {
      sel.appendChild(new Option(`${method}  ${path}`, `${method}|${path}`));
    });
  });
}

function onEndpointChange(value) {
  document.getElementById('f-result').value = '';   // result filter is endpoint-specific
  expandedRows.clear();
  if (!value || !currentSpec) {
    results = {};
    currentEndpointKey = null;
    currentProfile = null;
    matchedCases = [];
    setExportVisible(false);
    renderTable([]);
    renderSummary([]);
    resetRequestBuilder();
    setPlaceholder('Select a Tag and Endpoint to generate test cases');
    return;
  }

  const [method, path] = value.split('|');
  const operation = getOperation(currentSpec, path, method);
  if (!operation) return;

  // Point `results` at this endpoint's stored map (restores any saved results).
  currentEndpointKey = endpointKey(method, path);
  results = resultsStore[currentEndpointKey] ||= {};

  currentProfile   = profileEndpoint(path, method, operation, currentSpec);
  currentOperation = operation;
  matchedCases     = matchTemplates(currentProfile, templates);

  // Expand TPL-NEG-009 into one case per disallowed method (every standard HTTP
  // method not defined on this path in the spec) so each unsupported method is
  // exercised — e.g. a GET-only path yields POST, PUT, PATCH and DELETE cases.
  // Each gets a method-suffixed id so its result persists independently.
  const ALL_HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'];
  const allowedOnPath = new Set(
    Object.keys(currentSpec.paths?.[path] ?? {}).map(k => k.toUpperCase())
  );
  const disallowedMethods = ALL_HTTP_METHODS.filter(m => !allowedOnPath.has(m));
  if (!disallowedMethods.length) disallowedMethods.push('OPTIONS');
  matchedCases = matchedCases.flatMap(tc =>
    tc.template_id === 'TPL-NEG-009'
      ? disallowedMethods.map(m => ({
          ...tc,
          id: `${tc.id}-${m}`,
          method: m,
          disallowed_method: m,
          purpose: `${tc.purpose} (${m})`,
        }))
      : [tc]
  );

  document.getElementById('api-meta').textContent =
    `${method}  ${path} — ${operation.summary || ''}`;

  setExportVisible(true);
  applyFiltersAndRender();
  initRequestBuilder(currentProfile, operation, currentSpec);
}

function runTc(tcId) {
  const tc = matchedCases.find(c => c.id === tcId);
  if (!tc) return;

  activateTab('tryit');

  runTestCase(tc, (id, result) => {
    results[id] = result;
    persistResults();
    applyFiltersAndRender();
  });
}

window.__rbRunTc = runTc;

// ── Exploratory generation from a live response ───────────────────────────────

// Auto-generation from a successful live response.
function handleTryItResponse({ status, body }) {
  if (!currentProfile) return;

  // Mirror the response into the manual "Generate" box so it can be tweaked / re-run.
  const sampleBody = document.getElementById('rb-sample-body');
  const sampleStatus = document.getElementById('rb-sample-status');
  if (sampleBody)   sampleBody.value = body;
  if (sampleStatus) sampleStatus.value = status;

  const generated = generateTestCasesFromResponse({ status, body, profile: currentProfile });
  const notice = document.getElementById('rb-gen-notice');
  if (!notice) return;

  if (!generated.length) {
    notice.style.display = '';
    notice.innerHTML = `<span class="rb-gen-icon">🧪</span> No test cases could be generated (response body is not JSON).`;
    return;
  }
  foldGeneratedCases(generated, notice);
}

// Manual generation from a pasted sample body — works even when the live call is CORS-blocked.
window.__rbGenerateFromSample = () => {
  const notice = document.getElementById('rb-gen-manual-notice');
  if (!notice) return;
  if (!currentProfile) {
    showGenMessage(notice, 'Select an endpoint first.');
    return;
  }
  const body   = document.getElementById('rb-sample-body').value.trim();
  const status = parseInt(document.getElementById('rb-sample-status').value, 10) || 200;
  if (!body) {
    showGenMessage(notice, 'Paste a JSON response body first.');
    return;
  }
  const generated = generateTestCasesFromResponse({ status, body, profile: currentProfile });
  if (!generated.length) {
    showGenMessage(notice, 'Could not parse JSON — check the body and try again.');
    return;
  }
  foldGeneratedCases(generated, notice);
};

// Fold generated cases into the current endpoint. Each generated case carries an
// observed-shape `assertion`; rather than listing it as its own row, we attach it
// as an extra test script on the best-matching template case — the case whose
// expected status matches the analysed response (e.g. a 200 body's field/shape
// checks land on the GET-200 happy case). The status-confirmation assertion is
// dropped (it just restates the host case's own status block); a generated case
// that has no scriptable assertion (e.g. a "fetch by observed id" follow-up) or
// that matches no template case is kept as a standalone row.
function foldGeneratedCases(generated, noticeEl) {
  let attached = 0;
  const orphans = [];

  generated.forEach(g => {
    if (g.assertion?.kind === 'status') return;             // redundant with the host status block

    const target = g.assertion
      ? findCaseForStatus(expectedStatuses(g.expected_status)[0])
      : null;

    if (target) {
      const list = (target.generatedAssertions ||= []);
      const sig  = JSON.stringify(g.assertion);
      if (!list.some(a => JSON.stringify(a) === sig)) { list.push(g.assertion); attached++; }
    } else {
      orphans.push(g);                                      // no scriptable assertion, or nothing to host it
    }
  });

  const existingIds  = new Set(matchedCases.map(c => c.id));
  const freshOrphans = orphans.filter(g => !existingIds.has(g.id));
  matchedCases = matchedCases.concat(freshOrphans);
  applyFiltersAndRender();

  reportGenerated(noticeEl, attached, freshOrphans.length);
}

// Best template case to host a generated assertion: among non-generated cases
// whose expected status includes `status`, the highest-priority one (happy_path
// first, via the shared category ordering used by the table and exports).
function findCaseForStatus(status) {
  const candidates = matchedCases.filter(tc =>
    !tc.generated && expectedStatuses(tc.expected_status).includes(status)
  );
  return candidates.sort(compareTestCases)[0] || null;
}

function reportGenerated(noticeEl, attached, orphanCount) {
  const parts = [];
  if (attached)    parts.push(`added <strong>${attached}</strong> assertion script${attached === 1 ? '' : 's'} to matching cases`);
  if (orphanCount) parts.push(`<strong>${orphanCount}</strong> standalone case${orphanCount === 1 ? '' : 's'}`);
  const summary = parts.length ? parts.join(' and ') : 'no new assertions (already present)';
  noticeEl.style.display = '';
  noticeEl.innerHTML = `
    <span class="rb-gen-icon">🧪</span>
    Generated: ${summary}.
    <button class="rb-gen-view-btn" onclick="window.__viewGenerated()">View in Test Cases →</button>
  `;
}

function showGenMessage(noticeEl, msg) {
  noticeEl.style.display = '';
  noticeEl.innerHTML = `<span class="rb-gen-icon">🧪</span> ${esc(msg)}`;
}

// Jump to the Test Cases tab and reveal the folded scripts: clear the category
// filter (folded assertions live on the happy/positive cases, not a "generated"
// bucket) and auto-expand every case that received them.
window.__viewGenerated = () => {
  activateTab('testcases');
  document.getElementById('f-cat').value = '';
  matchedCases.forEach(tc => { if (tc.generatedAssertions?.length) expandedRows.add(tc.id); });
  applyFiltersAndRender();
};

// ── Filter & render ───────────────────────────────────────────────────────────

function bindFilters() {
  document.getElementById('f-swagger').addEventListener('change', async e => {
    const [, file] = e.target.value.split('|');
    if (file) {
      await onSwaggerChange(file);
    } else {
      currentSpec = null;
      currentProfile = null;
      matchedCases = [];
      ['f-tag', 'f-endpoint'].forEach(id => {
        const el = document.getElementById(id);
        el.innerHTML = id === 'f-tag'
          ? '<option value="">All Tags</option>'
          : '<option value="">— Select Endpoint —</option>';
        el.disabled = true;
      });
      setExportVisible(false);
      renderTable([]);
      renderSummary([]);
      resetRequestBuilder();
      setPlaceholder('Select a Swagger to begin');
    }
  });

  document.getElementById('f-tag').addEventListener('change', e => {
    populateEndpoints(e.target.value || null);
    document.getElementById('f-endpoint').value = '';
    currentProfile = null;
    matchedCases = [];
    setExportVisible(false);
    renderTable([]);
    renderSummary([]);
    resetRequestBuilder();
    setPlaceholder('Select an Endpoint to generate test cases');
  });

  document.getElementById('f-endpoint').addEventListener('change', e => {
    onEndpointChange(e.target.value);
  });

  ['f-cat', 'f-test-status', 'f-status', 'f-result'].forEach(id =>
    document.getElementById(id).addEventListener('change', applyFiltersAndRender)
  );
  document.getElementById('f-search').addEventListener('input', applyFiltersAndRender);

  document.querySelectorAll('thead th[data-col]').forEach(th => {
    // Only columns carrying a .sort-icon are sortable (Purpose / Result / Notes
    // intentionally omit it). Skip the rest so a click can't dereference a
    // missing icon (TypeError) on those headers.
    const icon = th.querySelector('.sort-icon');
    if (!icon) return;
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortDir = sortCol === col ? sortDir * -1 : 1;
      sortCol = col;
      document.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted'));
      document.querySelectorAll('thead .sort-icon').forEach(s => { s.textContent = '↕'; });
      th.classList.add('sorted');
      icon.textContent = sortDir === 1 ? '↑' : '↓';
      applyFiltersAndRender();
    });
  });

  document.getElementById('btn-export').addEventListener('click', exportCases);
  document.getElementById('btn-postman').addEventListener('click', onExportPostman);
  document.getElementById('btn-karate').addEventListener('click', onExportKarate);

  // Swagger-UI-style: click a row to expand/collapse its detail panel.
  document.getElementById('tbody').addEventListener('click', e => {
    if (e.target.closest('.run-tc-btn')) return;      // let the Run button act on its own
    const row = e.target.closest('.tc-main-row');
    if (!row) return;
    toggleDetail(row.dataset.tcId);
  });
}

function applyFiltersAndRender() {
  if (!matchedCases.length) {
    renderSummary([]);
    renderTable([]);
    return;
  }

  const cat        = document.getElementById('f-cat').value;
  const testStatus = document.getElementById('f-test-status').value;
  const status     = document.getElementById('f-status').value;
  const result     = document.getElementById('f-result').value;
  const search     = document.getElementById('f-search').value.toLowerCase();

  let rows = matchedCases.filter(tc => {
    if (cat        && tc.category !== cat)                              return false;
    if (testStatus && tc.tag !== testStatus)                            return false;
    if (status     && !expectedStatuses(tc.expected_status).some(s => String(s).startsWith(status))) return false;
    if (search     && ![tc.id, tc.endpoint, tc.purpose, tc.notes].join(' ').toLowerCase().includes(search)) return false;
    if (result) {
      const r = results[tc.id];
      if (result === 'untested' && r)                return false;
      if (result === 'pass'     && (!r || !r.passed)) return false;
      if (result === 'fail'     && (!r || r.passed))  return false;
    }
    return true;
  });

  rows = rows.slice().sort((a, b) => {
    // The id / category columns follow the fixed category priority (not
    // alphabetical); other columns keep generic value comparison.
    if (sortCol === 'id' || sortCol === 'category') {
      return compareTestCases(a, b) * sortDir;
    }
    // Sort by the primary (first) status so array-valued cases order sensibly.
    if (sortCol === 'expected_status') {
      const sa = expectedStatuses(a.expected_status)[0] ?? 0;
      const sb = expectedStatuses(b.expected_status)[0] ?? 0;
      return (sa - sb) * sortDir;
    }
    const va = String(a[sortCol] ?? '');
    const vb = String(b[sortCol] ?? '');
    return va.localeCompare(vb, undefined, { numeric: true }) * sortDir;
  });

  renderSummary(rows);
  renderTable(rows);
  document.getElementById('count-label').textContent =
    `Showing ${rows.length} of ${matchedCases.length} matched cases`;
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function renderSummary(rows) {
  const cats = {};
  rows.forEach(tc => { cats[tc.category] = (cats[tc.category] || 0) + 1; });

  const cards = [
    { num: rows.length,               lbl: 'Matched',    cls: '' },
    { num: cats['happy_path'] || 0,   lbl: 'Happy Path', cls: 'cat-happy_path' },
    { num: cats['positive']   || 0,   lbl: 'Positive',   cls: 'cat-positive' },
    { num: cats['negative']   || 0,   lbl: 'Negative',   cls: 'cat-negative' },
    { num: cats['auth']       || 0,   lbl: 'Auth',       cls: 'cat-auth' },
    { num: cats['boundary']   || 0,   lbl: 'Boundary',   cls: 'cat-boundary' },
    ...(cats['generated'] ? [{ num: cats['generated'], lbl: 'Generated', cls: 'cat-generated' }] : []),
  ];

  document.getElementById('summary-cards').innerHTML = cards.map(c =>
    `<div class="card${c.cls ? ' ' + c.cls : ''}"><div class="num">${c.num}</div><div class="lbl">${c.lbl}</div></div>`
  ).join('');
}

// ── Table ─────────────────────────────────────────────────────────────────────

function statusClass(code) {
  if (code >= 500) return 's5xx';
  if (code >= 400) return 's4xx';
  return 's2xx';
}

// Render one coloured status badge per expected status (cases may list several).
function renderExpectedStatus(expected) {
  return expectedStatuses(expected)
    .map(c => `<span class="status ${statusClass(c)}">${esc(c)}</span>`)
    .join(' ');
}

function renderTable(rows) {
  const tbody = document.getElementById('tbody');
  const noRes = document.getElementById('no-results');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    noRes.style.display = '';
  } else {
    noRes.style.display = 'none';
    tbody.innerHTML = rows.map(tc => {
      const r   = results[tc.id];
      const resBadge = r
        ? r.passed
          ? `<span class="result-badge result-pass">✅ Pass</span><span class="result-actual">${r.actual_status} · ${r.elapsed}ms</span>`
          : `<span class="result-badge result-fail">❌ Fail</span><span class="result-actual">${r.actual_status} · ${r.elapsed}ms</span>`
        : `<span class="result-badge result-untested">—</span>`;
      const open    = expandedRows.has(tc.id);
      const rowCls  = [r ? (r.passed ? 'row-pass' : 'row-fail') : '', 'tc-main-row', open ? 'expanded' : ''].filter(Boolean).join(' ');
      return `
      <tr class="${rowCls}" data-tc-id="${esc(tc.id)}">
        <td>
          <span class="tc-caret">▸</span>
          <span class="tc-id">${esc(tc.id)}</span>
          <button class="run-tc-btn" onclick="window.__rbRunTc('${esc(tc.id)}')" title="Run in Try It">▶</button>
        </td>
        <td><span class="badge method-${esc(tc.method)}">${esc(tc.method)}</span></td>
        <td class="endpoint-cell">${esc(tc.endpoint)}</td>
        <td><span class="badge cat-${esc(tc.category)}">${esc(tc.category.replace(/_/g, ' '))}</span></td>
        <td><span class="badge tag-${esc(tc.tag ?? '')}">${esc(tc.tag ?? '—')}</span></td>
        <td class="purpose-cell">${esc(tc.purpose)}</td>
        <td>${renderExpectedStatus(tc.expected_status)}</td>
        <td>${resBadge}</td>
        <td class="notes-cell">${esc(tc.notes || '—')}</td>
      </tr>
      <tr class="tc-detail-row" data-detail-for="${esc(tc.id)}" ${open ? '' : 'style="display:none;"'}>
        <td colspan="9">${renderTcDetail(tc, r)}</td>
      </tr>`;
    }).join('');
  }
}

// Expandable detail panel (Swagger-UI style): metadata + the test scripts
// that this case will run / export.
function renderTcDetail(tc, r) {
  const meta = [
    ['Method',          `<span class="badge method-${esc(tc.method)}">${esc(tc.method)}</span>`],
    ['Endpoint',        `<span class="mono">${esc(tc.endpoint)}</span>`],
    ['Category',        `<span class="badge cat-${esc(tc.category)}">${esc(tc.category.replace(/_/g, ' '))}</span>`],
    ['Tag',             `<span class="badge tag-${esc(tc.tag ?? '')}">${esc(tc.tag ?? '—')}</span>`],
    ['Expected status', renderExpectedStatus(tc.expected_status)],
    ['Auth',            esc(tc.auth_status ?? '—')],
    ['Template',        esc(tc.template_id ?? '—')],
    ['Last result',     r ? `${r.passed ? '✅ Pass' : '❌ Fail'} · ${esc(r.actual_status)} · ${esc(r.elapsed)}ms` : '<span class="tc-muted">not run</span>'],
  ];

  const scripts = getTestScripts(tc);
  const scriptList = scripts.map(s => `
    <li class="tc-script">
      <div class="tc-script-name">✔ ${esc(s.name)}</div>
      <pre class="tc-script-code">${esc(s.code)}</pre>
    </li>`).join('');

  return `
    <div class="tc-detail">
      <div class="tc-detail-grid">
        ${meta.map(([k, v]) => `<div class="tc-detail-cell"><span class="tc-detail-k">${k}</span><span class="tc-detail-v">${v}</span></div>`).join('')}
      </div>
      <div class="tc-detail-section">
        <div class="tc-detail-label">Purpose</div>
        <p class="tc-detail-text">${esc(tc.purpose)}</p>
      </div>
      ${tc.notes ? `
      <div class="tc-detail-section">
        <div class="tc-detail-label">Notes</div>
        <p class="tc-detail-text">${esc(tc.notes)}</p>
      </div>` : ''}
      <div class="tc-detail-section">
        <div class="tc-detail-label">Test Scripts <span class="tc-detail-count">${scripts.length}</span></div>
        <ol class="tc-script-list">${scriptList}</ol>
      </div>
    </div>`;
}

function toggleDetail(id) {
  const open = !expandedRows.has(id);
  if (open) expandedRows.add(id); else expandedRows.delete(id);

  const detail = document.querySelector(`.tc-detail-row[data-detail-for="${CSS.escape(id)}"]`);
  const main   = document.querySelector(`.tc-main-row[data-tc-id="${CSS.escape(id)}"]`);
  if (detail) detail.style.display = open ? '' : 'none';
  if (main)   main.classList.toggle('expanded', open);
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportCases() {
  if (!currentProfile || !matchedCases.length) return;

  const slug = currentProfile.path
    .replace(/^\//,'')
    .replace(/\//g, '-')
    .replace(/[{}]/g, '')
    .replace(/-+/g, '-');

  const filename = `api-${currentProfile.method.toLowerCase()}-${slug}-testcases.json`;

  const payload = {
    generated_at: new Date().toISOString(),
    swagger_endpoint: {
      method: currentProfile.method,
      path: currentProfile.path,
      summary: currentProfile.summary,
      auth_type: currentProfile.auth_type,
    },
    testcases: matchedCases.slice().sort(compareTestCases).map(tc => ({
      ...tc,
      ...(results[tc.id] ? { result: results[tc.id] } : {}),
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function onExportPostman() {
  if (!currentProfile || !matchedCases.length || !currentSpec) return;
  exportPostman(currentProfile, currentOperation, currentSpec, matchedCases);
}

function onExportKarate() {
  if (!currentProfile || !matchedCases.length || !currentSpec) return;
  exportKarate(currentProfile, currentOperation, currentSpec, matchedCases);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setExportVisible(show) {
  document.getElementById('btn-export').style.display  = show ? '' : 'none';
  document.getElementById('btn-postman').style.display = show ? '' : 'none';
  document.getElementById('btn-karate').style.display  = show ? '' : 'none';
  document.getElementById('rb-gen-section').style.display = show ? '' : 'none';
}

function setPlaceholder(msg) {
  document.getElementById('no-results').textContent = msg;
  document.getElementById('no-results').style.display = '';
  document.getElementById('count-label').textContent = '';
}

init();
