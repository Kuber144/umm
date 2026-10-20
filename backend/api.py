import filecmp
import json
import logging
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Annotated

import objc
from AppKit import (NSBitmapImageFileTypeJPEG, NSBitmapImageFileTypePNG, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext,
                    NSImageCompressionFactor, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
                    NSPasteboardTypeString, NSPasteboardURLReadingFileURLsOnlyKey, NSWorkspace)
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from Foundation import NSURL
from ocrmac.ocrmac import OCR
from pydantic import BaseModel, Field, StringConstraints
from Quartz import CGWindowListCopyWindowInfo, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly

import db
import embed
import record
import settings

app = FastAPI()


def expire():  # at start and once a day, so screenshot_days applies without a restart
    while True:
        if days := settings.get()["screenshot_days"]:
            db.expire(days)
        time.sleep(86400)


threading.Thread(target=db.backfill, daemon=True).start()
threading.Thread(target=expire, daemon=True).start()
record.recover()  # recordings a quit or crash left without an item
db.embed_later()  # backfill items saved before search by meaning existed, or while the model was missing

Nonempty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
# "*" means all profiles in GET /api/items, so it can't be a profile name. "/" breaks the delete URL, newlines split profiles.txt
ProfileName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60, pattern=r"^[^*/\r\n]+$")]
Content = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=db.MAX_CONTENT)]


def one_line(r):  # a traceback is 10 KB of log for one error
    if r.exc_info:
        r.msg, r.args, r.exc_info = f"{r.getMessage().strip()}: {r.exc_info[1]!r}", (), None
    return True


logging.getLogger("uvicorn.error").addFilter(one_line)
moving = threading.Lock()  # held while the data folder moves, writes are refused so none land in the old folder
writes = 0  # writes in flight, a move waits for them before it copies


@app.middleware("http")
async def refuse_writes(request, call_next):
    global writes
    if request.method == "GET":
        return await call_next(request)
    if moving.locked():
        return JSONResponse({"detail": "umm is moving its data folder, try again in a moment"}, 503)
    writes += 1
    try:
        return await call_next(request)
    finally:
        writes -= 1


class Item(BaseModel):
    content: Content
    app: str | None = None
    meta: dict | None = None
    profile: ProfileName | None = None
    note: Content | None = None


class Edit(BaseModel):
    content: Content | None = None
    profile: ProfileName | None = None
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=db.MAX_CONTENT)] | None = None  # "" clears
    pinned: bool | None = None  # pinned items come first in a list without a query


class Text(BaseModel):
    text: str


class At(BaseModel):
    at: str  # the `at` of a clipboard history entry


class Clip(At):
    note: Content | None = None
    profile: ProfileName | None = None


class App(BaseModel):
    app: str | None = None
    meta: dict | None = None
    note: Content | None = None


class Shot(App):
    display: int | None = None  # 1-based, as in screencapture -D. Omitted means the main display.
    area: bool = False  # interactive region selection
    profile: ProfileName | None = None


class Import(App):
    path: Nonempty
    profile: ProfileName | None = None


class Id(BaseModel):
    id: int


class Open(Id):
    reveal: bool = False


class Profile(BaseModel):
    name: ProfileName


class Folder(BaseModel):
    path: str


class Rename(BaseModel):
    from_: Nonempty = Field(alias="from")
    to: ProfileName


def run(cmd, shell=False, input=None):
    return subprocess.run(cmd, shell=shell, input=input, capture_output=True, text=True).stdout.strip()


def front_window():
    """'App: window title' of the frontmost app, works for any app (browser tab title, Finder folder, editor file)."""
    app_name = "".join(re.findall(r'="(.*)"', run("lsappinfo info -only name $(lsappinfo front)", shell=True)))
    with objc.autorelease_pool():
        windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
        title = next((w["kCGWindowName"] for w in windows if w.get("kCGWindowOwnerName") == app_name
                      and w.get("kCGWindowLayer") == 0 and w.get("kCGWindowName")), "")
    return f"{app_name}: {title}" if title else app_name


@app.get("/api/items")
def items(q: str = "", profile: str = "", kind: str = "", app: str = "", since: str = "", until: str = "",
          sort: str = "", limit: int = 50, offset: int = 0, source: str = "", agent: str = "", project: str = "", session: str = "",
          mode: str = "hybrid"):
    return db.search(q, profile or db.active_profile(), kind, max(0, min(limit, 200)), offset, app, since, until, sort,
                     agent, project, source, session, mode=mode)


