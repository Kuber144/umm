import functools
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
from pathlib import Path

import numpy as np

import embed
import link

os.umask(0o077)  # the data folder is private to the user
BASE = Path.home() / "Library" / "Application Support" / "umm"  # fixed: the location pointer, socket and log
POINTER = BASE / "location"  # absolute path of the data folder, absent means BASE
KEEP = {"location", "umm.sock", "umm.log"}  # belong to BASE, never moved with the data
OLD = Path(__file__).resolve().parent.parent / "data"  # the data folder before it could move


def location():
    """UMM_DATA, else the pointer file if its folder exists (an unplugged drive or a deleted folder falls back), else BASE."""
    p = POINTER.exists() and Path(POINTER.read_text().strip())
    return Path(os.environ.get("UMM_DATA") or (p if p and p.is_absolute() and p.is_dir() else BASE))


if not os.environ.get("UMM_DATA") and not POINTER.exists() and not (BASE / "umm.db").exists() and (OLD / "umm.db").exists():
    BASE.mkdir(parents=True, exist_ok=True)
    for f in sorted(OLD.iterdir(), key=lambda f: f.name == "umm.db"):  # the database last, so a move cut short runs again
        if f.name not in KEEP:
            shutil.move(f, BASE / f.name)
    print(f"umm: moved the data in {OLD} to {BASE}", file=sys.stderr)  # stderr, MCP owns stdout
DATA = location()
if not os.environ.get("UMM_DATA") and POINTER.exists() and POINTER.read_text().strip() != str(DATA):
    print(f"umm: the data folder {POINTER.read_text().strip()} is missing, using {DATA} until it is back", file=sys.stderr)
FILES = DATA / "files"
FILES.mkdir(parents=True, exist_ok=True)
DATA.chmod(0o700)
embed.DIR = DATA / "model"
MAX_CONTENT = 100_000  # characters
PROFILE = DATA / "profile.txt"
EXTRA = DATA / "profiles.txt"  # created profiles, one per line, so empty ones persist
BUILTIN = ["user", "agent"]

# one connection is shared by API threads and the transcriber, so every function below runs under this lock
lock = threading.RLock()


def locked(f):
    @functools.wraps(f)
    def run(*a, **k):
        with lock:
            return f(*a, **k)
    return run


