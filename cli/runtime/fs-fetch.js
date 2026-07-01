// Filesystem-backed `fetch` shim for the CLI.
//
// The browser app reaches the disk through the Python dev server
// (.claude/devserver.py): relative GETs are static files, `POST /save?path=…`
// writes under output/, and live requests are tunnelled via `/proxy?url=…`.
// Every core module (swagger-loader, config-loader, specs-store, the exporters)
// talks to that contract through the global `fetch`.
//
// Installing this shim as `globalThis.fetch` lets the CLI reuse all of those
// modules UNCHANGED — relative reads come off disk, `/save` writes to disk, and
// absolute http(s) URLs (the live-runner's real requests) pass straight through
// to Node's built-in fetch. This is the single seam that keeps the CLI and the
// browser app on one implementation of the generation/export pipeline.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Extensions POST /save may write — same allowlist as devserver.py, so the CLI
// can't be coerced into dropping executable/web-servable files into the tree.
const SAVE_ALLOWED_EXTS = new Set(['.json', '.feature', '.js']);

const SAVE_PREFIX = '/save?';
const PROXY_PREFIX = '/proxy?url=';

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.feature': 'text/plain',
  '.html': 'text/html',
};

// Decide how a fetch() call should be handled. Pure (no I/O) so it can be unit
// tested. Returns one of:
//   { kind: 'network' }                       — absolute http(s) URL or /proxy
//   { kind: 'save', relPath }                 — POST /save?path=<rel>
//   { kind: 'file', relPath }                 — relative path read
export function classifyRequest(rawUrl, method = 'GET') {
  const url = String(rawUrl);

  if (/^https?:\/\//i.test(url)) return { kind: 'network' };

  if (url.startsWith(PROXY_PREFIX)) {
    return { kind: 'network', target: decodeURIComponent(url.slice(PROXY_PREFIX.length)) };
  }

  if (url.startsWith(SAVE_PREFIX) || String(method).toUpperCase() === 'POST') {
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const params = new URLSearchParams(query);
    return { kind: 'save', relPath: params.get('path') || '' };
  }

  // Strip a leading "./" or "/" and any query string — these are static reads
  // like "swaggers/index.json" or "output/{id}/specs.json".
  const clean = url.replace(/^\.?\//, '').split('?')[0];
  return { kind: 'file', relPath: clean };
}

// A minimal Response-like object exposing only what the core modules use:
// `.ok`, `.status`, `.json()`, `.text()`, `.headers.get()`.
function makeResponse(status, body, contentType) {
  const headers = new Map([['content-type', contentType || 'application/octet-stream']]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

// True when `target` resolves inside `root` (path-escape / different-drive safe).
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function handleFile(projectRoot, relPath) {
  const abs = path.resolve(projectRoot, relPath);
  // Containment: a relative read must stay inside the project root.
  if (!isInside(projectRoot, abs)) return makeResponse(403, 'Forbidden', 'text/plain');
  try {
    const body = await readFile(abs, 'utf8');
    const ct = CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    return makeResponse(200, body, ct);
  } catch {
    // Missing file → 404 so loadOrScaffoldSpecs scaffolds and
    // ensureKarateConfigFile writes (mirrors a static server's behaviour).
    return makeResponse(404, 'Not Found', 'text/plain');
  }
}

async function handleSave(projectRoot, relPath, body) {
  if (!relPath) return makeResponse(400, JSON.stringify({ ok: false, error: 'missing path' }), 'application/json');

  const outputRoot = path.resolve(projectRoot, 'output');
  const target = path.resolve(projectRoot, decodeURIComponent(relPath));
  if (!isInside(outputRoot, target)) {
    return makeResponse(403, JSON.stringify({ ok: false, error: 'path must resolve inside output/' }), 'application/json');
  }
  if (!SAVE_ALLOWED_EXTS.has(path.extname(target).toLowerCase())) {
    return makeResponse(403, JSON.stringify({ ok: false, error: 'file extension not allowed (.json/.feature/.js)' }), 'application/json');
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body ?? '', 'utf8');
  return makeResponse(200, JSON.stringify({ ok: true, path: relPath }), 'application/json');
}

/**
 * Replaces globalThis.fetch with the filesystem-backed router. Returns a
 * function that restores the original fetch (handy for tests).
 *
 * @param {string} projectRoot - absolute path to the "API Testing" directory
 */
export function installFsFetch(projectRoot) {
  const realFetch = globalThis.fetch;

  globalThis.fetch = async function fsFetch(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = init.method || (typeof input === 'object' ? input?.method : 'GET') || 'GET';
    const route = classifyRequest(rawUrl, method);

    switch (route.kind) {
      case 'network':
        return realFetch(route.target ?? rawUrl, init);
      case 'save':
        return handleSave(projectRoot, route.relPath, init.body);
      default:
        return handleFile(projectRoot, route.relPath);
    }
  };

  return function uninstall() { globalThis.fetch = realFetch; };
}