@app.get("/api/apps")
def apps(profile: str = ""):
    return db.apps(profile or db.active_profile())


@app.get("/api/origins")
def origins(profile: str = ""):
    return db.origins(profile or db.active_profile())


NO_ICON = set()  # app names without an installed app, so the lookup runs once per backend start


@app.get("/api/icon")
def icon(app: str):
    """The installed app's icon as a 64px PNG, cached in <data>/files/icons. app may be a full "App: window title"."""
    name = app.split(":")[0].strip()
    f = db.FILES / "icons" / f"app-{name}.png"
    if not f.exists():
        if not name or "/" in name or "'" in name or name in NO_ICON:
            raise HTTPException(404)
        with objc.autorelease_pool():
            ws = NSWorkspace.sharedWorkspace()
            path = ws.fullPathForApplication_(name) or run(
                ["mdfind", f"kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '{name}'cd"]).split("\n")[0]
            if not path:
                NO_ICON.add(name)
                raise HTTPException(404)
            rep = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
                None, 64, 64, 8, 4, True, False, NSDeviceRGBColorSpace, 0, 0)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.setCurrentContext_(NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep))
            ws.iconForFile_(path).drawInRect_(((0, 0), (64, 64)))
            NSGraphicsContext.restoreGraphicsState()
            f.parent.mkdir(exist_ok=True)
            rep.representationUsingType_properties_(NSBitmapImageFileTypePNG, {}).writeToFile_atomically_(str(f), True)
    return FileResponse(f)


@app.post("/api/items")
def add(item: Item):
    return {"id": db.add(item.content, app=item.app, profile=item.profile, meta=item.meta, note=item.note)}


@app.patch("/api/items/{id}")
def edit(id: int, e: Edit):
    db.update(id, e.content, e.profile, e.note, e.pinned)
    return {}


@app.delete("/api/items/{id}")
def delete(id: int):
    db.delete(id)
    return {}


def clipboard():
    """(kind, value): files -> list of paths, image -> None, text -> str. (None, "") when empty. Files win over image, since Finder adds an icon."""
    with objc.autorelease_pool():
        pb = NSPasteboard.generalPasteboard()
        if {"org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"} & set(pb.types() or []):
            return None, ""  # a password manager marked it secret
        urls = pb.readObjectsForClasses_options_([NSURL], {NSPasteboardURLReadingFileURLsOnlyKey: True})
        if urls:
            return "files", [str(u.path()) for u in urls]
        if {NSPasteboardTypePNG, NSPasteboardTypeTIFF} & set(pb.types() or []):
            return "image", None
        text = pb.stringForType_(NSPasteboardTypeString)  # in process, pbpaste would fork on every hotbar open and clipboard change
    text = str(text) if text is not None else run("pbpaste")  # pbpaste still converts rich text only copies
    return ("text", text) if text.strip() else (None, "")


def pasteboard_image():
    pb = NSPasteboard.generalPasteboard()
    return pb.dataForType_(NSPasteboardTypePNG) or pb.dataForType_(NSPasteboardTypeTIFF)


def jpg(data, path):
    with objc.autorelease_pool():
        NSBitmapImageRep.imageRepWithData_(data).representationUsingType_properties_(
            NSBitmapImageFileTypeJPEG, {NSImageCompressionFactor: 0.8}).writeToFile_atomically_(str(path), True)


def put_image(f):
    """The image file on the pasteboard as PNG (macOS adds TIFF on request)."""
    with objc.autorelease_pool():
        pb = NSPasteboard.generalPasteboard()
        pb.clearContents()
        pb.setData_forType_(NSBitmapImageRep.imageRepWithContentsOfFile_(str(f)).representationUsingType_properties_(NSBitmapImageFileTypePNG, {}),
                            NSPasteboardTypePNG)


@app.get("/api/context")
def context(url: str | None = None):  # url is the page or document Swift read over Accessibility
    kind, value = clipboard()
    return {"app": front_window(), "profile": db.active_profile(), "clipboard_kind": kind,
            "clipboard": ("\n".join(value) if kind == "files" else value or "")[:2000], "recording": record.status(), "url": url, "history": len(history)}


try:
    history = json.loads((CLIP := db.DATA / "clipboard.json").read_text())  # [{text, at} or {image, at}] newest first. What the backend saw, for the hotbar picker
except (OSError, ValueError):
    history = []
