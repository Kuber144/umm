import { memo, useEffect, useRef, useState } from 'react'
import { fileUrl, thumbUrl, type Item, type LinkInfo } from './api'
import { send } from './bridge'
import { AppIcon, Dot, Icon, SOURCES, ago, hl, when } from './ui'

export type Act = {
  copy: (it: Item) => void
  reveal: (it: Item) => void
  del: (it: Item) => void
  move: (it: Item, profile: string) => void
  save: (it: Item, content: string) => Promise<void>
  zoom: (it: Item) => void
}

export const copyText = (it: Item) => (it.kind === 'link' ? it.content.split(/\s+/)[0] : it.content)
// A project folder by its last two parts, the full path goes in a tooltip.
export const projectName = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/')
export const appName = (a: string | null) => a?.split(':')[0] ?? ''
const winTitle = (a: string | null) => a?.split(/:\s*/).slice(1).join(': ') || ''

// Short piece of text around the first match, so a long OCR dump shows why it matched.
function snip(text: string, q: string, n = 150) {
  const flat = text.slice(0, 20000).replace(/\s+/g, ' ').trim()
  const w = q.split(/\s+/).find(Boolean)
  const at = w ? flat.toLowerCase().indexOf(w.toLowerCase()) : -1
  const from = Math.max(0, at - 40)
  return (from ? '... ' : '') + cut(flat.slice(from), n)
}
// Cut to n characters without splitting an emoji or other surrogate pair.
export function cut(s: string, n: number) {
  const c = [...s]
  return c.length > n ? c.slice(0, n).join('') + ' ...' : s
}

function Voice({ file }: { file: string }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => () => { if (src) URL.revokeObjectURL(src) }, [src])
  const load = () => fetch(fileUrl(file)).then(r => r.blob()).then(b => setSrc(URL.createObjectURL(b)), () => setFailed(true))
  return src ? <audio src={src} controls autoPlay />
    : <button className="play" onClick={load} title={failed ? 'Could not load, click to retry' : 'Play recording'} aria-label="Play recording"><Icon name="play" /></button>
}

// Fetched details of a link: the text added to content after the URL, in the order the backend wrote it.
const linkText = (l?: LinkInfo) =>
  (['site', 'title', 'author', 'text'] as const).map(k => l?.[k]).filter(Boolean).join('\n')
export const linkLabel = (it: Item) => {
  const l = it.meta?.link
  return l ? `${l.title || l.text || ''} - ${l.site}` : ''
}

function Link({ it, q }: { it: Item; q: string }) {
  const [url] = it.content.split(/\s+/)
  const l = it.meta?.link
  const added = linkText(l)
  let note = it.content.slice(url.length)
  if (added && note.endsWith(added)) note = note.slice(0, -added.length)
  note = note.trim()
  let host = url, tail = ''
  try { const u = new URL(url); host = u.host.replace(/^www\./, ''); tail = (u.pathname + u.search).replace(/^\/$/, '') } catch { /* show raw */ }
  const open = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); send({ type: 'openExternal', url }) }
  const fav = it.meta?.icon ? <img className="fav" src={fileUrl(it.meta.icon)} alt="" /> : <Icon name="link" />
  return <>
    {l ? (
      <a className="card" href={url} onClick={open}>
        <span className="site">{fav}<span>{hl(l.site ?? host, q)}</span>{l.author && <span className="by">{hl(l.author, q)}</span>}</span>
        {l.title && <b>{hl(l.title, q)}</b>}
        {l.text && <span className="desc">{hl(l.text, q)}</span>}
        <span className="url">{host}{tail}</span>
      </a>
    ) : (
      <a className="link" href={url} onClick={open}>{fav}<b>{hl(host, q)}</b><span>{hl(tail, q)}</span></a>
    )}
    {note && <p className="txt note">{hl(note, q)}</p>}
  </>
}

// Voice transcripts in another language carry an English version after "English:".
function Transcript({ text, q, clamp }: { text: string; q: string; clamp: boolean }) {
  const [said, english] = text.split(/\n+English: /)
  return <>
    <p className={'txt' + (clamp ? ' clamp' : '')}>{hl(said, q)}</p>
    {english && <p className="trans"><span>English</span>{hl(english, q)}</p>}
  </>
}

