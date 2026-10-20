import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, type Agent, type Item, type Kind, type Origin, type Profiles, type Rec } from './api'
import { pending, send } from './bridge'
import Connections from './Connections'
import { Detail, Row, copyText, projectName, type Act } from './Memory'
import Settings from './Settings'
import { AppIcon, Dot, Icon, Kbd, Pop, SOURCES, clock } from './ui'
import icon from '../../assets/icon.svg'
import './main.css'

const PAGE = 40
const KINDS: [Kind, string][] = [['screenshot', 'Screenshots'], ['text', 'Notes'], ['path', 'Paths'], ['link', 'Links'], ['voice', 'Voice']]
const EMPTY: Record<string, string> = {
  user: 'Press Ctrl+Shift+Space, then Enter, to keep what is on your screen. Or write something above.',
  agent: 'Ask Claude to remember something and it shows up here.',
}
const day = (v: string) => new Date(v + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
// totals per key, most first, from GET /api/origins rows
const tally = (rows: Origin[], key: 'source' | 'agent' | 'cwd') => {
  const m = new Map<string, number>()
  for (const r of rows) if (r[key]) m.set(r[key]!, (m.get(r[key]!) ?? 0) + r.count)
  return [...m].sort((a, b) => b[1] - a[1])
}

type View = 'list' | 'settings' | 'connections'

// The note box keeps its own text, so typing does not re-render the list.
function Composer({ to, onSave, box }: { to: string; onSave: (text: string) => Promise<unknown>; box: React.RefObject<HTMLTextAreaElement | null> }) {
  const [draft, setDraft] = useState('')
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 220) + 'px' }
  const save = () => { if (draft.trim()) onSave(draft.trim()).then(() => { setDraft(''); if (box.current) box.current.style.height = '' }, () => {}) }
  return (
    <div className={'composer' + (draft ? ' has' : '')}>
      <textarea ref={box} rows={1} value={draft} onChange={e => { setDraft(e.target.value); grow(e.currentTarget) }}
        placeholder="Write a note" aria-label="Write a note"
        onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); save() } }} />
      <div className="cbar">
        <span className="to">Saves to <Dot name={to} />{to}</span>
        <button className="btn primary" disabled={!draft.trim()} onClick={save}>Save <Kbd>Cmd Enter</Kbd></button>
      </div>
    </div>
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
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [rec, setRec] = useState<Rec>({ on: false, seconds: 0, transcribing: 0 })
  const [sel, setSel] = useState(-1)
  const [detail, setDetail] = useState<number | null>(null)
  const [toast, setToast] = useState<{ msg: string; undo?: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [, tick] = useReducer(x => x + 1, 0)
  const searchRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const seq = useRef(0)
  const busy = useRef(false)
  const toastTimer = useRef(0)
  const del = useRef<{ it: Item; timer: number } | null>(null)

  const list = items
  const sortNow = sort === 'relevance' && !q.trim() ? 'new' : sort || (q.trim() ? 'relevance' : 'new')
  const page = (offset: number, limit = PAGE) => api.items({
    q: q.trim(), profile: scope, kind: kinds.join(','), app, since, until, sort: sortNow, limit, offset,
    source, agent, project, session: session?.session,
  })
  const refresh = (limit = PAGE) => {
    const n = ++seq.current
    const lim = Math.min(200, limit)  // the API caps a page at 200
    return page(0, lim).then(r => {
      if (n !== seq.current) return
      setItems(r); setMore(r.length >= lim); setLoaded(true); setFailed(false)
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

  // Deleting waits a few seconds so it can be undone. Only then are the row and its file removed.
  const flush = () => {
    const d = del.current
    if (!d) return
    clearTimeout(d.timer); del.current = null; setToast(null)
    api.del(d.it.id).then(refreshProfiles, () => { say('Could not delete'); refresh() })
  }
  const remove = (it: Item) => {
    flush()
    setItems(l => l.filter(x => x.id !== it.id))
    clearTimeout(toastTimer.current)
    setToast({ msg: 'Deleted', undo: true })
    del.current = { it, timer: window.setTimeout(flush, 6000) }
  }
  const undo = () => {
    if (!del.current) return
    clearTimeout(del.current.timer); del.current = null; setToast(null); refresh(items.length + 1)
  }
  useEffect(() => { window.addEventListener('pagehide', flush); return () => window.removeEventListener('pagehide', flush) })

  const acts = useRef<Act>(null!)
  acts.current = {
    copy: it => api.copy(copyText(it)).then(() => say('Copied'), () => say('Could not copy')),
    reveal: it => api.reveal(it.content),
    del: remove,
    move: (it, p) => api.edit(it.id, { profile: p }).then(() => { say(`Moved to ${p}`); refresh(items.length); refreshProfiles() }),
    save: (it, content) => api.edit(it.id, { content }).then(() => { refresh(items.length) }, e => { say('Could not save'); throw e }),
    zoom: it => setDetail(it.id),
  }
  // one object for the life of the page that calls the latest handlers, so memoized rows don't re-render
  const act = useMemo(() => new Proxy({} as Act, { get: (_, k: keyof Act) => (...a: never[]) => (acts.current[k] as (...a: never[]) => void)(...a) }), [])
  const primary = (it: Item) => (it.kind === 'screenshot' ? setDetail(it.id) : it.kind === 'link' ? send({ type: 'openExternal', url: copyText(it) }) : act.copy(it))

  const clearFilters = () => { setQ(''); setKinds([]); setApp(''); setSince(''); setUntil(''); setSource(''); setAgent(''); setProject(''); setSession(null) }
  const go = (name: string) => {
    flush(); setView('list'); setScope(name); setApp(''); setAgent(''); setProject(''); setSession(null); setSel(-1); setConfirmDel(false); setRenaming(null)
  }
  const openSession = (a: Agent) => { go('*'); clearFilters(); setSession(a) }
  const names = useMemo(() => profiles.all.map(p => p.name).sort((a, b) => +(b === 'user') - +(a === 'user') || +(b === 'agent') - +(a === 'agent') || a.localeCompare(b)), [profiles])
  const order = [...names, '*']
  const count = (n: string) => (n === '*' ? profiles.all.reduce((s, p) => s + p.count, 0) : profiles.all.find(p => p.name === n)?.count ?? 0)
  const custom = scope !== '*' && scope !== 'user' && scope !== 'agent'
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
    const t = setTimeout(() => { refresh(); setSel(-1) }, 120)
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
      page(items.length).then(r => {
        setItems(l => [...l, ...r.filter(x => !l.some(y => y.id === x.id))]); setMore(r.length >= PAGE)
      }).finally(() => { busy.current = false })
    })
    io.observe(sentinel.current)
    return () => io.disconnect()
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // native bridge
  useEffect(() => {
    const open = (o: { query?: string }) => { setQ(o.query ?? ''); setDetail(null); setView('list'); searchRef.current?.focus(); refreshProfiles() }
    window.ummOpen = open
    if (pending.open) { open(pending.open); pending.open = undefined }
    return () => { window.ummOpen = undefined }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (detail !== null) return
      if (e.metaKey && e.key === ',') { e.preventDefault(); setView(v => (v === 'settings' ? 'list' : 'settings')); return }
      const t = e.target as HTMLElement
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
      const search = searchRef.current
      if (e.metaKey && /^[1-9]$/.test(e.key)) { if (order[+e.key - 1]) { e.preventDefault(); go(order[+e.key - 1]) } return }
      if (view !== 'list') return
      if (e.metaKey && e.key === 'k') { e.preventDefault(); search?.focus(); search?.select(); return }
      if (e.metaKey && e.key === 'n') { e.preventDefault(); composerRef.current?.focus(); return }
      if (typing) {
        if (t === search && e.key === 'Escape') { if (q) setQ(''); else t.blur() }
        else if (t === search && e.key === 'ArrowDown' && list.length) { e.preventDefault(); t.blur(); setSel(0) }
        else if (t === composerRef.current && e.key === 'Escape') t.blur()
        return
      }
      const it = list[sel]
      // Enter and Delete act on the selected row only when no button or link has focus
      const free = t === document.body || t === listRef.current
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setSel(s => Math.min(list.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setSel(s => (s <= 0 && q ? (search?.focus(), -1) : Math.max(0, s - 1))) }
      else if (e.key === 'Enter' && it && free) { e.preventDefault(); primary(it) }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && it && free) { e.preventDefault(); remove(it); setSel(s => Math.min(s, list.length - 2)) }
      else if (e.key === 'Escape') setSel(-1)
      else if (e.key === '/') { e.preventDefault(); search?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  // a note goes to the profile on screen, All profiles uses the active one
  const saveTo = scope && scope !== '*' ? scope : profiles.active
  const save = (text: string) => api.add(text, 'app', undefined, saveTo)
    .then(() => { say('Saved'); refresh(items.length + 1); refreshProfiles() }, e => { say('Could not save'); throw e })
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
  const detailIt = items.find(i => i.id === detail)
  const step = (d: number) => {
    const shots = items.filter(i => i.kind === 'screenshot')
    const n = shots[shots.findIndex(i => i.id === detail) + d]
    if (n) setDetail(n.id)
  }
  const grid = kinds.length === 1 && kinds[0] === 'screenshot'

  const agents = tally(origins, 'agent')
  const projects = tally(origins.filter(o => o.source === 'mcp'), 'cwd')
  const sources = tally(origins, 'source')
  const n = count(scope)
  const caption = filtered ? (list.length ? `${list.length}${more ? '+' : ''} ${list.length === 1 ? 'result' : 'results'}` : 'No results')
    : scope === 'agent' && agents.length
    ? `${plural(n, 'memory', 'memories')} from ${plural(agents.length, 'agent')} in ${plural(projects.length, 'project')}`
    : `${plural(n, 'memory', 'memories')}${scope === '*' ? ' across all profiles' : ''}`
  const nFilters = +!!app + +!!since + +!!until + +!!source + +!!(agent && scope !== 'agent') + +!!(project && scope !== 'agent')
  const sortLabel = { new: 'Newest first', old: 'Oldest first', relevance: 'Best match' }[sortNow]
  const chip = (on: boolean, set: () => void, label: React.ReactNode, n: number, key: string) =>
    <button key={key} className={'chip' + (on ? ' on' : '')} aria-pressed={on} onClick={set}>{label}<span className="n">{n}</span></button>
  const side = (v: View, ic: 'plug' | 'gear', label: string, extra: React.ReactNode) =>
    <button className={'prof' + (view === v ? ' on' : '')} onClick={() => { flush(); setView(view === v ? 'list' : v) }}>
      <Icon name={ic} /><span className="name">{label}</span>{extra}
    </button>

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img src={icon} alt="" />
          <span className="word">umm</span><span className="dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <nav>
          {names.map((p, i) => (
            <button key={p} className={'prof' + (scope === p && view === 'list' ? ' on' : '')} onClick={() => go(p)}
              title={(p === profiles.active ? 'New saves land here. ' : '') + (i < 9 ? `Cmd ${i + 1}` : '')}>
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
          {side('connections', 'plug', 'Connections', live > 0 && <span className="n"><i className="livedot" />{live}</span>)}
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
                : <h1>{scope === '*' ? 'All profiles' : scope}</h1>}
              {custom && renaming === null && (
                <Pop trigger={t => <button className="icon" onClick={t} title="Profile options" aria-label="Profile options"><Icon name="more" /></button>}>
                  {close => <div className="menu">
                    <button onClick={() => { close(); setRenaming(scope) }}>Rename</button>
                    <button className="danger" onClick={() => { close(); setConfirmDel(true) }}>Delete profile</button>
                  </div>}
                </Pop>
              )}
            </div>
            {confirmDel
              ? <p>Delete {scope} and its {plural(n, 'item')}? <button className="link-btn danger" onClick={() => api.delProfile(scope).then(() => { go('user'); refreshProfiles() }, () => say('Could not delete'))}>Delete</button> <button className="link-btn" onClick={() => setConfirmDel(false)}>Keep</button></p>
              : <p>{caption}</p>}
          </div>
          <label className="search">
            <Icon name="search" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search" aria-label="Search" spellCheck={false} />
            {q ? <button className="clear" onClick={() => setQ('')} aria-label="Clear search"><Icon name="x" /></button> : <Kbd>Cmd K</Kbd>}
          </label>
          <button className={'rec' + (rec.on ? ' on' : '')} onClick={toggleRec} title={rec.on ? 'Stop recording' : 'Record your voice'}>
            {rec.on ? <><i className="recdot" />{clock(rec.seconds)}</> : rec.transcribing ? <><Icon name="voice" />Transcribing</> : <><Icon name="voice" />Record</>}
          </button>
        </header>

        <Composer to={saveTo} onSave={save} box={composerRef} />

        <div className="tabs">
          <div className="kinds" role="tablist">
            {([[null, 'All'], ...KINDS] as [Kind | null, string][]).map(([k, label]) => {
              const on = k ? kinds[0] === k : !kinds.length
              return <button key={label} role="tab" aria-selected={on} className={'tab' + (on ? ' on' : '')} onClick={() => setKinds(k ? [k] : [])}>{label}</button>
            })}
          </div>
          <span className="gap" />
          <label className="sortpick">{sortLabel}<Icon name="caret" />
            <select value={sortNow} onChange={e => setSort(e.target.value)} aria-label="Sort">
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="relevance" disabled={!q.trim()}>Best match</option>
            </select>
          </label>
          <Pop trigger={t => <button className={'tab filter' + (nFilters ? ' on' : '')} onClick={t}><Icon name="filter" />Filter{nFilters ? <span className="n">{nFilters}</span> : null}</button>}>
            {() => <div className="fields">
              <label>App
                <select value={app} onChange={e => setApp(e.target.value)}>
                  <option value="">Any app</option>
                  {apps.map(a => <option key={a.app} value={a.app}>{a.app} ({a.count})</option>)}
                </select>
              </label>
              {sources.length > 1 && <label>Saved from
                <select value={source} onChange={e => setSource(e.target.value)}>
                  <option value="">Anywhere</option>
                  {sources.map(([s, c]) => <option key={s} value={s}>{SOURCES[s]?.[1] ?? s} ({c})</option>)}
                </select>
              </label>}
              {agents.length > 0 && scope !== 'agent' && <label>Agent
                <select value={agent} onChange={e => setAgent(e.target.value)}>
                  <option value="">Any agent</option>
                  {agents.map(([a, c]) => <option key={a} value={a}>{a} ({c})</option>)}
                </select>
              </label>}
              {projects.length > 0 && scope !== 'agent' && <label>Project
                <select value={project} onChange={e => setProject(e.target.value)}>
                  <option value="">Any project</option>
                  {projects.map(([p, c]) => <option key={p} value={p}>{projectName(p)} ({c})</option>)}
                </select>
              </label>}
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
            {agents.length > 1 && <i className="sep" />}
            {projects.map(([p, c]) => chip(project === p, () => setProject(project === p ? '' : p), <><Icon name="path" /><span title={p}>{projectName(p)}</span></>, c, p))}
          </div>
        )}
        {(nFilters > 0 || session) && (
          <div className="active">
            {session && <button className="tag" onClick={() => setSession(null)}><AppIcon name={session.agent} />{session.agent} session in {projectName(session.cwd)}<Icon name="x" /></button>}
            {app && <button className="tag" onClick={() => setApp('')}><AppIcon name={app} />{app}<Icon name="x" /></button>}
            {source && <button className="tag" onClick={() => setSource('')}>From {SOURCES[source]?.[1].toLowerCase() ?? source}<Icon name="x" /></button>}
            {agent && scope !== 'agent' && <button className="tag" onClick={() => setAgent('')}><AppIcon name={agent} />{agent}<Icon name="x" /></button>}
            {project && scope !== 'agent' && <button className="tag" onClick={() => setProject('')}>{projectName(project)}<Icon name="x" /></button>}
            {since && <button className="tag" onClick={() => setSince('')}>From {day(since)}<Icon name="x" /></button>}
            {until && <button className="tag" onClick={() => setUntil('')}>Until {day(until)}<Icon name="x" /></button>}
            <button className="link-btn" onClick={clearFilters}>Clear all</button>
          </div>
        )}

        <div className="scroll">
          {!loaded && !failed && <ul className="list skel" aria-hidden="true">{[0, 1, 2, 3].map(i => <li key={i} className="row"><span className="gut"><i /></span><div className="body"><i /></div></li>)}</ul>}
          {failed ? (
            <div className="empty">
              <img src={icon} alt="" />
              <h2>Cannot reach the umm backend</h2>
              <p>Your memories are safe on disk. The app restarts the backend on its own, and this page tries again every 2 seconds.</p>
              <div><button className="btn" onClick={() => { refreshProfiles(); if (scope) refresh() }}>Retry now</button></div>
            </div>
          ) : list.length > 0 ? (
            <ul ref={listRef} className={'list' + (grid ? ' grid' : '')} role="listbox" tabIndex={0} aria-label="Memories"
              aria-activedescendant={list[sel] ? 'm' + list[sel].id : undefined} onFocus={e => e.target === e.currentTarget && sel < 0 && setSel(0)}>
              {list.map((it, i) => (
                <Row key={it.id} it={it} i={i} q={q} sel={i === sel} all={scope === '*'} profiles={names} act={act} onSelect={setSel} />
              ))}
            </ul>
          ) : loaded && (
            <div className="empty">
              <img src={icon} alt="" />
              <h2>{filtered ? 'Nothing matches' : 'Nothing here yet'}</h2>
              <p>{filtered ? 'Try fewer words or remove a filter.' : EMPTY[scope] ?? 'Write something in the box above, or press Ctrl+Shift+Space anywhere.'}</p>
              {filtered && <div>
                {scope !== '*' && <button className="btn" onClick={() => go('*')}>Search all profiles</button>}
                <button className="btn" onClick={clearFilters}>Clear filters</button>
              </div>}
            </div>
          )}
          {more && <div ref={sentinel} className="more-sentinel">Loading more</div>}
        </div>
        {toast && <div className="toast" role="status">{toast.msg}{toast.undo && <button onClick={undo}>Undo</button>}</div>}
      </main>}
      {detailIt && <Detail it={detailIt} act={act} onClose={() => setDetail(null)} step={step} />}
    </div>
  )
}
