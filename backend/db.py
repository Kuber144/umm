import os
import sqlite3
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
FILES = DATA / "files"
FILES.mkdir(parents=True, exist_ok=True)
PROFILE = DATA / "profile.txt"

# sqlite3.threadsafety is 3 (serialized), so one connection is shared by API threads and the transcriber
db = sqlite3.connect(DATA / "umm.db", check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS items USING fts5("
           "profile UNINDEXED, kind UNINDEXED, content, file UNINDEXED, app, created_at UNINDEXED)")
COLS = "rowid AS id, profile, kind, content, file, app, created_at"


def active_profile():
    return PROFILE.read_text().strip() if PROFILE.exists() else "default"


def set_profile(name):
    PROFILE.write_text(name)


def profiles():
    counts = dict(db.execute("SELECT profile, count(*) FROM items GROUP BY profile").fetchall())
    counts.setdefault(active_profile(), 0)
    return [{"name": n, "count": c} for n, c in sorted(counts.items())]


def detect(content):
    if content.startswith(("http://", "https://")):
        return "link"
    if "\n" not in content and os.path.exists(os.path.expanduser(content)):
        return "path"
    return "text"


def add(content, kind=None, file=None, app=None, profile=None):
    cur = db.execute("INSERT INTO items VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))",
                     (profile or active_profile(), kind or detect(content), content, file, app))
    db.commit()
    return cur.lastrowid


def update(id, content):
    db.execute("UPDATE items SET content = ?, kind = ? WHERE rowid = ? AND kind NOT IN ('screenshot', 'voice')",
               (content, detect(content), id))
    db.execute("UPDATE items SET content = ? WHERE rowid = ? AND kind IN ('screenshot', 'voice')", (content, id))
    db.commit()


def search(q="", profile=None, kind=None, limit=50, offset=0):
    """profile None or '*' searches every profile."""
    where, args = [], []
    if q.strip():
        # quote each word so paths like ~/a/b don't break FTS syntax, * gives prefix match
        where.append("items MATCH ?")
        args.append(" ".join(f'"{w}"*' for w in q.replace('"', "").split()))
    if profile and profile != "*":
        where.append("profile = ?")
        args.append(profile)
    if kind:
        where.append("kind = ?")
        args.append(kind)
    sql = f"SELECT {COLS} FROM items {'WHERE ' + ' AND '.join(where) if where else ''} " \
          f"ORDER BY {'rank' if q.strip() else 'rowid DESC'} LIMIT ? OFFSET ?"
    return [dict(r) for r in db.execute(sql, (*args, limit, offset))]


def delete(id):
    row = db.execute("SELECT file FROM items WHERE rowid = ?", (id,)).fetchone()
    if row and row[0]:
        (FILES / row[0]).unlink(missing_ok=True)
    db.execute("DELETE FROM items WHERE rowid = ?", (id,))
    db.commit()
