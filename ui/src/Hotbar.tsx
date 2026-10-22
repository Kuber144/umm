import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, fileUrl, type Ctx, type Item, type Profiles, type Rec } from './api'
import { native, pending, send } from './bridge'
import { KINDS } from './Library'
import { Body, appName, copyText, linkLabel } from './Memory'
import { AppIcon, Dot, Icon, Kbd, ago, clock, hl, type IconName } from './ui'
import icon from '../../assets/icon.svg'
import './hotbar.css'

type Row = { id: string; icon: IconName | 'dot'; label: string; keys?: string; detail?: ReactNode; run: () => void; edit?: () => void; save?: () => void; thumb?: string; full?: ReactNode; app?: string; info?: string }
type Mode = 'menu' | 'note' | 'profiles' | 'clip' | 'search'
// what a note does on Cmd+Enter: header, footer hint
const THEN = { save: ['', 'save'], shot: ['Then takes a screenshot', 'screenshot'], rec: ['Then starts recording', 'record'], clip: ['Edit, then save', 'save'] }
const flat = (s: string) => [...s.trim().replace(/\s+/g, ' ')].slice(0, 70).join('')

// first n characters, without cutting an emoji in half
const chars = (s: string, n: number) => [...s].slice(0, n).join('')
const CLIPS = [['text', 'Text'], ['image', 'Images'], ['link', 'Links'], ['file', 'Files']]
type Copy = { text?: string; image?: string; files?: string[]; at: string; app?: string }  // a copied image file has a preview image
const clipKind = (h: Copy) => h.image ? 'image' : h.files ? 'file' : /^https?:\/\/\S+$/.test(h.text!.trim()) ? 'link' : 'text'
const base = (p: string) => p.slice(p.replace(/\/$/, '').lastIndexOf('/') + 1)

