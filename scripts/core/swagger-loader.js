import SwaggerParser from '../vendor/swagger-parser.js';

/**
 * Fetches the list of available swagger files from swaggers/index.json.
 * Returns: [{ id, file, title }]
 */
export async function loadManifest() {
  const res = await fetch('swaggers/index.json');
  return res.json();
}

/**
 * Fetches a swagger spec by filename and dereferences it ONCE at load time.
 *
 * SwaggerParser.dereference inlines every $ref it can — internal, multi-file,
 * and external URL — so the rest of the app sees plain schemas and never has to
 * resolve refs itself. `circular: 'ignore'` leaves genuinely circular refs in
 * place as { $ref } (instead of building JS object cycles), which keeps the
 * result safe to deep-clone and recurse over downstream.
 *
 * The main document is fetched here (preserving existing behaviour); the fetched
 * object plus its URL are handed to the parser so external relative $refs resolve
 * against `swaggers/`. If dereferencing fails, we fall back to the raw spec.
 */
export async function loadSwagger(file) {
  const url = `swaggers/${file}`;
  const raw = await (await fetch(url)).json();
  try {
    return await SwaggerParser.dereference(url, raw, { dereference: { circular: 'ignore' } });
  } catch (err) {
    console.warn(`SwaggerParser.dereference failed for ${file}; using raw spec.`, err);
    return raw;
  }
}

// Valid HTTP operation keys on a Swagger/OpenAPI path-item object.
// Anything else (e.g. `parameters`, `$ref`, vendor `x-*` extensions) is not an operation.
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * Extracts unique tag names from a swagger spec, preserving declaration order.
 * Returns: string[]
 */
export function getTagsFromSpec(spec) {
  if (spec.tags && spec.tags.length > 0) {
    return spec.tags.map(t => t.name);
  }
  // Fallback: collect tags from paths
  const seen = new Set();
  Object.values(spec.paths || {}).forEach(methods => {
    Object.entries(methods).forEach(([method, op]) => {
      if (!HTTP_METHODS.has(method.toLowerCase())) return;
      (op.tags || []).forEach(t => seen.add(t));
    });
  });
  return [...seen];
}

/**
 * Extracts unique endpoint paths that belong to the given tag.
 * Pass tag = null to get all paths.
 * Returns: [{ path, methods: string[] }]
 */
export function getEndpointsByTag(spec, tag) {
  const result = [];
  const seen = new Set();

  Object.entries(spec.paths || {}).forEach(([path, methodMap]) => {
    const methods = Object.entries(methodMap)
      .filter(([method]) => HTTP_METHODS.has(method.toLowerCase()))
      .filter(([, op]) => !tag || (op.tags || []).includes(tag))
      .map(([method]) => method.toUpperCase());

    if (methods.length > 0 && !seen.has(path)) {
      seen.add(path);
      result.push({ path, methods });
    }
  });

  return result;
}
