import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { fileUrl, type Item, type LinkInfo } from './api'
import { send } from './bridge'
import { AppIcon, Dot, Icon, Kbd, Menu, SOURCES, type Opt, clock, full, hl, home, stamp, type IconName } from './ui'

export type Act = {
  copy: (it: Item) => void
  reveal: (it: Item) => void
  del: (its: Item[]) => void
  move: (its: Item[], profile: string) => void
  save: (it: Item, content: string) => Promise<void>
  zoom: (it: Item) => void
  shot: (it: Item, what: 'copy' | 'open' | 'reveal') => void
}

export const copyText = (it: Item) => (it.kind === 'link' ? it.content.split(/\s+/)[0] : it.content)
// A project folder by its last two parts, the full path goes in a tooltip.
export const projectName = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/')
export const appName = (a: string | null) => a?.split(':')[0] ?? ''
const winTitle = (a: string | null) => a?.split(/:\s*/).slice(1).join(': ') || ''
const openUrl = (url: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); send({ type: 'openExternal', url }) }
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
// a page's host, or a document's path for file URLs
const host = (url: string) => {
  try { const u = new URL(url); return u.protocol === 'file:' ? home(decodeURI(u.pathname)) : u.host.replace(/^www\./, '') || url } catch { return url }
}

// Short piece of text around the first match, so a long OCR dump shows why it matched.
function snip(text: string, q: string, n = 150) {
  const f = flat(text.slice(0, 20000))
  const w = q.split(/\s+/).find(Boolean)
  const at = w ? f.toLowerCase().indexOf(w.toLowerCase()) : -1
  const from = Math.max(0, at - 16)
  return (from ? '... ' : '') + cut(f.slice(from), n)
}
// Cut to n characters without splitting an emoji or other surrogate pair.
export function cut(s: string, n: number) {
  const c = [...s]
  return c.length > n ? c.slice(0, n).join('') + ' ...' : s
}

// Fetched details of a link: the text added to content after the URL, in the order the backend wrote it.
const linkText = (l?: LinkInfo) =>
  (['site', 'title', 'author', 'text'] as const).map(k => l?.[k]).filter(Boolean).join('\n')
export const linkLabel = (it: Item) => {
  const l = it.meta?.link
  return l ? `${l.title || l.text || ''} - ${l.site}` : ''
}
// url, the note typed after it (without the fetched lines), and the fetched info
function linkParts(it: Item) {
  const [url] = it.content.split(/\s+/)
  const l = it.meta?.link
  const added = linkText(l)
  let note = it.content.slice(url.length)
  if (added && note.endsWith(added)) note = note.slice(0, -added.length)
  return { url, l, note: note.trim() }
}
// Voice transcripts in another language carry an English version after "English:".
const voiceParts = (text: string) => text.split(/\n+English: /)

// The leading glyph: a link's site icon, the app's icon or an agent monogram, with a small kind badge. Else the kind alone.
export function Glyph({ it }: { it: Item }) {
  const from = appName(it.app)
  const face = it.meta?.icon ? <img className="fav" src={fileUrl(it.meta.icon)} alt="" /> : from ? <AppIcon name={from} /> : null
  return face ? <span className="glyph">{face}{it.kind !== 'text' && <i className="badge"><Icon name={it.kind} /></i>}</span>
    : <span className="kind"><Icon name={it.kind} /></span>
}

const QuietUrl = ({ url, q = '' }: { url: string; q?: string }) =>
  <a className="qurl" href={url} data-tip={url} onClick={openUrl(url)}>{hl(host(url), q)}</a>

