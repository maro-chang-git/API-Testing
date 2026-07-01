// Single source of the apiKey-header vs Bearer vs Cookie decision.
//
// The same classification is needed by the Try It tab (request-ui), the Postman
// exporter, the Karate exporter, and the CLI live-runner. Centralising it here
// keeps those call sites in sync (the "keep N call sites in sync" invariant in
// CLAUDE.md): change the auth-style rules once and every consumer follows.
//
// The per-format *value wrappers* (Postman's literal `{{token}}` substitution vs
// Karate's JS-expression concatenation) stay in their exporters — only the facts
// they all share (which header, cookie vs not, the cookie name) live here.

import { isCookieAuth } from '../tryit/request-core.js';

/**
 * Classifies an effective-auth selection into the header-shaping facts.
 *
 * @param {{type?,kind?,name?,in?,token?}} auth - effectiveAuth()-shaped object
 * @param {{auth_type?}} profile
 * @returns {{cookieAuth:boolean, apiKeyHeader:boolean, headerName:string,
 *            fullCookie:boolean, cookieName:string}}
 */
export function classifyAuth(auth = {}, profile = {}) {
  // Cookie auth comes from the persisted effective selection (auth.in / auth.type),
  // not just the spec's scheme name — a scheme-less spec has auth_type 'none', so
  // deciding on isCookieAuth(profile.auth_type) alone would wrongly emit Bearer.
  const cookieAuth = auth.in === 'cookie' || isCookieAuth(auth.type) || isCookieAuth(profile.auth_type);
  // A header apiKey scheme (e.g. x-api-key) is sent as a raw header, no Bearer prefix.
  const apiKeyHeader = auth.kind === 'apiKey' && auth.in === 'header';
  const headerName = cookieAuth ? 'Cookie' : apiKeyHeader ? (auth.name || 'X-API-Key') : 'Authorization';
  // A persisted full `name=value` cookie is sent verbatim; a bare value is
  // prefixed with the cookie name (preserved for invalid/expired credentials).
  const fullCookie = cookieAuth && String(auth.token || '').includes('=');
  const cookieName = fullCookie ? String(auth.token).split('=')[0] : 'session';
  return { cookieAuth, apiKeyHeader, headerName, fullCookie, cookieName };
}
