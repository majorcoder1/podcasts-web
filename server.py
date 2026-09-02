#!/usr/bin/env python3
"""
Static file server plus the small same-origin proxy the front end needs.

Browsers cannot fetch podcast RSS feeds directly: feeds do not send CORS
headers. Everything network-facing therefore goes through /api/* here, on the
same origin as the page, which also means the front end needs no CORS at all.

Zero dependencies - Python 3.9+ standard library only.

    python3 server.py --port 8080

Put it behind nginx or Caddy for TLS; see deploy/.
"""

from __future__ import annotations

import argparse
import gzip
import ipaddress
import json
import mimetypes
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import app_api

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")

USER_AGENT = "PodcastsWeb/1.0 (+https://github.com/)"
FETCH_TIMEOUT = 20
MAX_FEED_BYTES = 12 * 1024 * 1024
MAX_REDIRECTS = 5

ITUNES_SEARCH = "https://itunes.apple.com/search"
ITUNES_CHARTS = "https://itunes.apple.com/us/rss/toppodcasts"

# Feed bodies are cached briefly so a reload does not re-hit the publisher.
FEED_CACHE_TTL = 300
_feed_cache: dict[str, tuple[float, bytes, str]] = {}
_cache_lock = threading.Lock()


class UpstreamError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def assert_public_url(raw: str) -> urllib.parse.ParseResult:
    """
    Reject anything that is not a plain public http(s) URL.

    This process can reach the host's own network, so an unguarded fetch(url)
    endpoint would let any visitor probe localhost and the LAN behind it.
    """
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise UpstreamError(400, "Only http and https URLs are allowed")
    if not parsed.hostname:
        raise UpstreamError(400, "URL has no host")

    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror:
        raise UpstreamError(502, "Could not resolve host") from None

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise UpstreamError(403, "That host is not publicly routable")
    return parsed


class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Every hop is re-checked, so a public URL cannot redirect into the LAN."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(ValidatingRedirectHandler())


def fetch(url: str, accept: str, limit: int = MAX_FEED_BYTES) -> tuple[bytes, str]:
    """Fetch a validated URL, returning (body, content_type)."""
    assert_public_url(url)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
            "Accept-Encoding": "gzip",
        },
    )
    try:
        with _opener.open(request, timeout=FETCH_TIMEOUT) as response:
            body = response.read(limit + 1)
            if len(body) > limit:
                raise UpstreamError(502, "Upstream response too large")
            if response.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            return body, response.headers.get("Content-Type", "application/octet-stream")
    except urllib.error.HTTPError as error:
        raise UpstreamError(502, f"Upstream returned {error.code}") from None
    except (urllib.error.URLError, TimeoutError, socket.timeout):
        raise UpstreamError(504, "Upstream did not respond") from None


def cached_feed(url: str) -> tuple[bytes, str]:
    now = time.time()
    with _cache_lock:
        hit = _feed_cache.get(url)
        if hit and now - hit[0] < FEED_CACHE_TTL:
            return hit[1], hit[2]

    body, content_type = fetch(url, "application/rss+xml, application/xml, text/xml, */*")

    with _cache_lock:
        if len(_feed_cache) > 200:
            _feed_cache.clear()
        _feed_cache[url] = (now, body, content_type)
    return body, content_type