// Title and second line of a row.
function lines(it: Item, q: string): [ReactNode, ReactNode] {
  const m = it.meta
  const said = (s: string) => hl(cut(flat(s), 160), q)
  const near = (s: string) => hl(snip(s, q), q)  // second lines show the part around a match
  if (m?.source === 'mcp' && it.kind === 'text') return [said(it.content), <><b>{m.agent}</b>{m.cwd && <><Icon name="path" />{projectName(m.cwd)}</>}</>]
  const url = m?.url ? <QuietUrl url={m.url} q={q} /> : null
  if (it.kind === 'screenshot') {
    const t = winTitle(it.app) || appName(it.app) || 'Screenshot'
    // OCR often starts with the window title, which the row already shows
    const text = it.content.trim().startsWith(t) ? it.content.trim().slice(t.length) : it.content
    return [hl(t, q), <>{url}{text.trim() ? hl(snip(text, q), q) : 'No text found'}</>]
  }
  if (it.kind === 'link') {
    const { url: u, l, note } = linkParts(it)
    const t = l?.title || l?.text || note
    return [hl(t || host(u), q), <><span className="host">{hl(t ? host(u) : u.replace(/^https?:\/\/(www\.)?/, ''), q)}</span>{l?.author && hl(l.author, q)}</>]
  }
  if (it.kind === 'path') {
    const i = it.content.replace(/\/$/, '').lastIndexOf('/')
    return [hl(it.content.slice(i + 1) || it.content, q), <code>{hl(home(it.content.slice(0, i + 1)), q)}</code>]
  }
  const [head, ...rest] = it.content.trim().split('\n')
  if (it.kind === 'voice') {
    if (m?.transcribing) return [<span className="busy">Transcribing...</span>, <><Icon name="voice" />Voice note</>]
    const [orig, english] = voiceParts(it.content)
    return [said(orig), <><Icon name="voice" />{english ? near(english) : 'Voice note'}</>]
  }
  return [said(head), <>{url}{rest.join(' ').trim() ? near(rest.join(' ')) : appName(it.app) || SOURCES[m?.source ?? '']?.[1] || 'Note'}</>]
}

// Rows only re-render when their own props change, so onPick must be stable.
export const Row = memo(function Row({ it, i, q, on, cur, all, onPick, onOpen }: {
  it: Item; i: number; q: string; on: boolean; cur: boolean; all: boolean
  onPick: (i: number, e: React.MouseEvent) => void; onOpen: (it: Item) => void
}) {
  const el = useRef<HTMLLIElement>(null)
  useEffect(() => { if (cur) el.current?.scrollIntoView({ block: 'nearest' }) }, [cur])
  const [title, sub] = lines(it, q)
  return (
    <li ref={el} id={'m' + it.id} role="option" aria-selected={on} className={'row ' + it.kind + (on ? ' on' : '') + (cur ? ' cur' : '')}
      onMouseDown={e => e.shiftKey && e.preventDefault()} onClick={e => onPick(i, e)} onDoubleClick={() => onOpen(it)}>
      <span className="lead"><Glyph it={it} /></span>
      <span className="l1"><b>{title}</b>{all && <Dot name={it.profile} />}<time data-tip={full(it.created_at)}>{stamp(it.created_at)}</time></span>
      <span className="l2">{sub}</span>
    </li>
  )
})

function Player({ file }: { file: string }) {
  const a = useRef<HTMLAudioElement>(null)
  const [src, setSrc] = useState('')
  const [t, setT] = useState(0)
  const [d, setD] = useState(0)
  const [on, setOn] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => () => { if (src) URL.revokeObjectURL(src) }, [src])
  // the umm:// scheme answers whole files only, so the recording is loaded as a blob once
  const toggle = () => src ? (a.current!.paused ? a.current!.play() : a.current!.pause())
    : fetch(fileUrl(file)).then(r => r.blob()).then(b => { setSrc(URL.createObjectURL(b)); setFailed(false) }, () => setFailed(true))
  return (
    <div className="player">
      <button className="pp" onClick={toggle} aria-label={on ? 'Pause' : 'Play recording'} data-tip={failed ? 'Could not load, click to retry' : undefined}><Icon name={on ? 'pause' : 'play'} /></button>
      <input type="range" min={0} max={d || 1} step={0.05} value={t} disabled={!d} aria-label="Position"
        onChange={e => { a.current!.currentTime = +e.target.value; setT(+e.target.value) }} style={{ '--p': `${d ? (t / d) * 100 : 0}%` } as React.CSSProperties} />
      <span className="clock">{d ? `${clock(Math.floor(t))} / ${clock(Math.round(d))}` : failed ? 'Could not load' : 'Play'}</span>
      {src && <audio ref={a} src={src} autoPlay onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => setOn(false)}
        onLoadedMetadata={e => setD(e.currentTarget.duration)} onTimeUpdate={e => setT(e.currentTarget.currentTime)} />}
    </div>
  )
}

