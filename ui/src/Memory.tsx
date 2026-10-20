import { useEffect, useRef, useState } from 'react'
import { fileUrl, type Item } from './api'
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

// Short piece of text around the first match, so a long OCR dump shows why it matched.
function snip(text: string, q: string, n = 240) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const w = q.split(/\s+/).find(Boolean)
  const at = w ? flat.toLowerCase().indexOf(w.toLowerCase()) : -1
  const from = Math.max(0, at - 60)
  return (from ? '... ' : '') + flat.slice(from, from + n) + (flat.length > from + n ? ' ...' : '')
}

function Voice({ file }: { file: string }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => () => { if (src) URL.revokeObjectURL(src) }, [src])
  const load = () => fetch(fileUrl(file)).then(r => r.blob()).then(b => setSrc(URL.createObjectURL(b)), () => setFailed(true))
  return src ? <audio src={src} controls autoPlay /> : <button className="btn" onClick={load}>{failed ? 'Could not load, retry' : 'Play recording'}</button>
}

function Link({ content, q }: { content: string; q: string }) {
  const [url, ...rest] = content.split(/\s+/)
  let host = url, tail = ''
  try { const u = new URL(url); host = u.host.replace(/^www\./, ''); tail = (u.pathname + u.search).replace(/^\/$/, '') } catch { /* show raw */ }
  const site = /youtu\.?be/.test(host) ? 'YouTube' : /^(x|twitter)\.com$/.test(host) ? 'X post' : ''
  return <>
    <a className="link" href={url} onClick={e => { e.preventDefault(); send({ type: 'openExternal', url }) }}>
      <b>{hl(site || host, q)}</b>{site && <span> {host}</span>}<span className="dim">{hl(tail, q)}</span>
    </a>
    {rest.length > 0 && <p className="txt">{hl(rest.join(' '), q)}</p>}
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
  const text = <p className={'txt' + (long && !open ? ' clamp' : '')}>{hl(it.content, q)}</p>
  const i = it.content.lastIndexOf('/')

  const edit = () => {
    const done = () => (ta.current!.value.trim() !== it.content ? act.save(it, ta.current!.value) : Promise.resolve()).then(() => setEditing(false))
    return <div className="edit">
      <textarea ref={ta} autoFocus defaultValue={it.content} rows={Math.min(10, it.content.split('\n').length + 1)}
        onFocus={e => e.currentTarget.setSelectionRange(it.content.length, it.content.length)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
          if (e.key === 'Enter' && e.metaKey) done()
        }} />
      <div className="editbar">
        <button className="btn primary" onClick={done}>Save</button>
        <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
        <span className="dim">Cmd+Enter saves, Esc cancels</span>
      </div>
    </div>
  }

  return (
    <li ref={el} className={'row' + (sel ? ' sel' : '')} onClick={onSelect}>
      <div className="gut"><Icon name={it.kind === 'text' ? 'text' : it.kind} /><time title={when(it.created_at).toLocaleString()}>{ago(it.created_at)}</time></div>
      <div className="body">
        {editing ? edit() : it.kind === 'screenshot' ? (
          <div className="shot">
            <button className="thumb" onClick={() => act.zoom(it)} aria-label="Open screenshot">
              <img loading="lazy" src={fileUrl(it.file!)} alt="" />
            </button>
            <p className="txt ocr">{hl(snip(it.content, q), q) || <span className="dim">No text found</span>}</p>
          </div>
        ) : it.kind === 'link' ? <Link content={it.content} q={q} />
          : it.kind === 'path' ? <code className="path"><span className="dim">{hl(it.content.slice(0, i + 1), q)}</span>{hl(it.content.slice(i + 1), q)}</code>
          : <>{text}{it.kind === 'voice' && it.file && <Voice file={it.file} />}</>}
        {long && !editing && it.kind !== 'screenshot' && <button className="more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
        <div className="meta">
          {all && <span className="ptag"><Dot name={it.profile} />{it.profile}</span>}
          {it.app && <span className="app">{it.app}</span>}
          <div className="acts">
          {it.kind === 'path' && <button className="btn" onClick={() => act.reveal(it)}>Reveal</button>}
          <button className="btn" onClick={() => act.copy(it)}>Copy</button>
          {it.kind !== 'screenshot' && !editing && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
          <label className="btn sel-move">Move
            <select value="" onChange={e => e.target.value && act.move(it, e.target.value)} aria-label="Move to profile">
              <option value="">Move to...</option>
              {profiles.filter(p => p !== it.profile).map(p => <option key={p}>{p}</option>)}
            </select>
          </label>
          <button className="btn danger" onClick={() => act.del(it)}>Delete</button>
          </div>
        </div>
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
        <div className="dhead"><b>{ago(it.created_at)}</b><span className="dim">{when(it.created_at).toLocaleString()}</span>
          {it.app && <span className="dim">{it.app}</span>}</div>
        <pre className="ocrfull">{it.content || 'No text found in this screenshot.'}</pre>
        <div className="editbar">
          <button className="btn primary" onClick={() => act.copy(it)}>Copy text</button>
          <button className="btn danger" onClick={() => { act.del(it); onClose() }}>Delete</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </aside>
    </div>
  )
}
