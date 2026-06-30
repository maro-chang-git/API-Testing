/**
 * Canonical list of per-endpoint RESPONSE body types + pure detection helpers.
 *
 * The response body type drives the 2xx success assertions in both exporters and
 * the Try It tab — replacing the old `response_is_stream` boolean. It is
 * AUTO-DETECTED from the spec's 2xx content type (with a request-type hint) and
 * OVERRIDABLE per endpoint in specs.json. SSE additionally carries a dialect
 * (openai | anthropic | generic) describing its terminal marker + delta path.
 *
 * Everything here is pure (no DOM / spec-walking / AJV) so it stays unit-testable
 * and core-clean. Mirrors the shape of core/request-types.js.
 */

export const DEFAULT_RESPONSE_BODY_TYPE = 'json';

export const RESPONSE_BODY_TYPES = [
  { key: 'json',   label: 'JSON' },
  { key: 'sse',    label: 'SSE (text/event-stream)' },
  { key: 'ndjson', label: 'NDJSON (line-delimited JSON)' },
  { key: 'text',   label: 'Plain text' },
  { key: 'binary', label: 'Binary' },
];

// SSE dialect descriptors. `terminal` is a substring that marks the end of the
// stream; `deltaPath` documents where the incremental text lives (used by the
// parser/exporters); `sessionField` is an optional id field carried by the stream.
export const SSE_DIALECTS = {
  openai:    { label: 'OpenAI',    terminal: '[DONE]',       deltaPath: 'choices[].delta.content', sessionField: 'id' },
  anthropic: { label: 'Anthropic', terminal: 'message_stop', deltaPath: 'delta.text',              sessionField: 'message.id' },
  generic:   { label: 'Generic',   terminal: null,           deltaPath: null,                      sessionField: null },
};

export const DEFAULT_SSE_DIALECT = 'generic';

// Maps a single response content-type (media type) to a body type, or null when
// it doesn't match a known shape.
export function mapContentTypeToBodyType(ct = '') {
  const s = String(ct).toLowerCase();
  if (!s) return null;
  if (s.includes('event-stream'))                              return 'sse';
  if (s.includes('ndjson') || s.includes('x-jsonlines'))       return 'ndjson';
  if (s.includes('json'))                                      return 'json';   // application/json, +json
  if (/^text\//.test(s))                                       return 'text';   // text/plain, text/csv, …
  if (s.includes('octet-stream') || s.includes('pdf') ||
      s.includes('zip') || s.includes('xmind') ||
      s.includes('application/vnd.') || s.includes('image/') ||
      s.includes('audio/') || s.includes('video/'))            return 'binary';
  return null;
}

/**
 * Resolves the auto-detected response body type:
 *   first mapped 2xx content type → request-type hint → 'json'.
 * @param {string[]} contentTypes - 2xx response media types from the spec
 * @param {string}   requestType  - the endpoint's manual request type
 */
export function detectResponseBodyType(contentTypes = [], requestType = 'regular') {
  for (const ct of contentTypes) {
    const t = mapContentTypeToBodyType(ct);
    if (t) return t;
  }
  if (requestType === 'stream')   return 'sse';
  if (requestType === 'download') return 'binary';
  return DEFAULT_RESPONSE_BODY_TYPE;
}

// Best-effort SSE dialect sniff from the request host, header names and whether
// the 2xx response schema looks OpenAI-shaped (has a `choices` array). Pure.
export function sniffSseDialect({ host = '', headerNames = [], schemaHasChoices = false } = {}) {
  const h = String(host).toLowerCase();
  const names = headerNames.map(n => String(n).toLowerCase());
  if (h.includes('anthropic') || names.some(n => n.startsWith('anthropic-'))) return 'anthropic';
  if (h.includes('openai') || schemaHasChoices)                              return 'openai';
  return DEFAULT_SSE_DIALECT;
}

// Dropdown option text (parity with request-types.requestTypeOptionLabel).
export function responseBodyTypeLabel(type) {
  return type.label;
}
