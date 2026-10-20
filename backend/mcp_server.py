from typing import Annotated, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field

import db

INSTRUCTIONS = """umm is the user's personal memory on their Mac. It holds screenshots (with OCR text), notes, folder paths, links, voice recordings (transcribed) and clipboard saves.
Items live in profiles. `user` is what the person saved. `agent` is your own memory. The user may add more, such as `work`.

Search first. Call search_memory before asking the user where a file or folder is, what a link was, or about something they saw, wrote or said. Use short keywords and retry with fewer words. An empty query lists the newest items. Screenshot and voice results include an absolute `file` path you can open.

Remember durable facts worth keeping across sessions: preferences, decisions, project paths, how things are set up. Use remember, which saves to `agent`. Do not save secrets or passing details. Search before saving to avoid duplicates.

Never change or delete the user's items. forget only deletes from `agent` unless the user asked you to delete a specific item."""
PREVIEW = 500

mcp = MCPServer("umm", instructions=INSTRUCTIONS)


def item(r, full=False):
    if r["file"]:
        r["file"] = str(db.FILES / r["file"])
    if not full and len(r["content"]) > PREVIEW:
        r["content"], r["truncated"] = r["content"][:PREVIEW] + "...", True
    return r


@mcp.tool()
def search_memory(
    query: Annotated[str, Field(description="Keywords, AND-matched with prefix matching. Empty lists the newest items.")] = "",
    kind: Annotated[list[Literal["screenshot", "text", "path", "link", "voice"]] | None, Field(description="Only these kinds. Default is all.")] = None,
    app: Annotated[str, Field(description="Only items saved while this app was in front, such as Safari. See list_apps.")] = "",
    since: Annotated[str, Field(description="YYYY-MM-DD, inclusive.")] = "",
    until: Annotated[str, Field(description="YYYY-MM-DD, inclusive.")] = "",
    sort: Annotated[Literal["relevance", "new", "old"], Field(description="Default is relevance when query is set, else new.")] = "relevance",
    limit: Annotated[int, Field(ge=1, le=50)] = 10,
    offset: Annotated[int, Field(ge=0, description="Skip this many results, for paging.")] = 0,
    profile: Annotated[str, Field(description='Profile name, or "*" for all profiles.')] = "*",
) -> list[dict]:
    """Search the user's saved memory: screenshot OCR text, notes, folder paths, links, voice transcripts.
    Returns {id, profile, kind, content, file, app, created_at}, newest or best match first.
    Long content is cut to 500 characters and marked `truncated: true`; call get_memory(id) for the rest.
    `file` is an absolute path to the screenshot image or voice recording, or null."""
    rows = db.search(query, profile.strip() or "*", ",".join(kind or []), limit, offset, app, since, until, sort)
    return [item(r) for r in rows]


@mcp.tool()
def get_memory(id: int) -> dict:
    """Get one item by id with its full content. Use it when search_memory marked a result `truncated`."""
    r = db.get(id)
    if not r:
        raise ToolError(f"no item {id}")
    return item(r, full=True)


@mcp.tool()
def remember(content: Annotated[str, Field(description="A note, folder path or link. Multi-line is fine.")], profile: str = "agent") -> int:
    """Save a durable note, folder path or link to memory. Returns the new id.
    Saves to the `agent` profile by default. Pass another profile name only if the user asked for it."""
    profile = profile.strip() or "agent"
    if not content.strip():
        raise ToolError("content is empty")
    if profile == "*":
        raise ToolError('"*" means all profiles and can\'t be a profile name')
    return db.add(content.strip(), profile=profile)


@mcp.tool()
def forget(id: int, allow_any: Annotated[bool, Field(description="Set true only when the user asked you to delete this item from another profile.")] = False) -> str:
    """Delete an item and its file. Only items in the `agent` profile can be deleted unless allow_any is true."""
    r = db.get(id)
    if not r:
        raise ToolError(f"no item {id}")
    if r["profile"] != "agent" and not allow_any:
        raise ToolError(f'item {id} is in profile "{r["profile"]}", not "agent". Pass allow_any=true only if the user asked for it')
    db.delete(id)
    return f"deleted {id}"


@mcp.tool()
def list_profiles() -> list[dict]:
    """List profiles with item counts. `user` is the person's own saves, `agent` is yours."""
    return db.profiles()


@mcp.tool()
def list_apps(profile: str = "*") -> list[dict]:
    """List app names that items were saved from, with counts, most used first. Use a name as the `app` filter of search_memory."""
    return db.apps(profile.strip() or "*")


if __name__ == "__main__":
    mcp.run()
