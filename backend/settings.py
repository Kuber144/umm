import json
from typing import Literal

from pydantic import BaseModel, Field

from db import DATA

FILE = DATA / "settings.json"


class Settings(BaseModel):
    """The defaults live here. data/settings.json only holds what the person changed."""
    # languages you speak; free auto detect misreads short clips (it heard "hello hello" as Arabic),
    # so detection only picks the likeliest of these. An empty list allows any language
    languages: list[str] = ["en", "hi"]
    # faster-whisper size, runs in a child process only while transcribing to keep idle memory low
    model: Literal["small", "medium"] = "medium"
    enrich_links: bool = True  # fetch title and description of saved links
    excluded_apps: list[str] = []  # app names the hotbar screenshot refuses to capture
    screenshot_days: int = Field(0, ge=0)  # delete screenshot images older than this, keep their text. 0 keeps them forever


def get():
    """Read at use time, so a change needs no restart."""
    try:
        return Settings(**json.loads(FILE.read_text())).model_dump()
    except (OSError, ValueError):
        return Settings().model_dump()


def update(patch):
    """Raises ValueError (pydantic's ValidationError) on a bad value."""
    s = Settings(**{**get(), **patch}).model_dump()
    FILE.write_text(json.dumps(s, indent=2))
    return s
