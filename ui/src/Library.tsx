import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { api, type Item, type Kind, type Profiles, type Rec } from './api'
import { pending, send } from './bridge'
import { Detail, Row, copyText, type Act } from './Memory'
import { Dot, Kbd, clock } from './ui'
import icon from '../../assets/icon.svg'
import './main.css'

const PAGE = 40
const KINDS: [Kind, string][] = [['screenshot', 'Screenshots'], ['text', 'Notes'], ['path', 'Paths'], ['link', 'Links'], ['voice', 'Voice']]
const SUB: Record<string, string> = {
  user: 'What you saved.', agent: 'What Claude and other agents remembered.', '*': 'Everything, from every profile.',
}
const EMPTY: Record<string, string> = {
  user: 'Press Ctrl+Shift+Space, then Enter, to keep what is on your screen. Or write something above.',
  agent: 'Ask Claude to remember something and it shows up here.',
}

function Chip({ label, value, clear, children }: { label: string; value: string; clear: () => void; children: ReactNode }) {
  return (
    <span className={'chip pick' + (value ? ' on' : '')}>
      <span>{value ? `${label}: ${value}` : label}</span>{children}
      {value && <button className="x" onClick={clear} aria-label={`Remove ${label} filter`}>x</button>}
    </span>
  )
}

