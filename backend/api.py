import filecmp
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
                    NSPasteboardURLReadingFileURLsOnlyKey, NSWorkspace)
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from Foundation import NSURL
from ocrmac.ocrmac import OCR
from pydantic import BaseModel, Field, StringConstraints
from Quartz import CGWindowListCopyWindowInfo, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly

import db
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
moving = threading.Event()  # set while the data folder moves, writes are refused so none land in the old folder


@app.middleware("http")
async def refuse_writes(request, call_next):
    if moving.is_set() and request.method != "GET":
        return JSONResponse({"detail": "umm is moving its data folder, try again in a moment"}, 503)
    return await call_next(request)


class Item(BaseModel):
    content: Content
    app: str | None = None
    meta: dict | None = None
    profile: ProfileName | None = None


class Edit(BaseModel):
    content: Content | None = None
    profile: ProfileName | None = None


class Text(BaseModel):
    text: str


class App(BaseModel):
    app: str | None = None
    meta: dict | None = None


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
    return {"id": db.add(item.content, app=item.app, profile=item.profile, meta=item.meta)}


@app.patch("/api/items/{id}")
def edit(id: int, e: Edit):
    db.update(id, e.content, e.profile)
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
    text = run("pbpaste")
    return ("text", text) if text.strip() else (None, "")


@app.get("/api/context")
def context(url: str | None = None):  # url is the page or document Swift read over Accessibility
    kind, value = clipboard()
    return {"app": front_window(), "profile": db.active_profile(), "clipboard_kind": kind,
            "clipboard": ("\n".join(value) if kind == "files" else value or "")[:2000], "recording": record.status(), "url": url}


def save_shot(name, app_name, meta=None, profile=None):
    """OCR and thumbnail the screenshot already written to FILES/name, then save it."""
    # the same image saved in the last 10 minutes returns that item, so a repeated capture adds nothing
    for id, _, f in db.recent(profile or db.active_profile(), "screenshot", 600):
        if f and (db.FILES / f).is_file() and filecmp.cmp(db.FILES / f, db.FILES / name, shallow=False):
            (db.FILES / name).unlink()
            return id
    # worker threads have no autorelease pool, so Vision objects would leak without one
    with objc.autorelease_pool():
        text = "\n".join(t for t, _, _ in OCR(str(db.FILES / name)).recognize())
    thumb(name)
    return db.add(text, "screenshot", name, app_name, profile, meta)


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
    return {"id": save_shot(name, app_name, a.meta or {"source": "hotbar"}, a.profile)}  # only the hotbar captures without meta


@app.post("/api/clipboard")
def save_clipboard(a: App | None = None):
    app_name = (a and a.app) or front_window()
    kind, value = clipboard()
    if kind == "files":
        return {"ids": [db.add(p, "path", app=app_name, meta=a and a.meta) for p in value]}
    if kind == "image":
        name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
        with objc.autorelease_pool():
            pb = NSPasteboard.generalPasteboard()
            rep = NSBitmapImageRep.imageRepWithData_(pb.dataForType_(NSPasteboardTypePNG) or pb.dataForType_(NSPasteboardTypeTIFF))
            rep.representationUsingType_properties_(NSBitmapImageFileTypeJPEG, {NSImageCompressionFactor: 0.8}).writeToFile_atomically_(str(db.FILES / name), True)
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
    meta = i.meta or {"source": "app"}  # files are dropped on the main window
    if p.is_file() and run(["sips", "-g", "format", str(p)]).rpartition(" ")[2] in IMAGES:
        name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
        subprocess.run(["sips", "-s", "format", "jpeg", str(p), "--out", str(db.FILES / name)], capture_output=True, check=True)
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
    if set(os.listdir(new)) - db.KEEP:
        raise HTTPException(400, f"{new} is not empty")
    moving.set()
    try:
        shutil.copytree(old, new, dirs_exist_ok=True, ignore=lambda d, names: db.KEEP | {"umm.db", "umm.db-wal", "umm.db-shm"} if d == str(old) else ())
        db.copy_to(new)
    except (OSError, sqlite3.Error) as e:
        clear(new)
        moving.clear()
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
    record.start("" if app_name.split(":")[0].lower() == "umm" else app_name, a and a.meta)  # started from the main window
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
    with objc.autorelease_pool():
        rep = NSBitmapImageRep.imageRepWithContentsOfFile_(str(db.FILES / it["file"]))
        pb = NSPasteboard.generalPasteboard()
        pb.clearContents()
        pb.setData_forType_(rep.representationUsingType_properties_(NSBitmapImageFileTypePNG, {}), NSPasteboardTypePNG)  # macOS adds TIFF on request
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
