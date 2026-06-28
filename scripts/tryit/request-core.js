/**
 * Pure request construction for the Try It tab — no DOM. request-ui collects the
 * raw input values from the page and hands them here; these functions turn them
 * into the final URL / headers / body that `fetch()` receives. Keeping them pure
 * makes the fiddly bits (path-param substitution, the proxy cookie rename,
 * api_key_query placement) unit-testable.
 */
import { methodHasBody } from '../exporters/export-shared.js';

/**
 * Builds the API base URL, supporting both Swagger 2 (schemes/host/basePath)
 * and OpenAPI 3 (servers[].url, with {variable} templates filled from each
 * variable's default).
 */
export function getBaseUrl(spec) {
  const server = spec?.servers?.[0];
  if (server?.url) {
    return server.url.replace(/\{([^}]+)\}/g, (_, name) =>
      server.variables?.[name]?.default ?? `{${name}}`);
  }
  const scheme = spec?.schemes?.[0] ?? 'https';
  return `${scheme}://${spec?.host ?? ''}${spec?.basePath ?? ''}`;
}

/**
 * Detects cookie-based auth from an endpoint profile's auth_type (the security
 * scheme name, e.g. "cookieAuth" / "session_cookie"). Such endpoints expect
 * credentials in a Cookie header rather than a Bearer Authorization header.
 */
export function isCookieAuth(authType) {
  return /cookie/i.test(authType || '');
}

/**
 * Composes the request URL: base + path (with {params} substituted) + query
 * string. A blank path-param value keeps its `{name}` placeholder so the gap is
 * visible. `api_key_query` auth is appended as a query parameter here (it is the
 * one auth style that isn't a header).
 *
 * @param {string} path
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {Object<string,string>} opts.pathParams  - name → raw value
 * @param {Object<string,string>} opts.queryParams - name → raw value (blanks skipped)
 * @param {{type,key,value}} opts.auth
 */
export function buildRequestUrl(path, { baseUrl, pathParams = {}, queryParams = {}, auth = {} }) {
  const base = baseUrl.trim().replace(/\/$/, '');

  let p = path;
  for (const [name, value] of Object.entries(pathParams)) {
    p = p.replace(`{${name}}`, encodeURIComponent((value ?? '').trim() || `{${name}}`));
  }

  const qp = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    if ((value ?? '').trim()) qp.set(key, value.trim());
  }

  const authValue = (auth.value ?? '').trim();
  if (auth.type === 'api_key_query' && authValue) {
    qp.set((auth.key ?? '').trim() || 'api_key', authValue);
  }

  const qs = qp.toString();
  return base + p + (qs ? '?' + qs : '');
}

/**
 * Reduces the header rows (already read from the editor, in DOM order) into a
 * header map — later rows win on duplicate keys. When the request goes through
 * the local dev-server proxy, a `Cookie` header is renamed to `X-Proxy-Cookie`
 * (browsers strip a fetch-set Cookie; devserver.py renames it back).
 *
 * @param {Array<{key:string,val:string}>} headerRows
 * @param {{baseUrl:string, proxyOrigin:string}} opts
 */
export function buildRequestHeaders(headerRows, { baseUrl, proxyOrigin }) {
  const headers = {};
  for (const { key, val } of headerRows) {
    if (key) headers[key] = val;
  }

  const proxyPrefix = `${proxyOrigin}/proxy?url=`;
  if (baseUrl.trim().startsWith(proxyPrefix)) {
    // Match the cookie header regardless of casing (Cookie / cookie / COOKIE).
    const cookieKey = Object.keys(headers).find(k => k.toLowerCase() === 'cookie');
    if (cookieKey) {
      headers['X-Proxy-Cookie'] = headers[cookieKey];
      delete headers[cookieKey];
    }
  }

  // api_key_query auth is not a header — handled in buildRequestUrl()
  return headers;
}

/** The request body: trimmed editor text for body methods, otherwise undefined. */
export function buildRequestBody(method, bodyText) {
  if (!methodHasBody(method)) return undefined;
  return (bodyText ?? '').trim() || undefined;
}
