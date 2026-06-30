"""Static dev server + CORS proxy for the API Test Cases viewer.

Serves the project directory and sends `Cache-Control: no-store` so the
browser always re-fetches JS modules during development (avoids stale ES
module caching after edits). Port comes from the PORT env var.

It also exposes a same-origin forwarding proxy at `/proxy?url=<target>` so the
Try It tab can call APIs that don't send CORS headers. Because the browser
talks to this server (same origin as the page) and this server makes the real
request server-side, CORS never applies. The browser refuses to let fetch()
set a `Cookie` header (it's a forbidden header name), so request-builder.js
sends it as `X-Proxy-Cookie`; the proxy renames it back to `Cookie` before
forwarding to the target.

Security: the listener binds **127.0.0.1 only** (loopback), so it is never
reachable from the LAN — Vite (same host) is the only intended client. Both
write/forward surfaces are further constrained: `/save` enforces a write-extension
allowlist plus a loopback-Origin (CSRF) check, and `/proxy` validates every target
(and redirect hop) against an SSRF guard that blocks private / loopback / link-local
/ reserved addresses unless the host is opted in via the `PROXY_ALLOW_HOSTS` env var.
"""
import os
import json
import ssl
import socket
import ipaddress
import http.server
import urllib.request
import urllib.error
import urllib.parse

PROXY_PREFIX = '/proxy?url='
SAVE_PREFIX = '/save?'

# Extensions the browser legitimately writes via POST /save (specs.json, exported
# test-case JSON, Postman collections, Karate .feature files, karate-config.js).
# Anything else is rejected so /save can't be coerced into dropping executable or
# web-servable files (.html/.bat/…) into the repo tree.
SAVE_ALLOWED_EXTS = {'.json', '.feature', '.js'}

# Origins allowed to POST /save. The browser sets Origin on every fetch POST, and
# Vite forwards it unchanged (http://localhost:5500). Requiring a loopback origin
# blocks drive-by CSRF POSTs from a malicious page (which carry their own Origin).
SAVE_ALLOWED_ORIGIN_HOSTS = {'localhost', '127.0.0.1', '::1'}

# Hostnames the proxy may reach even if they resolve to a private/loopback address.
# Comma-separated in PROXY_ALLOW_HOSTS, e.g. "127.0.0.1,localhost" to test a local
# no-CORS API (swaggers/openapi3.json points at 127.0.0.1:8774).
PROXY_ALLOW_HOSTS = {h.strip().lower() for h in
                     os.environ.get('PROXY_ALLOW_HOSTS', '').split(',') if h.strip()}


class ProxyTargetError(Exception):
    """A proxy target (or redirect hop) failed the SSRF / scheme validation."""