// Rows only re-render when their own props change, so act and onSelect must be stable.
export const Row = memo(function Row({ it, i, q, sel, all, profiles, act, onSelect }: {
  it: Item; i: number; q: string; sel: boolean; all: boolean; profiles: string[]; act: Act; onSelect: (i: number) => void
}) {
  const el = useRef<HTMLLIElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (sel) el.current?.scrollIntoView({ block: 'nearest' }) }, [sel])
  const long = it.content.length > 360 || it.content.split('\n').length > 5
  // a clamped note shows a few lines, so only that part is highlighted
  const shown = long && !open ? it.content.slice(0, 600).replace(/\n\s*\n/g, '\n') : it.content
  const cut = it.content.lastIndexOf('/')
  const done = () => (ta.current!.value.trim() !== it.content ? act.save(it, ta.current!.value) : Promise.resolve()).then(() => setEditing(false), () => {})
  const tool = (icon: Parameters<typeof Icon>[0]['name'], label: string, fn: () => void) =>
    <button className="tool" title={label} aria-label={label} onClick={e => { e.stopPropagation(); fn() }}><Icon name={icon} /></button>
  const m = it.meta
  const src = m?.source && SOURCES[m.source]
  const from = appName(it.app)

  return (
    <li ref={el} id={'m' + it.id} role="option" aria-selected={sel} className={'row' + (sel ? ' sel' : '')} onClick={() => onSelect(i)}>
      <span className="lead" title={it.app ?? undefined}>{from ? <AppIcon name={from} /> : <Icon name={it.kind} />}</span>
      <div className="body">
        {editing ? (
          <div className="edit">
            <textarea ref={ta} autoFocus defaultValue={it.content} rows={Math.min(10, it.content.split('\n').length + 1)}
              onFocus={e => e.currentTarget.setSelectionRange(it.content.length, it.content.length)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
                if (e.key === 'Enter' && e.metaKey) done()
              }} />
            <div className="btns">
              <button className="btn primary" onClick={done}>Save</button>
              <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : it.kind === 'screenshot' ? (
          <div className="shot">
            <button className="thumb" onClick={() => act.zoom(it)} aria-label="Open screenshot">
              <img loading="lazy" src={thumbUrl(it.file!)} alt="" />
            </button>
            <div className="cap">
              <b>{hl(winTitle(it.app) || from || 'Screenshot', q)}</b>
              <p className="ocr">{it.content.trim() ? hl(snip(it.content, q), q) : 'No text found'}</p>
            </div>
          </div>
        ) : it.kind === 'link' ? <Link it={it} q={q} />
          : it.kind === 'path' ? <code className="path"><Icon name="path" /><span><i>{hl(it.content.slice(0, cut + 1), q)}</i>{hl(it.content.slice(cut + 1), q)}</span></code>
          : it.kind === 'voice' ? (
            <div className="voice">
              {it.file && <Voice file={it.file} />}
              <div><Transcript text={shown} q={q} clamp={long && !open} /></div>
            </div>
          ) : <p className={'txt' + (long && !open ? ' clamp' : '')}>{hl(shown, q)}</p>}
        {long && !editing && it.kind !== 'screenshot' && <button className="more" onClick={e => { e.stopPropagation(); setOpen(!open) }}>{open ? 'Show less' : 'Show more'}</button>}
        {m?.cwd && !editing && (
          <p className="prov" title={[m.agent && `${m.agent} ${m.agent_version ?? ''}`, m.cwd, m.session && `session ${m.session}`].filter(Boolean).join('\n')}>
            {m.agent && <b>{m.agent}</b>}<Icon name="path" />{projectName(m.cwd)}
          </p>
        )}
      </div>
      <span className="meta">
        {all && <><Dot name={it.profile} />{it.profile}</>}
        {/* the hotbar is the usual way in and agents already show their name, so only the other sources get a glyph */}
        {src && (m?.source === 'cli' || m?.source === 'app') && <span title={'Saved from the ' + src[1].toLowerCase()}><Icon name={src[0]} /></span>}
        <time title={when(it.created_at).toLocaleString() + (src ? `\nSaved from ${m?.source === 'mcp' ? m.agent : 'the ' + src[1].toLowerCase()}` : '')}>{ago(it.created_at)}</time>
      </span>
      {!editing && <span className="acts">
        {it.kind === 'path' && tool('reveal', 'Reveal in Finder', () => act.reveal(it))}
        {tool('copy', 'Copy', () => act.copy(it))}
        {it.kind !== 'screenshot' && tool('edit', 'Edit', () => setEditing(true))}
        <label className="tool" title="Move to profile" onClick={e => e.stopPropagation()}>
          <Icon name="move" />
          <select value="" onChange={e => e.target.value && act.move(it, e.target.value)} aria-label="Move to profile">
            <option value="">Move to...</option>
            {profiles.filter(p => p !== it.profile).map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        {tool('trash', 'Delete', () => act.del(it))}
      </span>}
    </li>
  )
})

export function Detail({ it, act, onClose, step }: { it: Item; act: Act; onClose: () => void; step: (d: number) => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  const from = appName(it.app)
  return (
    <div className="detail" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="stage"><img src={fileUrl(it.file!)} alt="" /></div>
      <aside>
        <h2>{winTitle(it.app) || from || 'Screenshot'}</h2>
        <p className="from" title={when(it.created_at).toLocaleString()}>{from && <><AppIcon name={from} /><span>{from}</span></>}<span>{ago(it.created_at)}</span></p>
        <pre className="ocrfull">{it.content || 'No text found in this screenshot.'}</pre>
        <div className="btns">
          <button className="btn primary" onClick={() => act.copy(it)}>Copy text</button>
          <button className="btn" onClick={() => { act.del(it); onClose() }}>Delete</button>
          <span className="gap" />
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </aside>
    </div>
  )
}