// The right pane: the whole item, its details and actions. Every action has keys, shown in its tooltip.
type Tool = [IconName, string, string, () => void]
type Maybe<T> = T | false | '' | null | undefined
export function Preview({ it, q, act, profiles }: { it: Item; q: string; act: Act; profiles: Opt[] }) {
  const [editing, setEditing] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const m = it.meta
  const from = appName(it.app)
  const mcp = m?.source === 'mcp'
  const shot = it.kind === 'screenshot'
  const src = m?.source && SOURCES[m.source]
  const done = () => (ta.current!.value.trim() !== it.content ? act.save(it, ta.current!.value) : Promise.resolve()).then(() => setEditing(false), () => {})
  const lp = it.kind === 'link' ? linkParts(it) : null
  const [said, english] = voiceParts(it.content)
  const slash = it.content.replace(/\/$/, '').lastIndexOf('/')

  const tools = ([
    shot ? ['copy', 'Copy image', 'Cmd C', () => act.shot(it, 'copy')] : ['copy', lp ? 'Copy link' : it.kind === 'path' ? 'Copy path' : 'Copy text', 'Cmd C', () => act.copy(it)],
    shot && it.content.trim() && ['ctext', 'Copy text', 'Cmd Shift C', () => act.copy(it)],
    shot && it.file && ['reveal', 'Open in Preview', 'Cmd O', () => act.shot(it, 'open')],
    lp && ['reveal', 'Open link', 'Cmd O', () => send({ type: 'openExternal', url: lp.url })],
    (it.file && shot || it.kind === 'path') && ['path', 'Show in Finder', 'Cmd Shift R', () => (shot ? act.shot(it, 'reveal') : act.reveal(it))],
    !shot && !m?.transcribing && ['edit', 'Edit', 'Cmd E', () => setEditing(true)],
  ] as Maybe<Tool>[]).filter(Boolean) as Tool[]
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return
      if (e.key.toLowerCase() === 'c' && !getSelection()?.isCollapsed) return  // copying selected text
      const t = tools.find(x => x[2] === ['Cmd', e.shiftKey && 'Shift', e.key.toUpperCase()].filter(Boolean).join(' '))
      if (t) { e.preventDefault(); t[3]() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const body = editing ? (
    <div className="edit">
      <textarea ref={ta} autoFocus defaultValue={it.content} rows={Math.min(14, it.content.split('\n').length + 2)}
        onFocus={e => e.currentTarget.setSelectionRange(it.content.length, it.content.length)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
          if (e.key === 'Enter' && e.metaKey) done()
        }} />
      <div className="btns"><button className="btn" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary" onClick={done}>Save <Kbd>Cmd Enter</Kbd></button></div>
    </div>
  ) : shot ? <>
    {it.file
      ? <button className="hero" onClick={() => act.zoom(it)} data-tip="Zoom" data-keys="Space" aria-label="Zoom screenshot"><img src={fileUrl(it.file)} alt="" /></button>
      : <p className="gone"><Icon name="screenshot" />The image was removed after the time set in Settings. Its text is kept.</p>}
    <h2>{hl(winTitle(it.app) || from || 'Screenshot', q)}</h2>
    {it.content.trim()
      ? <details className="ocr" open={!!q.trim()}><summary><Icon name="chevron" />Text in image</summary><p>{hl(it.content, q)}</p></details>
      : <p className="dim">No text found in the image.</p>}
  </> : lp ? <>
    {lp.note && <p className="prose">{hl(lp.note, q)}</p>}
    <a className="card" href={lp.url} onClick={openUrl(lp.url)} data-tip="Open link" data-keys="Cmd O">
      <span className="site"><span className="kind">{m?.icon ? <img className="fav" src={fileUrl(m.icon)} alt="" /> : <Icon name="link" />}</span>{hl(lp.l?.site ?? host(lp.url), q)}{lp.l?.author && <span className="by">{hl(lp.l.author, q)}</span>}</span>
      {lp.l?.title && <b>{hl(lp.l.title, q)}</b>}
      {lp.l?.text && <span className="desc">{hl(lp.l.text, q)}</span>}
      <span className="url">{lp.url}</span>
    </a>
  </> : it.kind === 'path' ? (
    <div className="file"><span className="kind"><Icon name="path" /></span><div><h2>{hl(it.content.slice(slash + 1) || it.content, q)}</h2><code>{hl(home(it.content.slice(0, slash + 1)), q)}</code></div></div>
  ) : it.kind === 'voice' ? <>
    {it.file && <Player file={it.file} />}
    {m?.transcribing ? <p className="busy">Transcribing...</p> : <p className="prose">{hl(said, q)}</p>}
    {english && <div className="trans"><h3>English translation</h3><p>{hl(english, q)}</p></div>}
  </> : <p className="prose">{hl(it.content, q)}</p>

  const facts = ([
    mcp ? ['Agent', <><AppIcon name={m.agent ?? 'Agent'} />{m.agent ?? 'Agent'}<span className="dim">{m.agent_version}</span></>]
      : from && ['App', <><AppIcon name={from} />{from}{!shot && <span className="dim">{winTitle(it.app)}</span>}</>],
    m?.url && ['Page', <QuietUrl url={m.url} />],
    m?.cwd && [mcp ? 'Project' : 'Folder', <span data-tip={m.cwd}>{home(m.cwd)}</span>],
    !mcp && src && ['Saved with', src[1]],
    ['Profile', <><Dot name={it.profile} />{it.profile}</>],
    ['Saved', full(it.created_at)],
  ] as Maybe<[string, ReactNode]>[]).filter(Boolean) as [string, ReactNode][]
  return (
    <section className="pane" aria-label="Preview">
      <header className="phead">
        {tools.map(([ic, label, keys, fn]) => <button key={label} className="tool" data-tip={label} data-keys={keys} aria-label={label} onClick={fn}><Icon name={ic} /></button>)}
        <span className="gap" />
        <Menu className="tool" label="Move to profile" tip="Move to profile" options={[{ value: '', label: 'Move to', disabled: true }, ...profiles.filter(p => p.value !== it.profile)]} onPick={p => act.move([it], p)}><Icon name="move" /></Menu>
        <button className="tool" data-tip="Delete item" data-keys="Delete" aria-label="Delete" onClick={() => act.del([it])}><Icon name="trash" /></button>
      </header>
      <div className={'pbody ' + it.kind}>
        {body}
        <dl className="facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
    </section>
  )
}

