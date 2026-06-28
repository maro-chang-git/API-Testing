/**
 * Single source for test-case category ordering — used by the table, the JSON
 * export, and both the Postman and Karate exporters so every view lists cases
 * in the same order: happy_path → positive → negative → auth → boundary →
 * generated.
 */

export const CATEGORY_ORDER = ['happy_path', 'positive', 'negative', 'auth', 'boundary', 'generated'];

export const CATEGORY_LABEL = {
  happy_path: 'Happy Path',
  positive:   'Positive',
  negative:   'Negative',
  auth:       'Auth',
  boundary:   'Boundary',
  generated:  'Generated (from response)',
};

/** Rank of a category in CATEGORY_ORDER; unknown categories sort last. */
export function categoryRank(c) {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Comparator that orders cases by fixed category priority, then by id within a
 * category (numeric-aware so TC-…-002 precedes TC-…-010).
 */
export function compareTestCases(a, b) {
  return (categoryRank(a.category) - categoryRank(b.category)) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}
