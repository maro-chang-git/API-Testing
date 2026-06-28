/**
 * Folds exploratory "generated" cases (derived from an observed response) into
 * the matched test cases.
 *
 * Each generated case carries an observed-shape `assertion`; rather than listing
 * it as its own row, we attach it as an extra script on the best-matching
 * template case — the case whose expected status matches the analysed response
 * (e.g. a 200 body's field/shape checks land on the GET-200 happy case). The
 * status-confirmation assertion is dropped (it just restates the host case's own
 * status block); a generated case with no scriptable assertion, or that matches
 * no template case, is kept as a standalone row.
 *
 * Pure: takes the current matchedCases + generated cases and returns the new
 * matchedCases plus counts. (It does mutate `generatedAssertions` on the host
 * case objects, exactly as the in-place version did.)
 */
import { expectedStatuses } from '../core/template-matcher.js';
import { compareTestCases } from '../core/case-order.js';

/**
 * Best template case to host a generated assertion: among non-generated cases
 * whose expected status includes `status`, the highest-priority one (happy_path
 * first, via the shared category ordering used by the table and exports).
 */
export function findCaseForStatus(matchedCases, status) {
  const candidates = matchedCases.filter(tc =>
    !tc.generated && expectedStatuses(tc.expected_status).includes(status)
  );
  return candidates.sort(compareTestCases)[0] || null;
}

/**
 * @returns {{ matchedCases: Array, attached: number, orphanCount: number }}
 *   matchedCases — the original cases plus any standalone orphan cases
 *   attached     — number of assertion scripts folded onto host cases
 *   orphanCount  — number of fresh standalone cases added
 */
export function foldGeneratedCases(matchedCases, generated) {
  let attached = 0;
  const orphans = [];

  generated.forEach(g => {
    if (g.assertion?.kind === 'status') return;             // redundant with the host status block

    const target = g.assertion
      ? findCaseForStatus(matchedCases, expectedStatuses(g.expected_status)[0])
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
  return {
    matchedCases: matchedCases.concat(freshOrphans),
    attached,
    orphanCount: freshOrphans.length,
  };
}
