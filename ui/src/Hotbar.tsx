import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, fileUrl, type Ctx, type Item, type Profiles } from './api'
import { native, pending, send } from './bridge'
import { appName, copyText, linkLabel } from './Memory'
import { AppIcon, Dot, Icon, Kbd, ago, clock, hl, type IconName } from './ui'
import icon from '../../assets/icon.svg'
import './hotbar.css'

type Row = { id: string; icon: IconName | 'dot'; label: string; keys?: string; detail?: ReactNode; run: () => void }
type Mode = 'menu' | 'note' | 'profiles'

// first n characters, without cutting an emoji in half
const chars = (s: string, n: number) => [...s].slice(0, n).join('')

export default function Hotbar() {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [mode, setMode] = useState<Mode>('menu')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(-1)
  const [note, setNote] = useState('')
  const [mems, setMems] = useState<Item[]>([])
  const [profiles, setProfiles] = useState<Profiles>({ active: '', all: [] })
  const [rec, setRec] = useState(ctx?.recording ?? { on: false, seconds: 0, transcribing: 0 })
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const [shown, setShown] = useState(0)
  const [armed, setArmed] = useState(false)

  // Swift calls ummShow with a fresh context every time the hotbar opens.
  useEffect(() => {
    // Swift sends {} when the context fetch fails, so every field gets a default. A half-written note survives a reopen.
    const show = (raw: Partial<Ctx>) => {
      const c: Ctx = { app: '', profile: '', clipboard: '', clipboard_kind: null, recording: { on: false, seconds: 0, transcribing: 0 }, ...raw }
      setCtx(c); setRec(c.recording); setMode('menu'); setQ(''); setSel(-1); setArmed(false); setMems([]); setShown(n => n + 1)
    }
    window.ummShow = show
    if (pending.show) { show(pending.show); pending.show = undefined }
    else if (!native) api.context().then(show, () => {})
    return () => { window.ummShow = undefined }
  }, [])
  useEffect(() => { (mode === 'note' ? area : input).current?.focus() }, [shown, mode])

  // report height to the native panel
  useEffect(() => {
    const el = root.current!
    const ro = new ResizeObserver(() => send({ type: 'resize', height: Math.ceil(el.getBoundingClientRect().height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!rec.on) return
    const t = setInterval(() => api.record().then(setRec, () => {}), 1000)
    return () => clearInterval(t)
  }, [rec.on])

  const query = q.trim().toLowerCase()
  useEffect(() => {
    if (mode !== 'menu' || !query) { setMems([]); return }
    let stale = false
    const t = setTimeout(() => api.items({ q, profile: '*', limit: 6 }).then(r => { if (!stale) setMems(r) }, () => {}), 120)
    return () => { stale = true; clearTimeout(t) }
  }, [q, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const fail = () => send({ type: 'error' })
  const clip = ctx?.clipboard.trim() ?? ''
  const kind = ctx?.clipboard_kind
  const nfiles = kind === 'files' ? clip.split('\n').length : 0
  const active = ctx?.profile ?? ''

  const menu: (Row & { kw: string })[] = [
    { id: 'shot', icon: 'screenshot', label: 'Take a screenshot', kw: 'capture screen', run: () => send({ type: 'capture' }) },
    { id: 'area', icon: 'area', label: 'Screenshot an area', kw: 'capture screen region select', run: () => send({ type: 'area' }) },
    ...(kind ? [{ id: 'clip', icon: kind === 'image' ? 'screenshot' as const : kind === 'files' ? 'files' as const : 'clip' as const, kw: 'paste copy',
      label: kind === 'image' ? 'Save clipboard image' : kind === 'files' ? `Save ${nfiles} copied file${nfiles > 1 ? 's' : ''}` : 'Save clipboard',
      detail: kind === 'image' ? null : <span className="peek">{chars(clip.replace(/\s+/g, ' '), 70)}</span>,
      run: () => { api.saveClipboard(ctx?.app, 'hotbar', undefined, ctx?.url).then(() => send({ type: 'saved' }), fail) } }] : []),
    { id: 'note', icon: 'text', label: 'Write a note', kw: 'text type', detail: note.trim() ? <span className="peek">{chars(note.trim(), 40)}</span> : null, run: () => setMode('note') },
    { id: 'rec', icon: 'voice', label: rec.on ? 'Stop recording' : 'Start recording', kw: 'voice mic audio',
      detail: rec.on ? <span className="live"><i className="recdot" />{clock(rec.seconds)}</span> : rec.transcribing ? <span className="peek">transcribing</span> : null,
      run: () => (rec.on ? api.recStop() : api.recStart('hotbar', ctx?.app)).then(r => { setRec(r); send({ type: 'recording', on: r.on }); send({ type: 'hide' }) }, fail) },
    { id: 'find', icon: 'search', label: query ? `Search umm for "${q.trim()}"` : 'Search memories', kw: query, detail: query ? null : <span className="peek">just start typing</span>,
      run: () => (query ? send({ type: 'openMain', query: q.trim() }) : input.current?.focus()) },
    { id: 'prof', icon: 'user', label: 'Switch profile', kw: 'profiles user agent', detail: <span className="peek"><Dot name={active} />{active}</span>,
      run: () => { api.profiles().then(setProfiles); setMode('profiles'); setQ(''); setSel(-1) } },
    { id: 'open', icon: 'open', label: 'Open umm', kw: 'main window', run: () => send({ type: 'openMain' }) },
    { id: 'quit', icon: 'quit', label: armed ? 'Recording is on. Enter again to quit' : 'Quit umm', kw: 'exit kill',
      run: () => (rec.on && !armed ? setArmed(true) : send({ type: 'quit' })) },
  ]
  const match = (s: string) => query.split(/\s+/).every(w => s.toLowerCase().includes(w))
  const pick = (name: string) => api.setProfile(name).then(() => { setCtx(c => c && { ...c, profile: name }); setMode('menu'); setQ('') }, fail)
  const profRows: Row[] = [
    ...profiles.all.filter(p => match(p.name)).map(p => ({ id: p.name, icon: 'dot' as const, label: p.name, detail: <span className="peek">{p.name === active ? 'active, ' : ''}{p.count}</span>, run: () => pick(p.name) })),
    ...(query && !profiles.all.some(p => p.name === q.trim()) ? [{ id: '+', icon: 'dot' as const, label: `Create "${q.trim()}"`, run: () => pick(q.trim()) }] : []),
  ]
  // the generic search row goes last while typing, so a specific match wins Enter
  const hits = menu.filter(r => !query || r.id === 'find' || match(r.label + ' ' + r.kw))
  const rows: Row[] = mode === 'profiles' ? profRows : query ? [...hits.filter(r => r.id !== 'find'), ...hits.filter(r => r.id === 'find')] : hits
  const memRows = mode === 'menu' ? mems : []
  const total = rows.length + memRows.length
  // Before any arrow key, a typed query picks a row only when it starts that row's label, else the first memory, else search.
  // So "exit" or "mic" plus Enter searches instead of quitting or recording.
  const prefix = rows.findIndex(r => r.label.toLowerCase().startsWith(query))
  const at = sel >= 0 ? Math.min(sel, Math.max(0, total - 1))
    : !query || mode === 'profiles' ? 0 : prefix >= 0 ? prefix : memRows.length ? rows.length : rows.findIndex(r => r.id === 'find')
  useEffect(() => { root.current?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }) }, [at])

  const run = (i: number) => {
    if (i < rows.length) return rows[i].run()
    const m = memRows[i - rows.length]
    if (m) api.copy(copyText(m)).then(() => send({ type: 'hide' }), fail)
  }
  const saveNote = () => {
    if (note.trim()) api.add(note.trim(), 'hotbar', ctx?.app, undefined, ctx?.url).then(() => { setNote(''); send({ type: 'saved' }) }, fail)
  }
  const back = () => { setMode('menu'); setQ(''); setSel(-1) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return  // Enter confirms an input method's text, it must not run a row
    if (mode === 'note') {
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); saveNote() }
      else if (e.key === 'Escape') { e.preventDefault(); back() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(total - 1, at + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, at - 1)) }
    else if (e.key === 'Enter' && !e.metaKey) { e.preventDefault(); run(at) }
    else if (e.key === 'Escape') { e.preventDefault(); if (mode === 'profiles') back(); else if (q) { setQ(''); setSel(-1) } else send({ type: 'hide' }) }
  }

  const tile = (r: Row) => <span className="tile">{r.icon === 'dot' ? <Dot name={r.label} /> : <Icon name={r.icon} />}</span>
  const foot = (
    <footer>
      <span className="fprof" title="Active profile: new saves land here"><Dot name={active || 'user'} />{active}</span>
      <span className="hint">{mode === 'note' ? <><Kbd>Cmd Enter</Kbd> save <Kbd>Esc</Kbd> back</> : <><Kbd>Enter</Kbd> run <Kbd>Esc</Kbd> {q || mode === 'profiles' ? 'back' : 'close'}</>}</span>
    </footer>
  )

  return (
    <div className="bar" ref={root} onKeyDown={onKey}>
      {mode === 'note' ? (
        <div className="note">
          <textarea ref={area} value={note} onChange={e => setNote(e.target.value)} rows={5} placeholder="Write it down. Enter makes a new line." spellCheck />
          {ctx?.app && <p className="nfrom">From {ctx.app.slice(0, 70)}</p>}
        </div>
      ) : (
        <>
          <div className="ask">
            <img className="logo" src={icon} alt="" />
            <input ref={input} value={q} onChange={e => { setQ(e.target.value); setSel(-1); setArmed(false) }} spellCheck={false} autoFocus
              role="combobox" aria-expanded aria-controls="hrows" aria-activedescendant={total ? 'h' + at : undefined}
              placeholder={mode === 'profiles' ? 'Pick a profile, or type a new name' : 'umm... what do you want to keep or find?'} />
          </div>
          <ul className={'rows' + (mode === 'profiles' ? ' capped' : '')} id="hrows" role="listbox">
            {rows.map((r, i) => (
              <li key={r.id} id={'h' + i} role="option" aria-selected={i === at} className={(i === at ? 'on' : '') + (!query && mode === 'menu' && (r.id === 'rec' || r.id === 'prof') ? ' split' : '')}
                onMouseMove={() => setSel(i)} onClick={() => run(i)}>
                {tile(r)}
                <span className="label">{r.label}</span>
                {r.detail}
              </li>
            ))}
            {!rows.length && <li className="none">No profile matches</li>}
          </ul>
          {memRows.length > 0 && (
            <ul className="mems" role="listbox">
              {memRows.map((m, j) => {
                const i = rows.length + j
                return (
                  <li key={m.id} id={'h' + i} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseMove={() => setSel(i)} onClick={() => run(i)}>
                    <span className="tile">{m.meta?.icon ? <img className="fav" src={fileUrl(m.meta.icon)} alt="" /> : m.app ? <AppIcon name={appName(m.app)} /> : <Icon name={m.kind} />}</span>
                    <span className="label">{hl(chars(linkLabel(m) || m.content.slice(0, 400).replace(/\s+/g, ' '), 120), q)}</span>
                    {m.profile !== active && <span className="peek"><Dot name={m.profile} />{m.profile}</span>}
                    <span className="peek">{ago(m.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
      {foot}
    </div>
  )
}