(db.FILES / "clipboard").mkdir(exist_ok=True)  # the images of history, served by /api/files


def keep(new):
    """The new history. Images that fell off lose their file."""
    old, history[:] = history[:], new
    for h in old:
        if "image" in h and h not in history:
            (db.FILES / h["image"]).unlink(missing_ok=True)
    CLIP.with_suffix(".tmp").write_text(json.dumps(history))
    CLIP.with_suffix(".tmp").replace(CLIP)


def remember(entry, n):
    """Newest first, up to n. An older copy of the same text is dropped, images are not compared."""
    text = entry.get("text")
    keep([entry, *(h for h in history if text is None or h.get("text") != text)][:n])


def remember_image(data, n):
    name = f"clipboard/{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.jpg"
    jpg(data, db.FILES / name)
    remember({"image": name, "at": datetime.now().isoformat(timespec="seconds")}, n)


seen = [None]  # the pasteboard changeCount the watcher saw last. A restore sets it, so its own copy is not a new entry


def watch_clipboard():
    while True:
        time.sleep(1)
        n = settings.get()["clipboard_history"]
        with objc.autorelease_pool():
            changed, seen[0] = seen[0] != (c := NSPasteboard.generalPasteboard().changeCount()), c
            if not n:
                if history:
                    keep([])
            elif changed and (r := clipboard())[0] in ("image", "text"):
                if r[0] == "image":
                    remember_image(pasteboard_image(), n)
                else:
                    remember({"text": r[1][:db.MAX_CONTENT], "at": datetime.now().isoformat(timespec="seconds")}, n)


threading.Thread(target=watch_clipboard, daemon=True).start()


@app.get("/api/clipboard/history")
def clipboard_history():
    return history


@app.delete("/api/clipboard/history")
def clear_history():
    keep([])
    return {}


def entry(at):
    if not (e := next((h for h in history if h["at"] == at), None)) or "image" in e and not (db.FILES / e["image"]).is_file():
        raise HTTPException(404, "no clipboard entry with that time")
    return e


@app.post("/api/clipboard/restore")
def restore_clipboard(a: At):
    e = entry(a.at)
    run("pbcopy", input=e["text"]) if "text" in e else put_image(db.FILES / e["image"])
    with objc.autorelease_pool():
        seen[0] = NSPasteboard.generalPasteboard().changeCount()
    keep([e, *(h for h in history if h is not e)])  # newest first, like a fresh copy
    return {}


@app.post("/api/clipboard/save")
def save_history_entry(c: Clip):
    e, app_name, meta = entry(c.at), front_window(), {"source": "hotbar"}
    if "text" in e:
        return {"id": db.add(e["text"], app=app_name, profile=c.profile, meta=meta, note=c.note)}
    name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
    shutil.copy(db.FILES / e["image"], db.FILES / name)
    return {"id": save_shot(name, app_name, meta, c.profile, c.note)}


def save_shot(name, app_name, meta=None, profile=None, note=None):
    """Saves the screenshot already written to FILES/name at once. The thumbnail and OCR follow in a thread, so the reply is instant."""
    # the same image saved in the last 10 minutes returns that item, so a repeated capture adds nothing
    for id, _, f in db.recent(profile or db.active_profile(), "screenshot", 600):
        if f and (db.FILES / f).is_file() and filecmp.cmp(db.FILES / f, db.FILES / name, shallow=False):
            (db.FILES / name).unlink()
            return id
    id = db.add("", "screenshot", name, app_name, profile, {**(meta or {}), "reading": True}, note)
    threading.Thread(target=read_shot, args=(id, name), daemon=True).start()
    return id


def read_shot(id, name):
    thumb(name)
    # worker threads have no autorelease pool, so Vision objects would leak without one
    with objc.autorelease_pool():
        text = "\n".join(t for t, _, _ in OCR(str(db.FILES / name)).recognize())
    db.update(id, text)  # clears meta.reading


def thumb(name):
    """Small copy of a screenshot next to it. Old screenshots get one on first request."""
    t = db.thumb(name)
    if not t.exists():  # a temp name, so two requests for the same file don't write one path
        tmp = t.with_suffix(f".{threading.get_ident()}.jpg")
        subprocess.run(["sips", "-Z", "640", str(db.FILES / name), "--out", str(tmp)], capture_output=True, check=True)
        tmp.replace(t)
    return t


