"""Static file server for the local browser tests (`just e2e`).

`python3 -m http.server` drops connections when a browser opens the ~40 ES
modules of the confirmation log at once (listen backlog of 5), which shows
up as flaky ERR_CONNECTION_RESET console errors. Same server, bigger backlog,
and the Cache-Control rule of deploy/nginx.conf.example (deploy.spec.mjs).

Usage: python3 serve.py <directory> [port]
"""

import functools
import http.server
import re
import sys

# deploy/nginx.conf.example: revalidate pages, scripts, styles and data.
NO_CACHE = re.compile(r"(/|\.(html|js|mjs|css|json|webmanifest))$")


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        if NO_CACHE.search(self.path.split("?", 1)[0]):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):  # quiet: Playwright shows failures
        pass


def main() -> None:
    directory = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    handler = functools.partial(Handler, directory=directory)
    with Server(("127.0.0.1", port), handler) as httpd:
        print(f"serving {directory} at http://127.0.0.1:{port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
