/**
 * Shared request-body layer for all test generators (Postman, Karate, future generators).
 *
 * getTestBody() returns a format-agnostic descriptor { kind, data }.
 * Each generator converts that descriptor into its own output format.
 *
 * kind values (BODY_KIND):
 *   VALID     – reference the pre-defined valid body (vars / Background def)
 *   EMPTY     – send {} (missing-fields test)
 *   OBJECT    – send the plain object in `data` (type / range / huge-payload tests)
 *   MALFORMED – send the raw string in `data` as-is (not valid JSON)
 */
import { expectedStatuses } from '../core/template-matcher.js';

export const BODY_KIND = Object.freeze({
  VALID:    'valid',
  EMPTY:    'empty',
  OBJECT:   'object',
  MALFORMED:'malformed',
});

/**
 * Returns a body descriptor for the given test case.
 *
 * @param {object} tc         - test case (needs template_id, category, expected_status)
 * @param {object} exampleObj - schema-derived example body (from buildExampleFromSchema)
 * @returns {{ kind: string, data?: object|string }}
 */
export function getTestBody(tc, exampleObj) {
  // Decide success-vs-negative body from the primary (first) expected status.
  const primaryStatus = expectedStatuses(tc.expected_status)[0];
  const is2xx = primaryStatus >= 200 && primaryStatus < 300;

  // Success cases, auth cases, and NEG-008 (intentional duplicate) all send
  // the valid body — only the status code or auth header differ.
  if (is2xx || tc.category === 'auth' || tc.template_id === 'TPL-NEG-008') {
    return { kind: BODY_KIND.VALID };
  }

  // Non-object bodies (array, scalar, null) cannot be meaningfully mutated.
  if (!exampleObj || typeof exampleObj !== 'object' || Array.isArray(exampleObj)) {
    return { kind: BODY_KIND.VALID };
  }

  const entries = Object.entries(exampleObj);

  switch (tc.template_id) {

    // Send an empty body so all required fields are absent.
    case 'TPL-NEG-001':
      return { kind: BODY_KIND.EMPTY };

    // Flip every field to the wrong type (string→number, number→string, boolean→string).
    case 'TPL-NEG-002':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k,
          typeof v === 'string'  ? 12345 :
          typeof v === 'number'  ? 'abc'  :
          typeof v === 'boolean' ? 'yes'  : v,
        ])),
      };

    // Numeric fields → -1 (below any sane minimum).
    // String fields → 999999999 (wrong type; triggers validation when no numeric fields exist).
    case 'TPL-NEG-003':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k,
          typeof v === 'number' ? -1 :
          typeof v === 'string' ? 999999999 : v,
        ])),
      };

    // String fields → 1001-character string (exceeds any reasonable maxLength).
    case 'TPL-NEG-004':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'string' ? 'a'.repeat(1001) : v,
        ])),
      };

    // Send a raw string that is not valid JSON.
    case 'TPL-NEG-005':
      return {
        kind: BODY_KIND.MALFORMED,
        data: '{ "malformed": json syntax error, "missing": closing brace',
      };

    // Valid fields plus many unknown extra fields to inflate the payload size.
    case 'TPL-BND-006': {
      const extra = {};
      for (let i = 1; i <= 10; i++) extra[`unknownField${i}`] = 'x'.repeat(100);
      return {
        kind: BODY_KIND.OBJECT,
        data: { ...exampleObj, ...extra },
      };
    }

    // Special characters in all string fields.
    case 'TPL-NEG-010':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'string' ? '!@#$%^&*()[]{};:<>?,./~`|\\' : v,
        ])),
      };

    // Null for every field — triggers required-field validation.
    case 'TPL-BND-007':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k]) => [k, null])),
      };

    // Empty string for all string fields.
    case 'TPL-BND-008':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'string' ? '' : v,
        ])),
      };

    // Zero for all numeric fields.
    case 'TPL-BND-009':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'number' ? 0 : v,
        ])),
      };

    // SQL injection in all string fields.
    case 'TPL-SEC-001':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'string' ? "' OR '1'='1'; DROP TABLE users; --" : v,
        ])),
      };

    // XSS injection in all string fields.
    case 'TPL-SEC-002':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'string' ? '<script>alert("xss")</script>' : v,
        ])),
      };

    // Command injection / path traversal in all string fields.
    case 'TPL-SEC-003':
      return {
        kind: BODY_KIND.OBJECT,
        data: Object.fromEntries(entries.map(([k, v]) => [
          k, typeof v === 'string' ? '; ls -la ../../etc/passwd' : v,
        ])),
      };

    default:
      return { kind: BODY_KIND.VALID };
  }
}
