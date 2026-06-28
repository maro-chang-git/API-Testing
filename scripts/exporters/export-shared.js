/**
 * Logic shared by the Postman and Karate exporters. Each exporter keeps its own
 * format-specific string rendering; everything that was byte-for-byte duplicated
 * between them — key validation, assertion-shape validation, path-param
 * extraction, the body-method check and the filename slug — lives here.
 */

/** A bare identifier safe to use unquoted as an object key / dotted path. */
export function isSimpleKey(k) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
}

/** Extracts `foo` from a `foo[0]` collection reference, or null if it isn't one. */
export function parseCollectionKey(base) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[0\]$/.exec(base || '');
  return m ? m[1] : null;
}

/**
 * Validates a generated-case assertion and resolves it to a normalised shape
 * both exporters can render, or null when the assertion can't be expressed
 * safely (non-simple key, unparseable collection, unknown kind).
 *
 * Shapes:
 *   { kind: 'array-root' }
 *   { kind: 'field',      path, jsType }
 *   { kind: 'count',      path }
 *   { kind: 'item-field', collKey, path }
 */
export function normalizeAssertion(a) {
  if (!a) return null;
  if (a.kind === 'array-root') return { kind: 'array-root' };
  if (a.kind === 'field' && isSimpleKey(a.path)) {
    return { kind: 'field', path: a.path, jsType: a.jsType };
  }
  if (a.kind === 'count' && isSimpleKey(a.path)) {
    return { kind: 'count', path: a.path };
  }
  if (a.kind === 'item-field') {
    const collKey = parseCollectionKey(a.collection);
    if (collKey && isSimpleKey(a.path)) {
      return { kind: 'item-field', collKey, path: a.path };
    }
  }
  return null;
}

/** Path-template variable names, e.g. /pets/{petId}/toys/{toyId} → ['petId','toyId']. */
export function pathParamNames(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
}

/** HTTP methods that carry a request body. */
export const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

/** True when the method sends a request body. */
export function methodHasBody(method) {
  return BODY_METHODS.includes(method);
}

/** Filesystem-safe slug for an endpoint path: /a/{id}/b → a-id-b. */
export function filenameSlug(path) {
  return path.replace(/^\//, '').replace(/\//g, '-').replace(/[{}]/g, '').replace(/-+/g, '-');
}