@app.get("/api/thumb/{name}")
def get_thumb(name: str):
    if not name.endswith(".jpg") or not (db.FILES / Path(name).name).is_file():
        raise HTTPException(404)
    return FileResponse(thumb(Path(name).name))


for id, f in db.transcribing("reading"):  # a quit or crash mid OCR
    threading.Thread(target=read_shot, args=(id, f), daemon=True).start()


@app.post("/api/capture")
def capture(a: Shot | None = None):
    a = a or Shot()
    front = front_window()  # check the real front app, whatever app string the caller sends
    if front.split(":")[0].strip().lower() in {x.strip().lower() for x in settings.get()["excluded_apps"]}:
        raise HTTPException(403, f"{front.split(':')[0]} is in your excluded apps, nothing was captured")
    app_name = a.app or front
    # jpg is ~9x smaller than png and OCR reads the same text. Microseconds keep parallel captures from sharing a file.
    name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
    flags = ["-i"] if a.area else ["-D", str(a.display)] if a.display else []
    if subprocess.run(["screencapture", "-x", *flags, "-t", "jpg", str(db.FILES / name)]).returncode:
        raise HTTPException(412, "screencapture failed. Screen Recording permission is probably missing for umm: "
                                 "allow it in System Settings, Privacy and Security, Screen Recording")
    if a.area and not (db.FILES / name).exists():  # Esc during selection
        return {"id": None}
    id = save_shot(name, app_name, a.meta or {"source": "hotbar"}, a.profile, a.note)  # only the hotbar captures without meta
    return {"id": id, "file": db.get(id)["file"]}  # the file of the earlier item when this one was a repeat


@app.post("/api/clipboard")
def save_clipboard(a: App | None = None):
    app_name = (a and a.app) or front_window()
    kind, value = clipboard()
    if kind == "files":
        return {"ids": [db.add(p, "path", app=app_name, meta=a and a.meta) for p in value]}
    if kind == "image":
        name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
        with objc.autorelease_pool():
            jpg(pasteboard_image(), db.FILES / name)
        return {"ids": [save_shot(name, app_name, a and a.meta)]}
    if kind == "text":
        return {"ids": [db.add(value, app=app_name, meta=a and a.meta)]}
    raise HTTPException(400, "clipboard is empty")


IMAGES = {"png", "jpeg", "heic", "gif", "tiff", "webp"}  # formats sips reads, by content, not extension


@app.post("/api/import")
def import_file(i: Import):
    """An image file becomes a screenshot with OCR, anything else a path item."""
    p = Path(i.path).expanduser()
    if not p.is_absolute() or not p.exists():
        raise HTTPException(400, f"no file at {i.path}")
    meta = {**(i.meta or {"source": "app"}), "path": str(p)}  # files are dropped on the main window. path survives screenshot_days
    name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
    # sips prints only the path for a non-image, so "a png" must not count. An unreadable or broken image is saved as a path
    if (p.is_file() and run(["sips", "-g", "format", str(p)]).rpartition("format: ")[2] in IMAGES
            and subprocess.run(["sips", "-s", "format", "jpeg", str(p), "--out", str(db.FILES / name)], capture_output=True).returncode == 0):
        return {"id": save_shot(name, i.app, meta, i.profile)}
    return {"id": db.add(str(p), "path", app=i.app, profile=i.profile, meta=meta)}


@app.get("/api/settings")
def get_settings():
    return settings.get()


@app.patch("/api/settings")
def patch_settings(patch: dict):
    try:
        return settings.update(patch)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/api/storage")
def storage():
    size = sum(f.stat().st_size for f in db.DATA.rglob("*") if f.is_file())
    return {"path": str(db.DATA), "bytes": size, "kinds": db.kinds()}


def clear(folder):
    """Deletes the data in folder, and the folder once empty. BASE keeps the pointer, socket and log."""
    for p in folder.iterdir():
        if p.name not in db.KEEP:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
    if not any(folder.iterdir()):
        folder.rmdir()


