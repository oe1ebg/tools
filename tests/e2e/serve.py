"""Static file server for the local browser tests (`just e2e`).

`python3 -m http.server` drops connections when a browser opens the ~40 ES
modules of the confirmation log at once (listen backlog of 5), which shows
up as flaky ERR_CONNECTION_RESET console errors. Same server, bigger backlog,
and the response headers of deploy/nginx.conf.example (deploy.spec.mjs):
its `add_header` lines and `map $uri` blocks are read from that file, so
the two can't drift apart.

Usage: python3 serve.py <directory> [port]
"""

import functools
import http.server
import re
import sys
from pathlib import Path

NGINX_CONF = Path(__file__).resolve().parents[2] / "deploy" / "nginx.conf.example"

# nginx sends add_header without `always` only with these statuses.
ADD_HEADER_STATUSES = {200, 201, 204, 206, 301, 302, 303, 304, 307, 308}


def read_nginx_headers(text: str):
    """[(name, value-or-$var, always)], {var: (default, [(regex, value)])}."""
    text = re.sub(r"#[^\n]*", "", text)
    maps = {}
    for var, body in re.findall(r"map\s+\$uri\s+\$(\w+)\s*\{(.*?)\}", text, re.S):
        default, rules = "", []
        for key, value in re.findall(r'(\S+)\s+"([^"]*)"\s*;', body):
            if key == "default":
                default = value
            else:
                rules.append((re.compile(key.removeprefix("~")), value))
        maps[var] = (default, rules)
    headers = [
        (name, value.strip('"'), bool(always))
        for name, value, always in re.findall(r'add_header\s+(\S+)\s+("[^"]*"|\S+?)(\s+always)?\s*;', text)
    ]
    return headers, maps


HEADERS, MAPS = read_nginx_headers(NGINX_CONF.read_text(encoding="utf-8"))


def header_value(value: str, uri: str) -> str:
    if not value.startswith("$"):
        return value
    default, rules = MAPS[value[1:]]
    return next((v for rx, v in rules if rx.search(uri)), default)


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
    }
    status = 200

    def send_response(self, code, message=None):
        self.status = code
        super().send_response(code, message)

    def end_headers(self):
        uri = self.path.split("?", 1)[0]
        # nginx's $uri after the index redirect
        if uri.endswith("/") and self.status < 300:
            uri += "index.html"
        for name, value, always in HEADERS:
            if always or self.status in ADD_HEADER_STATUSES:
                value = header_value(value, uri)
                if value:
                    self.send_header(name, value)
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
