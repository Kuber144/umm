import json
from typing import Literal

from pydantic import BaseModel, Field

import db


class Settings(BaseModel):
    """The defaults live here. <data>/settings.json only holds what the person changed."""
    # languages you speak; free auto detect misreads short clips (it heard "hello hello" as Arabic),
    # so detection only picks the likeliest of these. An empty list allows any language
    languages: list[str] = ["en", "hi"]
    # faster-whisper size, runs in a child process only while transcribing to keep idle memory low
    model: Literal["small", "medium"] = "medium"
    enrich_links: bool = True  # fetch title and description of saved links
    excluded_apps: list[str] = []  # app names the hotbar screenshot refuses to capture
    clipboard_history: int = Field(50, ge=0, le=500)  # copies, text or image, kept for the hotbar picker, in clipboard.json in the data folder. 0 turns it off and clears it
    appearance: Literal["system", "light", "dark"] = "system"  # the app applies it to its windows, the page follows them
    hotkey: Literal["option+space", "ctrl+shift+space", "ctrl+option+space"] = "option+space"  # opens the hotbar, the app registers it
    screenshot_days: int = Field(0, ge=0)  # delete screenshot images older than this, keep their text. 0 keeps them forever


def get():
    """Read at use time, so a change needs no restart."""
    try:
        return Settings(**json.loads((db.DATA / "settings.json").read_text())).model_dump()
    except (OSError, ValueError):
        return Settings().model_dump()


def update(patch):
    """Raises ValueError (pydantic's ValidationError) on a bad value."""
    s = Settings(**{**get(), **patch}).model_dump()
    (db.DATA / "settings.json").write_text(json.dumps(s, indent=2))
    return s