export default function Library() {
  const [profiles, setProfiles] = useState<Profiles>({ active: 'user', all: [] })
  const [scope, setScope] = useState('')
  const [q, setQ] = useState('')
  const [kinds, setKinds] = useState<Kind[]>([])
  const [app, setApp] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [sort, setSort] = useState('')
  const [apps, setApps] = useState<{ app: string; count: number }[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [rec, setRec] = useState<Rec>({ on: false, seconds: 0, transcribing: 0 })
  const [sel, setSel] = useState(-1)
  const [detail, setDetail] = useState<number | null>(null)
  const [toast, setToast] = useState<{ msg: string; undo?: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [, tick] = useReducer(x => x + 1, 0)
  const searchRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const busy = useRef(false)
  const toastTimer = useRef(0)
  const del = useRef<{ it: Item; timer: number } | null>(null)

  const sortNow = sort === 'relevance' && !q.trim() ? 'new' : sort || (q.trim() ? 'relevance' : 'new')
  const page = (offset: number, limit = PAGE) => api.items({
    q: q.trim(), profile: scope, kind: kinds.join(','), app, since, until, sort: sortNow, limit, offset,
  })
  const refresh = (limit = PAGE) => {
    const n = ++seq.current
    return page(0, Math.min(200, limit)).then(r => {
      if (n !== seq.current) return
      setItems(r); setMore(r.length >= limit); setLoaded(true)
    }, () => setLoaded(true))
  }
  const refreshProfiles = () => api.profiles().then(p => { setProfiles(p); setScope(s => (s === '*' ? s : p.active)) }, () => {})
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

  const act: Act = {
    copy: it => api.copy(copyText(it)).then(() => say('Copied'), () => say('Could not copy')),
    reveal: it => api.reveal(it.content),
    del: remove,
    move: (it, p) => api.edit(it.id, { profile: p }).then(() => { say(`Moved to ${p}`); refresh(items.length); refreshProfiles() }),
    save: (it, content) => api.edit(it.id, { content }).then(() => refresh(items.length), () => say('Could not save')),
    zoom: it => setDetail(it.id),
  }
  const primary = (it: Item) => (it.kind === 'screenshot' ? setDetail(it.id) : it.kind === 'link' ? send({ type: 'openExternal', url: copyText(it) }) : act.copy(it))

  const go = (name: string) => {
    flush(); setScope(name); setApp(''); setSel(-1); setConfirmDel(false); setRenaming(null)
    if (name !== '*') api.setProfile(name).then(refreshProfiles)
  }
  const names = [...profiles.all.map(p => p.name)].sort((a, b) => +(b === 'user') - +(a === 'user') || +(b === 'agent') - +(a === 'agent') || a.localeCompare(b))
  const order = [...names, '*']
  const count = (n: string) => (n === '*' ? profiles.all.reduce((s, p) => s + p.count, 0) : profiles.all.find(p => p.name === n)?.count ?? 0)
  const custom = scope !== '*' && scope !== 'user' && scope !== 'agent'
  const filtered = !!(q.trim() || kinds.length || app || since || until)
  const clearFilters = () => { setQ(''); setKinds([]); setApp(''); setSince(''); setUntil('') }

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
  }, [scope, q, kinds, app, since, until, sort]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (scope) api.apps(scope).then(setApps, () => setApps([])) }, [scope, items.length > 0])
  useEffect(() => { const t = setInterval(tick, 30000); return () => clearInterval(t) }, [])

  // recording: poll only while it matters, and pick up the voice item when transcribing ends
  const wasBusy = useRef(0)
  useEffect(() => {
    if (wasBusy.current && !rec.transcribing) { refresh(Math.max(items.length, PAGE)); refreshProfiles() }
    wasBusy.current = rec.transcribing
    if (!rec.on && !rec.transcribing) return
    const t = setInterval(() => api.record().then(setRec, () => {}), 1000)
    return () => clearInterval(t)
  }, [rec.on, rec.transcribing]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleRec = () => (rec.on ? api.recStop() : api.recStart()).then(r => { setRec(r); send({ type: 'recording', on: r.on }) }, () => say('Could not use the microphone'))

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
    const open = (o: { query?: string }) => { setQ(o.query ?? ''); setDetail(null); searchRef.current?.focus(); refreshProfiles() }
    window.ummOpen = open
    if (pending.open) { open(pending.open); pending.open = undefined }
    return () => { window.ummOpen = undefined }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (detail !== null) return
      const t = e.target as HTMLElement
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
      const search = searchRef.current
      if (e.metaKey && e.key === 'k') { e.preventDefault(); search?.focus(); search?.select(); return }
      if (e.metaKey && e.key === 'n') { e.preventDefault(); composerRef.current?.focus(); return }
      if (e.metaKey && /^[1-9]$/.test(e.key)) { if (order[+e.key - 1]) { e.preventDefault(); go(order[+e.key - 1]) } return }
      if (typing) {
        if (t === search && e.key === 'Escape') { if (q) setQ(''); else t.blur() }
        else if (t === search && e.key === 'ArrowDown' && items.length) { e.preventDefault(); t.blur(); setSel(0) }
        else if (t === composerRef.current && e.key === 'Escape') t.blur()
        return
      }
      const it = items[sel]
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setSel(s => (s <= 0 && q ? (search?.focus(), -1) : Math.max(0, s - 1))) }
      else if (e.key === 'Enter' && it && t.tagName !== 'BUTTON' && t.tagName !== 'A') { e.preventDefault(); primary(it) }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && it) { e.preventDefault(); remove(it); setSel(s => Math.min(s, items.length - 2)) }
      else if (e.key === 'Escape') setSel(-1)
      else if (e.key === '/') { e.preventDefault(); search?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 220) + 'px' }
  useEffect(() => { if (!draft && composerRef.current) composerRef.current.style.height = '' }, [draft])
  const save = () => {
    if (!draft.trim()) return
    api.add(draft.trim()).then(() => { setDraft(''); say('Saved'); refresh(items.length + 1); refreshProfiles() }, () => say('Could not save'))
  }
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

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img src={icon} alt="" />
          <div><span className="word">umm</span><span className="dots" aria-hidden="true"><i /><i /><i /></span><small>u might miss</small></div>
        </div>
        <nav>
          {names.map(n => (
            <button key={n} className={'prof' + (scope === n ? ' on' : '')} onClick={() => go(n)} title={n === profiles.active ? 'New saves land here' : undefined}>
              <Dot name={n} /><span className="name">{n}</span>{n === profiles.active && <em>saves here</em>}<span className="n">{count(n)}</span>
            </button>
          ))}
          <button className={'prof all' + (scope === '*' ? ' on' : '')} onClick={() => go('*')}>
            <span className="name">All profiles</span><span className="n">{count('*')}</span>
          </button>
          {creating
            ? <input className="newprof" autoFocus placeholder="Profile name" onBlur={e => create(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur() } }} />
            : <button className="prof add" onClick={() => setCreating(true)}>New profile</button>}
        </nav>
        <dl className="keys">
          <dt><Kbd>Cmd</Kbd><Kbd>K</Kbd></dt><dd>Search</dd>
          <dt><Kbd>Cmd</Kbd><Kbd>1-9</Kbd></dt><dd>Profile</dd>
          <dt><Kbd>Up</Kbd><Kbd>Down</Kbd></dt><dd>Move</dd>
          <dt><Kbd>Enter</Kbd></dt><dd>Copy or open</dd>
          <dt><Kbd>Del</Kbd></dt><dd>Delete</dd>
        </dl>
      </aside>

      <main className={scope === 'agent' ? 'agent' : ''}>
        <header className="top">
          <div className="title">
            {renaming !== null
              ? <input className="rename" autoFocus defaultValue={scope} onBlur={e => rename(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = scope; e.currentTarget.blur() } }} />
              : <h1>{scope === '*' ? 'All profiles' : scope}</h1>}
            {confirmDel
              ? <p>Delete {scope} and its {count(scope)} items? <button className="btn danger" onClick={() => api.delProfile(scope).then(() => { go('user'); refreshProfiles() }, () => say('Could not delete'))}>Delete profile</button> <button className="btn" onClick={() => setConfirmDel(false)}>Keep</button></p>
              : <p>{SUB[scope] ?? 'Your own profile.'}{custom && <> <button className="btn" onClick={() => setRenaming(scope)}>Rename</button> <button className="btn" onClick={() => setConfirmDel(true)}>Delete</button></>}</p>}
          </div>
          <label className="search">
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search everything you saved" aria-label="Search" spellCheck={false} />
            <Kbd>Cmd K</Kbd>
          </label>
          <button className={'rec' + (rec.on ? ' on' : '')} onClick={toggleRec} title={rec.on ? 'Stop recording' : 'Record your voice'}>
            <i className="recdot" />{rec.on ? `Stop ${clock(rec.seconds)}` : 'Record'}
          </button>
        </header>

        <div className={'composer' + (draft ? ' has' : '')}>
          <textarea ref={composerRef} rows={1} value={draft} onChange={e => { setDraft(e.target.value); grow(e.currentTarget) }}
            placeholder="Something you might miss later. Type a thought, paste a link or a folder path."
            onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); save() } }} />
          <div className="cbar">
            <span className="dim">Saving to <Dot name={profiles.active} />{profiles.active}</span>
            <button className="btn primary" disabled={!draft.trim()} onClick={save}>Save <Kbd>Cmd Enter</Kbd></button>
          </div>
        </div>

        <div className="filters">
          {KINDS.map(([k, label]) => (
            <button key={k} className={'chip' + (kinds.includes(k) ? ' on' : '')} aria-pressed={kinds.includes(k)}
              onClick={() => setKinds(l => (l.includes(k) ? l.filter(x => x !== k) : [...l, k]))}>{label}</button>
          ))}
          <span className="gap" />
          <Chip label="App" value={app} clear={() => setApp('')}>
            <select value={app} onChange={e => setApp(e.target.value)} aria-label="Filter by app">
              <option value="">Any app</option>
              {apps.map(a => <option key={a.app} value={a.app}>{a.app} ({a.count})</option>)}
            </select>
          </Chip>
          <Chip label="From" value={since} clear={() => setSince('')}>
            <input type="date" value={since} max={until || undefined} onChange={e => setSince(e.target.value)} onClick={e => e.currentTarget.showPicker?.()} aria-label="From date" />
          </Chip>
          <Chip label="Until" value={until} clear={() => setUntil('')}>
            <input type="date" value={until} min={since || undefined} onChange={e => setUntil(e.target.value)} onClick={e => e.currentTarget.showPicker?.()} aria-label="Until date" />
          </Chip>
          <select className="sort" value={sortNow} onChange={e => setSort(e.target.value)} aria-label="Sort">
            <option value="new">Newest first</option>
            <option value="old">Oldest first</option>
            <option value="relevance" disabled={!q.trim()}>Best match</option>
          </select>
          {filtered && <button className="chip clear" onClick={clearFilters}>Clear all</button>}
        </div>

        <div className="scroll">
          {items.length > 0 && (
            <ul className={'list' + (grid ? ' grid' : '')}>
              {items.map((it, i) => (
                <Row key={it.id} it={it} q={q} sel={i === sel} all={scope === '*'} profiles={names} act={act} onSelect={() => setSel(i)} />
              ))}
            </ul>
          )}
          {loaded && !items.length && (
            <div className="empty">
              <h2>{filtered ? 'Nothing matches' : 'Nothing here yet'}</h2>
              <p>{filtered ? 'Try fewer words or remove a filter.' : EMPTY[scope] ?? 'Write something in the box above, or press Ctrl+Shift+Space anywhere.'}</p>
              {filtered && <button className="btn" onClick={clearFilters}>Clear all</button>}
              {filtered && scope !== '*' && <button className="btn" onClick={() => go('*')}>Search all profiles</button>}
            </div>
          )}
          {more && <div ref={sentinel} className="more-sentinel">Loading more</div>}
        </div>
        {toast && <div className="toast" role="status">{toast.msg}{toast.undo && <button onClick={undo}>Undo</button>}</div>}
      </main>
      {detailIt && <Detail it={detailIt} act={act} onClose={() => setDetail(null)} step={step} />}
    </div>
  )
}
