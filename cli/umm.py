"""umm command line. Talks to the umm app over ~/Library/Application Support/umm/umm.sock using only the standard library, so it starts fast."""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

VERSION = "0.1.0"
KINDS = ["screenshot", "text", "path", "link", "voice"]
ROOT = Path(os.environ.get("UMM_ROOT") or Path(__file__).resolve().parent.parent)
BASE = Path.home() / "Library" / "Application Support" / "umm"  # socket, log and the location pointer, same as backend/db.py
DATA = Path(os.environ.get("UMM_DATA") or ((BASE / "location").read_text().strip() if (BASE / "location").exists() else BASE))
LOG = BASE / "umm.log"
COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"
KIND_COLOR = {"screenshot": "36", "text": "0", "path": "32", "link": "34", "voice": "35"}


class Fail(Exception):
    pass


def c(code, s):
    return f"\033[{code}m{s}\033[0m" if COLOR else str(s)


def meta():
    return {"source": "cli", "cwd": os.getcwd()}


def dump(x):
    print(json.dumps(x, indent=2, ensure_ascii=False))


# ---- backend ----

def api(method, path, body=None, params=None):
    import http.client
    import socket
    from urllib.parse import urlencode

    class Conn(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.settimeout(60)
            self.sock.connect(str(BASE / "umm.sock"))

    if params:
        path += "?" + urlencode({k: v for k, v in params.items() if v not in (None, "")})
    try:
        conn = Conn("umm")
        conn.request(method, path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json"})
        r = conn.getresponse()
        data = r.read()
    except TimeoutError:
        raise Fail(f"the backend did not answer in time, see {LOG}")
    except OSError:
        if not (ROOT / "start.sh").exists():
            raise Fail(f"umm repo not found at {ROOT}, set UMM_ROOT")
        raise Fail("the app is not running, start it with: umm start")
    try:
        parsed = json.loads(data)
    except ValueError:
        parsed = None
    if r.status >= 400:
        d = parsed.get("detail") if isinstance(parsed, dict) else None
        if isinstance(d, list):
            d = "invalid input: " + str(d[0].get("msg", d[0]))
        raise Fail(d or f"backend error (HTTP {r.status}), see {LOG}")
    return parsed


def get(id):
    """The API has no get-by-id, so page through items (newest first) until the id shows up."""
    off = 0
    while True:
        page = api("GET", "/api/items", params={"profile": "*", "sort": "new", "limit": 200, "offset": off})
        for it in page:
            if it["id"] == id:
                return it
            if it["id"] < id:
                raise Fail(f"no item #{id}")
        if len(page) < 200:
            raise Fail(f"no item #{id}")
        off += 200


def profiles():
    return api("GET", "/api/profiles")


def need(name, p=None):
    if name not in [x["name"] for x in (p or profiles())["all"]]:
        raise Fail(f"no profile '{name}', create it with: umm profile new {name}")


def confirm(msg, yes):
    if yes:
        return
    if not sys.stdin.isatty():
        raise Fail("confirmation needed, pass -y")
    try:
        ok = input(f"{msg} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        ok = False
    if not ok:
        raise Fail("cancelled")


# ---- output ----

def ago(ts):
    s = time.time() - time.mktime(time.strptime(ts, "%Y-%m-%d %H:%M:%S"))
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)}m ago"
    if s < 86400:
        return f"{int(s // 3600)}h ago"
    if s < 172800:
        return "yesterday"
    return f"{int(s // 86400)}d ago" if s < 30 * 86400 else ts[:10]


def width():
    try:
        return max(os.get_terminal_size().columns, 40) if os.get_terminal_size().columns else 100
    except OSError:
        return 100


def snippet(text, words, w):
    """One line of content, centered on the first match, with matches highlighted."""
    t = " ".join(text.split()) or "(no text)"
    pat = re.compile("|".join(map(re.escape, words)), re.I) if words else None
    m = pat and pat.search(t)
    if m and m.end() > w:
        t = "…" + t[max(0, m.start() - w // 4):]
    if len(t) > w:
        t = t[:w - 1] + "…"
    return pat.sub(lambda m: c("1;33", m.group()), t) if pat and COLOR else t


def tag(it):
    """'agent · project' for memories saved by AI agents, 'cli · folder' for the command line."""
    m = it.get("meta") or {}
    parts = [m.get("agent") or m.get("source"), Path(m["cwd"]).name if m.get("cwd") else None]
    return " · ".join(p for p in parts if p)


def render(items, words=(), all_=False):
    idw = max(len(str(i["id"])) for i in items)
    w = width() - idw - 4
    for i in items:
        head = [c(1, f"{i['id']:>{idw}}"), c(KIND_COLOR.get(i["kind"], "0"), f"{i['kind']:<10}"), c(2, f"{ago(i['created_at']):<10}")]
        if all_:
            head.append(c(33, i["profile"]))
        if i["app"]:
            head.append(c(2, i["app"].split(":")[0]))
        if tag(i):
            head.append(c(2, tag(i)))
        print("  ".join(head).rstrip())
        print(" " * (idw + 2) + snippet(i["content"], words, w))


def saved(id):
    it = get(id)
    print(f"saved #{id} ({it['kind']}) to {it['profile']}, {len(it['content'])} chars")


# ---- argument types ----

def ident(s):
    try:
        return int(s.lstrip("#"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"'{s}' is not an item id")


def when(s):
    if re.fullmatch(r"\d{4}-\d\d-\d\d", s):
        return s
    m = re.fullmatch(r"(\d+)([dw])", s)
    days = {"today": 0, "yesterday": 1}.get(s, int(m[1]) * (7 if m[2] == "w" else 1) if m else None)
    if days is None:
        raise argparse.ArgumentTypeError(f"'{s}' is not a date, use YYYY-MM-DD, today, yesterday, 3d or 2w")
    return time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))


def kinds(s):
    bad = [k for k in s.split(",") if k not in KINDS]
    if bad:
        raise argparse.ArgumentTypeError(f"unknown kind '{bad[0]}', choose from {', '.join(KINDS)}")
    return s


# ---- commands ----

def edit_text(text, name):
    """Edit text in $VISUAL or $EDITOR and return the result."""
    import shlex
    import subprocess
    import tempfile
    editor = shlex.split(os.environ.get("VISUAL") or os.environ.get("EDITOR") or "vi")
    fd, path = tempfile.mkstemp(suffix=".txt", prefix=f"umm-{name}-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text + "\n" if text else "")
        try:
            if subprocess.run([*editor, path]).returncode:
                raise Fail("the editor exited with an error, nothing saved")
        except FileNotFoundError:
            raise Fail(f"editor not found: {editor[0]}, set $EDITOR")
        return Path(path).read_text().strip()
    finally:
        os.unlink(path)


def copy_text(it):
    import subprocess
    subprocess.run(["pbcopy"], input=it["content"], text=True, check=True)
    print(f"copied #{it['id']} ({len(it['content'])} chars)")


def cmd_add(a):
    import subprocess
    text = " ".join(a.text)
    if a.clipboard:
        text = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
    elif not text:
        text = edit_text("", "note") if sys.stdin.isatty() else sys.stdin.read()  # a terminal gets an editor for a multi-line note
    if not text.strip():
        raise Fail("nothing to add, the input is empty")
    if a.profile:
        need(a.profile)
    if text.startswith(("./", "../")) and os.path.exists(text.strip()):
        text = os.path.abspath(text.strip())  # the backend runs elsewhere, so relative paths must be made absolute here
    r = api("POST", "/api/items", {"content": text, "profile": a.profile, "meta": meta()})
    dump(r) if a.json else saved(r["id"])


def find(a, q=""):
    items = api("GET", "/api/items", params={
        "q": q, "profile": "*" if a.all else a.profile, "kind": a.kind, "app": a.app, "since": a.since,
        "until": a.until, "sort": a.sort, "limit": a.limit})
    if a.json:
        dump(items)
    elif items:
        render(items, q.split(), a.all)
        if getattr(a, "copy", False):
            copy_text(items[0])
        if len(items) == a.limit and sys.stderr.isatty():
            print(f"showing the first {len(items)}, use -n for more", file=sys.stderr)
    else:
        scope = "every profile" if a.all else f"profile '{a.profile}'" if a.profile else "the active profile"
        print(f"{'no matches' if q else 'nothing'} in {scope}" + ("" if a.all else ", try --all"), file=sys.stderr)
    return 1 if q and not items else 0


def cmd_show(a):
    it = get(a.id)
    path = str(DATA / "files" / it["file"]) if it["file"] else None
    if a.json:
        return dump({**it, "path": path})
    print(f"#{it['id']}  {c(KIND_COLOR.get(it['kind'], '0'), it['kind'])}  {c(33, it['profile'])}  {it['created_at']} ({ago(it['created_at'])})")
    meta = it.get("meta") or {}
    for k, v in [("app", it["app"]), ("file", path), *meta.items()]:
        if v:
            print(f"{c(2, f'{k:<14}')}{v}")
    print("\n" + it["content"])


def cmd_copy(a):
    copy_text(get(a.id))


def cmd_open(a):
    import subprocess
    if a.id is None:  # no id opens the main window
        if not (ROOT / "build/umm.app").exists():
            raise Fail(f"umm.app is not built, run {ROOT}/start.sh")
        return subprocess.run(["open", str(ROOT / "build/umm.app")]).returncode
    it = get(a.id)
    if it["file"]:
        target = DATA / "files" / it["file"]
        cmd = ["open", str(target)]
    elif it["kind"] == "link":
        target, cmd = it["content"].split()[0], ["open", it["content"].split()[0]]
    elif it["kind"] == "path":
        target = Path(it["content"].strip()).expanduser()
        cmd = ["open", "-R", str(target)]
    else:
        raise Fail(f"#{a.id} is a text note, nothing to open (try: umm show {a.id})")
    if isinstance(target, Path) and not target.exists():
        raise Fail(f"file is gone: {target}")
    subprocess.run(cmd, check=True)


def cmd_rm(a):
    items = [get(i) for i in a.ids]
    render(items, all_=True)
    confirm(f"Delete {len(items)} item{'s' * (len(items) > 1)}?", a.yes)
    for i in a.ids:
        api("DELETE", f"/api/items/{i}")
    print(f"deleted {len(a.ids)} item{'s' * (len(a.ids) > 1)}")


def cmd_edit(a):
    it = get(a.id)
    new = edit_text(it["content"], a.id)
    if new == it["content"].strip():
        print("no changes")
    elif not new:
        raise Fail("the content is empty, nothing saved (to delete it use: umm rm)")
    else:
        api("PATCH", f"/api/items/{a.id}", {"content": new})
        print(f"updated #{a.id}")


def cmd_mv(a):
    need(a.profile)
    for i in a.ids:
        get(i)
        api("PATCH", f"/api/items/{i}", {"profile": a.profile})
    print(f"moved {len(a.ids)} item{'s' * (len(a.ids) > 1)} to {a.profile}")


def cmd_shot(a):
    if a.area:  # TODO: send the flag once /api/capture supports area select
        raise Fail("--area is not supported by the backend yet")
    time.sleep(a.delay)
    try:
        r = api("POST", "/api/capture", {"meta": meta()})
    except Fail as e:
        if "HTTP 500" in str(e):
            raise Fail("the screenshot failed, check Screen Recording permission for umm in System Settings > Privacy & Security")
        raise
    dump(r) if a.json else saved(r["id"])


def recline(r):
    s = int(r["seconds"])
    line = f"recording {s // 60}:{s % 60:02d}" if r["on"] else "not recording"
    return line + (f", transcribing {r['transcribing']}" if r["transcribing"] else "")


def cmd_rec(a):
    try:
        r = api("POST", f"/api/record/{a.action}", {"meta": meta()} if a.action == "start" else None) if a.action in ("start", "stop") else api("GET", "/api/record")
    except Fail as e:
        if "HTTP 500" in str(e):
            raise Fail("recording failed, check Microphone permission for umm in System Settings > Privacy & Security")
        raise
    dump(r) if a.json else print(recline(r))


def cmd_profile_list(a):
    p = profiles()
    if a.json:
        return dump(p)
    w = max(len(x["name"]) for x in p["all"])
    for x in p["all"]:
        on = x["name"] == p["active"]
        print(c(1, f"* {x['name']:<{w}}  {x['count']:>4}") if on else f"  {x['name']:<{w}}  {x['count']:>4}")


def cmd_profile_use(a):
    need(a.name)
    api("POST", "/api/profiles", {"name": a.name})
    print(f"active profile is now {a.name}")


def cmd_profile_new(a):
    if a.name in [x["name"] for x in profiles()["all"]]:
        raise Fail(f"profile '{a.name}' already exists, switch with: umm profile use {a.name}")
    api("POST", "/api/profiles", {"name": a.name})
    print(f"created profile {a.name} and made it active")


def cmd_profile_rename(a):
    p = profiles()
    need(a.old, p)
    if a.new in [x["name"] for x in p["all"]]:
        raise Fail(f"profile '{a.new}' already exists")
    api("POST", "/api/profiles/rename", {"from": a.old, "to": a.new})
    print(f"renamed {a.old} to {a.new}")


def cmd_profile_rm(a):
    p = profiles()
    need(a.name, p)
    n = next(x["count"] for x in p["all"] if x["name"] == a.name)
    confirm(f"Delete profile '{a.name}' and its {n} item{'s' * (n != 1)}? This cannot be undone.", a.yes)
    api("DELETE", f"/api/profiles/{a.name}")
    print(f"deleted profile {a.name} and {n} item{'s' * (n != 1)}")


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return f"{n:.0f} {u}" if u == "B" else f"{n:.1f} {u}"
        n /= 1024


def cmd_status(a):
    import subprocess
    pids = subprocess.run(["pgrep", "-x", "umm"], capture_output=True, text=True).stdout.split()
    try:
        p, rec = profiles(), api("GET", "/api/record")
    except Fail:
        p = rec = None
    files = [Path(d) / f for d, _, fs in os.walk(DATA) for f in fs]
    size = sum(f.stat().st_size for f in files if f.exists())
    total = sum(x["count"] for x in p["all"]) if p else None
    counts = ", ".join(x["name"] + " " + str(x["count"]) for x in p["all"]) if p else ""
    if a.json:
        dump({"app_running": bool(pids), "pid": int(pids[0]) if pids else None, "backend": bool(p), "socket": str(BASE / "umm.sock"),
              "data": str(DATA), "active_profile": p and p["active"], "items": total, "profiles": p and p["all"], "recording": rec, "data_bytes": size})
    else:
        rows = [("app", f"running (pid {pids[0]})" if pids else "not running"),
                ("backend", f"ok ({BASE / 'umm.sock'})" if p else "not reachable"),
                ("profile", p["active"] if p else "-"),
                ("items", f"{total} ({counts})" if p else "-"),
                ("recording", recline(rec) if rec else "-"),
                ("data", f"{human(size)} in {len(files)} files ({DATA})")]
        for k, v in rows:
            print(f"{c(2, f'{k:<10}')}{v}")
        if not (pids and p):
            print("\nstart it with: umm start")
    return 0 if pids and p else 1


def script(name):
    import subprocess
    if not (ROOT / name).exists():
        raise Fail(f"umm repo not found at {ROOT}, set UMM_ROOT")
    return subprocess.run(["bash", str(ROOT / name)], stdout=subprocess.DEVNULL if name == "start.sh" else None).returncode


def cmd_start(a):
    try:
        api("GET", "/api/record")
        return print("umm is already running")
    except Fail:
        pass
    if script("start.sh"):
        raise Fail("start.sh failed, see the output above")
    for _ in range(80):
        try:
            api("GET", "/api/record")
            return print("umm started")
        except Fail:
            time.sleep(0.25)
    raise Fail(f"the app started but the backend did not answer, see {LOG}")


def cmd_stop(a):
    return script("stop.sh")


def cmd_profile_names(a):
    print("\n".join(x["name"] for x in profiles()["all"]))


# ---- zsh completion, generated from the parser so it never drifts ----

def zsh(p, name, out):
    clean = lambda s: re.sub(r"[\[\]':\\]", "", s or "")
    subs = next((x for x in p._actions if isinstance(x, argparse._SubParsersAction)), None)
    specs = []
    for x in p._actions:
        if isinstance(x, argparse._SubParsersAction):
            continue
        meta = (x.metavar or x.dest).lower()
        act = getattr(x, "complete", None) or (f"({' '.join(x.choices)})" if x.choices else "_umm_profiles" if "profile" in (x.dest, meta) else "")
        if x.option_strings:
            tail = "" if x.nargs == 0 else f":{meta}:{act}"
            specs += [f"'{o}[{clean(x.help)}]{tail}'" for o in x.option_strings]
        else:
            specs.append(f"'{'*' if x.nargs in ('+', '*') else ''}:{meta}:{act}'")
    body = f"_arguments -C {' '.join(specs)}"
    if subs:
        groups = {}
        for n, sp in subs.choices.items():
            groups.setdefault(sp, []).append(n)
        helps = {x.dest: x.help for x in subs._choices_actions}
        cmds = " ".join(f"'{n}:{clean(helps[n])}'" for sp, ns in groups.items() for n in ns[:1] if n in helps)
        cases = "\n".join(f"      {'|'.join(ns)}) _{name}_{ns[0]};;" for sp, ns in groups.items())
        body += f" '1:command:->cmd' '*::arg:->args'\n  case $state in\n    cmd) local -a c; c=({cmds}); _describe -t commands command c;;\n" \
                f"    args) case $line[1] in\n{cases}\n    esac;;\n  esac"
        for sp, ns in groups.items():
            zsh(sp, f"{name}_{ns[0]}", out)
    out.append(f"_{name}() {{\n  local state line\n  {body}\n}}")


def cmd_completion(a):
    out = ["_umm_profiles() { local -a p; p=(${(f)\"$(umm _profiles 2>/dev/null)\"}); compadd -a p; }"]
    zsh(parser(), "umm", out)
    print("#compdef umm\n" + "\n".join(out) + '\nif [ "$funcstack[1]" = "_umm" ]; then _umm "$@"; else compdef _umm umm; fi')


# ---- parser ----

class RAW(argparse.RawDescriptionHelpFormatter):
    def __init__(self, prog):
        super().__init__(prog, max_help_position=30)

    def _format_action(self, a):  # list the commands without the extra "<command>" header line
        if isinstance(a, argparse._SubParsersAction):
            return "".join(self._format_action(x) for x in a._get_subactions())
        return super()._format_action(a)


def parser():
    p = argparse.ArgumentParser("umm", formatter_class=RAW, description=(
        "Personal memory for macOS. Talks to the umm app over ~/Library/Application Support/umm/umm.sock.\n\n"
        "examples:\n  umm add \"remember to call mum\"       save a note\n  pbpaste | umm add                    save the clipboard\n"
        "  umm shot                             screenshot and OCR\n  umm find invoice --since 1w          search the last week\n"
        "  umm ls --all -k link                 recent links in every profile\n  umm show 42 / umm copy 42 / umm open 42"),
        epilog="environment: UMM_ROOT (repo location), UMM_DATA (data folder), NO_COLOR, EDITOR\ncompletions: eval \"$(umm completion zsh)\"  (see docs/cli.md)")
    p.add_argument("-V", "--version", action="version", version=f"umm {VERSION}")
    sub = p.add_subparsers(metavar="<command>", title="commands")

    def cmd(sub, name, fn, help, *aliases, parents=(), eg=""):
        sp = sub.add_parser(name, aliases=list(aliases), help=help, description=help, parents=parents, formatter_class=RAW,
                            epilog="examples:\n" + "\n".join("  " + e for e in eg.split("\n")) if eg else None)
        sp.set_defaults(fn=fn)
        return sp

    def arg(sp, *flags, complete=None, **kw):
        sp.add_argument(*flags, **kw).complete = complete

    js = argparse.ArgumentParser(add_help=False)
    js.add_argument("--json", action="store_true", help="print JSON")

    filt = argparse.ArgumentParser(add_help=False, parents=[js])
    scope = filt.add_mutually_exclusive_group()
    arg(scope, "-p", "--profile", metavar="NAME", help="profile to look in (default: the active one)")
    scope.add_argument("-A", "--all", action="store_true", help="look in every profile")
    arg(filt, "-k", "--kind", type=kinds, metavar="KIND", help=f"{', '.join(KINDS)} (comma separated)",
        complete="_values -s , kind " + " ".join(KINDS))
    filt.add_argument("-a", "--app", help="only items saved from this app, e.g. Safari")
    filt.add_argument("--since", type=when, metavar="WHEN", help="YYYY-MM-DD, today, yesterday, 3d, 2w (whole days)")
    filt.add_argument("--until", type=when, metavar="WHEN", help="same format, inclusive")
    filt.add_argument("-s", "--sort", choices=["new", "old", "relevance"], help="default: relevance with a query, else new")
    filt.add_argument("-n", "--limit", type=int, default=20, help="max results (default 20, cap 200)")

    s = cmd(sub, "add", cmd_add, "save text, a path or a link (or stdin)", "a", parents=[js],
            eg='umm add "call the dentist"\numm add                 write a longer note in $EDITOR\numm add -c              save the clipboard\npbpaste | umm add\necho ~/Documents/plan.pdf | umm add\numm add -p work "ship friday"')
    s.add_argument("text", nargs="*", help="what to save, multi-line is fine (default: stdin, or $EDITOR in a terminal)")
    s.add_argument("-c", "--clipboard", action="store_true", help="save the clipboard")
    arg(s, "-p", "--profile", metavar="NAME", help="save into this profile (default: the active one)")

    s = cmd(sub, "search", lambda a: find(a, " ".join(a.query)), "full text search", "find", "s", parents=[filt],
            eg='umm find invoice\numm find "api key" --all --kind text,link\numm s meeting -a Slack --since 2w --json | jq .[].content')
    s.add_argument("query", nargs="+", help="words to find, each matches word starts")
    s.add_argument("--copy", action="store_true", help="copy the top hit to the clipboard")

    s = cmd(sub, "clip", cmd_add, "save the clipboard (same as add -c)", parents=[js], eg="umm clip\numm clip -p work")
    s.set_defaults(clipboard=True, text=[])
    arg(s, "-p", "--profile", metavar="NAME", help="save into this profile (default: the active one)")

    cmd(sub, "ls", find, "list recent items", "recent", "l", parents=[filt],
        eg="umm ls\numm ls -n 5 -k screenshot\numm recent --all --since yesterday")

    for name, fn, help, al, eg in [("show", cmd_show, "print one item in full", (), "umm show 42\numm show 42 --json"),
                                   ("copy", cmd_copy, "copy an item's text to the clipboard", ("cp",), "umm copy 42"),
                                   ("open", cmd_open, "open the file or link, or reveal the path in Finder", ("o",), "umm open 42\numm open        open the main window"),
                                   ("edit", cmd_edit, "edit an item's text in $EDITOR", ("e",), "umm edit 42")]:
        s = cmd(sub, name, fn, help, *al, parents=[js] if name == "show" else [], eg=eg)
        s.add_argument("id", type=ident, nargs="?" if name == "open" else None, help="item id, shown by ls and find")

    s = cmd(sub, "rm", cmd_rm, "delete items and their files", "delete", eg="umm rm 42\numm rm 40 41 42 -y")
    s.add_argument("ids", nargs="+", type=ident, metavar="id")
    s.add_argument("-y", "--yes", action="store_true", help="do not ask")

    s = cmd(sub, "mv", cmd_mv, "move items to another profile", eg="umm mv 42 work\numm mv 40 41 42 agent")
    s.add_argument("ids", nargs="+", type=ident, metavar="id")
    s.add_argument("profile", metavar="profile")

    s = cmd(sub, "shot", cmd_shot, "take a screenshot and OCR it", "screenshot", parents=[js], eg="umm shot\numm shot -d 3   wait 3 seconds first")
    s.add_argument("--area", action="store_true", help="select an area (not supported by the backend yet)")
    s.add_argument("-d", "--delay", type=float, default=0, metavar="SECONDS", help="wait before capturing, to switch windows")

    s = cmd(sub, "rec", cmd_rec, "voice recording: start, stop or status", parents=[js], eg="umm rec start\numm rec stop")
    s.add_argument("action", nargs="?", choices=["start", "stop", "status"], default="status")

    s = cmd(sub, "profile", cmd_profile_list, "list and manage profiles", "p", parents=[js], eg="umm profile\numm profile use work\numm profile new side-project")
    ps = s.add_subparsers(metavar="<command>", title="commands")
    cmd(ps, "list", cmd_profile_list, "list profiles with item counts (default)", "ls", parents=[js])
    cmd(ps, "use", cmd_profile_use, "make a profile the active one").add_argument("name", metavar="profile")
    cmd(ps, "new", cmd_profile_new, "create a profile and make it active").add_argument("name")
    s = cmd(ps, "rename", cmd_profile_rename, "rename a profile (not user or agent)")
    s.add_argument("old", metavar="profile")
    s.add_argument("new")
    s = cmd(ps, "rm", cmd_profile_rm, "delete a profile and every item in it", "delete")
    s.add_argument("name", metavar="profile")
    s.add_argument("-y", "--yes", action="store_true", help="do not ask")

    cmd(sub, "start", cmd_start, "start the umm app and its backend")
    cmd(sub, "stop", cmd_stop, "quit the app and the backend")
    cmd(sub, "status", cmd_status, "app, backend, counts and disk use", "st", parents=[js])
    s = cmd(sub, "completion", cmd_completion, "print the shell completion script", eg='eval "$(umm completion zsh)"')
    s.add_argument("shell", choices=["zsh"])
    sub.add_parser("_profiles").set_defaults(fn=cmd_profile_names)
    return p


def main():
    p = parser()
    a = p.parse_args()
    if not hasattr(a, "fn"):
        p.print_help()
        return
    try:
        code = a.fn(a) or 0
        sys.stdout.flush()
    except Fail as e:
        print(f"umm: {e}", file=sys.stderr)
        code = 1
    except KeyboardInterrupt:
        code = 130
    except BrokenPipeError:
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        code = 0
    sys.exit(code)


if __name__ == "__main__":
    main()
