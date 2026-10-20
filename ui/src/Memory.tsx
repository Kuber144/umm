import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { fileUrl, thumbUrl, type Item, type LinkInfo } from './api'
import { send } from './bridge'
import { AppIcon, Dot, Icon, SOURCES, clock, full, hl, home, stamp, type IconName } from './ui'

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

// The leading glyph: a link's site icon, the app's icon, an agent monogram, else the kind.
export function Glyph({ it }: { it: Item }) {
  const from = appName(it.app)
  return it.meta?.icon ? <img className="fav" src={fileUrl(it.meta.icon)} alt="" />
    : from ? <AppIcon name={from} /> : <span className="kind"><Icon name={it.kind} /></span>
}

const QuietUrl = ({ url, q = '' }: { url: string; q?: string }) =>
  <a className="qurl" href={url} title={url} onClick={openUrl(url)}>{hl(host(url), q)}</a>

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
      <span className="lead">{it.kind === 'screenshot' && it.file ? <img className="mini" loading="lazy" src={thumbUrl(it.file)} alt="" /> : <Glyph it={it} />}</span>
      <span className="l1"><b>{title}</b>{all && <Dot name={it.profile} />}<time title={full(it.created_at)}>{stamp(it.created_at)}</time></span>
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
      <button className="pp" onClick={toggle} aria-label={on ? 'Pause' : 'Play recording'} title={failed ? 'Could not load, click to retry' : undefined}><Icon name={on ? 'pause' : 'play'} /></button>
      <input type="range" min={0} max={d || 1} step={0.05} value={t} disabled={!d} aria-label="Position"
        onChange={e => { a.current!.currentTime = +e.target.value; setT(+e.target.value) }} style={{ '--p': `${d ? (t / d) * 100 : 0}%` } as React.CSSProperties} />
      <span className="clock">{d ? `${clock(Math.floor(t))} / ${clock(Math.round(d))}` : failed ? 'Could not load' : 'Play'}</span>
      {src && <audio ref={a} src={src} autoPlay onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => setOn(false)}
        onLoadedMetadata={e => setD(e.currentTarget.duration)} onTimeUpdate={e => setT(e.currentTarget.currentTime)} />}
    </div>
  )
}

