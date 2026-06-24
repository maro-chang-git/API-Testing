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
"""
import os
import http.server
import urllib.request
import urllib.error

PROXY_PREFIX = '/proxy?url='

# Request headers the proxy must not forward: hop-by-hop / connection-specific
# ones, plus those it sets itself (Host, Content-Length).
SKIP_REQUEST_HEADERS = {'host', 'connection', 'content-length', 'accept-encoding'}

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

    def do_POST(self):    self.proxy()
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
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.relay(resp.status, resp.headers, resp.read())
        except urllib.error.HTTPError as e:
            # 4xx/5xx from the target are valid test results — relay them as-is.
            self.relay(e.code, e.headers, e.read())
        except urllib.error.URLError as e:
            self.send_error(502, f'Proxy could not reach target: {e.reason}')

    def relay(self, status, headers, body):
        self.send_response(status)
        for key in headers:
            if key.lower() not in SKIP_RESPONSE_HEADERS:
                self.send_header(key, headers[key])
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


port = int(os.environ.get('PORT', '8000'))
# Threaded so the browser's parallel module requests don't serialize/stall.
httpd = http.server.ThreadingHTTPServer(('', port), DevHandler)
httpd.serve_forever()
