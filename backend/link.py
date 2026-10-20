import html
import json
import re
import time
from html.parser import HTMLParser
from urllib.parse import parse_qsl, quote, urljoin, urlparse
from urllib.request import Request, urlopen

KEYS = ("site", "title", "author", "text")  # order of the fields in meta.link and in the text added to content
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
MAX_BYTES = 256 * 1024
MAX_ICON = 100 * 1024
EXT = {"image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg", "image/jpeg": "jpg",
       "image/gif": "gif", "image/webp": "webp"}
TIMEOUT = 8  # seconds in total per request
SECRET = re.compile(r"token|key|sig|code|auth|secret|pass|otp|session|reset", re.I)  # query parameter names that look like secrets


def get(url, limit, types):
    """(content type, charset, first limit bytes) of url. Follows redirects. Raises on errors and on other content types."""
    end = time.monotonic() + TIMEOUT
    with urlopen(Request(url, headers={"User-Agent": UA, "Accept-Language": "en"}), timeout=TIMEOUT) as r:
        kind = r.headers.get_content_type()
        if not kind.startswith(types):
            raise ValueError(kind)
        body = b""
        while len(body) < limit and time.monotonic() < end:
            chunk = r.read1(16384)
            if not chunk:
                break
            body += chunk
        return kind, r.headers.get_content_charset() or "utf-8", body


def text(url, limit, types):
    kind, charset, body = get(url, limit, types)
    return body.decode(charset, "replace")


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.title, self.in_title, self.icons = {}, "", False, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self.in_title = True
        elif tag == "meta" and (a.get("property") or a.get("name")):
            self.meta.setdefault((a.get("property") or a["name"]).lower(), a.get("content") or "")
        elif tag == "link" and a.get("href") and re.search(r"\bicon\b", a.get("rel") or ""):
            self.icons.append(("apple" in a["rel"], a["href"]))

    def handle_endtag(self, tag):
        self.in_title &= tag != "title"

    def handle_data(self, data):
        if self.in_title:
            self.title += data


def clean(s, n=400):
    return re.sub(r"\s+", " ", html.unescape(s or "")).strip()[:n]


def page(url):
    p = Head()
    p.feed(text(url, MAX_BYTES, ("text/html", "application/xhtml+xml")))
    m = p.meta
    host = (urlparse(url).hostname or "").removeprefix("www.")
    info = {"site": clean(m.get("og:site_name")) or host, "title": clean(m.get("og:title") or p.title),
            "text": clean(m.get("og:description") or m.get("description"), 600)}
    return info, [urljoin(url, h) for _, h in sorted(p.icons)]  # plain icons first, then apple-touch-icon


def oembed(endpoint, url):
    return json.loads(text(f"{endpoint}?format=json&url={quote(url, safe='')}", 65536, ("application/json", "text/")))


def icon(url, hrefs, folder):
    """Save the site's icon once per host as <folder>/<host>.<ext> and return 'icons/<host>.<ext>', or None."""
    host = re.sub(r"[^a-z0-9.-]", "", (urlparse(url).hostname or "").lower().removeprefix("www."))
    if not host:
        return None
    folder.mkdir(exist_ok=True)
    for f in folder.glob(host + ".*"):
        return f"icons/{f.name}"
    for href in [*hrefs, urljoin(url, "/favicon.ico")]:
        try:
            kind, _, body = get(href, MAX_ICON + 1, "image/")
            if 0 < len(body) <= MAX_ICON:
                name = f"{host}.{EXT.get(kind, 'png')}"
                (folder / name).write_bytes(body)
                return f"icons/{name}"
        except Exception:
            pass


def fetch(url, icons):
    """{site, title, author, text, icon} for a link, or None when nothing could be read. icons is the folder for icon files."""
    try:
        if any(SECRET.search(k) for k, _ in parse_qsl(urlparse(url).query, keep_blank_values=True)):
            return None  # one-time links must not be opened, and the URL must not go to the site
        host, path = (urlparse(url).hostname or "").removeprefix("www.").removeprefix("mobile."), urlparse(url).path
        hrefs = []
        if host in ("x.com", "twitter.com") and re.match(r"/[^/]+/status/\d+", path):
            d = oembed("https://publish.twitter.com/oembed", url)
            t = re.sub(r"<br\s*/?>", "\n", re.search(r"<p[^>]*>(.*?)</p>", d["html"], re.S).group(1))
            t = re.sub(r"<[^>]+>|https?://(t\.co|pic\.twitter\.com)/\S+", "", t)
            handle = d.get("author_url", "").rstrip("/").rsplit("/", 1)[-1]
            r = {"site": "X", "author": clean(d.get("author_name")) + (f" (@{handle})" if handle else ""), "text": clean(t, 600)}
        elif host in ("youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"):
            d = oembed("https://www.youtube.com/oembed", url)
            r = {"site": "YouTube", "title": clean(d.get("title")), "author": clean(d.get("author_name"))}
        else:
            r, hrefs = page(url)
        r = {k: r[k] for k in KEYS if r.get(k)}
        if not (r.get("title") or r.get("text")):
            return None
        return {**r, "icon": icon(url, hrefs, icons)}
    except Exception:
        return None
