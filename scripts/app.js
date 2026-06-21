import { loadManifest, loadSwagger, getTagsFromSpec, getEndpointsByTag } from './swagger-loader.js';
import { profileEndpoint, matchTemplates, getOperation } from './template-matcher.js';
import { initRequestBuilder, resetRequestBuilder, toggleAuthInput, addHeaderRow, sendRequest, runTestCase, clearActiveTc, saveResult } from './request-builder.js';

let templates    = [];
let currentSpec  = null;
let currentProfile = null;
let matchedCases = [];
let results      = {};   // tcId → { actual_status, elapsed, passed, tested_at }
let sortCol = 'id';
let sortDir = 1;

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
  ]);

  templates = tplData.templates;

  populateSwaggerSelect(manifest);
  bindFilters();
  bindTabs();
  renderTable([]);
  renderSummary([]);

  if (manifest.length > 0) {
    const first = manifest[0];
    document.getElementById('f-swagger').value = `${first.id}|${first.file}`;
    await onSwaggerChange(first.file);
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });

  // Response sub-tabs inside Try It
  document.addEventListener('click', e => {
    const btn = e.target.closest('.rb-res-tab');
    if (!btn) return;
    const target = btn.dataset.resTab;
    document.querySelectorAll('.rb-res-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('rb-res-body').style.display    = target === 'body'    ? '' : 'none';
    document.getElementById('rb-res-headers').style.display = target === 'headers' ? '' : 'none';
  });
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
  results = {};
  if (!value || !currentSpec) {
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

  currentProfile = profileEndpoint(path, method, operation);
  matchedCases = matchTemplates(currentProfile, templates);

  document.getElementById('api-meta').textContent =
    `${method}  ${path} — ${operation.summary || ''}`;

  setExportVisible(true);
  applyFiltersAndRender();
  initRequestBuilder(currentProfile, operation, currentSpec);
}

function runTc(tcId) {
  const tc = matchedCases.find(c => c.id === tcId);
  if (!tc) return;

  // Switch to Try It tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="tryit"]').classList.add('active');
  document.getElementById('tab-tryit').classList.add('active');

  runTestCase(tc, (id, result) => {
    results[id] = result;
    applyFiltersAndRender();
  });
}

window.__rbRunTc = runTc;

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
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortDir = sortCol === col ? sortDir * -1 : 1;
      sortCol = col;
      document.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.sort-icon').textContent = sortDir === 1 ? '↑' : '↓';
      applyFiltersAndRender();
    });
  });

  document.getElementById('btn-export').addEventListener('click', exportCases);
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
    if (status     && !String(tc.expected_status).startsWith(status))  return false;
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
      return `
      <tr class="${r ? (r.passed ? 'row-pass' : 'row-fail') : ''}">
        <td>
          <span class="tc-id">${tc.id}</span>
          <button class="run-tc-btn" onclick="window.__rbRunTc('${tc.id}')" title="Run in Try It">▶</button>
        </td>
        <td><span class="badge method-${tc.method}">${tc.method}</span></td>
        <td class="endpoint-cell">${tc.endpoint}</td>
        <td><span class="badge cat-${tc.category}">${tc.category.replace(/_/g, ' ')}</span></td>
        <td><span class="badge tag-${tc.tag ?? ''}">${tc.tag ?? '—'}</span></td>
        <td class="purpose-cell">${tc.purpose}</td>
        <td><span class="status ${statusClass(tc.expected_status)}">${tc.expected_status}</span></td>
        <td>${resBadge}</td>
        <td class="notes-cell">${tc.notes || '—'}</td>
      </tr>`;
    }).join('');
  }
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
    testcases: matchedCases.map(tc => ({
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function setExportVisible(show) {
  document.getElementById('btn-export').style.display = show ? '' : 'none';
}

function setPlaceholder(msg) {
  document.getElementById('no-results').textContent = msg;
  document.getElementById('no-results').style.display = '';
  document.getElementById('count-label').textContent = '';
}

init();
