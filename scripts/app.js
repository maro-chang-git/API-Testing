import { loadManifest, loadSwagger, getTagsFromSpec, getEndpointsByTag } from './swagger-loader.js';
import { profileEndpoint, matchTemplates, getOperation } from './template-matcher.js';

let templates = [];
let currentSpec = null;
let currentProfile = null;
let matchedCases = [];
let sortCol = 'id';
let sortDir = 1;

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const [manifest, tplData] = await Promise.all([
    loadManifest(),
    fetch('data/templates.json').then(r => r.json()),
  ]);

  templates = tplData.templates;

  populateSwaggerSelect(manifest);
  bindFilters();
  renderTable([]);
  renderSummary([]);

  if (manifest.length > 0) {
    const first = manifest[0];
    document.getElementById('f-swagger').value = `${first.id}|${first.file}`;
    await onSwaggerChange(first.file);
  }
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
  if (!value || !currentSpec) {
    currentProfile = null;
    matchedCases = [];
    setExportVisible(false);
    renderTable([]);
    renderSummary([]);
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
}

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
    setPlaceholder('Select an Endpoint to generate test cases');
  });

  document.getElementById('f-endpoint').addEventListener('change', e => {
    onEndpointChange(e.target.value);
  });

  ['f-cat', 'f-test-status', 'f-status'].forEach(id =>
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
  const search     = document.getElementById('f-search').value.toLowerCase();

  let rows = matchedCases.filter(tc => {
    if (cat        && tc.category    !== cat)        return false;
    if (testStatus && tc.tag !== testStatus) return false;
    if (status     && !String(tc.expected_status).startsWith(status)) return false;
    if (search     && ![tc.id, tc.endpoint, tc.purpose, tc.notes].join(' ').toLowerCase().includes(search)) return false;
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
    tbody.innerHTML = rows.map(tc => `
      <tr>
        <td><span class="tc-id">${tc.id}</span></td>
        <td><span class="badge method-${tc.method}">${tc.method}</span></td>
        <td class="endpoint-cell">${tc.endpoint}</td>
        <td><span class="badge cat-${tc.category}">${tc.category.replace(/_/g, ' ')}</span></td>
        <td><span class="badge tag-${tc.tag ?? ''}">${tc.tag ?? '—'}</span></td>
        <td class="purpose-cell">${tc.purpose}</td>
        <td><span class="status ${statusClass(tc.expected_status)}">${tc.expected_status}</span></td>
        <td class="notes-cell">${tc.notes || '—'}</td>
      </tr>
    `).join('');
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
    testcases: matchedCases,
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
