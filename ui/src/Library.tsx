import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, type Agent, type Item, type Kind, type Origin, type Profiles, type Rec } from './api'
import { native, pending, send } from './bridge'
import Connections from './Connections'
import { Glyph, Preview, Row, Zoom, copyText, projectName, type Act } from './Memory'
import Settings, { Welcome } from './Settings'
import { AppIcon, Dot, Icon, Kbd, Menu, Pop, SOURCES, Tips, clock, type Opt } from './ui'
import icon from '../../assets/icon.svg'
import './main.css'

const PAGE = 40
const KINDS: [Kind, string, string][] = [['screenshot', 'Screenshots', 'screenshot'], ['text', 'Notes', 'note'], ['link', 'Links', 'link'], ['path', 'Paths', 'path'], ['voice', 'Voice', 'voice note']]
const EMPTY: Record<string, string> = {
  user: 'Press Ctrl+Shift+Space, then Enter, to keep what is on your screen. Or drop a file or some text here.',
  agent: 'Ask Claude to remember something and it shows up here.',
}
const day = (v: string) => new Date(v + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const SKIP = 'umm.welcome'  // localStorage, set when the first run guide is skipped
const typing = (t: EventTarget | null) => /^(INPUT|TEXTAREA|SELECT)$/.test((t as HTMLElement)?.tagName)
// totals per key, most first, from GET /api/origins rows
const tally = (rows: Origin[], key: 'source' | 'agent' | 'cwd') => {
  const m = new Map<string, number>()
  for (const r of rows) if (r[key]) m.set(r[key]!, (m.get(r[key]!) ?? 0) + r.count)
  return [...m].sort((a, b) => b[1] - a[1])
}

type View = 'list' | 'settings' | 'connections'

// A new note opens in the preview pane. It keeps its own text, so typing does not re-render the list.
function NewNote({ to, onSave, onClose }: { to: string; onSave: (text: string) => Promise<unknown>; onClose: () => void }) {
  const [draft, setDraft] = useState('')
  const save = () => { if (draft.trim()) onSave(draft.trim()).then(onClose, () => {}) }
  return (
    <section className="pane compose" aria-label="New note">
      <header className="phead"><b>New note</b><span className="to">in <Dot name={to} />{to}</span></header>
      <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} placeholder="Write it down" aria-label="Note"
        onKeyDown={e => {
          if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); save() }
          if (e.key === 'Escape') { e.stopPropagation(); onClose() }
        }} />
      <footer><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!draft.trim()} onClick={save}>Save <Kbd>Cmd Enter</Kbd></button></footer>
    </section>
  )
}