@app.post("/api/storage/move")
def move_storage(f: Folder):
    """Copies the data folder to f.path, points umm at it, deletes the old one and exits so the app restarts the backend there."""
    old, new = db.DATA.resolve(), Path(f.path)
    if os.environ.get("UMM_DATA"):
        raise HTTPException(400, "UMM_DATA is set, unset it to move the data folder")
    if not new.is_absolute():
        raise HTTPException(400, "the folder must be an absolute path")
    new = new.resolve()
    if new.is_relative_to(old):
        raise HTTPException(400, "the folder can't be inside the current data folder")
    if (r := record.status())["on"] or r["transcribing"]:
        raise HTTPException(409, "wait for the recording to finish")
    try:
        new.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(400, f"can't create {new}: {e.strerror}")
    if not os.access(new, os.W_OK):
        raise HTTPException(400, f"{new} is not writable")
    if set(os.listdir(new)) - db.KEEP - {".DS_Store"}:  # Finder leaves one in a folder it showed
        raise HTTPException(400, f"{new} is not empty")
    if not moving.acquire(blocking=False):  # a second move would wait on the first forever
        raise HTTPException(409, "the data folder is already moving")
    while writes > 1:  # this request is one
        time.sleep(0.05)
    if embed.proc:  # its first-run model download would go on into the old folder after the delete
        embed.proc.kill()
    try:
        shutil.copytree(old, new, dirs_exist_ok=True, ignore=lambda d, names: db.KEEP | {"umm.db", "umm.db-wal", "umm.db-shm"} if d == str(old) else ())
        db.copy_to(new)
    except (OSError, sqlite3.Error) as e:
        clear(new)
        moving.release()
        raise HTTPException(500, f"the move failed and nothing changed: {e}")
    logging.getLogger("uvicorn.error").info(f"moved the data folder from {old} to {new}")
    try:
        clear(old)
    finally:
        threading.Timer(0.5, os._exit, [0]).start()  # after the reply. Exit 0 makes the app restart the backend at once
    return {"path": str(new)}


@app.get("/api/profiles")
def profiles():
    return {"active": db.active_profile(), "all": db.profiles()}


@app.post("/api/profiles")
def set_profile(p: Profile):
    db.set_profile(p.name)
    return {}


def custom(*names):
    if set(names) & set(db.BUILTIN):
        raise HTTPException(400, "user and agent can't be renamed or deleted")


@app.post("/api/profiles/rename")
def rename_profile(r: Rename):
    custom(r.from_, r.to)
    if r.to in [p["name"] for p in db.profiles()]:
        raise HTTPException(409, f'profile "{r.to}" already exists')
    db.rename_profile(r.from_, r.to)
    return {}


@app.delete("/api/profiles/{name}")
def delete_profile(name: str):
    custom(name)
    db.delete_profile(name)
    return {}


@app.get("/api/record")
def record_status():
    return record.status()


@app.post("/api/record/start")
def record_start(a: App | None = None):
    app_name = (a and a.app) or front_window()
    record.start("" if app_name.split(":")[0].lower() == "umm" else app_name, a and a.meta, a and a.note)  # started from the main window
    return record.status()


@app.post("/api/record/stop")
def record_stop():
    record.stop()
    return record.status()


@app.post("/api/copy")
def copy(t: Text):
    run("pbcopy", input=t.text)
    return {}


@app.post("/api/copy-image")
def copy_image(o: Id):
    it = db.get(o.id)
    if not it or it["kind"] != "screenshot" or not it["file"] or not (db.FILES / it["file"]).is_file():
        raise HTTPException(404, "no screenshot image with that id")
    put_image(db.FILES / it["file"])
    return {}


@app.post("/api/open")
def open_item(o: Open):
    """Open the item's file in its default app, or reveal it in Finder. A path item's file is its path."""
    it = db.get(o.id)
    f = it and (db.FILES / it["file"] if it["file"] else Path(it["content"].strip()).expanduser() if it["kind"] == "path" else None)
    if not f or not f.exists():
        raise HTTPException(404, "the item has no file")
    subprocess.run(["open", *(["-R"] if o.reveal else []), str(f)])
    return {}


@app.post("/api/reveal")
def reveal(t: Text):
    subprocess.run(["open", "-R", str(Path(t.text).expanduser())])
    return {}


@app.get("/api/agents")
def agents():
    return db.agents()


@app.get("/api/setup")
def setup():
    """Commands that connect agents and install the CLI, with this checkout's path."""
    root = Path(__file__).resolve().parent.parent
    return {"mcp": f'claude mcp add umm -s user -- uv run --project "{root}/backend" "{root}/backend/mcp_server.py"',
            "cli": f'uv tool install --editable "{root}/cli"'}


mimetypes.add_type("audio/mp4", ".m4a")  # the default audio/mp4a-latm is not playable in WebKit
app.mount("/api/files", StaticFiles(directory=db.FILES))
dist = Path(__file__).resolve().parent.parent / "ui" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True))
