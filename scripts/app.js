import { loadManifest, loadSwagger, getTagsFromSpec, getEndpointsByTag } from './core/swagger-loader.js';
import { profileEndpoint, matchTemplates, getOperation, authEnforced } from './core/template-matcher.js';
import { initRequestBuilder, resetRequestBuilder, runTestCase, setOnResponse, captureTryItAuth, captureTryItBody, captureTryItBaseUrl, captureTryItHeader } from './tryit/request-ui.js';
import { exportPostman } from './exporters/postman-collection-builder.js';
import { exportKarate } from './exporters/karate-feature-builder.js';
import { loadConfig } from './core/config-loader.js';
import * as specsStore from './specs-store.js';
import { generateTestCasesFromResponse } from './generate/response-test-generator.js';
import { compareTestCases } from './core/case-order.js';
import { REQUEST_TYPES, DEFAULT_REQUEST_TYPE, requestTypeOptionLabel } from './core/request-types.js';
import { expandMethodNotAllowed } from './core/case-expander.js';
import { filterAndSort } from './ui/filter-sort.js';
import { esc } from './ui/dom.js';
import { activateTab, bindTabs } from './ui/tabs.js';
import { renderSummary, renderTable, toggleDetail } from './ui/table-render.js';
import { foldGeneratedCases as foldGenerated } from './generate/case-folder.js';
import { loadResultsStore, saveResultsStore, endpointKey } from './state/results-store.js';
import { filenameSlug } from './exporters/export-shared.js';

let manifest        = [];       // swaggers/index.json entries
let currentSwagger  = null;     // { id, file, title } of the selected swagger
let templates       = [];
let currentSpec     = null;
let currentProfile  = null;
let currentOperation = null;
let matchedCases    = [];
let sortCol = 'id';
let sortDir = 1;
let expandedRows = new Set();   // tc ids whose detail panel is open

// Test-case ordering (category priority, then id) is single-sourced in
// core/case-order.js — see compareTestCases — so the table, JSON export and both
// exporters list cases in the same order.

// ── Results store (persisted per endpoint in localStorage) ─────────────────────
// resultsStore: { endpointKey → { tcId → { actual_status, elapsed, passed, tested_at } } }
// `results` always points at the current endpoint's map, so writes flow into the store.
// Load / persist / keying live in state/results-store.js.
let resultsStore       = loadResultsStore();
let results            = {};
let currentEndpointKey = null;

const persistResults = () => saveResultsStore(resultsStore);

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  // loadConfig() resolves to nothing — it populates config-loader's module state
  // (read app-wide via getConfig()). Kick it off alongside the data fetches so it
  // still loads concurrently, but await it explicitly instead of destructuring and
  // discarding a Promise.all slot that hides the real side-effect dependency.
  const configReady = loadConfig();
  const [manifestData, tplData] = await Promise.all([
    loadManifest(),
    fetch('data/templates.json').then(r => r.json()),
  ]);
  await configReady;

  manifest  = manifestData;
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
    await onSwaggerChange(`${first.id}|${first.file}`);
  }
}

// ── Swagger / Tag / Endpoint cascade ─────────────────────────────────────────

function populateSwaggerSelect(manifest) {
  const sel = document.getElementById('f-swagger');
  manifest.forEach(s => sel.appendChild(new Option(s.title, `${s.id}|${s.file}`)));
}

async function onSwaggerChange(value) {
  const [id, file] = value.split('|');
  currentSwagger = manifest.find(m => m.id === id) || { id, file, title: '' };

  currentSpec = await loadSwagger(file);
  // Load the per-swagger specs (or scaffold from the spec + config) so Try It
  // defaults and exports read from output/{id}/specs.json.
  await specsStore.loadOrScaffoldSpecs(currentSwagger, currentSpec);
  currentProfile = null;
  matchedCases = [];

  document.getElementById('btn-save-specs').style.display = '';

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
    setRequestTypeVisible(false);
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
  currentEndpointKey = endpointKey(currentSwagger.id, method, path);
  results = resultsStore[currentEndpointKey] ||= {};
  currentOperation = operation;

  // Reflect the saved request type (loaded with the rest of the specs) into the
  // toolbar dropdown, then derive cases for it.
  syncRequestTypeSelect(method, path);
  deriveAndRenderEndpoint(method, path, operation);
}