db = sqlite3.connect(DATA / "umm.db", check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")  # MCP servers write from other processes
db.execute("PRAGMA busy_timeout=5000")
SCHEMA = "profile UNINDEXED, kind UNINDEXED, content, file UNINDEXED, app, meta UNINDEXED, created_at UNINDEXED, vec UNINDEXED, note"
if db.execute("SELECT 1 FROM pragma_table_info('items') WHERE name = 'note'").fetchone() is None:
    old = [c for (c,) in db.execute("SELECT name FROM pragma_table_info('items')")]
    if old:  # table from before note (and maybe before vec or meta), copy what it has
        db.backup(sqlite3.connect(DATA / "umm.db.bak"))
        cols = ", ".join(old)
        db.execute("BEGIN")
        db.execute(f"CREATE VIRTUAL TABLE items_new USING fts5({SCHEMA})")
        db.execute(f"INSERT INTO items_new(rowid, {cols}) SELECT rowid, {cols} FROM items")
        db.execute("DROP TABLE items")
        db.execute("ALTER TABLE items_new RENAME TO items")
        db.commit()
    else:
        db.execute(f"CREATE VIRTUAL TABLE items USING fts5({SCHEMA})")
COLS = "rowid AS id, profile, kind, content, file, app, meta, created_at, note"
MOVED = 1  # PRAGMA user_version of a database the data folder moved away from


def commit():
    """Commits a write, unless the data folder moved while it waited for the lock. Else it would land in the old, deleted database."""
    if db.execute("PRAGMA user_version").fetchone()[0] == MOVED:
        db.rollback()
        raise sqlite3.OperationalError("umm moved its data folder, try again")
    db.commit()


def row(r):
    d = dict(r)
    d["meta"] = json.loads(d["meta"]) if d["meta"] else None
    return d


def active_profile():
    return PROFILE.read_text().strip() if PROFILE.exists() else "user"


def extra():
    return EXTRA.read_text().split("\n") if EXTRA.exists() else []


def set_profile(name):
    PROFILE.write_text(name)
    if name not in BUILTIN + extra():
        EXTRA.write_text("\n".join([*extra(), name]).strip())


@locked
def profiles():
    counts = dict(db.execute("SELECT profile, count(*) FROM items GROUP BY profile").fetchall())
    names = BUILTIN + sorted((set(counts) | set(extra()) | {active_profile()}) - set(BUILTIN) - {""})
    return [{"name": n, "count": counts.get(n, 0)} for n in names]


@locked
def rename_profile(old, new):
    db.execute("UPDATE items SET profile = ? WHERE profile = ?", (new, old))
    commit()
    EXTRA.write_text("\n".join(n for n in {*extra(), new} - {old, ""}))
    if active_profile() == old:
        PROFILE.write_text(new)


@locked
def delete_profile(name):
    for (id,) in db.execute("SELECT rowid FROM items WHERE profile = ?", (name,)).fetchall():
        delete(id)
    EXTRA.write_text("\n".join(n for n in extra() if n != name))
    if active_profile() == name:
        PROFILE.write_text("user")


def detect(content):
    if content.startswith(("http://", "https://")):
        return "link"
    if "\n" not in content and content.startswith(("/", "~/")) and os.path.exists(os.path.expanduser(content)):
        return "path"
    return "text"


@locked
def add(content, kind=None, file=None, app=None, profile=None, meta=None, note=None):
    profile, kind = profile or active_profile(), kind or detect(content)
    if not file and (same := [id for id, c, _ in recent(profile, kind, 10) if c == content]):  # a double Enter saves once
        return same[0]
    cur = db.execute("INSERT INTO items(profile, kind, content, file, app, meta, created_at, note) "
                     "VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?)",
                     (profile, kind, content, file, app, json.dumps(meta) if meta else None, note or None))
    commit()
    if cur.lastrowid and kind == "link":
        enrich_later(cur.lastrowid, content)
    embed_later()
    return cur.lastrowid


def enrich_on():
    import settings  # settings imports db, so import it here
    return settings.get()["enrich_links"]


def enrich_later(id, content):
    threading.Thread(target=enrich, args=(id, content.split()[0]), daemon=True).start()


# links not looked up yet. meta.tried marks a failed or refused attempt, so backfill does not retry it at every launch
TODO = "kind = 'link' AND json_extract(meta, '$.link') IS NULL AND json_extract(meta, '$.tried') IS NULL"


def enrich(id, url):
    """Fetch title and text for a saved link. Puts them in meta.link and appends them to content so FTS finds them."""
    if not enrich_on():
        return
    info = link.fetch(url, FILES / "icons")
    with lock:
        if info:
            icon = info.pop("icon")  # meta.icon is a file name under /api/files/, shared by every link on that host
            db.execute("UPDATE items SET content = content || ?, vec = NULL, "
                       f"meta = json_set(coalesce(meta, '{{}}'), '$.link', json(?), '$.icon', ?) WHERE rowid = ? AND {TODO}",
                       ("\n" + "\n".join(info.values()), json.dumps(info), icon, id))
        else:
            db.execute(f"UPDATE items SET meta = json_set(coalesce(meta, '{{}}'), '$.tried', 1) WHERE rowid = ? AND {TODO}", (id,))
        commit()
    if info:
        embed_later()


def backfill(delay=1):
    """Enrich links saved before enrichment existed. One per second, newest first."""
    with lock:
        todo = db.execute(f"SELECT rowid, content FROM items WHERE {TODO} ORDER BY rowid DESC").fetchall() if enrich_on() else []
    for id, content in todo:
        enrich(id, content.split()[0])
        time.sleep(delay)


@locked
def update(id, content=None, profile=None, note=None):
    if content is not None:  # a new text drops what was fetched for the old link
        db.execute("UPDATE items SET content = ?, kind = ?, vec = NULL, meta = json_remove(meta, '$.link', '$.icon', '$.tried') "
                   "WHERE rowid = ? AND kind NOT IN ('screenshot', 'voice')", (content, detect(content), id))
        db.execute("UPDATE items SET content = ?, vec = NULL, meta = json_remove(meta, '$.transcribing') "
                   "WHERE rowid = ? AND kind IN ('screenshot', 'voice')", (content, id))
    if note is not None:  # "" clears it
        db.execute("UPDATE items SET note = ?, vec = NULL WHERE rowid = ?", (note or None, id))
    if profile:
        db.execute("UPDATE items SET profile = ? WHERE rowid = ?", (profile, id))
    commit()
    if content is not None and (r := get(id)) and r["kind"] == "link":
        enrich_later(id, content)
    embed_later()


embedding = threading.Lock()


def embed_pending():
    """Embeds every item without a vector, 4 at a time to keep the model's peak memory down."""
    with embedding:
        while True:
            with lock:
                rows = db.execute("SELECT rowid, content, note FROM items WHERE vec IS NULL AND content != '' LIMIT 4").fetchall()  # a voice note being transcribed waits
            vecs = rows and embed.embed([f"{n}\n{c}" if n else c for _, c, n in rows])  # outside the lock, the model is slow
            if not vecs:  # nothing left, or no model and the items stay keyword only
                return
            with lock:
                for (id, c, _), v in zip(rows, vecs):
                    db.execute("UPDATE items SET vec = ? WHERE rowid = ? AND content = ?", (v, id, c))  # skips an item edited meanwhile
                commit()


def embed_later():
    threading.Thread(target=embed_pending, daemon=True).start()


def fts(q):
    """FTS5 match string. Each word is quoted so paths like ~/a/b don't break the syntax, * gives prefix match."""
    return " ".join(f'"{w}"*' for w in q.replace('"', "").replace("\0", "").split())


RRF = 60  # reciprocal rank fusion constant
# e5 cosines are compressed (unrelated 0.75-0.8, real 0.8-0.9), so keep the top SEM_TOP above SEM_MIN and within SEM_GAP of the best
SEM_TOP, SEM_MIN, SEM_GAP = 20, 0.8, 0.06
APP = "substr(app, 1, instr(app || ':', ':') - 1)"  # app name is the part before ':'


def search(q="", profile=None, kind=None, limit=50, offset=0, app=None, since=None, until=None, sort=None,
           agent=None, project=None, source=None, session=None, mode="hybrid"):
    """profile None or '*' searches every profile. kind is comma separated. since/until are YYYY-MM-DD or YYYY-MM-DD HH:MM, inclusive.
    agent, source and session match those meta keys. project matches meta.cwd, that folder or any folder under it.
    With q, mode "hybrid" fuses keyword and cosine ranks. "keyword", or a missing model, is keywords only."""
    qv = fts(q) and mode != "keyword" and embed.embed([q], query=True)  # before the lock, a cold model takes ~0.5 s and saves would wait
    with lock:
        where, args = [], []
        match = fts(q)
        if match:
            where.append("items MATCH ?")
            args.append(match)
        # created_at is "YYYY-MM-DD HH:MM:SS", so until + "z" sorts after every time within the given day or minute
        for cond, val in [("profile = ?", profile if profile != "*" else None), (f"{APP} = ?", app),
                          ("created_at >= ?", since), ("created_at <= ? || 'z'", until)]:
            if val:
                where.append(cond)
                args.append(val)
        for key, val in [("agent", agent), ("source", source), ("session", session)]:
            if val:
                where.append(f"json_extract(meta, '$.{key}') = ?")
                args.append(val)
        if project:
            project = project.rstrip("/") or "/"
            where.append("(json_extract(meta, '$.cwd') = ? OR substr(json_extract(meta, '$.cwd'), 1, length(?) + 1) = ? || '/')")
            args += [project] * 3
        if kind:
            where.append(f"kind IN ({','.join('?' * len(kind.split(',')))})")
            args += kind.split(",")
        clause = lambda w: f"WHERE {' AND '.join(w)}" if w else ""
        if match and qv:
            # hybrid: reciprocal rank fusion of keyword order and cosine order, same filters on both
            score = {id: 1 / (RRF + n) for n, (id,) in enumerate(db.execute(f"SELECT rowid FROM items {clause(where)} ORDER BY rank", args))}
            vecs = db.execute(f"SELECT rowid, vec FROM items {clause(where[1:] + ['vec IS NOT NULL'])}", args[1:]).fetchall()
            qv = np.frombuffer(qv[0], np.float16).astype(np.float32)
            sims = np.frombuffer(b"".join(v for _, v in vecs), np.float16).reshape(len(vecs), qv.size).astype(np.float32) @ qv
            for n, i in enumerate(i for i in np.argsort(-sims)[:SEM_TOP] if sims[i] >= max(SEM_MIN, sims.max() - SEM_GAP)):
                score[vecs[i][0]] = score.get(vecs[i][0], 0) + 1 / (RRF + n)
            ids = sorted(score, key={"old": lambda i: i, "new": lambda i: -i}.get(sort, lambda i: (-score[i], -i)))[offset:offset + limit]
            found = {r["id"]: row(r) for r in db.execute(f"SELECT {COLS} FROM items WHERE rowid IN ({','.join('?' * len(ids))})", ids)}
            return [found[i] for i in ids]
        order = {"old": "rowid", "new": "rowid DESC"}.get(sort) or ("rank, rowid DESC" if match else "rowid DESC")
        sql = f"SELECT {COLS} FROM items {clause(where)} ORDER BY {order} LIMIT ? OFFSET ?"
        return [row(r) for r in db.execute(sql, (*args, limit, offset))]


@locked
def snippets(q, ids):
    """{id: text around the first keyword match} for the items in ids that match q."""
    if not (match := fts(q)) or not ids:
        return {}
    return dict(db.execute(f"SELECT rowid, snippet(items, 2, '', '', ' ... ', 40) FROM items WHERE items MATCH ? "
                           f"AND rowid IN ({','.join('?' * len(ids))})", (match, *ids)))


@locked
def has_file(name):
    return db.execute("SELECT 1 FROM items WHERE file = ?", (name,)).fetchone() is not None


@locked
def transcribing():
    """(id, file) of voice items whose transcription has not finished."""
    return db.execute("SELECT rowid, file FROM items WHERE json_extract(meta, '$.transcribing')").fetchall()


@locked
def apps(profile=None):
    where = "WHERE profile = ?" if profile and profile != "*" else ""
    sql = f"SELECT {APP} AS a, count(*) AS n FROM items {where} GROUP BY a HAVING a != '' ORDER BY n DESC, a"
    return [{"app": a, "count": n} for a, n in db.execute(sql, (profile,) if where else ())]


@locked
def origins(profile=None):
    """Where items came from: count per (source, agent, cwd), for the source, agent and project filters."""
    where = "WHERE profile = ?" if profile and profile != "*" else ""
    sql = (f"SELECT json_extract(meta, '$.source') AS source, json_extract(meta, '$.agent') AS agent, "
           f"json_extract(meta, '$.cwd') AS cwd, count(*) AS count FROM items {where} GROUP BY 1, 2, 3 ORDER BY count DESC")
    return [dict(r) for r in db.execute(sql, (profile,) if where else ())]


@locked
def kinds():
    return dict(db.execute("SELECT kind, count(*) FROM items GROUP BY kind").fetchall())


def thumb(name):
    return FILES / (Path(name).stem + ".thumb.jpg")


@locked
def recent(profile, kind, seconds):
    """(id, content, file) of items of one kind saved in the last seconds, newest first."""
    return db.execute("SELECT rowid, content, file FROM items WHERE profile = ? AND kind = ? AND created_at >= datetime('now', 'localtime', ?) "
                      "ORDER BY rowid DESC", (profile, kind, f"-{seconds} seconds")).fetchall()


@locked
def expire(days):
    """Delete image and thumbnail of screenshots older than days. The item, its OCR text and meta stay, file becomes null."""
    old = db.execute("SELECT rowid, file FROM items WHERE kind = 'screenshot' AND file IS NOT NULL "
                     "AND created_at < datetime('now', 'localtime', ?)", (f"-{days} days",)).fetchall()
    for id, f in old:
        (FILES / f).unlink(missing_ok=True)
        thumb(f).unlink(missing_ok=True)
        db.execute("UPDATE items SET file = NULL WHERE rowid = ?", (id,))
    commit()


@locked
def delete(id):
    row = db.execute("SELECT file FROM items WHERE rowid = ?", (id,)).fetchone()
    if row and row[0]:
        (FILES / row[0]).unlink(missing_ok=True)
        thumb(row[0]).unlink(missing_ok=True)
    db.execute("DELETE FROM items WHERE rowid = ?", (id,))
    commit()


@locked
def copy_to(path):
    """Backs up the database to path under the write lock, so MCP servers can't write meanwhile, checks it opens, writes the pointer and marks the old one MOVED."""
    db.execute("BEGIN IMMEDIATE")
    try:
        src, dst = sqlite3.connect(DATA / "umm.db"), sqlite3.connect(path / "umm.db")  # a backup from db itself waits forever on its own lock
        src.backup(dst)
        src.close()
        dst.close()
        n = sqlite3.connect(path / "umm.db").execute("SELECT count(*) FROM items").fetchone()[0]
        if n != db.execute("SELECT count(*) FROM items").fetchone()[0]:
            raise sqlite3.DatabaseError(f"the copy in {path} has {n} items")
        POINTER.write_text(str(path))
        db.execute(f"PRAGMA user_version = {MOVED}")
        db.commit()
    finally:
        db.rollback()


@locked
def get(id):
    r = db.execute(f"SELECT {COLS} FROM items WHERE rowid = ?", (id,)).fetchone()
    return row(r) if r else None


@locked
def agents():
    """Connected MCP servers, from the files they write to <data>/agents. Dead ones are dropped after 30 days."""
    counts = dict(db.execute("SELECT json_extract(meta, '$.session'), count(*) FROM items GROUP BY 1").fetchall())
    out = []
    for f in (DATA / "agents").glob("*.json"):
        a = json.loads(f.read_text())
        try:
            os.kill(a["pid"], 0)
            a["connected"] = True
        except ProcessLookupError:
            a["connected"] = False
            if time.time() - f.stat().st_mtime > 30 * 86400:
                f.unlink()
                continue
        a["memories"] = counts.get(a["session"], 0)
        out.append(a)
    return sorted(out, key=lambda a: a["last_seen"], reverse=True)