export default function Library() {
  const [profiles, setProfiles] = useState<Profiles>({ active: 'user', all: [] })
  const [scope, setScope] = useState('')
  const [view, setView] = useState<View>('list')
  const [q, setQ] = useState('')
  const [kinds, setKinds] = useState<Kind[]>([])
  const [app, setApp] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [source, setSource] = useState('')
  const [agent, setAgent] = useState('')
  const [project, setProject] = useState('')
  const [session, setSession] = useState<Agent | null>(null)
  const [sort, setSort] = useState('')
  const [apps, setApps] = useState<{ app: string; count: number }[]>([])
  const [origins, setOrigins] = useState<Origin[]>([])
  const [live, setLive] = useState(0)
  const [items, setItems] = useState<Item[]>([])
  const [hq, setHq] = useState('')  // the query the shown items were found with, so rows only re-render when results arrive
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [rec, setRec] = useState<Rec>({ on: false, seconds: 0, transcribing: 0 })
  const [sel, setSel] = useState(-1)
  const [picked, setPicked] = useState<number[]>([])  // ids, only while more than one row is selected
  const [zoom, setZoom] = useState<number | null>(null)
  const [composing, setComposing] = useState(false)
  const [drag, setDrag] = useState(false)
  const [toast, setToast] = useState<{ msg: string; undo?: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [skipped, setSkipped] = useState(() => { try { return !!localStorage.getItem(SKIP) } catch { return false } })
  const [, tick] = useReducer(x => x + 1, 0)
  const searchRef = useRef<HTMLInputElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const seq = useRef(0)
  const busy = useRef(false)
  const anchor = useRef(-1)
  const base = useRef<number[]>([])  // picks made before the anchor, kept by Shift ranges
  const toastTimer = useRef(0)
  const del = useRef<{ its: Item[]; timer: number } | null>(null)

  const list = items
  const sortNow = sort === 'relevance' && !q.trim() ? 'new' : sort || (q.trim() ? 'relevance' : 'new')
  const page = (offset: number, limit = PAGE) => api.items({
    q: q.trim(), profile: scope, kind: kinds.join(','), app, since, until, sort: sortNow, limit, offset,
    source, agent, project, session: session?.session,
  })
  // Reloads the rows shown, 200 per request (the API cap), keeping the selected item. first starts at the top.
  const refresh = (limit = PAGE, first = false) => {
    const n = ++seq.current
    const id = list[sel]?.id
    return Promise.all(Array.from({ length: Math.ceil(limit / 200) }, (_, i) => page(i * 200, Math.min(200, limit - i * 200)))).then(rs => {
      if (n !== seq.current) return
      const r = rs.flat()
      setItems(r); setHq(q); setMore(r.length >= limit); setLoaded(true); setFailed(false)
      if (first) { setSel(r.length ? 0 : -1); setPicked([]); anchor.current = 0 }
      else if (r.some(x => x.id === id)) setSel(r.findIndex(x => x.id === id))
      return r
    }, () => { setLoaded(true); setFailed(true) })
  }
  // Browsing a profile is only UI state. The active profile, where hotkey saves go, changes in Settings and the hotbar.
  const refreshProfiles = () => {
    api.agents().then(a => setLive(a.filter(x => x.connected).length), () => {})
    return api.profiles().then(p => { setProfiles(p); setScope(s => (s === '*' || p.all.some(x => x.name === s) ? s : p.active)) }, () => setFailed(true))
  }
  const say = (msg: string, ms = 1800) => {
    clearTimeout(toastTimer.current)
    setToast({ msg })
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }

  // Deleting waits a few seconds so it can be undone, a batch at once. Only then are the rows and their files removed.
  const flush = () => {
    const d = del.current
    if (!d) return
    clearTimeout(d.timer); del.current = null; setToast(null)
    Promise.all(d.its.map(it => api.del(it.id))).then(refreshProfiles, () => { say('Could not delete'); refresh(items.length) })
  }
  const remove = (its: Item[]) => {
    if (!its.length) return
    flush()
    const ids = new Set(its.map(x => x.id))
    setItems(l => l.filter(x => !ids.has(x.id)))
    setPicked([]); setSel(s => Math.min(s, list.length - its.length - 1))
    clearTimeout(toastTimer.current)
    setToast({ msg: its.length > 1 ? `Deleted ${its.length} memories` : 'Deleted', undo: true })
    del.current = { its, timer: window.setTimeout(flush, 6000) }
  }
  const undo = () => {
    if (!del.current) return
    const back = del.current.its.map(x => x.id)
    clearTimeout(del.current.timer); del.current = null; setToast(null)
    // select what came back
    refresh(items.length + back.length).then(r => {
      const i = r?.findIndex(x => back.includes(x.id)) ?? -1
      if (i >= 0) { setSel(i); setPicked(back.length > 1 ? back : []) }
    })
  }
  useEffect(() => { window.addEventListener('pagehide', flush); return () => window.removeEventListener('pagehide', flush) })

  const acts = useRef<Act>(null!)
  acts.current = {
    copy: it => api.copy(copyText(it)).then(() => say('Copied'), () => say('Could not copy')),
    reveal: it => api.reveal(it.content),
    del: remove,
    move: (its, p) => Promise.all(its.map(it => api.edit(it.id, { profile: p }))).then(() => {
      say(`Moved ${its.length > 1 ? its.length + ' memories ' : ''}to ${p}`); setPicked([]); refresh(items.length); refreshProfiles()
    }, () => say('Could not move')),
    save: (it, content) => api.edit(it.id, { content }).then(() => { refresh(items.length) }, e => { say('Could not save'); throw e }),
    zoom: it => setZoom(it.id),
    shot: (it, what) => (what === 'copy' ? api.copyImage(it.id) : api.open(it.id, what === 'reveal'))
      .then(() => what === 'copy' && say('Image copied'), () => say(what === 'copy' ? 'Could not copy the image' : 'Could not open the screenshot')),
  }
  // one object for the life of the page that calls the latest handlers, so memoized rows don't re-render
  const act = useMemo(() => new Proxy({} as Act, { get: (_, k: keyof Act) => (...a: never[]) => (acts.current[k] as (...a: never[]) => void)(...a) }), [])
  const open = (it: Item) => (it.kind === 'screenshot' ? setZoom(it.id) : it.kind === 'link' ? send({ type: 'openExternal', url: copyText(it) }) : act.copy(it))

  // Click selects one row, Cmd-click adds or removes a row, Shift-click selects the range from the last plain pick.
  const ids = (a: number, b: number) => list.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id)
  const pickAt = (i: number, how: { metaKey?: boolean; shiftKey?: boolean } = {}) => {
    const id = list[i]?.id
    if (id === undefined) return
    setComposing(false)
    if (how.shiftKey && anchor.current >= 0) setPicked([...new Set([...base.current, ...ids(anchor.current, i)])])
    else if (how.metaKey) {
      const now = picked.length ? picked : list[sel] ? [list[sel].id] : []
      const next = now.includes(id) ? now.filter(x => x !== id) : [...now, id]
      setPicked(next); anchor.current = i; base.current = next
    } else { setPicked([]); anchor.current = i; base.current = [] }
    setSel(i)
  }
  const pickRef = useRef(pickAt)
  pickRef.current = pickAt
  const onPick = useMemo(() => (i: number, e: React.MouseEvent) => pickRef.current(i, e), [])
  const onOpen = useMemo(() => (it: Item) => openRef.current(it), [])
  const openRef = useRef(open)
  openRef.current = open
  const chosen = picked.length > 1 ? list.filter(x => picked.includes(x.id)) : list[sel] ? [list[sel]] : []

  const clearFilters = () => { setQ(''); setKinds([]); setApp(''); setSince(''); setUntil(''); setSource(''); setAgent(''); setProject(''); setSession(null) }
  const go = (name: string) => {
    flush(); setView('list'); setScope(name); setApp(''); setAgent(''); setProject(''); setSession(null); setConfirmDel(false); setRenaming(null); setComposing(false)
  }
  const openSession = (a: Agent) => { go('*'); clearFilters(); setSession(a) }
  const names = useMemo(() => profiles.all.map(p => p.name).sort((a, b) => +(b === 'user') - +(a === 'user') || +(b === 'agent') - +(a === 'agent') || a.localeCompare(b)), [profiles])
  const order = [...names, '*']
  const count = (n: string) => (n === '*' ? profiles.all.reduce((s, p) => s + p.count, 0) : profiles.all.find(p => p.name === n)?.count ?? 0)
  const custom = !!scope && scope !== '*' && scope !== 'user' && scope !== 'agent'
  const filtered = !!(q.trim() || kinds.length || app || since || until || source || agent || project || session)

  // initial load and refresh when the window regains focus (hotkey saves happen while it is hidden)
  useEffect(() => { refreshProfiles(); api.record().then(setRec, () => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = () => { refreshProfiles(); api.record().then(setRec, () => {}); refresh(Math.max(items.length, PAGE)) }
    window.addEventListener('focus', f)
    return () => window.removeEventListener('focus', f)
  })
  useEffect(() => {
    if (!scope) return
    const t = setTimeout(() => refresh(PAGE, true), 120)
    return () => clearTimeout(t)
  }, [scope, q, kinds, app, since, until, sort, source, agent, project, session]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!scope) return
    api.apps(scope).then(setApps, () => setApps([]))
    api.origins(scope).then(setOrigins, () => setOrigins([]))
  }, [scope, items.length > 0])
  useEffect(() => { const t = setInterval(tick, 30000); return () => clearInterval(t) }, [])
  useEffect(() => {
    if (!failed) return
    const t = setInterval(() => { refreshProfiles(); if (scope) refresh() }, 2000)
    return () => clearInterval(t)
  }, [failed, scope]) // eslint-disable-line react-hooks/exhaustive-deps

  // recording: poll only while it matters, and pick up the voice item when transcribing ends
  const wasBusy = useRef(0)
  useEffect(() => {
    if (wasBusy.current && !rec.transcribing) { refresh(Math.max(items.length, PAGE)); refreshProfiles() }
    wasBusy.current = rec.transcribing
    if (!rec.on && !rec.transcribing) return
    const t = setInterval(() => api.record().then(setRec, () => {}), 1000)
    return () => clearInterval(t)
  }, [rec.on, rec.transcribing]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleRec = () => (rec.on ? api.recStop() : api.recStart('app')).then(r => { setRec(r); send({ type: 'recording', on: r.on }) }, () => say('Could not use the microphone'))

  // infinite scroll
  useEffect(() => {
    if (!more || !sentinel.current) return
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || busy.current) return
      busy.current = true
      const n = seq.current  // a page that arrives after a reload or another profile is dropped
      page(items.length).then(r => {
        if (n !== seq.current) return
        setItems(l => [...l, ...r.filter(x => !l.some(y => y.id === x.id))]); setMore(r.length >= PAGE)
      }).finally(() => { busy.current = false })
    })
    io.observe(sentinel.current)
    return () => io.disconnect()
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // a note goes to the profile on screen, All profiles uses the active one
  const saveTo = scope && scope !== '*' ? scope : profiles.active
  const saved = (n = 1) => { say(n > 1 ? `Saved ${n}` : 'Saved'); refresh(items.length + n, true); refreshProfiles() }
  const save = (text: string) => api.add(text, 'app', undefined, saveTo).then(() => saved(), e => { say('Could not save'); throw e })

  // native bridge: open with a query, files dropped on the window
  useEffect(() => {
    const show = (o: { query?: string }) => { setQ(o.query ?? ''); setZoom(null); setView('list'); searchRef.current?.focus(); refreshProfiles() }
    window.ummOpen = show
    if (pending.open) { show(pending.open); pending.open = undefined }
    return () => { window.ummOpen = undefined }
  }, [])
  useEffect(() => {
    window.ummDrop = ({ paths }) => {
      setDrag(false)
      Promise.allSettled(paths.map(p => api.import(p, saveTo))).then(r => {
        const ok = r.filter(x => x.status === 'fulfilled').length
        if (ok) saved(ok)
        if (ok < r.length) say(ok ? `Saved ${ok}, ${r.length - ok} could not be saved` : 'Could not save what was dropped', 3000)
      })
    }
    return () => { window.ummDrop = undefined }
  })
  // Text and links dropped or pasted on the window become a note. Files dropped are Swift's job (ummDrop).
  useEffect(() => {
    const over = (e: DragEvent) => { if (view !== 'list') return; e.preventDefault(); setDrag(true) }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDrag(false) }
    const drop = (e: DragEvent) => {
      e.preventDefault(); setDrag(false)
      const dt = e.dataTransfer
      if (!dt || view !== 'list') return
      if (dt.files.length) { if (!native) say('Drop files on the umm app window to save them', 3000); return }
      const text = (dt.getData('text/uri-list').split('\n').find(l => l && !l.startsWith('#')) || dt.getData('text/plain')).trim()
      if (text) save(text).catch(() => {})
    }
    const paste = (e: ClipboardEvent) => {
      if (typing(e.target) || view !== 'list' || !e.clipboardData) return
      e.preventDefault()
      const text = e.clipboardData.getData('text/plain').trim()
      // an image or copied files: the backend reads the clipboard itself
      if (e.clipboardData.files.length || !text) api.saveClipboard(undefined, 'app', saveTo).then(r => saved((r as { ids?: number[] }).ids?.length || 1), () => say('Nothing to save on the clipboard'))
      else save(text).catch(() => {})
    }
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop); window.addEventListener('paste', paste)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); window.removeEventListener('paste', paste) }
  })

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (zoom !== null) return
      if (e.metaKey && e.key === ',') { e.preventDefault(); setView(v => (v === 'settings' ? 'list' : 'settings')); return }
      const t = e.target as HTMLElement
      const search = searchRef.current
      if (e.metaKey && /^[1-9]$/.test(e.key)) { if (order[+e.key - 1]) { e.preventDefault(); go(order[+e.key - 1]) } return }
      // Cmd+K and Cmd+N also leave Settings and Connections, the search box mounts on the next render
      if (e.metaKey && e.key === 'k') { e.preventDefault(); setView('list'); setTimeout(() => { searchRef.current?.focus(); searchRef.current?.select() }); return }
      if (e.metaKey && e.key === 'n') { e.preventDefault(); setView('list'); setComposing(true); return }
      if (view !== 'list') return
      if (typing(t)) {
        if (t === search && e.key === 'Escape') { if (q) setQ(''); else t.blur() }
        else if (t === search && e.key === 'ArrowDown' && list.length) { e.preventDefault(); t.blur(); listRef.current?.focus(); pickAt(Math.max(0, sel)) }
        return
      }
      // Enter, Space and Delete act on the selection only when no button or link has focus
      const free = t === document.body || t === listRef.current
      const it = list[sel]
      const step = (d: number) => {
        e.preventDefault()
        const i = Math.max(0, Math.min(list.length - 1, sel + d))
        if (e.key === 'ArrowUp' && sel <= 0 && q && !e.shiftKey) { search?.focus(); setSel(-1); return }
        if (e.shiftKey && anchor.current < 0) anchor.current = Math.max(sel, 0)
        pickAt(i, { shiftKey: e.shiftKey })
      }
      if (e.key === 'ArrowDown' || e.key === 'j') step(1)
      else if (e.key === 'ArrowUp' || e.key === 'k') step(-1)
      else if (e.metaKey && e.key === 'z' && del.current) { e.preventDefault(); undo() }
      else if (e.metaKey && e.key === 'a' && list.length) { e.preventDefault(); setPicked(list.map(x => x.id)) }
      else if (e.key === 'Enter' && it && free) { e.preventDefault(); open(it) }
      else if (e.key === ' ' && it?.kind === 'screenshot' && free) { e.preventDefault(); setZoom(it.id) }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && chosen.length && free) { e.preventDefault(); remove(chosen) }
      else if (e.key === 'Escape') { if (composing) setComposing(false); else if (picked.length) setPicked([]); else if (sel >= 0) setSel(-1); else setQ('') }
      else if (e.key === '/') { e.preventDefault(); search?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const create = (v: string) => {
    setCreating(false)
    const name = v.trim().replace(/^\*$/, '')
    if (name) api.setProfile(name).then(() => { setScope(name); setApp(''); refreshProfiles() })
  }
  const rename = (v: string) => {
    const to = v.trim()
    setRenaming(null)
    if (to && to !== scope) api.renameProfile(scope, to).then(() => { setScope(to); refreshProfiles() }, () => say('Could not rename'))
  }
  const zoomIt = items.find(i => i.id === zoom)
  const stepZoom = (d: number) => {
    const shots = items.filter(i => i.kind === 'screenshot')
    const n = shots[shots.findIndex(i => i.id === zoom) + d]
    if (n) { setZoom(n.id); setSel(items.indexOf(n)) }
  }

  const agents = tally(origins, 'agent')
  const projects = tally(origins.filter(o => o.source === 'mcp'), 'cwd')
  const sources = tally(origins, 'source')
  const n = count(scope)
  const caption = filtered ? (list.length ? `${list.length}${more ? '+' : ''} ${list.length === 1 ? 'result' : 'results'}` : 'No results')
    : scope === 'agent' && agents.length
    ? `${plural(n, 'memory', 'memories')} from ${plural(agents.length, 'agent')}`
    : plural(n, 'memory', 'memories')
  const nFilters = +!!app + +!!since + +!!until + +!!source + +!!(agent && scope !== 'agent') + +!!(project && scope !== 'agent') + +(sort !== '' && sortNow !== (q.trim() ? 'relevance' : 'new'))
  const chip = (on: boolean, set: () => void, label: React.ReactNode, n: number, key: string) =>
    <button key={key} className={'chip' + (on ? ' on' : '')} aria-pressed={on} onClick={set}>{label}<span className="n">{n}</span></button>
  const counted = (value: string, label: React.ReactNode, n: number): Opt => ({ value, text: value, label: <>{label}<span className="n">{n}</span></> })
  const field = (name: string, value: string, set: (v: string) => void, opts: Opt[]) => (
    <div className="field"><span>{name}</span>
      <Menu label={name} value={value} onPick={set} options={opts}><span className="cur">{opts.find(o => o.value === value)?.label ?? value}</span><Icon name="updown" /></Menu>
    </div>
  )
  const side = (v: View, ic: 'plug' | 'gear', label: string, extra: React.ReactNode) =>
    <button className={'prof' + (view === v ? ' on' : '')} onClick={() => { flush(); setView(view === v ? 'list' : v) }}>
      <Icon name={ic} /><span className="name">{label}</span>{extra}
    </button>

  // kinds in the selection, for the summary: "2 screenshots and 1 note"
  const kindsIn = KINDS.map(([k, , one]) => [chosen.filter(x => x.kind === k).length, one] as const).filter(([c]) => c).map(([c, one]) => plural(c, one))
  const toProfile = (ps: string[]): Opt[] => ps.map(p => ({ value: p, label: <><Dot name={p} />{p}</>, text: p }))
  const pane = composing ? <NewNote to={saveTo} onSave={save} onClose={() => setComposing(false)} />
    : chosen.length > 1 ? (
      <section className="pane state bulk" aria-label="Selection">
        <div className="stack">{chosen.slice(0, 4).map(it => <span key={it.id}><Glyph it={it} /></span>)}</div>
        <h2>{plural(chosen.length, 'memory', 'memories')} selected</h2>
        <p>{kindsIn.length > 1 ? kindsIn.slice(0, -1).join(', ') + ' and ' + kindsIn[kindsIn.length - 1] : kindsIn[0]}</p>
        <div className="btns">
          <Menu className="btn" label="Move to profile" options={toProfile(names.filter(n => chosen.some(x => x.profile !== n)))} onPick={p => act.move(chosen, p)}><Icon name="move" />Move to<Icon name="caret" /></Menu>
          <button className="btn danger" onClick={() => remove(chosen)}><Icon name="trash" />Delete</button>
        </div>
        <p className="keys"><Kbd>Esc</Kbd> clears the selection</p>
      </section>
    ) : chosen[0] ? <Preview key={chosen[0].id} it={chosen[0]} q={hq} act={act} profiles={toProfile(names)} />
    : (
      <section className="pane state">
        {loaded && !list.length && !filtered ? <>
          <img src={icon} alt="" />
          <h2>Nothing in {scope === '*' ? 'any profile' : scope} yet</h2>
          <p>{EMPTY[scope] ?? 'Drop a file or some text here, or press Ctrl+Shift+Space anywhere.'}</p>
          <div className="btns"><button className="btn" onClick={() => setComposing(true)}><Icon name="compose" />New note</button></div>
        </> : loaded && !list.length ? <>
          <span className="glyphbig"><Icon name="search" /></span>
          <h2>{q.trim() ? `No results for "${q.trim()}"` : 'Nothing matches these filters'}</h2>
          <p>Try fewer words or remove a filter.</p>
          <div className="btns">
            {scope !== '*' && <button className="btn" onClick={() => go('*')}>Search all profiles</button>}
            <button className="btn" onClick={() => { clearFilters(); setSort('') }}>Clear search and filters</button>
          </div>
        </> : loaded && <p>Select a memory to see it here</p>}
      </section>
    )
  const first = loaded && !failed && !skipped && !composing && profiles.all.length > 0 && count('*') === 0

  return (
    <div className="shell">
      <aside className="side">
        <h3>Profiles</h3>
        <nav>
          {names.map((p, i) => (
            <button key={p} className={'prof' + (scope === p && view === 'list' ? ' on' : '')} onClick={() => go(p)}
              data-tip={p === profiles.active ? `${p}, where new saves land` : p} data-keys={i < 9 ? `Cmd ${i + 1}` : undefined}>
              <Dot name={p} /><span className="name">{p}</span><span className="n">{count(p)}</span>
            </button>
          ))}
          {creating
            ? <input className="newprof" autoFocus placeholder="Profile name" onBlur={e => create(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur() } }} />
            : <button className="prof add" onClick={() => setCreating(true)}><Icon name="plus" /><span className="name">New profile</span></button>}
        </nav>
        <div className="foot">
          <button className={'prof' + (scope === '*' && view === 'list' ? ' on' : '')} onClick={() => go('*')}>
            <Icon name="stack" /><span className="name">All profiles</span><span className="n">{count('*')}</span>
          </button>
          {side('connections', 'plug', 'Connections', live > 0 && <span className="n" data-tip={`${plural(live, 'agent')} connected now`}><i className="livedot" />{live}</span>)}
          {side('settings', 'gear', 'Settings', null)}
        </div>
      </aside>

      {view === 'settings' ? <Settings profiles={profiles} onActive={p => api.setProfile(p).then(refreshProfiles)} />
        : view === 'connections' ? <Connections onOpen={openSession} />
        : <main>
        <header className="top">
          <div className="title">
            <div className="h">
              {renaming !== null
                ? <input className="rename" autoFocus defaultValue={scope} onBlur={e => rename(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = scope; e.currentTarget.blur() } }} />
                : <h1>{scope === '*' ? 'All profiles' : scope || 'umm'}</h1>}
              {custom && renaming === null && (
                <Menu className="icon" label="Profile options" tip="Profile options" onPick={v => (v === 'rename' ? setRenaming(scope) : setConfirmDel(true))}
                  options={[{ value: 'rename', label: 'Rename...' }, { value: 'delete', label: 'Delete profile...', danger: true }]}><Icon name="caret" /></Menu>
              )}
            </div>
            {confirmDel
              ? <p>Delete {scope} and its {plural(n, 'item')}? <button className="link-btn danger" onClick={() => api.delProfile(scope).then(() => { go('user'); refreshProfiles() }, () => say('Could not delete'))}>Delete</button> <button className="link-btn" onClick={() => setConfirmDel(false)}>Keep</button></p>
              : <p>{failed ? 'Not connected' : caption}</p>}
          </div>
          <label className="search">
            <Icon name="search" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search" aria-label="Search" spellCheck={false} />
            {q ? <button className="clear" onClick={() => setQ('')} aria-label="Clear search" data-tip="Clear search" data-keys="Esc"><Icon name="x" /></button> : <Kbd>Cmd K</Kbd>}
          </label>
          <button className={'tbtn rec' + (rec.on ? ' on' : '')} onClick={toggleRec} data-tip={rec.on ? 'Stop recording' : 'Record a voice note'} aria-label={rec.on ? 'Stop recording' : 'Record a voice note'}>
            {rec.on ? <><i className="recdot" />{clock(rec.seconds)}</> : rec.transcribing ? <><Icon name="voice" />Transcribing</> : <Icon name="voice" />}
          </button>
          <button className="tbtn" onClick={() => setComposing(true)} data-tip="New note" data-keys="Cmd N" aria-label="New note"><Icon name="compose" /></button>
        </header>

        {failed ? (
          <div className="state">
            <img src={icon} alt="" />
            <h2>Cannot reach the umm backend</h2>
            <p>Your memories are safe on disk. The app restarts the backend on its own, and this page tries again every 2 seconds.</p>
            <div className="btns"><button className="btn" onClick={() => { refreshProfiles(); if (scope) refresh() }}>Retry now</button></div>
          </div>
        ) : first ? <Welcome onSkip={() => { try { localStorage.setItem(SKIP, '1') } catch { /* private window */ } setSkipped(true) }} />
        : <div className="split">
          <div className="col">
            <div className="scope">
              <div className="seg" role="tablist" aria-label="Kind">
                {([[null, 'All'], ...KINDS] as [Kind | null, string][]).map(([k, label]) => {
                  const on = k ? kinds[0] === k : !kinds.length
                  return <button key={label} role="tab" aria-selected={on} className={on ? 'on' : ''} data-tip={k ? label : 'Everything'} aria-label={label} onClick={() => setKinds(k ? [k] : [])}>
                    {k && <Icon name={k} />}<span className={k ? 'segt' : ''}>{label}</span></button>
                })}
              </div>
              <span className="gap" />
              <Pop trigger={t => <button className={'icon' + (nFilters ? ' lit' : '')} onClick={t} data-tip="Sort and filter" aria-label="Sort and filter"><Icon name="filter" />{nFilters ? <span className="n">{nFilters}</span> : null}</button>}>
                {() => <div className="fields">
                  {field('Sort', sortNow, setSort, [{ value: 'new', label: 'Newest first' }, { value: 'old', label: 'Oldest first' }, { value: 'relevance', label: 'Best match', disabled: !q.trim() }])}
                  {field('App', app, setApp, [{ value: '', label: 'Any app' }, ...apps.map(a => counted(a.app, <><AppIcon name={a.app} />{a.app}</>, a.count))])}
                  {sources.length > 1 && field('Saved with', source, setSource, [{ value: '', label: 'Anything' }, ...sources.map(([v, c]) => counted(v, SOURCES[v]?.[1] ?? v, c))])}
                  {agents.length > 0 && scope !== 'agent' && field('Agent', agent, setAgent, [{ value: '', label: 'Any agent' }, ...agents.map(([v, c]) => counted(v, <><AppIcon name={v} />{v}</>, c))])}
                  {projects.length > 0 && scope !== 'agent' && field('Project', project, setProject, [{ value: '', label: 'Any project' }, ...projects.map(([v, c]) => counted(v, projectName(v), c))])}
                  <div className="pair">
                    <label>From<input type="date" value={since} max={until || undefined} onChange={e => setSince(e.target.value)} /></label>
                    <label>Until<input type="date" value={until} min={since || undefined} onChange={e => setUntil(e.target.value)} /></label>
                  </div>
                </div>}
              </Pop>
            </div>
            {scope === 'agent' && agents.length > 0 && (
              <div className="facets">
                {agents.length > 1 && agents.map(([a, c]) => chip(agent === a, () => setAgent(agent === a ? '' : a), <><AppIcon name={a} />{a}</>, c, a))}
                {projects.map(([p, c]) => chip(project === p, () => setProject(project === p ? '' : p), <><Icon name="path" /><span data-tip={p}>{projectName(p)}</span></>, c, p))}
              </div>
            )}
            {(nFilters > 0 || session) && (
              <div className="facets">
                {session && <button className="tag" onClick={() => setSession(null)}><AppIcon name={session.agent} />{session.agent} in {projectName(session.cwd)}<Icon name="x" /></button>}
                {app && <button className="tag" onClick={() => setApp('')}><AppIcon name={app} />{app}<Icon name="x" /></button>}
                {source && <button className="tag" onClick={() => setSource('')}>{SOURCES[source]?.[1] ?? source}<Icon name="x" /></button>}
                {agent && scope !== 'agent' && <button className="tag" onClick={() => setAgent('')}><AppIcon name={agent} />{agent}<Icon name="x" /></button>}
                {project && scope !== 'agent' && <button className="tag" onClick={() => setProject('')}>{projectName(project)}<Icon name="x" /></button>}
                {since && <button className="tag" onClick={() => setSince('')}>From {day(since)}<Icon name="x" /></button>}
                {until && <button className="tag" onClick={() => setUntil('')}>Until {day(until)}<Icon name="x" /></button>}
                {sort && sortNow === 'old' && <button className="tag" onClick={() => setSort('')}>Oldest first<Icon name="x" /></button>}
                <button className="link-btn" onClick={() => { clearFilters(); setSort('') }}>Clear</button>
              </div>
            )}
            <div className="scroll">
              {!loaded && <ul className="list skel" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <li key={i} className="row"><span className="lead"><i /></span><span className="l1"><i /></span><span className="l2"><i /></span></li>)}</ul>}
              {list.length > 0 ? (
                <ul ref={listRef} className="list" role="listbox" tabIndex={0} aria-label="Memories" aria-multiselectable
                  aria-activedescendant={list[sel] ? 'm' + list[sel].id : undefined} onFocus={e => e.target === e.currentTarget && sel < 0 && pickAt(0)}>
                  {list.map((it, i) => (
                    <Row key={it.id} it={it} i={i} q={hq} cur={i === sel} on={!composing && (picked.length > 1 ? picked.includes(it.id) : i === sel)}
                      all={scope === '*'} onPick={onPick} onOpen={onOpen} />
                  ))}
                </ul>
              ) : null}
              {more && <div ref={sentinel} className="more-sentinel">Loading more</div>}
            </div>
          </div>
          {pane}
        </div>}
        {drag && <div className="dropzone"><div><Icon name="plus" /><b>Drop to save in {saveTo}</b><span>Images become screenshots with their text. Files are saved as paths, text and links as notes.</span></div></div>}
        {toast && <div className="toast" role="status">{toast.msg}{toast.undo && <button onClick={undo} data-tip="Undo delete" data-keys="Cmd Z">Undo</button>}</div>}
      </main>}
      <Tips />
      {zoomIt && <Zoom it={zoomIt} act={act} onClose={() => setZoom(null)} step={stepZoom} />}
    </div>
  )
}