// Profiles the endpoint (applying the persisted auth-required + request-type
// overrides), matches templates, expands the 405 cases, and renders the table +
// Try It tab. Re-runnable so the request-type dropdown can refresh in place.
function deriveAndRenderEndpoint(method, path, operation) {
  currentProfile = profileEndpoint(path, method, operation, currentSpec);
  // Honor a per-endpoint auth-required override from specs.json (set by Try It
  // auth discovery or hand-edited) — the spec often marks auth as optional when
  // the endpoint really enforces it.
  currentProfile.auth_required =
    specsStore.effectiveAuthRequired(method, path, currentProfile.auth_required);
  // Request type is a manual, per-endpoint selection (no spec auto-detection); it
  // drives the handler seam in the exporters + Try It (e.g. 'stream' → SSE).
  currentProfile.request_type       = specsStore.effectiveRequestType(method, path);
  currentProfile.response_is_stream = currentProfile.request_type === 'stream';
  matchedCases     = matchTemplates(currentProfile, templates);

  // Expand TPL-NEG-009 into one case per disallowed method (every standard HTTP
  // method not defined on this path in the spec) so each unsupported method is
  // exercised — e.g. a GET-only path yields POST, PUT, PATCH and DELETE cases.
  // Each gets a method-suffixed id so its result persists independently.
  const allowedOnPath = Object.keys(currentSpec.paths?.[path] ?? {});
  matchedCases = expandMethodNotAllowed(matchedCases, allowedOnPath);

  document.getElementById('api-meta').textContent =
    `${method}  ${path} — ${operation.summary || ''}`;

  setExportVisible(true);
  applyFiltersAndRender();
  initRequestBuilder(currentProfile, operation, currentSpec, currentSwagger.id);
}

// Persists the picked request type to specs.json immediately and re-derives the
// cases + Try It so the new handler routing takes effect at once.
async function onRequestTypeChange(value) {
  if (!currentProfile) return;
  const { method, path } = currentProfile;
  specsStore.setRequestType(method, path, value);
  deriveAndRenderEndpoint(method, path, currentOperation);
  const saved = await specsStore.saveSpecs();
  flashButton('btn-save-specs', 'Save Specs', saved ? 'Type saved ✓' : 'Saved locally');
}

