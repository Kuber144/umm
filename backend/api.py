import re
import subprocess
import time
from pathlib import Path

import objc
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from ocrmac.ocrmac import OCR
from pydantic import BaseModel
from Quartz import CGWindowListCopyWindowInfo, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly

import db
import record

app = FastAPI()


class Item(BaseModel):
    content: str
    app: str | None = None
    profile: str | None = None


class Edit(BaseModel):
    content: str


class Text(BaseModel):
    text: str


class App(BaseModel):
    app: str | None = None


class Profile(BaseModel):
    name: str


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
def items(q: str = "", profile: str = "", kind: str = "", limit: int = 50, offset: int = 0):
    return db.search(q, profile or db.active_profile(), kind or None, min(limit, 200), offset)


@app.post("/api/items")
def add(item: Item):
    return {"id": db.add(item.content.strip(), app=item.app, profile=item.profile)}


@app.patch("/api/items/{id}")
def edit(id: int, e: Edit):
    db.update(id, e.content.strip())
    return {}


@app.delete("/api/items/{id}")
def delete(id: int):
    db.delete(id)
    return {}


@app.get("/api/context")
def context():
    return {"app": front_window(), "profile": db.active_profile(), "clipboard": run("pbpaste")[:2000],
            "recording": record.status()}


@app.post("/api/capture")
def capture(a: App | None = None):
    app_name = (a and a.app) or front_window()
    # jpg is ~9x smaller than png and OCR reads the same text
    name = time.strftime("%Y%m%d-%H%M%S") + ".jpg"
    subprocess.run(["screencapture", "-x", "-t", "jpg", str(db.FILES / name)], check=True)
    # worker threads have no autorelease pool, so Vision objects would leak without one
    with objc.autorelease_pool():
        text = "\n".join(t for t, _, _ in OCR(str(db.FILES / name)).recognize())
    return {"id": db.add(text, "screenshot", name, app_name)}


@app.get("/api/profiles")
def profiles():
    return {"active": db.active_profile(), "all": db.profiles()}


@app.post("/api/profiles")
def set_profile(p: Profile):
    db.set_profile(p.name.strip())
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


app.mount("/api/files", StaticFiles(directory=db.FILES))
dist = Path(__file__).resolve().parent.parent / "ui" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True))
