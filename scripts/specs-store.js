// Per-swagger specs store.
//
// Holds one editable "specs" document per swagger — scaffolded from the spec +
// data/config.json, persisted to output/{id}/specs.json (via the dev-server
// POST /save endpoint), and read back to drive the Try It defaults and the
// Postman / Karate exports. The specs file is the source of truth: a value
// present there overrides the derived one (effective = specs ?? config ?? spec).
//
// Document shape (output/{id}/specs.json):
//   {
//     swaggerId, title, file, generatedAt, updatedAt,
//     swagger:   { baseUrl, auth: { type, in, token, expiredToken, invalidTokenValue }, headers: { accept, contentType } },
//     endpoints: { "GET /path": { method, path, summary, authRequired, requestType, responseBodyType?, sseDialect?, pathParams, headerParams?, responses: { "200", error }, baseline? } }
//   }

import { getBaseUrl, isCookieAuth } from './tryit/request-core.js';
import { getResponseExample, getRequestBodySchema, buildExampleFromSchema } from './tryit/schema-validator.js';
import { getConfig } from './core/config-loader.js';
import { getEndpointsByTag } from './core/swagger-loader.js';
import { getOperation, profileEndpoint } from './core/template-matcher.js';
import { DEFAULT_REQUEST_TYPE } from './core/request-types.js';
import { loadCachedSpecs, saveCachedSpecs, clearCachedSpecs } from './state/specs-cache.js';

const SAVE_ENDPOINT = '/save?path=';

let _model = null;   // current specs document
let _entry = null;   // { id, file, title } from swaggers/index.json

// Endpoint map key — human-readable and stable, e.g. "GET /products/{id}".
export function specKey(method, path) {
  return `${String(method).toUpperCase()} ${path}`;
}

// ── Load / scaffold ────────────────────────────────────────────────────────────

// Loads output/{id}/specs.json if it exists; otherwise scaffolds a fresh model
// from the spec + config. The on-disk file (with the user's edits) always wins
// when present. Returns the in-memory model.
export async function loadOrScaffoldSpecs(entry, spec) {
  _entry = entry;
  try {
    const res = await fetch(`output/${entry.id}/specs.json`, { cache: 'no-store' });
    if (res.ok) {
      // Disk is authoritative: when the dev server returns the file, it wins
      // over any localStorage cache (so hand-edits to specs.json are honoured).
      _model = healBaseUrl(await res.json(), spec);
      return _model;
    }
  } catch { /* dev server down or file absent — fall through to cache/scaffold */ }
  // Dev server unreachable: restore the un-persisted (offline) model if one was
  // cached, otherwise scaffold a fresh one from the spec + config.
  const cached = loadCachedSpecs(entry.id);
  if (cached) {
    _model = healBaseUrl(cached, spec);
    return _model;
  }
  _model = scaffoldSpecs(entry, spec);
  return _model;
}

// Self-heal a stale base URL: an old model may carry a scheme-only/empty baseUrl
// (e.g. "https://") that would otherwise shadow a spec that since gained a
// host/servers[]. Re-derive from the spec so it picks it up.
function healBaseUrl(model, spec) {
  if (isBlankBaseUrl(model?.swagger?.baseUrl)) {
    (model.swagger ||= {}).baseUrl = getBaseUrl(spec);
  }
  return model;
}

// A base URL is "blank" when it's empty or just a scheme with no host
// (e.g. "https://"), the value getBaseUrl() returns for a host-less spec.
function isBlankBaseUrl(url) {
  return !url || /^https?:\/\/$/.test(String(url).trim());
}

function scaffoldSpecs(entry, spec) {
  const cfg = getConfig();
  const now = new Date().toISOString();

  const endpoints = {};
  for (const { path, methods } of getEndpointsByTag(spec, null)) {
    for (const method of methods) {
      const op = getOperation(spec, path, method);
      if (!op) continue;
      const profile = profileEndpoint(path, method, op, spec);
      const hasBody = ['POST', 'PUT', 'PATCH'].includes(profile.method);
      endpoints[specKey(method, path)] = {
        method: profile.method,
        path,
        summary: op.summary || '',
        authRequired: profile.auth_required,
        requestType: DEFAULT_REQUEST_TYPE,
        pathParams: scaffoldPathParams(path, cfg),
        ...(hasBody ? { requestBody: requestBodyExample(op, spec) } : {}),
        responses: {
          '200':  getResponseExample(op, '200', spec),
          error:  errorExample(op, spec),
        },
      };
    }
  }

  return {
    swaggerId: entry.id,
    title: entry.title || '',
    file: entry.file,
    generatedAt: now,
    updatedAt: now,
    swagger: {
      baseUrl: getBaseUrl(spec),
      auth: scaffoldAuth(spec, cfg),
      headers: { accept: cfg.headers.accept, contentType: cfg.headers.contentType },
    },
    endpoints,
  };
}

function scaffoldPathParams(path, cfg) {
  const out = {};
  for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
    out[name] = cfg.pathParams?.[name] ?? '';
  }
  return out;
}

