/**
 * Schema logic for the Try It tab — kept DOM-free so it is unit-testable and
 * reusable. Two concerns:
 *
 *   1. Schema → example builders (also used by specs-store + the exporters to
 *      seed request/response bodies).
 *   2. Response-body validation against the spec's response schema, via Ajv.
 *
 * `validateResponse()` returns a plain result descriptor ({ kind, message,
 * errors }); the Try It UI renders it. Nothing here touches the DOM.
 */
import Ajv from '../vendor/ajv/ajv.js';
import addFormats from '../vendor/ajv/ajv-formats.js';

// ── Schema → example builders ──────────────────────────────────────────────────

// Extracts the request-body schema from an operation, supporting both
// Swagger 2 (a `parameters` entry with `in: 'body'`) and OpenAPI 3
// (`requestBody.content[<media-type>].schema`, preferring a JSON media type).
export function getRequestBodySchema(operation) {
  const bodyParam = (operation.parameters ?? []).find(p => p.in === 'body');
  if (bodyParam?.schema) return bodyParam.schema;

  const content = operation.requestBody?.content;
  if (content) {
    const types   = Object.keys(content);
    const jsonKey = types.find(t => t.includes('json')) ?? types[0];
    return content[jsonKey]?.schema ?? null;
  }
  return null;
}

// The spec is dereferenced once at load time (SwaggerParser, circular:'ignore'),
// so schemas arrive fully inlined. The `spec` arg is kept for call-site
// compatibility but no longer used for resolution.
export function buildExampleFromSchema(schema) {
  if (!schema) return null;

  // Any $ref still present is a circular one SwaggerParser left in place — stop
  // here to avoid infinite recursion.
  if (schema.$ref) return {};

  // Inline example wins
  if (schema.example !== undefined) return schema.example;

  const type = schema.type;

  if (type === 'object' || schema.properties) {
    const obj = {};
    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      obj[key] = buildExampleFromSchema(propSchema);
    }
    return obj;
  }

  if (type === 'array') {
    const item = schema.items ? buildExampleFromSchema(schema.items) : 'string';
    return [item];
  }

  return primitiveExample(type, schema.format, schema.enum);
}

// Builds an example body for a given response status, reusing the same
// status→schema lookup the Try It schema-validation panel uses (responseSchema).
// `status` may be a code ('200', '404') or 'default'. Returns the example
// object/array/scalar, or null when that status has no schema. Used by the
// specs scaffolder to seed each endpoint's 200 / error response bodies.
export function getResponseExample(operation, status, spec) {
  const responses = operation?.responses;
  if (!responses) return null;
  const resDef = responses[status] ?? responses.default;
  if (!resDef) return null;
  const schema = responseSchema(resDef);
  return schema ? buildExampleFromSchema(schema, spec) : null;
}

function primitiveExample(type, format, enumVals) {
  if (enumVals?.length) return enumVals[0];

  switch (type) {
    case 'integer':
    case 'number':   return format === 'float' || format === 'double' ? 0.0 : 0;
    case 'boolean':  return false;
    case 'string':
      switch (format) {
        case 'uuid':      return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
        case 'date':      return '2024-01-01';
        case 'date-time': return '2024-01-01T00:00:00Z';
        case 'email':     return 'user@example.com';
        case 'uri':       return 'https://example.com';
        case 'password':  return 'secret';
        default:          return 'string';
      }
    default: return null;
  }
}

// ── Response-body validation ────────────────────────────────────────────────────

/**
 * Validates a response body against the operation's response schema for `status`.
 * Pure — returns a descriptor the UI renders:
 *   { kind: 'none' | 'pass' | 'fail', message, errors: [{ path, msg }] }
 * 'none' covers every "nothing to validate" case (no responses, no schema,
 * non-JSON body), each with its own message.
 */
export function validateResponse(operation, spec, status, body) {
  if (!operation?.responses) {
    return none('No response definitions in spec.');
  }

  const resDef = operation.responses[status] ?? operation.responses['default'];
  if (!resDef) {
    return none(`No schema defined for status ${status}.`);
  }

  const rawSchema = responseSchema(resDef);
  if (!rawSchema) {
    return none(`Response ${status} has no schema (status-only response).`);
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    return none(`Response body is not JSON — cannot validate schema.`);
  }

  // rawSchema is already dereferenced (load-time SwaggerParser pass); pass it
  // straight to Ajv, which still resolves any remaining circular $ref via the
  // spec's definitions/components.
  const errors = [];
  validateValue(parsed, rawSchema, spec, 'response', errors);

  if (errors.length === 0) {
    return { kind: 'pass', message: `Schema valid — all fields match the spec for status ${status}.`, errors: [] };
  }
  return {
    kind: 'fail',
    message: `${errors.length} issue${errors.length > 1 ? 's' : ''} found for status ${status}:`,
    errors,
  };
}

const none = (message) => ({ kind: 'none', message, errors: [] });

