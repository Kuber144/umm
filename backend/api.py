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

app = FastAPI()


class Item(BaseModel):
    content: str
    app: str | None = None


class Profile(BaseModel):
    name: str


@app.get("/api/items")
def items(q: str = "", profile: str = ""):
    return db.search(q, profile or db.active_profile())


@app.post("/api/items")
def add(item: Item):
    return {"id": db.add(item.content.strip(), app=item.app)}


@app.delete("/api/items/{id}")
def delete(id: int):
    db.delete(id)


def run(cmd, shell=False):
    return subprocess.run(cmd, shell=shell, capture_output=True, text=True).stdout.strip()


def front_window():
    """'App: window title' of the frontmost app, works for any app (browser tab title, Finder folder, editor file)."""
    app_name = "".join(re.findall(r'="(.*)"', run("lsappinfo info -only name $(lsappinfo front)", shell=True)))
    with objc.autorelease_pool():
        windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
        title = next((w["kCGWindowName"] for w in windows if w.get("kCGWindowOwnerName") == app_name
                      and w.get("kCGWindowLayer") == 0 and w.get("kCGWindowName")), "")
    return f"{app_name}: {title}" if title else app_name


@app.get("/api/context")
def context():
    clip = run("pbpaste")
    options = [{"label": "Screenshot", "capture": True}]
    options += [{"label": f"Clipboard: {clip[:200]}", "content": clip}] if clip else []
    return {"app": front_window(), "profile": db.active_profile(), "options": options}


@app.post("/api/capture")
def capture():
    app_name = front_window()
    # jpg is ~9x smaller than png and OCR reads the same text
    name = time.strftime("%Y%m%d-%H%M%S") + ".jpg"
    subprocess.run(["screencapture", "-x", "-t", "jpg", str(db.SHOTS / name)], check=True)
    # worker threads have no autorelease pool, so Vision objects would leak without one
    with objc.autorelease_pool():
        text = "\n".join(t for t, _, _ in OCR(str(db.SHOTS / name)).recognize())
    return {"id": db.add(text, "screenshot", name, app_name)}


@app.get("/api/profiles")
def profiles():
    return {"active": db.active_profile(), "all": db.profiles()}


@app.post("/api/profiles")
def set_profile(p: Profile):
    db.set_profile(p.name.strip())


app.mount("/api/shots", StaticFiles(directory=db.SHOTS))
dist = Path(__file__).resolve().parent.parent / "ui" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True))
