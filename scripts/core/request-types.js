/**
 * Canonical list of per-endpoint request types.
 *
 * The request type is a MANUAL, per-endpoint selection (no spec auto-detection):
 * it routes handler logic in the Try It tab and BOTH exporters. Only `regular`
 * and `stream` are implemented today; every other type is listed for
 * future-proofing, shown as "… — not yet included", and routed to a TODO seam
 * that falls back to the `regular` handler.
 *
 * Single source of truth — imported by app.js, the exporters and request-ui so
 * there are no magic strings. Mirrors the shape of core/case-order.js.
 */

export const DEFAULT_REQUEST_TYPE = 'regular';

export const REQUEST_TYPES = [
  { key: 'regular',         label: 'Regular API',             implemented: true  },
  { key: 'stream',          label: 'Chat Stream (SSE)',       implemented: true  },
  { key: 'upload',          label: 'File Upload (multipart)', implemented: false },
  { key: 'download',        label: 'File Download (binary)',  implemented: false },
  { key: 'form-urlencoded', label: 'Form URL-Encoded',        implemented: false },
  { key: 'graphql',         label: 'GraphQL',                 implemented: false },
  { key: 'websocket',       label: 'WebSocket',               implemented: false },
  { key: 'grpc',            label: 'gRPC',                    implemented: false },
  { key: 'soap',            label: 'SOAP / XML',              implemented: false },
  { key: 'webhook',         label: 'Webhook',                 implemented: false },
  { key: 'batch',           label: 'Batch',                   implemented: false },
  { key: 'long-poll',       label: 'Long Polling',            implemented: false },
];

// True when the type has a real handler (regular / stream). Everything else
// routes to the TODO→regular fallback.
export function isImplementedType(key) {
  return REQUEST_TYPES.find(t => t.key === key)?.implemented ?? false;
}

// Dropdown option text — appends a "not yet included" note for unimplemented types.
export function requestTypeOptionLabel(type) {
  return type.implemented ? type.label : `${type.label} — not yet included`;
}
