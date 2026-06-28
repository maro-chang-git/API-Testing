/**
 * Renders the test-case table: the summary cards, the rows (with per-row result
 * badges and the expandable Swagger-UI-style detail panel), and the row
 * expand/collapse toggle. All state is passed in by app.js — this module owns
 * no mutable state of its own beyond the DOM it writes.
 */
import { esc } from './dom.js';
import { statusClass } from '../core/status-utils.js';
import { expectedStatuses } from '../core/template-matcher.js';
import { getTestScripts } from '../exporters/postman-collection-builder.js';

// ── Summary cards ─────────────────────────────────────────────────────────────

export function renderSummary(rows) {
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

// Render one coloured status badge per expected status (cases may list several).
function renderExpectedStatus(expected) {
  return expectedStatuses(expected)
    .map(c => `<span class="status ${statusClass(c)}">${esc(c)}</span>`)
    .join(' ');
}

export function renderTable(rows, results = {}, expandedRows = new Set()) {
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
          <button class="run-tc-btn" title="Run in Try It">▶</button>
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

// Toggle a row's detail panel open/closed, updating both `expandedRows` and the DOM.
export function toggleDetail(id, expandedRows) {
  const open = !expandedRows.has(id);
  if (open) expandedRows.add(id); else expandedRows.delete(id);

  const detail = document.querySelector(`.tc-detail-row[data-detail-for="${CSS.escape(id)}"]`);
  const main   = document.querySelector(`.tc-main-row[data-tc-id="${CSS.escape(id)}"]`);
  if (detail) detail.style.display = open ? '' : 'none';
  if (main)   main.classList.toggle('expanded', open);
}