// Example request body from the operation's request schema (POST/PUT/PATCH).
function requestBodyExample(op, spec) {
  const schema = getRequestBodySchema(op);
  return schema ? buildExampleFromSchema(schema, spec) : null;
}

// Example body for the first declared 4xx response (falling back to `default`).
function errorExample(op, spec) {
  const responses = op.responses || {};
  const code = Object.keys(responses).find(c => /^4\d\d$/.test(c))
            || (responses.default ? 'default' : null);
  return code ? getResponseExample(op, code, spec) : null;
}

// Auth spec from the swagger's security schemes (Swagger 2 securityDefinitions /
// OpenAPI 3 components.securitySchemes), seeded with the config's tokens. `type`
// is the scheme name (matches the profile's auth_type); `in` is where the
// credential goes (header | query | cookie).
function scaffoldAuth(spec, cfg) {
  const schemes = spec.securityDefinitions || spec.components?.securitySchemes || {};

  // Prefer a globally-required scheme; otherwise the first declared one.
  const globalReqs = Array.isArray(spec.security) ? spec.security : [];
  let name = globalReqs.map(r => Object.keys(r || {})[0]).find(Boolean)
          || Object.keys(schemes)[0]
          || null;

  const def = name ? schemes[name] : null;
  return {
    type: name || 'none',
    kind: def?.type ?? null,   // OpenAPI scheme kind: apiKey | http | oauth2 | …
    name: def?.name ?? null,   // header/query name for apiKey schemes (e.g. x-api-key)
    in: authLocation(def, name),
    token: cfg.auth.token,
    expiredToken: cfg.auth.expiredToken,
    invalidTokenValue: cfg.auth.invalidTokenValue,
  };
}

function authLocation(def, name) {
  if (def?.in) return def.in;                 // apiKey: header | query | cookie
  if (isCookieAuth(name)) return 'cookie';
  return 'header';                            // oauth2 / http(bearer) / basic
}

// ── Accessors / effective resolvers ──────────────────────────────────────────

export function getModel()        { return _model; }
export function currentId()       { return _entry?.id ?? null; }
export function getSwaggerSpecs() { return _model?.swagger ?? null; }
export function getEndpointSpecs(method, path) {
  return _model?.endpoints?.[specKey(method, path)] ?? null;
}

export function effectiveBaseUrl(spec) {
  return _model?.swagger?.baseUrl || getBaseUrl(spec);
}

export function effectiveAuth() {
  const cfg = getConfig();
  const a = _model?.swagger?.auth;
  return {
    type: a?.type ?? 'none',
    kind: a?.kind ?? null,
    name: a?.name ?? null,
    in: a?.in ?? 'header',
    token: a?.token ?? cfg.auth.token,
    expiredToken: a?.expiredToken ?? cfg.auth.expiredToken,
    invalidTokenValue: a?.invalidTokenValue ?? cfg.auth.invalidTokenValue,
  };
}

// Effective auth-required flag for an endpoint: the specs value (set by Try It
// auth discovery or hand-edited) when present, otherwise the spec-derived
// fallback. Lets a per-endpoint override force auth tests on/off regardless of
// what the swagger declared.
export function effectiveAuthRequired(method, path, fallback) {
  return getEndpointSpecs(method, path)?.authRequired ?? fallback;
}

// Effective request type for an endpoint: the persisted manual selection when
// present, otherwise the default ('regular'). Drives the handler seam in the Try
// It tab and both exporters (e.g. 'stream' → SSE assertions). There is no spec
// auto-detection — the user picks the type explicitly.
export function effectiveRequestType(method, path, fallback = DEFAULT_REQUEST_TYPE) {
  return getEndpointSpecs(method, path)?.requestType ?? fallback;
}

// Effective response body type (json | sse | ndjson | text | binary): a persisted
// override wins, otherwise the caller's auto-detected fallback. Drives the 2xx
// success assertions in both exporters + Try It. Not scaffolded, so auto-detection
// runs until the user overrides it.
export function effectiveResponseBodyType(method, path, fallback) {
  return getEndpointSpecs(method, path)?.responseBodyType ?? fallback;
}

// Effective SSE dialect (openai | anthropic | generic): persisted override wins,
// otherwise the caller's sniffed fallback.
export function effectiveSseDialect(method, path, fallback) {
  return getEndpointSpecs(method, path)?.sseDialect ?? fallback;
}

export function effectiveHeaders() {
  const cfg = getConfig();
  const h = _model?.swagger?.headers;
  return {
    accept: h?.accept ?? cfg.headers.accept,
    contentType: h?.contentType ?? cfg.headers.contentType,
  };
}

// Request body for an endpoint: the specs value (user-edited) when present,
// otherwise the example built from the operation's request schema.
export function effectiveRequestBody(method, path, operation, spec) {
  const e = getEndpointSpecs(method, path);
  if (e && e.requestBody !== undefined && e.requestBody !== null) return e.requestBody;
  const schema = getRequestBodySchema(operation);
  return schema ? buildExampleFromSchema(schema, spec) : null;
}