// Full window image: click switches between fit and 100%, scroll pans, arrows step through screenshots.
export function Zoom({ it, act, onClose, step }: { it: Item; act: Act; onClose: () => void; step: (d: number) => void }) {
  const [fit, setFit] = useState(true)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); onClose() }
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  return (
    <div className="zoom" role="dialog" aria-label="Screenshot">
      <header>
        <b>{winTitle(it.app) || appName(it.app) || 'Screenshot'}</b>
        <span className="dim">{stamp(it.created_at)}</span>
        <span className="gap" />
        <button className="btn" onClick={() => setFit(!fit)}>{fit ? 'Actual size' : 'Fit'}</button>
        <button className="tool" data-tip="Copy image" data-keys="Cmd C" aria-label="Copy image" onClick={() => act.shot(it, 'copy')}><Icon name="copy" /></button>
        <button className="tool" data-tip="Open in Preview" data-keys="Cmd O" aria-label="Open in Preview" onClick={() => act.shot(it, 'open')}><Icon name="reveal" /></button>
        <button className="tool" data-tip="Show in Finder" data-keys="Cmd Shift R" aria-label="Show in Finder" onClick={() => act.shot(it, 'reveal')}><Icon name="path" /></button>
        <button className="tool" data-tip="Close" data-keys="Esc" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className={'stage' + (fit ? ' fit' : '')} onClick={e => e.target === e.currentTarget && onClose()}>
        <img src={fileUrl(it.file!)} alt="" onClick={() => setFit(!fit)} />
      </div>
    </div>
  )
}