// Mirrors the saved/effective request type into the toolbar dropdown and enables it.
function syncRequestTypeSelect(method, path) {
  const sel = document.getElementById('f-request-type');
  if (!sel) return;
  sel.value = specsStore.effectiveRequestType(method, path);
  setRequestTypeVisible(true);
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

// ── Exploratory generation from a live response ───────────────────────────────

// Auto-generation from a successful live response.
function handleTryItResponse({ status, body, stream = null }) {
  if (!currentProfile) return;

  // Mirror the response into the manual "Generate" box so it can be tweaked / re-run.
  const sampleBody = document.getElementById('rb-sample-body');
  const sampleStatus = document.getElementById('rb-sample-status');
  if (sampleBody)   sampleBody.value = body;
  if (sampleStatus) sampleStatus.value = status;

  const notice = document.getElementById('rb-gen-notice');

  // Streaming (SSE) responses carry no JSON body to derive assertions from —
  // skip data-driven generation and say so plainly instead of "not JSON".
  if (stream) {
    if (notice) {
      notice.style.display = '';
      notice.innerHTML = `<span class="rb-gen-icon">🌊</span> Streaming response (text/event-stream) — ${stream.count} events received. Data-driven test generation is skipped for streams.`;
    }
    return;
  }

  // A 401/403 proves this endpoint enforces auth even though the spec marked it
  // optional/anonymous — flip it, add the auth test cases, and stop (an error
  // response is not a useful baseline for data-driven generation).
  if (authEnforced(status) && !currentProfile.auth_required) {
    enableAuthCases(status, notice);
    return;
  }

  const generated = generateTestCasesFromResponse({ status, body, profile: currentProfile });
  if (!notice) return;

  if (!generated.length) {
    notice.style.display = '';
    notice.innerHTML = `<span class="rb-gen-icon">🧪</span> No test cases could be generated (response body is not JSON).`;
    return;
  }
  foldGeneratedCases(generated, notice);
}

// Manual generation from a pasted sample body — works even when the live call is CORS-blocked.
function generateFromSample() {
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
}

// Marks the current endpoint auth-required (a live 401/403 revealed it enforces
// auth despite the spec), merges in the now-matching auth-category cases without
// disturbing existing template/folded cases, and notifies. The flag is recorded
// in the specs model so Save Specs persists it and reload keeps the auth cases.
function enableAuthCases(status, noticeEl) {
  const { method, path } = currentProfile;
  currentProfile.auth_required = true;
  specsStore.setAuthRequired(method, path, true);

  const authCases = matchTemplates(currentProfile, templates).filter(c => c.category === 'auth');
  const have = new Set(matchedCases.map(c => c.id));
  const added = authCases.filter(c => !have.has(c.id));
  matchedCases = [...matchedCases, ...added];

  applyFiltersAndRender();

  if (noticeEl) {
    noticeEl.style.display = '';
    noticeEl.innerHTML = `<span class="rb-gen-icon">🔒</span> This endpoint returned <strong>${status}</strong> — added ${added.length} authentication test case${added.length === 1 ? '' : 's'}. Click <strong>Save Specs</strong> to persist.`;
  }
}

// Fold generated cases into the current endpoint (see generate/case-folder.js),
// then re-render and report what changed.
function foldGeneratedCases(generated, noticeEl) {
  const res = foldGenerated(matchedCases, generated);
  matchedCases = res.matchedCases;
  applyFiltersAndRender();
  reportGenerated(noticeEl, res.attached, res.orphanCount);
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
    <button class="rb-gen-view-btn" data-view-generated>View in Test Cases →</button>
  `;
}

function showGenMessage(noticeEl, msg) {
  noticeEl.style.display = '';
  noticeEl.innerHTML = `<span class="rb-gen-icon">🧪</span> ${esc(msg)}`;
}

// Jump to the Test Cases tab and reveal the folded scripts: clear the category
// filter (folded assertions live on the happy/positive cases, not a "generated"
// bucket) and auto-expand every case that received them.
function viewGenerated() {
  activateTab('testcases');
  document.getElementById('f-cat').value = '';
  matchedCases.forEach(tc => { if (tc.generatedAssertions?.length) expandedRows.add(tc.id); });
  applyFiltersAndRender();
}

// ── Filter & render ───────────────────────────────────────────────────────────

function bindFilters() {
  document.getElementById('f-swagger').addEventListener('change', async e => {
    if (e.target.value) {
      await onSwaggerChange(e.target.value);
    } else {
      currentSwagger = null;
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
      document.getElementById('btn-save-specs').style.display = 'none';
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

  // Request-type dropdown: populate the (mostly not-yet-implemented) options once,
  // then persist + re-derive on each manual change.
  populateRequestTypeSelect();
  document.getElementById('f-request-type').addEventListener('change', e => {
    onRequestTypeChange(e.target.value);
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
  document.getElementById('btn-save-specs').addEventListener('click', onSaveSpecs);

  // Row interactions (delegated — rows are re-rendered on every filter/sort).
  // The ▶ Run button runs the case in Try It; clicking anywhere else on the row
  // expands/collapses its Swagger-UI-style detail panel.
  document.getElementById('tbody').addEventListener('click', e => {
    const row = e.target.closest('.tc-main-row');
    if (!row) return;
  if (e.target.closest('.run-tc-btn')) {
      runTc(row.dataset.tcId);
      return;
    }
    toggleDetail(row.dataset.tcId, expandedRows);
  });

  // Manual "Generate from sample" button + the delegated "View in Test Cases"
  // link that the generation notices render on demand (Try It panel).
  document.getElementById('rb-gen-btn').addEventListener('click', generateFromSample);
  document.getElementById('tab-tryit').addEventListener('click', e => {
    if (e.target.closest('[data-view-generated]')) viewGenerated();
  });
}

function applyFiltersAndRender() {
  if (!matchedCases.length) {
    renderSummary([]);
    renderTable([]);
    return;
  }

  const filters = {
    cat:        document.getElementById('f-cat').value,
    testStatus: document.getElementById('f-test-status').value,
    status:     document.getElementById('f-status').value,
    result:     document.getElementById('f-result').value,
    search:     document.getElementById('f-search').value,
  };

  const rows = filterAndSort(matchedCases, filters, { col: sortCol, dir: sortDir }, results);

  renderSummary(rows);
  renderTable(rows, results, expandedRows);
  document.getElementById('count-label').textContent =
    `Showing ${rows.length} of ${matchedCases.length} matched cases`;
}

// ── Export ────────────────────────────────────────────────────────────────────

async function exportCases() {
  if (!currentProfile || !matchedCases.length || !currentSwagger) return;

  const filename = `api-${currentProfile.method.toLowerCase()}-${filenameSlug(currentProfile.path)}-testcases.json`;

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

  // Write alongside specs.json under output/{id}/ (falls back to a browser
  // download when the dev server isn't running).
  const saved = await specsStore.saveOrDownload(
    `output/${currentSwagger.id}/${filename}`,
    filename,
    JSON.stringify(payload, null, 2),
    'application/json',
  );
  flashButton('btn-export', 'Export JSON', saved ? 'Saved ✓' : 'Downloaded ↓');
}

async function onExportPostman() {
  if (!currentProfile || !matchedCases.length || !currentSpec || !currentSwagger) return;
  const saved = await exportPostman(currentProfile, currentOperation, currentSpec, matchedCases, currentSwagger.id);
  flashButton('btn-postman', 'Export Postman', saved ? 'Saved ✓' : 'Downloaded ↓');
}

async function onExportKarate() {
  if (!currentProfile || !matchedCases.length || !currentSpec || !currentSwagger) return;
  const saved = await exportKarate(currentProfile, currentOperation, currentSpec, matchedCases, currentSwagger.id);
  flashButton('btn-karate', 'Export Karate', saved ? 'Saved ✓' : 'Downloaded ↓');
}

// Persists the per-swagger specs file (output/{id}/specs.json).
async function onSaveSpecs() {
  if (!currentSwagger) return;
  // Fold the base URL + token + headers + request body entered in Try It into the specs before saving.
  captureTryItBaseUrl();
  captureTryItAuth();
  captureTryItHeader();
  captureTryItBody();
  const saved = await specsStore.saveSpecs();
  flashButton('btn-save-specs', 'Save Specs', saved ? 'Saved ✓' : 'Saved locally');
}

// Briefly swaps a button's label to confirm an action, then restores it.
function flashButton(id, label, msg) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = label; }, 1600);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setExportVisible(show) {
  document.getElementById('btn-export').style.display  = show ? '' : 'none';
  document.getElementById('btn-postman').style.display = show ? '' : 'none';
  document.getElementById('btn-karate').style.display  = show ? '' : 'none';
  document.getElementById('rb-gen-section').style.display = show ? '' : 'none';
}

// Fills the request-type dropdown from the single-source REQUEST_TYPES list,
// flagging the not-yet-implemented types in their label.
function populateRequestTypeSelect() {
  const sel = document.getElementById('f-request-type');
  if (!sel) return;
  sel.innerHTML = '';
  for (const type of REQUEST_TYPES) {
    sel.appendChild(new Option(requestTypeOptionLabel(type), type.key));
  }
  sel.value = DEFAULT_REQUEST_TYPE;
}

function setRequestTypeVisible(show) {
  const sel = document.getElementById('f-request-type');
  if (sel) sel.disabled = !show;
}

function setPlaceholder(msg) {
  document.getElementById('no-results').textContent = msg;
  document.getElementById('no-results').style.display = '';
  document.getElementById('count-label').textContent = '';
}

init();