def validate_target(url):
    """Reject non-http(s) schemes and targets that resolve to a private / loopback
    / link-local / reserved address (covers cloud-metadata 169.254.169.254), unless
    the host is allow-listed via PROXY_ALLOW_HOSTS. Raises ProxyTargetError on a
    blocked target. Re-run on every redirect hop, not just the initial URL."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ('http', 'https'):
        raise ProxyTargetError(f'scheme not allowed: {parts.scheme or "(none)"}')
    host = (parts.hostname or '').lower()
    if not host:
        raise ProxyTargetError('missing target host')
    if host in PROXY_ALLOW_HOSTS:
        return
    try:
        infos = socket.getaddrinfo(host, parts.port)
    except socket.gaierror as e:
        raise ProxyTargetError(f'cannot resolve host: {host} ({e})')
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ProxyTargetError(f'target resolves to a blocked address: {ip}')


class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate each redirect target so a public URL can't bounce the proxy into
    a private/internal address (or switch to a non-http scheme) mid-request."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_target(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# TLS context for outbound proxy requests. Re-enable OpenSSL legacy renegotiation
# (off by default since OpenSSL 3) so hosts that still require it — e.g. the
# Databricks Apps host — don't fail with UNSAFE_LEGACY_RENEGOTIATION_DISABLED.
_tls_ctx = ssl.create_default_context()
if hasattr(ssl, 'OP_LEGACY_SERVER_CONNECT'):
    _tls_ctx.options |= ssl.OP_LEGACY_SERVER_CONNECT

# Opener that applies the TLS context and re-validates every redirect hop.
PROXY_OPENER = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=_tls_ctx),
    ValidatingRedirectHandler(),
)

# Browser exports and the per-swagger specs file are written here via POST /save.
# Writes are confined to this directory — see save() for the containment check.
OUTPUT_ROOT = os.path.realpath(os.path.join(os.getcwd(), 'output'))

# Request headers the proxy must not forward: hop-by-hop / connection-specific
# ones, plus those it sets itself (Host, Content-Length). `origin`/`referer` are
# dropped too so the target sees a server-side client, not a browser — some APIs
# (e.g. Anthropic) otherwise reject the call as a direct browser request unless a
# special opt-in header is set. The proxy already removes CORS from the equation,
# so the browser's Origin serves no purpose downstream.
SKIP_REQUEST_HEADERS = {'host', 'connection', 'content-length', 'accept-encoding',
                        'origin', 'referer'}

# Response headers we regenerate ourselves or that don't survive proxying.
# Content-Encoding is kept so a gzipped body still decodes in the browser.
SKIP_RESPONSE_HEADERS = {'transfer-encoding', 'connection', 'content-length', 'date', 'server'}


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    # ── Method routing: /proxy?url= is forwarded, everything else is a file ──
    def do_GET(self):
        if self.path.startswith(PROXY_PREFIX):
            self.proxy()
        else:
            super().do_GET()

    def do_HEAD(self):
        if self.path.startswith(PROXY_PREFIX):
            self.proxy()
        else:
            super().do_HEAD()

    def do_POST(self):
        if self.path.startswith(SAVE_PREFIX):
            self.save()
        else:
            self.proxy()

    def do_PUT(self):     self.proxy()
    def do_PATCH(self):   self.proxy()
    def do_DELETE(self):  self.proxy()
    def do_OPTIONS(self): self.proxy()

    # ── Forwarding proxy ────────────────────────────────────────────────────
    def proxy(self):
        if not self.path.startswith(PROXY_PREFIX):
            self.send_error(400, 'Proxy requests must use /proxy?url=<target>')
            return

        # Everything after `url=` is the raw target — taking the rest of the
        # path verbatim preserves the target's own query string (which may
        # itself contain `?` and `&`).
        target = self.path[len(PROXY_PREFIX):]
        if not target:
            self.send_error(400, 'Missing target url')
            return

        try:
            validate_target(target)
        except ProxyTargetError as e:
            self.send_error(403, f'Proxy target rejected: {e}')
            return

        fwd_headers = {}
        for key in self.headers:
            lower = key.lower()
            if lower in SKIP_REQUEST_HEADERS:
                continue
            if lower == 'x-proxy-cookie':
                fwd_headers['Cookie'] = self.headers[key]
            else:
                fwd_headers[key] = self.headers[key]

        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target, data=body, method=self.command, headers=fwd_headers)
        # One bounded retry: transient network/TLS hiccups (e.g. the Databricks Apps
        # host) raise URLError; a single retry smooths them over without masking a real
        # outage. HTTPError (4xx/5xx) is a valid test result and is relayed immediately.
        last_err = None
        for attempt in range(2):
            try:
                with PROXY_OPENER.open(req, timeout=30) as resp:
                    self.relay(resp.status, resp.headers, resp.read())
                return
            except urllib.error.HTTPError as e:
                # 4xx/5xx from the target are valid test results — relay them as-is.
                self.relay(e.code, e.headers, e.read())
                return
            except ProxyTargetError as e:
                # A redirect hop resolved to a blocked target.
                self.send_error(403, f'Proxy redirect rejected: {e}')
                return
            except urllib.error.URLError as e:
                last_err = e
        self.send_error(502, f'Proxy could not reach target: {last_err.reason}')

    def relay(self, status, headers, body):
        self.send_response(status)
        for key in headers:
            if key.lower() not in SKIP_RESPONSE_HEADERS:
                self.send_header(key, headers[key])
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── File writer (POST /save?path=output/…) ──────────────────────────────
    # Lets the browser persist the per-swagger specs file and the Postman/Karate
    # exports to disk under output/. The target is taken from the `path` query
    # param and resolved against OUTPUT_ROOT; anything that escapes that folder
    # (absolute paths, `..`, another drive) is rejected so a stray request can't
    # write elsewhere on the machine.
    def save(self):
        # Drain the request body first so the socket is clean before we respond
        # (responding with data still pending on the socket resets it on Windows).
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''

        # CSRF guard: only accept writes from a loopback Origin. The browser sets
        # Origin on every fetch POST and Vite forwards it (http://localhost:5500);
        # a drive-by POST from a malicious page carries a non-loopback Origin.
        origin = self.headers.get('Origin')
        if not origin or urllib.parse.urlsplit(origin).hostname not in SAVE_ALLOWED_ORIGIN_HOSTS:
            self.send_error(403, 'Save requests must come from a loopback origin')
            return

        query = urllib.parse.urlsplit(self.path).query
        rel = (urllib.parse.parse_qs(query).get('path') or [''])[0]
        if not rel:
            self.send_error(400, 'Missing target path (/save?path=output/...)')
            return

        target = os.path.realpath(os.path.join(os.getcwd(), rel))
        try:
            inside = os.path.commonpath([target, OUTPUT_ROOT]) == OUTPUT_ROOT
        except ValueError:
            inside = False  # different drive on Windows
        if not inside:
            self.send_error(403, 'Path must resolve inside output/')
            return

        if os.path.splitext(target)[1].lower() not in SAVE_ALLOWED_EXTS:
            self.send_error(403, 'File extension not allowed (.json/.feature/.js only)')
            return

        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(body)

        payload = json.dumps({'ok': True, 'path': rel}).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


port = int(os.environ.get('PORT', '8000'))
# Threaded so the browser's parallel module requests don't serialize/stall.
# Bind loopback only — Vite (same host) is the sole intended client; this keeps the
# /save writer and /proxy forwarder off the LAN.
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), DevHandler)
print(f'devserver listening on http://127.0.0.1:{port} (loopback only)')
httpd.serve_forever()
