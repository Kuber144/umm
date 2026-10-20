from mcp.server.mcpserver import MCPServer

import db

mcp = MCPServer("umm")


@mcp.tool()
def search_memory(query: str = "", profile: str = "") -> list[dict]:
    """Search what the user saved to remember later: screenshot OCR text, notes, folder paths, links.
    Words are AND-matched with prefix matching, so try short keyword queries and retry with fewer words.
    Empty query returns the most recent items. Leave profile empty to search all profiles (user and agent included).
    Screenshot items have `file`, an absolute image path you can open to see the screen."""
    rows = db.search(query, profile or None)
    for r in rows:
        if r["file"]:
            r["file"] = str(db.FILES / r["file"])
    return rows


@mcp.tool()
def list_profiles() -> list[dict]:
    """List the user's memory profiles."""
    return db.profiles()


@mcp.tool()
def remember(content: str, profile: str = "") -> int:
    """Save a note, folder path, or link to the user's memory. Empty profile saves to the `agent` profile."""
    if profile.strip() == "*":
        raise ValueError('"*" means all profiles and can\'t be a profile name')
    return db.add(content, profile=profile.strip() or "agent")


if __name__ == "__main__":
    mcp.run()
