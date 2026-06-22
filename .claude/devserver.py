"""Static dev server for the API Test Cases viewer.

Serves the project directory and sends `Cache-Control: no-store` so the
browser always re-fetches JS modules during development (avoids stale ES
module caching after edits). Port comes from the PORT env var.
"""
import os
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


port = int(os.environ.get('PORT', '8000'))
# Threaded so the browser's parallel module requests don't serialize/stall.
httpd = http.server.ThreadingHTTPServer(('', port), NoCacheHandler)
httpd.serve_forever()
