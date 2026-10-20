import mimetypes
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Annotated

import objc
from AppKit import (NSBitmapImageFileTypeJPEG, NSBitmapImageRep, NSImageCompressionFactor, NSPasteboard, NSPasteboardTypePNG,
                    NSPasteboardTypeTIFF, NSPasteboardURLReadingFileURLsOnlyKey)
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from Foundation import NSURL
from ocrmac.ocrmac import OCR
from pydantic import BaseModel, Field, StringConstraints
from Quartz import CGWindowListCopyWindowInfo, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly

import db
import record

app = FastAPI()

Nonempty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
# "*" means all profiles in GET /api/items, so it can't be a profile name
ProfileName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, pattern=r"^[^*]+$")]


class Item(BaseModel):
    content: Nonempty
    app: str | None = None
    profile: str | None = None


class Edit(BaseModel):
    content: Nonempty | None = None
    profile: ProfileName | None = None


class Text(BaseModel):
    text: str


class App(BaseModel):
    app: str | None = None


class Shot(App):
    display: int | None = None  # 1-based, as in screencapture -D. Omitted means the main display.
    area: bool = False  # interactive region selection


class Profile(BaseModel):
    name: ProfileName


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
          sort: str = "", limit: int = 50, offset: int = 0):
    return db.search(q, profile or db.active_profile(), kind, max(0, min(limit, 200)), offset, app, since, until, sort)


@app.get("/api/apps")
def apps(profile: str = ""):
    return db.apps(profile or db.active_profile())


@app.post("/api/items")
def add(item: Item):
    return {"id": db.add(item.content, app=item.app, profile=item.profile)}


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
        urls = pb.readObjectsForClasses_options_([NSURL], {NSPasteboardURLReadingFileURLsOnlyKey: True})
        if urls:
            return "files", [str(u.path()) for u in urls]
        if {NSPasteboardTypePNG, NSPasteboardTypeTIFF} & set(pb.types() or []):
            return "image", None
    text = run("pbpaste")
    return ("text", text) if text.strip() else (None, "")


@app.get("/api/context")
def context():
    kind, value = clipboard()
    return {"app": front_window(), "profile": db.active_profile(), "clipboard_kind": kind,
            "clipboard": ("\n".join(value) if kind == "files" else value or "")[:2000], "recording": record.status()}


def save_shot(name, app_name):
    """OCR and thumbnail the screenshot already written to FILES/name, then save it."""
    # worker threads have no autorelease pool, so Vision objects would leak without one
    with objc.autorelease_pool():
        text = "\n".join(t for t, _, _ in OCR(str(db.FILES / name)).recognize())
    thumb(name)
    return db.add(text, "screenshot", name, app_name)


def thumb(name):
    """Small copy of a screenshot next to it. Old screenshots get one on first request."""
    t = db.thumb(name)
    if not t.exists():
        subprocess.run(["sips", "-Z", "640", str(db.FILES / name), "--out", str(t)], capture_output=True, check=True)
    return t


@app.get("/api/thumb/{name}")
def get_thumb(name: str):
    if not name.endswith(".jpg") or not (db.FILES / Path(name).name).is_file():
        raise HTTPException(404)
    return FileResponse(thumb(Path(name).name))


@app.post("/api/capture")
def capture(a: Shot | None = None):
    a = a or Shot()
    app_name = a.app or front_window()
    # jpg is ~9x smaller than png and OCR reads the same text. Microseconds keep parallel captures from sharing a file.
    name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
    flags = ["-i"] if a.area else ["-D", str(a.display)] if a.display else []
    subprocess.run(["screencapture", "-x", *flags, "-t", "jpg", str(db.FILES / name)], check=True)
    if a.area and not (db.FILES / name).exists():  # Esc during selection
        return {"id": None}
    return {"id": save_shot(name, app_name)}


@app.post("/api/clipboard")
def save_clipboard(a: App | None = None):
    app_name = (a and a.app) or front_window()
    kind, value = clipboard()
    if kind == "files":
        return {"ids": [db.add(p, "path", app=app_name) for p in value]}
    if kind == "image":
        name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".jpg"
        with objc.autorelease_pool():
            pb = NSPasteboard.generalPasteboard()
            rep = NSBitmapImageRep.imageRepWithData_(pb.dataForType_(NSPasteboardTypePNG) or pb.dataForType_(NSPasteboardTypeTIFF))
            rep.representationUsingType_properties_(NSBitmapImageFileTypeJPEG, {NSImageCompressionFactor: 0.8}).writeToFile_atomically_(str(db.FILES / name), True)
        return {"ids": [save_shot(name, app_name)]}
    if kind == "text":
        return {"ids": [db.add(value, app=app_name)]}
    raise HTTPException(400, "clipboard is empty")


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
    record.start((a and a.app) or front_window())
    return record.status()


@app.post("/api/record/stop")
def record_stop():
    record.stop()
    return record.status()


@app.post("/api/copy")
def copy(t: Text):
    run("pbcopy", input=t.text)
    return {}


@app.post("/api/reveal")
def reveal(t: Text):
    subprocess.run(["open", "-R", str(Path(t.text).expanduser())])
    return {}


mimetypes.add_type("audio/mp4", ".m4a")  # the default audio/mp4a-latm is not playable in WebKit
app.mount("/api/files", StaticFiles(directory=db.FILES))
dist = Path(__file__).resolve().parent.parent / "ui" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True))