ACCOUNT_ROUTES = {
    "/api/register", "/api/login", "/api/logout", "/api/me", "/api/password",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "PodcastsWeb"
    protocol_version = "HTTP/1.1"
    head_only = False

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_HEAD(self):
        # Health checks, CDNs and proxies all probe with HEAD; answer the same
        # headers as GET but drop the body.
        self.head_only = True
        try:
            self.do_GET()
        finally:
            self.head_only = False

    def do_POST(self):
        self.dispatch()

    def do_GET(self):
        self.dispatch()

    def dispatch(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if route in ACCOUNT_ROUTES or route == "/api/sync":
                return self.api_account(route, query)
            if route == "/api/health":
                return self.api_health()
            if self.command != "GET":
                return self.send_json({"error": "Method not allowed"}, 405)
            if route == "/api/feed":
                return self.api_feed(query)
            if route == "/api/search":
                return self.api_search(query)
            if route == "/api/charts":
                return self.api_charts(query)
            if route == "/api/audio":
                return self.api_audio(query)
            if route.startswith("/api/"):
                return self.send_json({"error": "Unknown endpoint"}, 404)
            return self.serve_static(route)
        except app_api.ApiError as error:
            return self.send_json({"error": error.message}, error.status)
        except UpstreamError as error:
            return self.send_json({"error": error.message}, error.status)
        except BrokenPipeError:
            return
        except Exception as error:  # noqa: BLE001 - never take the server down
            self.log_message("unhandled: %r", error)
            return self.send_json({"error": "Internal error"}, 500)

    # ---- accounts and sync -----------------------------------------------

    def read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 8 * 1024 * 1024:
            raise app_api.ApiError(413, "That request is too large")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise app_api.ApiError(400, "Body must be JSON") from None
        return payload if isinstance(payload, dict) else {}

    def presented_token(self):
        header = self.headers.get("Authorization", "")
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == app_api.COOKIE_NAME:
                return value
        return ""

    def require_user(self):
        user = app_api.user_for_token(self.presented_token())
        if user is None:
            raise app_api.ApiError(401, "Sign in to continue")
        return user

    def require_json_post(self):
        # A browser cannot send this content type cross-site without a CORS
        # preflight, which never succeeds here. That plus SameSite on the
        # cookie is the CSRF defence.
        if self.command != "POST":
            raise app_api.ApiError(405, "Use POST for this endpoint")
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise app_api.ApiError(415, "Send JSON")
        return self.read_json_body()

    def api_health(self):
        self.send_json({
            "ok": True,
            "backend": "python",
            "python": sys.version.split()[0],
            "data_dir": app_api._db_path is not None,
            "registration": app_api.REGISTRATION,
        })

    def api_account(self, route, query):
        device = (self.headers.get("User-Agent") or "web")[:64]

        if route == "/api/register":
            payload, token = app_api.register(self.require_json_post(), device)
            return self.send_json(payload, 201, cookie=token)

        if route == "/api/login":
            payload, token = app_api.login(self.require_json_post(), device)
            return self.send_json(payload, cookie=token)

        if route == "/api/logout":
            payload = app_api.logout(self.presented_token())
            return self.send_json(payload, clear_cookie=True)

        if route == "/api/me":
            user = app_api.user_for_token(self.presented_token())
            return self.send_json({"user": None} if user is None else {
                "user": {"username": user["username"], "displayName": user["display_name"]}
            })

        if route == "/api/password":
            user = self.require_user()
            return self.send_json(app_api.change_password(user, self.require_json_post()))

        if route == "/api/sync":
            user = self.require_user()
            if self.command == "POST":
                return self.send_json(app_api.sync(user, self.require_json_post(), None))
            since = clamp_int((query.get("since") or ["0"])[0], 0, 2 ** 62, 0)
            return self.send_json(app_api.sync(user, {}, since))

        return self.send_json({"error": "Unknown endpoint"}, 404)

    # ---- API -------------------------------------------------------------

    def api_feed(self, query):
        url = (query.get("url") or [""])[0]
        if not url:
            raise UpstreamError(400, "Missing url")
        body, _ = cached_feed(url)
        self.send_bytes(body, "application/xml; charset=utf-8", cache="public, max-age=300")

    def api_search(self, query):
        term = (query.get("q") or [""])[0].strip()
        if not term:
            return self.send_json({"results": []})
        limit = clamp_int((query.get("limit") or ["50"])[0], 1, 200, 50)
        url = ITUNES_SEARCH + "?" + urllib.parse.urlencode(
            {"term": term, "media": "podcast", "entity": "podcast", "limit": limit}
        )
        body, _ = fetch(url, "application/json")
        self.send_bytes(body, "application/json; charset=utf-8", cache="public, max-age=600")

    def api_charts(self, query):
        genre = (query.get("genre") or [""])[0].strip()
        limit = clamp_int((query.get("limit") or ["30"])[0], 1, 100, 30)
        url = f"{ITUNES_CHARTS}/limit={limit}"
        if genre.isdigit():
            url += f"/genre={genre}"
        url += "/json"
        body, _ = fetch(url, "application/json")
        self.send_bytes(body, "application/json; charset=utf-8", cache="public, max-age=3600")

    def api_audio(self, query):
        """
        Only used when downloading an episode for offline play: the Cache API
        needs a same-origin response. Normal streaming plays straight from the
        publisher, so this does not sit in the hot path.
        """
        url = (query.get("url") or [""])[0]
        if not url:
            raise UpstreamError(400, "Missing url")
        body, content_type = fetch(url, "audio/*", limit=400 * 1024 * 1024)
        if not content_type.startswith(("audio/", "video/", "application/octet-stream")):
            raise UpstreamError(415, "That URL is not audio")
        self.send_bytes(body, content_type)

    # ---- static ----------------------------------------------------------

    def serve_static(self, route):
        relative = route.lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(PUBLIC, relative))
        if not target.startswith(PUBLIC):
            return self.send_json({"error": "Not found"}, 404)
        # Apache hides .htaccess and friends; this server should too.
        if any(part.startswith(".") for part in relative.split("/") if part):
            return self.send_json({"error": "Not found"}, 404)
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            # Single-page app: unknown paths render the shell and route client-side.
            target = os.path.join(PUBLIC, "index.html")

        content_type, _ = mimetypes.guess_type(target)
        if target.endswith(".webmanifest"):
            content_type = "application/manifest+json"

        stat = os.stat(target)
        etag = '"%x-%x"' % (int(stat.st_mtime), stat.st_size)

        # The app ships unversioned module paths, so every asset must revalidate
        # or a redeploy would not reach anyone still holding a cached copy.
        # no-cache means "ask first", and the ETag turns that into a cheap 304.
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        with open(target, "rb") as handle:
            body = handle.read()
        self.send_bytes(
            body,
            content_type or "application/octet-stream",
            cache="no-cache",
            etag=etag,
        )

    # ---- plumbing --------------------------------------------------------

    def send_bytes(self, body: bytes, content_type: str, cache: str = "no-store", etag: str | None = None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)

    def send_json(self, payload: dict, status: int = 200, cookie=None, clear_cookie=False):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header(
                "Set-Cookie",
                f"{app_api.COOKIE_NAME}={cookie}; Path=/; Max-Age={app_api.TOKEN_TTL}; "
                "HttpOnly; SameSite=Lax",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{app_api.COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
            )
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)


def clamp_int(raw: str, low: int, high: int, fallback: int) -> int:
    try:
        return max(low, min(high, int(raw)))
    except (TypeError, ValueError):
        return fallback


def main():
    parser = argparse.ArgumentParser(description="Serve the podcast web app")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = parser.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("image/svg+xml", ".svg")

    app_api.configure(os.path.join(HERE, "data"))

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving {PUBLIC} on http://{args.host}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
