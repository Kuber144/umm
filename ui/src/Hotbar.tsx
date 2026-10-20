import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Ctx, type Item, type Profiles } from './api'
import { native, pending, send } from './bridge'
import { copyText } from './Memory'
import { Dot, Icon, Kbd, ago, clock, hl, type IconName } from './ui'
import icon from '../../assets/icon.svg'
import './hotbar.css'

type Row = { id: string; icon: IconName | 'dot'; label: string; keys?: string; detail?: ReactNode; run: () => void }
type Mode = 'menu' | 'note' | 'profiles'

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

  // Swift calls ummShow with a fresh context every time the hotbar opens.
  useEffect(() => {
    const show = (c: Ctx) => { setCtx(c); setRec(c.recording); setMode('menu'); setQ(''); setSel(-1); setNote(''); setMems([]); setShown(n => n + 1) }
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
  const active = ctx?.profile ?? ''

  const menu: (Row & { kw: string })[] = [
    { id: 'shot', icon: 'screenshot', label: 'Take a screenshot', kw: 'capture screen', run: () => send({ type: 'capture' }) },
    { id: 'area', icon: 'screenshot', label: 'Screenshot an area', kw: 'capture screen region select', run: () => send({ type: 'area' }) },
    ...(clip ? [{ id: 'clip', icon: 'clip' as const, label: 'Save clipboard', kw: 'paste copy',
      detail: <span className="peek">{clip.replace(/\s+/g, ' ').slice(0, 70)}</span>,
      run: () => { api.add(clip, ctx?.app).then(() => send({ type: 'saved' }), fail) } }] : []),
    { id: 'note', icon: 'text', label: 'Write a note', kw: 'text type', run: () => setMode('note') },
    { id: 'rec', icon: 'voice', label: rec.on ? 'Stop recording' : 'Start recording', kw: 'voice mic audio',
      detail: rec.on ? <span className="live"><i className="recdot" />{clock(rec.seconds)}</span> : rec.transcribing ? <span className="peek">transcribing</span> : null,
      run: () => (rec.on ? api.recStop() : api.recStart(ctx?.app)).then(r => { setRec(r); send({ type: 'recording', on: r.on }); send({ type: 'hide' }) }, fail) },
    { id: 'find', icon: 'search', label: query ? `Search umm for "${q.trim()}"` : 'Search memories', kw: query, detail: query ? null : <span className="peek">just start typing</span>,
      run: () => (query ? send({ type: 'openMain', query: q.trim() }) : input.current?.focus()) },
    { id: 'prof', icon: 'user', label: 'Switch profile', kw: 'profiles user agent', detail: <span className="peek"><Dot name={active} />{active}</span>,
      run: () => { api.profiles().then(setProfiles); setMode('profiles'); setQ(''); setSel(-1) } },
    { id: 'open', icon: 'open', label: 'Open umm', kw: 'main window', run: () => send({ type: 'openMain' }) },
    { id: 'quit', icon: 'quit', label: 'Quit umm', kw: 'exit kill', run: () => send({ type: 'quit' }) },
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
  // before any arrow key: the first specific row, else the first memory, else the search row
  const at = sel < 0 ? (rows[0]?.id === 'find' && memRows.length ? rows.length : 0) : Math.min(sel, Math.max(0, total - 1))

  const run = (i: number) => {
    if (i < rows.length) return rows[i].run()
    const m = memRows[i - rows.length]
    if (m) api.copy(copyText(m)).then(() => send({ type: 'hide' }), fail)
  }
  const saveNote = () => {
    if (note.trim()) api.add(note.trim(), ctx?.app).then(() => send({ type: 'saved' }), fail)
  }
  const back = () => { setMode('menu'); setQ(''); setSel(-1) }

  const onKey = (e: React.KeyboardEvent) => {
    if (mode === 'note') {
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); saveNote() }
      else if (e.key === 'Escape') { e.preventDefault(); back() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((at + 1) % Math.max(1, total)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((at + total - 1) % Math.max(1, total)) }
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
            <input ref={input} value={q} onChange={e => { setQ(e.target.value); setSel(-1) }} spellCheck={false} autoFocus
              placeholder={mode === 'profiles' ? 'Pick a profile, or type a new name' : 'umm... what do you want to keep or find?'} />
          </div>
          <ul className="rows" role="listbox">
            {rows.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === at} className={(i === at ? 'on' : '') + (!query && mode === 'menu' && (r.id === 'rec' || r.id === 'prof') ? ' split' : '')}
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
                  <li key={m.id} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseMove={() => setSel(i)} onClick={() => run(i)}>
                    <span className="tile"><Icon name={m.kind === 'text' ? 'text' : m.kind} /></span>
                    <span className="label">{hl(m.content.replace(/\s+/g, ' ').slice(0, 120), q)}</span>
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