// The right pane: the whole item, its details and actions.
export function Preview({ it, q, act, profiles }: { it: Item; q: string; act: Act; profiles: string[] }) {
  const [editing, setEditing] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const m = it.meta
  const from = appName(it.app)
  const src = m?.source && SOURCES[m.source]
  const done = () => (ta.current!.value.trim() !== it.content ? act.save(it, ta.current!.value) : Promise.resolve()).then(() => setEditing(false), () => {})
  const tool = (icon: IconName, label: string, fn: () => void) =>
    <button className="tool" title={label} aria-label={label} onClick={fn}><Icon name={icon} /></button>
  const lp = it.kind === 'link' ? linkParts(it) : null
  const [said, english] = voiceParts(it.content)

  const body = editing ? (
    <div className="edit">
      <textarea ref={ta} autoFocus defaultValue={it.content} rows={Math.min(14, it.content.split('\n').length + 2)}
        onFocus={e => e.currentTarget.setSelectionRange(it.content.length, it.content.length)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
          if (e.key === 'Enter' && e.metaKey) done()
        }} />
      <div className="btns"><button className="btn primary" onClick={done}>Save</button><button className="btn" onClick={() => setEditing(false)}>Cancel</button></div>
    </div>
  ) : it.kind === 'screenshot' ? <>
    <button className="big" onClick={() => act.zoom(it)} aria-label="Zoom screenshot"><img src={fileUrl(it.file!)} alt="" /></button>
    <h2>{hl(winTitle(it.app) || from || 'Screenshot', q)}</h2>
    {it.content.trim() ? <pre className="full ocr">{hl(it.content, q)}</pre> : <p className="dim">No text found in this screenshot.</p>}
  </> : lp ? <>
    <a className="card" href={lp.url} onClick={openUrl(lp.url)}>
      <span className="site">{m?.icon ? <img className="fav" src={fileUrl(m.icon)} alt="" /> : <Icon name="link" />}{hl(lp.l?.site ?? host(lp.url), q)}{lp.l?.author && <span className="by">{hl(lp.l.author, q)}</span>}</span>
      {lp.l?.title && <b>{hl(lp.l.title, q)}</b>}
      {lp.l?.text && <span className="desc">{hl(lp.l.text, q)}</span>}
      <span className="url">{lp.url}</span>
    </a>
    {lp.note && <p className="full">{hl(lp.note, q)}</p>}
  </> : it.kind === 'path' ? <code className="pathbox">{hl(it.content, q)}</code>
    : it.kind === 'voice' ? <>
      {it.file && <Player file={it.file} />}
      <p className="full">{hl(said, q)}</p>
      {english && <p className="full trans"><span>English</span>{hl(english, q)}</p>}
    </> : <p className="full">{hl(it.content, q)}</p>

  const facts: [string, ReactNode][] = [
    ['Saved', full(it.created_at)],
    ...(from && m?.source !== 'mcp' ? [['From', <><AppIcon name={from} />{it.app}</>] as [string, ReactNode]] : []),
    ...(m?.url ? [['Page', <QuietUrl url={m.url} />] as [string, ReactNode]] : []),
    ...(m?.source === 'mcp' ? [['Agent', `${m.agent ?? 'Agent'} ${m.agent_version ?? ''}`] as [string, ReactNode]] : src ? [['Saved with', src[1]] as [string, ReactNode]] : []),
    ...(m?.cwd ? [['Folder', <span title={m.cwd}>{home(m.cwd)}</span>] as [string, ReactNode]] : []),
    ['Profile', <><Dot name={it.profile} />{it.profile}</>],
  ]
  return (
    <section className="pane" aria-label="Preview">
      <header className="phead">
        {it.kind === 'screenshot' ? <>
          <button className="btn" onClick={() => act.shot(it, 'copy')}><Icon name="copy" />Copy image</button>
          {tool('reveal', 'Open in Preview', () => act.shot(it, 'open'))}
          {tool('path', 'Show in Finder', () => act.shot(it, 'reveal'))}
          {it.content.trim() && tool('text', 'Copy text', () => act.copy(it))}
        </> : lp ? <>
          <button className="btn" onClick={() => send({ type: 'openExternal', url: lp.url })}><Icon name="reveal" />Open link</button>
          {tool('copy', 'Copy link', () => act.copy(it))}
        </> : <>
          <button className="btn" onClick={() => act.copy(it)}><Icon name="copy" />Copy</button>
          {it.kind === 'path' && tool('path', 'Show in Finder', () => act.reveal(it))}
        </>}
        {it.kind !== 'screenshot' && tool('edit', 'Edit', () => setEditing(true))}
        <span className="gap" />
        <label className="tool" title="Move to profile">
          <Icon name="move" />
          <select value="" onChange={e => e.target.value && act.move([it], e.target.value)} aria-label="Move to profile">
            <option value="">Move to...</option>
            {profiles.filter(p => p !== it.profile).map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        {tool('trash', 'Delete', () => act.del([it]))}
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
        <button className="btn" onClick={() => act.shot(it, 'copy')}><Icon name="copy" />Copy image</button>
        <button className="tool" title="Open in Preview" aria-label="Open in Preview" onClick={() => act.shot(it, 'open')}><Icon name="reveal" /></button>
        <button className="tool" title="Show in Finder" aria-label="Show in Finder" onClick={() => act.shot(it, 'reveal')}><Icon name="path" /></button>
        <button className="tool" title="Close (Esc)" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className={'stage' + (fit ? ' fit' : '')} onClick={e => e.target === e.currentTarget && onClose()}>
        <img src={fileUrl(it.file!)} alt="" onClick={() => setFit(!fit)} />
      </div>
    </div>
  )
}
