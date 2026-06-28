// Default values — used as-is when config.json is absent or a key is omitted.
const DEFAULTS = {
  responseTimeThresholdMs: 3000,
  headers: {
    accept: 'application/json',
    contentType: 'application/json',
  },
  auth: {
    token: '',
    expiredToken: '',
    invalidTokenValue: 'invalid_token_tampered_xyz',
  },
  pathParams: {},
};

let _config = DEFAULTS;

/**
 * Fetches data/config.json and merges it over the defaults.
 * Call once during app init; all subsequent getConfig() calls are synchronous.
 */
export async function loadConfig() {
  try {
    const data = await fetch('data/config.json').then(r => r.json());
    _config = deepMerge(DEFAULTS, data);
  } catch {
    // config.json missing or unparseable — silently keep defaults
  }
}

/** Returns the merged config object. Synchronous after loadConfig() resolves. */
export function getConfig() {
  return _config;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = (v !== null && typeof v === 'object' && !Array.isArray(v) &&
               typeof base[k] === 'object' && base[k] !== null)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}