// `in: header` parameter (and custom header) values for an endpoint: the specs
// value (user-edited in Try It) when present, otherwise the spec defaults (each
// `in: header` param's schema default/example). Persisted values win as a whole
// — they were captured from the full editable row set — so removals/edits stick.
// Returns an ordered name→value map.
export function effectiveHeaderParams(method, path, operation) {
  const persisted = getEndpointSpecs(method, path)?.headerParams;
  if (persisted && typeof persisted === 'object') return { ...persisted };
  const out = {};
  for (const p of (operation?.parameters ?? []).filter(p => p.in === 'header')) {
    out[p.name] = String(p.schema?.default ?? p.schema?.example ?? '');
  }
  return out;
}

// Path-param defaults for an endpoint: the specs value first, then config, then ''.
export function effectivePathParams(method, path) {
  const cfg = getConfig();
  const fromSpecs = getEndpointSpecs(method, path)?.pathParams ?? {};
  const out = {};
  for (const [, name] of String(path).matchAll(/\{([^}]+)\}/g)) {
    out[name] = fromSpecs[name] || cfg.pathParams?.[name] || '';
  }
  return out;
}

// ── Mutations ────────────────────────────────────────────────────────────────

// Stores the base URL captured from the Try It tab into the swagger specs.
export function setBaseUrl(url) {
  if (!_model) return;
  (_model.swagger ||= {});
  _model.swagger.baseUrl = url;
  _model.updatedAt = new Date().toISOString();
}

// Stores the valid auth token captured from the Try It tab into the swagger specs.
export function setAuthToken(token) {
  if (!_model) return;
  (_model.swagger ||= {});
  (_model.swagger.auth ||= {});
  _model.swagger.auth.token = token;
  _model.updatedAt = new Date().toISOString();
}

// Stores the request body captured from the Try It tab into the endpoint specs.
export function setRequestBody(method, path, body) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.requestBody = body;
  _model.updatedAt = new Date().toISOString();
}

// Stores the `in: header` parameter (and custom header) values captured from the
// Try It tab into the endpoint specs, so Save Specs persists them and both
// exporters emit the edited values. Keyed by header name → value.
export function setHeaderParams(method, path, headerParams) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.headerParams = headerParams;
  _model.updatedAt = new Date().toISOString();
}

// Marks an endpoint as (not) requiring auth — set when a live Try It response
// (401/403) reveals the endpoint enforces auth even though the spec said
// otherwise. Persisted on Save Specs so the auth tests reappear on reload.
export function setAuthRequired(method, path, value) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.authRequired = value;
  _model.updatedAt = new Date().toISOString();
}

// Sets the manual request type for an endpoint (regular | stream | upload | …).
// Persisted to specs.json (immediately by the toolbar dropdown handler) and
// loaded back with the rest of the specs on open.
export function setRequestType(method, path, value) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.requestType = value;
  _model.updatedAt = new Date().toISOString();
}

// Sets the response body type override (json | sse | ndjson | text | binary).
// Persisted immediately by the toolbar dropdown handler; absence = auto-detect.
export function setResponseBodyType(method, path, value) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.responseBodyType = value;
  _model.updatedAt = new Date().toISOString();
}

// Sets the SSE dialect override (openai | anthropic | generic).
export function setSseDialect(method, path, value) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.sseDialect = value;
  _model.updatedAt = new Date().toISOString();
}

// Records a known-good response snapshot as the endpoint's baseline.
export function setBaseline(method, path, snapshot) {
  if (!_model) return;
  const key = specKey(method, path);
  const e = (_model.endpoints[key] ||= { method: String(method).toUpperCase(), path });
  e.baseline = snapshot;
  _model.updatedAt = new Date().toISOString();
}

// ── Persistence ──────────────────────────────────────────────────────────────

// POSTs a file to the dev-server save endpoint, which writes it under output/.
// Returns true on success, false if the dev server isn't running / rejected it.
export async function saveFile(relPath, content, contentType = 'application/json') {
  try {
    const res = await fetch(SAVE_ENDPOINT + encodeURIComponent(relPath), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: content,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Saves a file to output/ if the dev server is available; otherwise falls back
// to a browser download so the export is never lost. Returns true if it was
// written to disk, false if it fell back to a download.
export async function saveOrDownload(relPath, filename, content, contentType = 'application/json') {
  const ok = await saveFile(relPath, content, contentType);
  if (!ok) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
  }
  return ok;
}

// Persists the current specs document to output/{id}/specs.json.
export async function saveSpecs() {
  if (!_model || !_entry) return false;
  _model.updatedAt = new Date().toISOString();
  const ok = await saveFile(`output/${_entry.id}/specs.json`, JSON.stringify(_model, null, 2));
  // Disk is the durable copy when reachable; otherwise mirror to localStorage so
  // the edits survive a reload / swagger switch. A successful save clears the
  // cache, leaving it to hold only un-persisted (offline) models.
  if (ok) clearCachedSpecs(_entry.id);
  else saveCachedSpecs(_entry.id, _model);
  return ok;
}
