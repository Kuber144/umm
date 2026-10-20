import json
import os
import sqlite3
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
FILES = DATA / "files"
FILES.mkdir(parents=True, exist_ok=True)
PROFILE = DATA / "profile.txt"
EXTRA = DATA / "profiles.txt"  # created profiles, one per line, so empty ones persist
BUILTIN = ["user", "agent"]

# sqlite3.threadsafety is 3 (serialized), so one connection is shared by API threads and the transcriber
db = sqlite3.connect(DATA / "umm.db", check_same_thread=False)
db.row_factory = sqlite3.Row
SCHEMA = "profile UNINDEXED, kind UNINDEXED, content, file UNINDEXED, app, meta UNINDEXED, created_at UNINDEXED"
if db.execute("SELECT 1 FROM pragma_table_info('items') WHERE name = 'meta'").fetchone() is None:
    if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'items'").fetchone():  # old table without meta
        db.backup(sqlite3.connect(DATA / "umm.db.bak"))
        db.execute("BEGIN")
        db.execute(f"CREATE VIRTUAL TABLE items_new USING fts5({SCHEMA})")
        db.execute("INSERT INTO items_new(rowid, profile, kind, content, file, app, created_at) "
                   "SELECT rowid, profile, kind, content, file, app, created_at FROM items")
        db.execute("DROP TABLE items")
        db.execute("ALTER TABLE items_new RENAME TO items")
        db.commit()
    else:
        db.execute(f"CREATE VIRTUAL TABLE items USING fts5({SCHEMA})")
COLS = "rowid AS id, profile, kind, content, file, app, meta, created_at"


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


def profiles():
    counts = dict(db.execute("SELECT profile, count(*) FROM items GROUP BY profile").fetchall())
    names = BUILTIN + sorted((set(counts) | set(extra()) | {active_profile()}) - set(BUILTIN) - {""})
    return [{"name": n, "count": counts.get(n, 0)} for n in names]


def rename_profile(old, new):
    db.execute("UPDATE items SET profile = ? WHERE profile = ?", (new, old))
    db.commit()
    EXTRA.write_text("\n".join(n for n in {*extra(), new} - {old, ""}))
    if active_profile() == old:
        PROFILE.write_text(new)


def delete_profile(name):
    for (id,) in db.execute("SELECT rowid FROM items WHERE profile = ?", (name,)).fetchall():
        delete(id)
    EXTRA.write_text("\n".join(n for n in extra() if n != name))
    if active_profile() == name:
        PROFILE.write_text("user")


def detect(content):
    if content.startswith(("http://", "https://")):
        return "link"
    if "\n" not in content and os.path.exists(os.path.expanduser(content)):
        return "path"
    return "text"


def add(content, kind=None, file=None, app=None, profile=None, meta=None):
    cur = db.execute("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))",
                     (profile or active_profile(), kind or detect(content), content, file, app,
                      json.dumps(meta) if meta else None))
    db.commit()
    return cur.lastrowid


def update(id, content=None, profile=None):
    if content is not None:
        db.execute("UPDATE items SET content = ?, kind = ? WHERE rowid = ? AND kind NOT IN ('screenshot', 'voice')",
                   (content, detect(content), id))
        db.execute("UPDATE items SET content = ? WHERE rowid = ? AND kind IN ('screenshot', 'voice')", (content, id))
    if profile:
        db.execute("UPDATE items SET profile = ? WHERE rowid = ?", (profile, id))
    db.commit()


APP = "substr(app, 1, instr(app || ':', ':') - 1)"  # app name is the part before ':'


def search(q="", profile=None, kind=None, limit=50, offset=0, app=None, since=None, until=None, sort=None,
           agent=None, project=None):
    """profile None or '*' searches every profile. kind is comma separated. since/until are YYYY-MM-DD.
    agent matches meta.agent. project matches meta.cwd, that folder or any folder under it."""
    where, args = [], []
    words = q.replace('"', "").split()
    if words:
        # quote each word so paths like ~/a/b don't break FTS syntax, * gives prefix match
        where.append("items MATCH ?")
        args.append(" ".join(f'"{w}"*' for w in words))
    for cond, val in [("profile = ?", profile if profile != "*" else None), (f"{APP} = ?", app),
                      ("date(created_at) >= ?", since), ("date(created_at) <= ?", until)]:
        if val:
            where.append(cond)
            args.append(val)
    if agent:
        where.append("json_extract(meta, '$.agent') = ?")
        args.append(agent)
    if project:
        project = project.rstrip("/") or "/"
        where.append("(json_extract(meta, '$.cwd') = ? OR substr(json_extract(meta, '$.cwd'), 1, length(?) + 1) = ? || '/')")
        args += [project] * 3
    if kind:
        where.append(f"kind IN ({','.join('?' * len(kind.split(',')))})")
        args += kind.split(",")
    order = {"old": "rowid", "new": "rowid DESC"}.get(sort) or ("rank, rowid DESC" if words else "rowid DESC")
    sql = f"SELECT {COLS} FROM items {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {order} LIMIT ? OFFSET ?"
    return [row(r) for r in db.execute(sql, (*args, limit, offset))]


def apps(profile=None):
    where = "WHERE profile = ?" if profile and profile != "*" else ""
    sql = f"SELECT {APP} AS a, count(*) AS n FROM items {where} GROUP BY a HAVING a != '' ORDER BY n DESC, a"
    return [{"app": a, "count": n} for a, n in db.execute(sql, (profile,) if where else ())]


def kinds():
    return dict(db.execute("SELECT kind, count(*) FROM items GROUP BY kind").fetchall())


def delete(id):
    row = db.execute("SELECT file FROM items WHERE rowid = ?", (id,)).fetchone()
    if row and row[0]:
        (FILES / row[0]).unlink(missing_ok=True)
    db.execute("DELETE FROM items WHERE rowid = ?", (id,))
    db.commit()


def get(id):
    r = db.execute(f"SELECT {COLS} FROM items WHERE rowid = ?", (id,)).fetchone()
    return row(r) if r else None
