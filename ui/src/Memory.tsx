import { useEffect, useRef, useState } from 'react'
import { fileUrl, thumbUrl, type Item, type LinkInfo } from './api'
import { send } from './bridge'
import { Dot, Icon, ago, hl, when } from './ui'

export type Act = {
  copy: (it: Item) => void
  reveal: (it: Item) => void
  del: (it: Item) => void
  move: (it: Item, profile: string) => void
  save: (it: Item, content: string) => Promise<void>
  zoom: (it: Item) => void
}

export const copyText = (it: Item) => (it.kind === 'link' ? it.content.split(/\s+/)[0] : it.content)
// Where an agent memory came from: the project folder, with the full detail on hover.
export const projectName = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/')
const appName = (a: string | null) => a?.split(':')[0] ?? ''
const winTitle = (a: string | null) => a?.split(/:\s*/).slice(1).join(': ') || ''

// Short piece of text around the first match, so a long OCR dump shows why it matched.
function snip(text: string, q: string, n = 150) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const w = q.split(/\s+/).find(Boolean)
  const at = w ? flat.toLowerCase().indexOf(w.toLowerCase()) : -1
  const from = Math.max(0, at - 40)
  return (from ? '... ' : '') + flat.slice(from, from + n) + (flat.length > from + n ? ' ...' : '')
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
  const open = (e: React.MouseEvent) => { e.preventDefault(); send({ type: 'openExternal', url }) }
  const site = /youtu\.?be/.test(host) ? 'YouTube' : /^(x|twitter)\.com$/.test(host) ? 'X post' : ''
  return <>
    {l ? (
      <a className="card" href={url} onClick={open}>
        <span className="site">{it.meta?.icon ? <img className="fav" src={fileUrl(it.meta.icon)} alt="" /> : <Icon name="link" />}{hl(l.site ?? host, q)}{l.author && <span> {hl(l.author, q)}</span>}</span>
        {l.title && <b>{hl(l.title, q)}</b>}
        {l.text && <span className="desc">{hl(l.text, q)}</span>}
        <span className="url">{hl(url, q)}</span>
      </a>
    ) : (
      <a className="link" href={url} onClick={open}>
        <Icon name="link" /><b>{hl(site || host, q)}</b>{site && <span> {host}</span>}<span>{hl(tail, q)}</span>
      </a>
    )}
    {note && <p className="txt">{hl(note, q)}</p>}
  </>
}

export function Row({ it, q, sel, all, profiles, act, onSelect }: {
  it: Item; q: string; sel: boolean; all: boolean; profiles: string[]; act: Act; onSelect: () => void
}) {
  const el = useRef<HTMLLIElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (sel) el.current?.scrollIntoView({ block: 'nearest' }) }, [sel])
  const long = it.content.length > 360 || it.content.split('\n').length > 6
  const i = it.content.lastIndexOf('/')
  const done = () => (ta.current!.value.trim() !== it.content ? act.save(it, ta.current!.value) : Promise.resolve()).then(() => setEditing(false))
  const tool = (icon: Parameters<typeof Icon>[0]['name'], label: string, fn: () => void) =>
    <button className="tool" title={label} aria-label={label} onClick={e => { e.stopPropagation(); fn() }}><Icon name={icon} /></button>

  return (
    <li ref={el} className={'row' + (sel ? ' sel' : '')} onClick={onSelect}>
      <div className="gut">
        <time title={when(it.created_at).toLocaleString()}>{ago(it.created_at)}</time>
        <div className="line">
          {all ? <span className="from" title={it.app ?? undefined}><Dot name={it.profile} />{it.profile}</span>
            : it.app && <span className="from" title={it.app}>{appName(it.app)}</span>}
          <span className="acts">
            {it.kind === 'path' && tool('reveal', 'Reveal in Finder', () => act.reveal(it))}
            {tool('copy', 'Copy', () => act.copy(it))}
            {it.kind !== 'screenshot' && tool('edit', 'Edit', () => setEditing(true))}
            <label className="tool" title="Move to profile">
              <Icon name="move" />
              <select value="" onChange={e => e.target.value && act.move(it, e.target.value)} aria-label="Move to profile">
                <option value="">Move to...</option>
                {profiles.filter(p => p !== it.profile).map(p => <option key={p}>{p}</option>)}
              </select>
            </label>
            {tool('trash', 'Delete', () => act.del(it))}
          </span>
        </div>
      </div>
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
              <b>{hl(winTitle(it.app) || appName(it.app) || 'Screenshot', q)}</b>
              <p className="ocr">{hl(snip(it.content, q), q) || 'No text found'}</p>
            </div>
          </div>
        ) : it.kind === 'link' ? <Link it={it} q={q} />
          : it.kind === 'path' ? <code className="path"><Icon name="path" /><span><i>{hl(it.content.slice(0, i + 1), q)}</i>{hl(it.content.slice(i + 1), q)}</span></code>
          : <div className={it.kind === 'voice' ? 'voice' : undefined}>
              {it.kind === 'voice' && it.file && <Voice file={it.file} />}
              <div>
                <p className={'txt' + (long && !open ? ' clamp' : '')}>{hl(it.content, q)}</p>
                {long && <button className="more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
              </div>
            </div>}
        {it.meta?.cwd && !editing && (
          <p className="prov" title={[it.meta.agent && `${it.meta.agent} ${it.meta.agent_version ?? ''}`, it.meta.cwd, it.meta.session && `session ${it.meta.session}`].filter(Boolean).join('\n')}>
            <Icon name="path" />{projectName(it.meta.cwd)}
          </p>
        )}
      </div>
    </li>
  )
}

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
  return (
    <div className="detail" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="stage"><img src={fileUrl(it.file!)} alt="" /></div>
      <aside>
        <h2>{winTitle(it.app) || appName(it.app) || 'Screenshot'}</h2>
        <p className="dim" title={when(it.created_at).toLocaleString()}>{appName(it.app)}{it.app ? ', ' : ''}{ago(it.created_at)}</p>
        <pre className="ocrfull">{it.content || 'No text found in this screenshot.'}</pre>
        <div className="btns">
          <button className="btn primary" onClick={() => act.copy(it)}>Copy text</button>
          <button className="btn" onClick={() => { act.del(it); onClose() }}>Delete</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </aside>
    </div>
  )
}
