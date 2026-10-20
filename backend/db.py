import os
import sqlite3
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
SHOTS = DATA / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)
PROFILE = DATA / "profile.txt"

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
    names = {r[0] for r in db.execute("SELECT DISTINCT profile FROM items")}
    return sorted(names | {active_profile()})


def add(content, kind=None, file=None, app=None, profile=None):
    if not kind:
        kind = "link" if content.startswith("http") else "path" if os.path.exists(os.path.expanduser(content)) else "text"
    cur = db.execute("INSERT INTO items VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))",
                     (profile or active_profile(), kind, content, file, app))
    db.commit()
    return cur.lastrowid


def search(q="", profile=None, limit=50):
    where, args = [], []
    if q.strip():
        # quote each word so paths like ~/a/b don't break FTS syntax, * gives prefix match
        where.append("items MATCH ?")
        args.append(" ".join(f'"{w}"*' for w in q.replace('"', "").split()))
    if profile:
        where.append("profile = ?")
        args.append(profile)
    sql = f"SELECT {COLS} FROM items {'WHERE ' + ' AND '.join(where) if where else ''} " \
          f"ORDER BY {'rank' if q.strip() else 'rowid DESC'} LIMIT ?"
    return [dict(r) for r in db.execute(sql, (*args, limit))]


def delete(id):
    row = db.execute("SELECT file FROM items WHERE rowid = ?", (id,)).fetchone()
    if row and row[0]:
        (SHOTS / row[0]).unlink(missing_ok=True)
    db.execute("DELETE FROM items WHERE rowid = ?", (id,))
    db.commit()