export default function Hotbar() {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [mode, setMode] = useState<Mode>('menu')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(-1)
  const [note, setNote] = useState('')
  const [then, setThen] = useState<keyof typeof THEN>('save')
  const [cnote, setCnote] = useState('')  // combo notes are fresh, so the plain draft in `note` survives
  const [hist, setHist] = useState<Copy[]>([])
  const [mems, setMems] = useState<Item[]>([])
  const [peek, setPeek] = useState(false)
  const [type, setType] = useState('')  // the kind filter of clipboard history or memory results, '' is all
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
    const show = (raw: Partial<Ctx>, mode?: string) => {
      const c: Ctx = { app: '', profile: '', clipboard: '', clipboard_kind: null, recording: { on: false, seconds: 0, transcribing: 0 }, ...raw }
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) root.current?.animate([{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' })
      setCtx(c); setRec(c.recording); setMode('menu'); setQ(''); setSel(-1); setArmed(false); setMems([]); setShown(n => n + 1)
      if (mode === 'clip') api.clipHistory().then(h => { setHist(h); setMode('clip') }, () => {})  // Ctrl+Shift+V opens straight into the history
    }
    window.ummShow = show
    if (pending.show) { show(pending.show, pending.mode); pending.show = undefined }
    else if (!native) api.context().then(show, () => {})
    api.settings().then(s => { send({ type: 'appearance', mode: s.appearance }); send({ type: 'hotkey', key: s.hotkey }) }, () => {})  // this page loads with the app, so it sets the saved appearance and hotkey
    return () => { window.ummShow = undefined }
  }, [])
  useEffect(() => { (mode === 'note' ? area : input).current?.focus() }, [shown, mode])

  // report height to the native panel
  useEffect(() => {
    const el = root.current!
    const ro = new ResizeObserver(() => send({ type: 'resize', height: el.offsetHeight }))  // layout height, so the open animation's scale does not count
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
    if (mode !== 'search') { setMems([]); return }  // an empty box lists recent memories
    let stale = false
    const t = setTimeout(() => api.items({ q, profile: '*', limit: 20, kind: type }).then(r => { if (!stale) setMems(r) }, () => {}), 120)
    return () => { stale = true; clearTimeout(t) }
  }, [q, mode, type])

  const fail = () => send({ type: 'error' })
  const openNote = (t: keyof typeof THEN, text = '') => { setThen(t); setCnote(text); setMode('note') }
  const recd = (p: Promise<Rec>) => p.then(r => { setRec(r); send({ type: 'recording', on: r.on }); send({ type: 'hide' }) }, fail)
  const clip = ctx?.clipboard.trim() ?? ''
  const kind = ctx?.clipboard_kind
  const nfiles = kind === 'files' ? clip.split('\n').length : 0
  const names = nfiles ? clip.split('\n').map(base).join(', ') : clip
  const active = ctx?.profile ?? ''

  const menu: (Row & { kw: string })[] = [
    { id: 'shot', icon: 'screenshot', label: 'Take a screenshot', kw: 'capture screen', run: () => send({ type: 'capture' }) },
    { id: 'area', icon: 'area', label: 'Screenshot an area', kw: 'capture screen region select', run: () => send({ type: 'area' }) },
    { id: 'shotnote', icon: 'screenshot', label: 'Screenshot with a note', kw: 'capture annotate caption', run: () => openNote('shot') },
    ...(rec.on ? [] : [{ id: 'shotrec', icon: 'screenshot' as const, label: 'Screenshot and record', kw: 'narrate voice capture', run: () => send({ type: 'capture', record: true }) }]),
    ...(kind ? [{ id: 'clip', icon: kind === 'image' ? 'screenshot' as const : kind === 'files' ? 'files' as const : 'clip' as const, kw: 'paste copy',
      label: kind === 'image' ? 'Save clipboard image' : kind === 'files' ? (nfiles > 1 ? `Save ${nfiles} copied files` : 'Save copied file') : 'Save clipboard',
      detail: kind === 'image' ? null : <span className="peek secret">{chars(names.replace(/\s+/g, ' '), 70)}</span>,
      edit: kind === 'text' ? () => api.clipHistory().then(h => openNote('clip', h[0]?.text ?? clip), fail) : undefined,  // the context text is cut at 2000
      run: () => { api.saveClipboard(ctx?.app, 'hotbar', undefined, ctx?.url).then(() => send({ type: 'saved', kind, label: kind === 'image' ? 'Image saved' : kind === 'files' ? `Saved ${nfiles} file${nfiles > 1 ? 's' : ''}` : 'Clipboard saved', detail: kind === 'image' ? undefined : flat(names) }), fail) } }] : []),
    ...(ctx?.history ? [{ id: 'hist', icon: 'clip' as const, label: 'Pick from clipboard history', kw: 'recent copies paste', detail: <span className="peek">{ctx.history} recent</span>,
      run: () => { api.clipHistory().then(h => { setHist(h); setMode('clip'); setQ(''); setSel(-1) }, fail) } }] : []),
    { id: 'note', icon: 'text', label: 'Write a note', kw: 'text type', detail: note.trim() ? <span className="peek">{chars(note.trim(), 40)}</span> : null, run: () => openNote('save') },
    { id: 'rec', icon: 'voice', label: rec.on ? 'Stop recording' : 'Start recording', kw: 'voice mic audio',
      detail: rec.on ? <span className="live"><i className="recdot" />{clock(rec.seconds)}</span> : rec.transcribing ? <span className="peek">transcribing</span> : null,
      run: () => recd(rec.on ? api.recStop() : api.recStart('hotbar', ctx?.app)) },
    ...(rec.on ? [] : [{ id: 'recnote', icon: 'voice' as const, label: 'Record with a note', kw: 'voice mic annotate', run: () => openNote('rec') }]),
    { id: 'find', icon: 'search', label: query ? `Search memories for "${q.trim()}"` : 'Search memories', kw: query,
      run: () => { setMode('search'); setSel(-1) } },  // typing in the menu only filters these rows, memories are searched here
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
  const histRows: Row[] = hist.filter(h => match(h.text ?? h.files?.join(' ') ?? 'image') && (!type || clipKind(h) === type)).map((h, i) => {
    const what = h.text ? flat(h.text) : h.files ? flat(h.files.map(base).join(', ')) : 'Image', info = [h.app, ago(h.at)].filter(Boolean).join(', ')
    return { id: '' + i, icon: h.files ? 'files' : 'clip', label: what, thumb: h.image, app: h.app, info, detail: <span className="peek">{info}</span>,
      run: () => { api.clipRestore(h.at).then(() => send({ type: 'paste', detail: what }), fail) },
      save: () => { api.clipSave(h.at).then(() => send({ type: 'saved', kind: 'clip', label: h.text ? 'Clipboard saved' : h.files ? 'Saved' : 'Image saved', detail: h.image ? undefined : what }), fail) },
      edit: h.text ? () => openNote('clip', h.text) : undefined,
      full: h.text ? <p className="prose">{chars(h.text, 20000)}</p> : <>{h.image && <img src={fileUrl(h.image)} alt="" />}{h.files && <p className="prose">{h.files.join('\n')}</p>}</> }
  })
  // the generic search row goes last while typing, so a specific match wins Enter
  const hits = menu.filter(r => !query || r.id === 'find' || match(r.label + ' ' + r.kw))
  const rows: Row[] = mode === 'search' ? [] : mode === 'profiles' ? profRows : mode === 'clip' ? histRows : query ? [...hits.filter(r => r.id !== 'find'), ...hits.filter(r => r.id === 'find')] : hits
  const memRows = mode === 'search' ? mems : []
  const total = rows.length + memRows.length
  // Before any arrow key, a typed query picks a row only when it starts that row's label, else the first memory, else search.
  // So "exit" or "mic" plus Enter searches instead of quitting or recording.
  const prefix = rows.findIndex(r => r.label.toLowerCase().startsWith(query))
  const at = sel >= 0 ? Math.min(sel, Math.max(0, total - 1))
    : !query || mode !== 'menu' ? 0 : prefix >= 0 ? prefix : memRows.length ? rows.length : rows.findIndex(r => r.id === 'find')
  useEffect(() => { root.current?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }) }, [at, mode])
  useEffect(() => setType(''), [mode])
  const types: string[][] | null = mode === 'clip' ? CLIPS : mode === 'search' ? KINDS : null
  const choose = (t: string) => { setType(t); setSel(-1); input.current?.focus() }
  const pm = memRows[at - rows.length]
  // Space toggles a preview pane that stays open while the selection moves. With an empty box a space cannot be typing.
  const pv = mode === 'clip' ? rows[at]?.full : pm && <Body key={pm.id} it={pm} q={q} />
  const info = mode === 'clip' ? rows[at]?.info : pm && [appName(pm.app), ago(pm.created_at)].filter(Boolean).join(', ')
  const listed = mode === 'clip' || memRows.length > 0
  const canPeek = listed && (sel >= 0 || !q)
  const split = peek && listed
  // a list scrolled under a still pointer fires mousemove too, which must not move the selection
  const pos = useRef('')
  const hover = (i: number) => (e: React.MouseEvent) => { const p = e.screenX + ',' + e.screenY; if (p !== pos.current) { pos.current = p; setSel(i) } }

  const run = (i: number) => {
    if (i < rows.length) return rows[i].run()
    const m = memRows[i - rows.length]
    if (m) api.copy(copyText(m)).then(() => send({ type: 'hide' }), fail)
  }
  const submit = () => {
    const t = (then === 'save' ? note : cnote).trim()
    if (then === 'shot') { setCnote(''); send({ type: 'capture', note: t || undefined }) }
    else if (then === 'rec') { setCnote(''); recd(api.recStart('hotbar', ctx?.app, t || undefined)) }
    else if (t) api.add(t, 'hotbar', ctx?.app, undefined, ctx?.url).then(() => { if (then === 'save') setNote(''); send({ type: 'saved', kind: then === 'save' ? 'note' : 'clip', label: then === 'save' ? 'Note saved' : 'Clipboard saved', detail: flat(t) }) }, fail)
  }
  const back = () => { setMode('menu'); setQ(''); setSel(-1) }

  const onKey = (e: React.KeyboardEvent) => {
    if (mode === 'note') {
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); submit() }
      else if (e.key === 'Escape') { e.preventDefault(); back() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(total - 1, at + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, at - 1)) }
    else if (e.key === 'Enter' && !e.metaKey) { e.preventDefault(); run(at) }
    else if (e.key === 'Enter' && mode === 'search') { e.preventDefault(); send({ type: 'openMain', query: q.trim() }) }
    else if (e.key === 'Enter' && mode === 'clip' && rows[at]?.save) { e.preventDefault(); rows[at].save!() }
    else if (e.key === ' ' && canPeek) { e.preventDefault(); setPeek(!peek) }
    else if (e.key === 'p' && e.metaKey && types) { e.preventDefault(); const all = ['', ...types.map(t => t[0])]; choose(all[(all.indexOf(type) + 1) % all.length]) }
    else if (e.key === 'Tab' && rows[at]?.edit) { e.preventDefault(); rows[at].edit!() }
    else if (e.key === 'Escape') { e.preventDefault(); if (mode !== 'menu') back(); else if (q) { setQ(''); setSel(-1) } else send({ type: 'hide' }) }
  }

  const tile = (r: Row) => <span className="tile">{r.thumb ? <img className="thumb" src={fileUrl(r.thumb)} alt="" /> : r.app ? <AppIcon name={r.app} /> : r.icon === 'dot' ? <Dot name={r.label} /> : <Icon name={r.icon} />}</span>
  const foot = (
    <footer>
      <span className="fprof" title="Active profile: new saves land here"><Dot name={active || 'user'} />{active}</span>
      <span className="hint">{canPeek && mode !== 'note' && <><Kbd>Space</Kbd> {peek ? 'hide' : 'preview'}</>}{mode === 'note' ? <><Kbd>Cmd Enter</Kbd> {THEN[then][1]} <Kbd>Esc</Kbd> back</> : mode === 'clip' ? <><Kbd>Enter</Kbd> paste <Kbd>Cmd Enter</Kbd> save <Kbd>Tab</Kbd> edit <Kbd>Esc</Kbd> back</> : mode === 'search' ? <><Kbd>Enter</Kbd> copy <Kbd>Cmd Enter</Kbd> open in umm <Kbd>Esc</Kbd> back</> : <><Kbd>Enter</Kbd> run <Kbd>Esc</Kbd> {q || mode === 'profiles' ? 'back' : 'close'}</>}</span>
    </footer>
  )

  return (
    <div className="bar" ref={root} onKeyDown={onKey}>
      <div className="in" key={shown}>
      {mode === 'note' ? (
        <div className="note">
          {then !== 'save' && <p className="nhead">{THEN[then][0]}</p>}
          <textarea ref={area} value={then === 'save' ? note : cnote} onChange={e => (then === 'save' ? setNote : setCnote)(e.target.value)} rows={5} spellCheck
            placeholder={then === 'save' ? 'Write it down. Enter makes a new line.' : 'Add a note to go with it. Enter makes a new line.'} />
          {ctx?.app && <p className="nfrom">From {ctx.app.slice(0, 70)}</p>}
        </div>
      ) : (
        <>
          <div className="ask">
            <img className="logo" src={icon} alt="" />
            <input ref={input} value={q} onChange={e => { setQ(e.target.value); setSel(-1); setArmed(false) }} spellCheck={false} autoFocus
              role="combobox" aria-expanded aria-controls="hrows" aria-activedescendant={total ? 'h' + at : undefined}
              placeholder={mode === 'profiles' ? 'Pick a profile, or type a new name' : mode === 'clip' ? 'Filter recent copies' : mode === 'search' ? 'Search memories' : 'umm... what do you want to keep or find?'} />
            {types && <select className="types" value={type} onChange={e => choose(e.target.value)} title="Filter by type, Cmd P">
              <option value="">All</option>{types.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>}
          </div>
          <div key={mode} className={'body' + (split ? ' split' : '')}>
          <div className="lists">
          {mode !== 'search' && <ul className={'rows' + (mode !== 'menu' ? ' capped' : '')} id="hrows" role="listbox">
            {rows.map((r, i) => (
              <li key={r.id} id={'h' + i} role="option" aria-selected={i === at} className={(i === at ? 'on' : '') + (!query && mode === 'menu' && (r.id === (rec.on ? 'rec' : 'recnote') || r.id === 'prof') ? ' split' : '')}
                onMouseMove={hover(i)} onClick={() => run(i)}>
                {tile(r)}
                <span className={'label' + (mode === 'clip' && !r.thumb ? ' secret' : '')}>{r.label}</span>
                {r.detail}
              </li>
            ))}
            {!rows.length && <li className="none">{mode === 'clip' ? 'No copy matches' : 'No profile matches'}</li>}
          </ul>}
          {mode === 'search' && (
            <ul className="mems" role="listbox">
              {!memRows.length && <li className="none">No memories match</li>}
              {memRows.map((m, j) => {
                const i = rows.length + j
                return (
                  <li key={m.id} id={'h' + i} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseMove={hover(i)} onClick={() => run(i)}>
                    <span className="tile">{m.meta?.icon ? <img className="fav" src={fileUrl(m.meta.icon)} alt="" /> : m.app ? <AppIcon name={appName(m.app)} /> : <Icon name={m.kind} />}</span>
                    <span className="label">{m.meta?.transcribing ? <span className="busy">Transcribing...</span> : hl(chars(linkLabel(m) || m.content.slice(0, 400).replace(/\s+/g, ' '), 120), q)}</span>
                    {m.meta?.pinned && <Icon name="pin" />}
                    {m.profile !== active && <span className="peek"><Dot name={m.profile} />{m.profile}</span>}
                    <span className="peek">{ago(m.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
          </div>
          {split && <div className={'peekbox ' + (mode === 'clip' ? '' : pm?.kind ?? '')}><div key={at} className="pv">{info && <p className="pinfo">{info}</p>}{pv ?? <p className="dim">Nothing to preview</p>}</div></div>}
          </div>
        </>
      )}
      {foot}
      </div>
    </div>
  )
}
