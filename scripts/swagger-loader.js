/**
 * Fetches the list of available swagger files from swaggers/index.json.
 * Returns: [{ id, file, title }]
 */
export async function loadManifest() {
  const res = await fetch('swaggers/index.json');
  return res.json();
}

/**
 * Fetches and parses a swagger spec by filename.
 * Returns the raw swagger JSON object.
 */
export async function loadSwagger(file) {
  const res = await fetch(`swaggers/${file}`);
  return res.json();
}

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
    Object.values(methods).forEach(op => {
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
      .filter(([, op]) => !tag || (op.tags || []).includes(tag))
      .map(([method]) => method.toUpperCase());

    if (methods.length > 0 && !seen.has(path)) {
      seen.add(path);
      result.push({ path, methods });
    }
  });

  return result;
}
