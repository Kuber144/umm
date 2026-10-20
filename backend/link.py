import html
import json
import os
import re
import time
from html.parser import HTMLParser
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

ENRICH = os.environ.get("UMM_ENRICH") != "0"  # set UMM_ENRICH=0 to never fetch anything for saved links
KEYS = ("site", "title", "author", "text")  # order of the fields in meta.link and in the text added to content
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
MAX_BYTES = 256 * 1024
TIMEOUT = 8  # seconds in total per request


def get(url, limit, only_html=False):
    """Text of the first limit bytes of url. Follows redirects. Raises on errors and, with only_html, other types."""
    end = time.monotonic() + TIMEOUT
    with urlopen(Request(url, headers={"User-Agent": UA, "Accept-Language": "en"}), timeout=TIMEOUT) as r:
        kind = r.headers.get_content_type()
        if only_html and kind not in ("text/html", "application/xhtml+xml"):
            raise ValueError(kind)
        body = b""
        while len(body) < limit and time.monotonic() < end:
            chunk = r.read1(16384)
            if not chunk:
                break
            body += chunk
        return body.decode(r.headers.get_content_charset() or "utf-8", "replace")


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.title, self.in_title = {}, "", False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self.in_title = True
        elif tag == "meta" and (a.get("property") or a.get("name")):
            self.meta.setdefault((a.get("property") or a["name"]).lower(), a.get("content") or "")

    def handle_endtag(self, tag):
        self.in_title &= tag != "title"

    def handle_data(self, data):
        if self.in_title:
            self.title += data


def clean(s, n=400):
    return re.sub(r"\s+", " ", html.unescape(s or "")).strip()[:n]


def page(url):
    p = Head()
    p.feed(get(url, MAX_BYTES, True))
    m = p.meta
    host = (urlparse(url).hostname or "").removeprefix("www.")
    return {"site": clean(m.get("og:site_name")) or host, "title": clean(m.get("og:title") or p.title),
            "text": clean(m.get("og:description") or m.get("description"), 600)}


def oembed(endpoint, url):
    return json.loads(get(f"{endpoint}?format=json&url={quote(url, safe='')}", 65536))


def fetch(url):
    """{site, title, author, text} for a link, or None when nothing could be read."""
    try:
        host, path = (urlparse(url).hostname or "").removeprefix("www.").removeprefix("mobile."), urlparse(url).path
        if host in ("x.com", "twitter.com") and re.match(r"/[^/]+/status/\d+", path):
            d = oembed("https://publish.twitter.com/oembed", url)
            text = re.sub(r"<br\s*/?>", "\n", re.search(r"<p[^>]*>(.*?)</p>", d["html"], re.S).group(1))
            text = re.sub(r"<[^>]+>|https?://(t\.co|pic\.twitter\.com)/\S+", "", text)
            handle = d.get("author_url", "").rstrip("/").rsplit("/", 1)[-1]
            r = {"site": "X", "author": clean(d.get("author_name")) + (f" (@{handle})" if handle else ""), "text": clean(text, 600)}
        elif host in ("youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"):
            d = oembed("https://www.youtube.com/oembed", url)
            r = {"site": "YouTube", "title": clean(d.get("title")), "author": clean(d.get("author_name"))}
        else:
            r = page(url)
        r = {k: r[k] for k in KEYS if r.get(k)}
        return r if r.get("title") or r.get("text") else None
    except Exception:
        return None