// A response's schema sits directly on the response object in Swagger 2, but
// under content[<media-type>].schema in OpenAPI 3 (prefer a JSON media type).
export function responseSchema(resDef) {
  if (resDef.schema) return resDef.schema;
  const content = resDef.content;
  if (content) {
    const types   = Object.keys(content);
    const jsonKey = types.find(t => t.includes('json')) ?? types[0];
    return content[jsonKey]?.schema ?? null;
  }
  return null;
}

// Validate `value` against an OpenAPI/Swagger `schema` using Ajv (JSON Schema
// draft-07). The spec's reusable schemas are attached so internal $refs resolve,
// and Ajv handles $ref cycles natively — so no hand-rolled recursion or
// visited-set is needed. Ajv's errors are mapped back into the { path, msg }
// shape the rest of the validation renders.
function validateValue(value, schema, spec, path, errors) {
  if (!schema) return;

  // Compiling Ajv (spread spec schemas → ajvSchema() deep-clone → compile) is the
  // hot cost paid on every Send. Memoize the compiled validator on the response
  // schema's object identity: a dereferenced spec gives each schema a stable
  // reference for its lifetime, so the same status reuses one validator and a
  // swagger reload drops the old entries via GC (WeakMap, no manual eviction).
  let validate = validatorCache.get(schema);
  if (!validate) {
    // Carry the spec's shared schemas so #/definitions/* (Swagger 2) and
    // #/components/schemas/* (OpenAPI 3) $refs resolve. ajvSchema() deep-clones
    // and rewrites OpenAPI's `nullable: true`, so the original spec is untouched.
    const root = ajvSchema({
      ...schema,
      ...(spec?.definitions ? { definitions: spec.definitions } : {}),
      ...(spec?.components  ? { components:  spec.components  } : {}),
    });

    try {
      validate = newAjv().compile(root);
    } catch (e) {
      errors.push({ path, msg: `schema could not be compiled (${e.message})` });
      return;
    }
    validatorCache.set(schema, validate);
  }

  if (validate(value)) return;
  for (const err of validate.errors ?? []) {
    errors.push(ajvErrorToEntry(path, err, value));
  }
}

// Compiled-validator memo, keyed on the response schema object (see validateValue).
const validatorCache = new WeakMap();

// Ajv tuned to tolerate OpenAPI-flavoured JSON Schema:
//   strict:false         — ignore OpenAPI-only keywords (example, xml, discriminator, readOnly…)
//   allErrors:true       — collect every problem instead of stopping at the first
//   allowUnionTypes:true — accept the type arrays produced by nullable handling
// allOf / anyOf / oneOf / additionalProperties are core keywords Ajv enforces by
// default; addFormats() registers the string/numeric format validators (date-time,
// email, uri, uuid, int32/int64…) so `format` is checked too. Each instance is
// single-use at compile time — keeping compilation stateless and avoiding Ajv's
// "schema already exists" cache errors should a spec carry $id/id keywords — while
// the *compiled* validator it produces is memoized per schema in validateValue().
function newAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv;
}

// Deep-clone a schema while rewriting OpenAPI 3.0 `nullable: true` into the
// JSON-Schema-native way of allowing null, so Ajv accepts null wherever the spec
// permits it instead of flagging a type/enum error. Handles both the `type`
// form ("string" -> ["string","null"]) and the `enum` form (append null).
export function ajvSchema(node) {
  if (Array.isArray(node)) return node.map(ajvSchema);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = ajvSchema(v);
    if (out.nullable === true) {
      if (Array.isArray(out.type)) {
        if (!out.type.includes('null')) out.type = [...out.type, 'null'];
      } else if (typeof out.type === 'string') {
        out.type = [out.type, 'null'];
      }
      if (Array.isArray(out.enum) && !out.enum.includes(null)) {
        out.enum = [...out.enum, null];
      }
    }
    delete out.nullable;
    return out;
  }
  return node;
}

// Map one Ajv error onto the { path, msg } shape the UI lists, rebuilding the
// dotted/bracketed display path (response.tags[0].name) from Ajv's JSON pointer.
function ajvErrorToEntry(rootPath, err, rootValue) {
  let p = rootPath;
  for (const seg of err.instancePath.split('/').slice(1).map(unescapePtr)) {
    p += /^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`;
  }
  if (err.keyword === 'required') {
    return { path: `${p}.${err.params.missingProperty}`, msg: 'required field missing' };
  }
  if (err.keyword === 'type') {
    const want = Array.isArray(err.params.type) ? err.params.type.join('|') : err.params.type;
    return { path: p, msg: `expected ${want}, got ${describeType(valueAtPointer(rootValue, err.instancePath))}` };
  }
  return { path: p, msg: err.message ?? 'invalid' };
}

// Undo JSON Pointer escaping (~1 -> /, ~0 -> ~) for a single path segment.
function unescapePtr(seg) { return seg.replace(/~1/g, '/').replace(/~0/g, '~'); }

// Walk `obj` to the value Ajv flagged, given its JSON Pointer instancePath.
function valueAtPointer(obj, pointer) {
  return pointer.split('/').slice(1).reduce(
    (o, seg) => (o == null ? o : o[unescapePtr(seg)]), obj);
}

function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isInteger(v)) return 'float';
  return typeof v;
}
