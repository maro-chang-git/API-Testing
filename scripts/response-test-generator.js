/**
 * Exploratory test generation: inspect a LIVE response body and derive
 * concrete, data-driven test cases from what the API actually returned.
 *
 * This complements template matching (which works from the swagger spec):
 * here we learn from real data — observed fields, types, and collection sizes.
 *
 * Returns an array of test-case objects shaped like template-matcher output,
 * each tagged `generated: true` and carrying an `assertion` descriptor. app.js
 * folds those assertions into the matching template case (e.g. the happy-path
 * case for the response's status) as extra scripts, so the exporters emit them
 * as real checks inside that case rather than as standalone requests.
 */
export function generateTestCasesFromResponse({ status, body, profile }) {
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return []; }                       // only JSON responses are analysable

  const cases = [];
  const add = (purpose, opts = {}) => cases.push(makeCase(purpose, status, profile, opts));

  // 1. Status / content confirmation
  add(`Response returns HTTP ${status} with a JSON body`, {
    tag: 'valid',
    assertion: { kind: 'status', status },
  });

  // 2. Shape-driven cases
  if (Array.isArray(parsed)) {
    add(`Top-level response is an array (observed ${parsed.length} item(s))`, {
      assertion: { kind: 'array-root' },
      notes: `Live response: array of ${parsed.length} item(s)`,
    });
    addItemFieldCases(parsed[0], status, profile, add);
    addIdDetailCase(parsed[0], profile, add);
  } else if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      const t = jsType(value);
      add(`Field "${key}" is present and of type ${t}`, {
        assertion: { kind: 'field', path: key, jsType: t },
        notes: `Live value: ${preview(value)}`,
      });
    }

    const collKey = detectCollection(parsed);
    if (collKey) {
      const arr = parsed[collKey];
      add(`Collection "${collKey}" returns ${arr.length} item(s)`, {
        assertion: { kind: 'count', path: collKey },
        notes: `Live count: ${arr.length}`,
      });
      addItemFieldCases(arr[0], status, profile, add, `${collKey}[0]`);
      addIdDetailCase(arr[0], profile, add);
    }
  }

  return cases;
}

// ── Case builders ──────────────────────────────────────────────────────────────

const ID_FIELDS = ['id', '_id', 'uuid', 'code', 'key', 'slug'];
const COLLECTION_KEYS = ['data', 'items', 'results', 'content', 'records', 'list', 'rows'];

function addItemFieldCases(item, status, profile, add, base = 'item') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;
  Object.entries(item).slice(0, 20).forEach(([key, value]) => {
    const t = jsType(value);
    add(`${cap(base)} field "${key}" is present and of type ${t}`, {
      assertion: { kind: 'item-field', path: key, jsType: t, collection: base },
      notes: `Live value: ${preview(value)}`,
    });
  });
}

function addIdDetailCase(item, profile, add) {
  if (!item || typeof item !== 'object') return;
  const idField = ID_FIELDS.find(f => item[f] !== undefined && item[f] !== null);
  if (!idField) return;
  const idVal = item[idField];
  add(`Fetch a single resource using observed ${idField} "${idVal}" from the list`, {
    tag: 'valid',
    notes: `Reuse this real ${idField} for a detail / 404-contrast test`,
  });
}

function makeCase(purpose, status, profile, { tag = 'data-driven', notes = '', assertion = null } = {}) {
  return {
    id: 'GEN-' + hashId(purpose),
    template_id: 'RESP-GEN',
    method: profile.method,
    endpoint: profile.path,
    summary: profile.summary,
    auth_status: 'valid',
    category: 'generated',
    tag,
    purpose,
    expected_status: status,
    notes,
    generated: true,
    ...(assertion ? { assertion } : {}),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectCollection(obj) {
  // Prefer well-known collection keys, then any array-valued field.
  for (const k of COLLECTION_KEYS) {
    if (Array.isArray(obj[k]) && obj[k].length) return k;
  }
  const anyArray = Object.entries(obj).find(([, v]) => Array.isArray(v) && v.length);
  return anyArray ? anyArray[0] : null;
}

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;   // 'string' | 'number' | 'boolean' | 'object'
}

function preview(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length} item(s)]`;
  if (typeof v === 'object') return '{…}';
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Small deterministic hash so the same observed assertion keeps the same id
// across re-sends (lets the results store and dedupe line up). Uses two seeded
// 32-bit accumulators combined into a 53-bit value (cyrb53) — far wider than a
// single 32-bit hash, so collisions across large response sets are negligible.
function hashId(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
