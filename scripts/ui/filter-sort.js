/**
 * Pure filter + sort for the test-case table. No DOM access: app.js reads the
 * filter inputs and current sort, calls filterAndSort(), and hands the resulting
 * rows to the renderer. Keeping this pure makes the table logic unit-testable.
 */
import { expectedStatuses } from '../core/template-matcher.js';
import { compareTestCases } from '../core/case-order.js';

/**
 * @param {Array}  cases   - matched test cases
 * @param {object} filters - { cat, testStatus, status, result, search }
 * @param {object} results - { tcId → { passed, … } } for the current endpoint
 */
export function filterCases(cases, filters, results) {
  const { cat, testStatus, status, result } = filters;
  const search = (filters.search || '').toLowerCase();

  return cases.filter(tc => {
    if (cat        && tc.category !== cat)   return false;
    if (testStatus && tc.tag !== testStatus) return false;
    if (status     && !expectedStatuses(tc.expected_status).some(s => String(s).startsWith(status))) return false;
    if (search     && ![tc.id, tc.endpoint, tc.purpose, tc.notes].join(' ').toLowerCase().includes(search)) return false;
    if (result) {
      const r = results[tc.id];
      if (result === 'untested' && r)                 return false;
      if (result === 'pass'     && (!r || !r.passed)) return false;
      if (result === 'fail'     && (!r || r.passed))  return false;
    }
    return true;
  });
}

/**
 * Sorts a copy of `cases`. The id / category columns follow the fixed category
 * priority (not alphabetical); expected_status sorts by primary status; every
 * other column uses numeric-aware string comparison. `dir` is 1 or -1.
 */
export function sortCases(cases, col, dir) {
  return cases.slice().sort((a, b) => {
    if (col === 'id' || col === 'category') {
      return compareTestCases(a, b) * dir;
    }
    if (col === 'expected_status') {
      const sa = expectedStatuses(a.expected_status)[0] ?? 0;
      const sb = expectedStatuses(b.expected_status)[0] ?? 0;
      return (sa - sb) * dir;
    }
    const va = String(a[col] ?? '');
    const vb = String(b[col] ?? '');
    return va.localeCompare(vb, undefined, { numeric: true }) * dir;
  });
}

/** Filter then sort — the table's row pipeline. `sort` is { col, dir }. */
export function filterAndSort(cases, filters, sort, results) {
  return sortCases(filterCases(cases, filters, results), sort.col, sort.dir);
}
