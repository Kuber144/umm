import { useEffect, useState } from 'react'

type Item = { id: number; kind: string; content: string; file: string | null; app: string | null; created_at: string }

const api = (path: string, body?: object, method = body ? 'POST' : 'GET') =>
  fetch('/api/' + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json())

export default function App() {
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [profiles, setProfiles] = useState({ active: '', all: [] as string[] })

  const load = () => api(`items?q=${encodeURIComponent(q)}`).then(setItems)
  useEffect(() => { api('profiles').then(setProfiles) }, [])
  useEffect(() => { load() }, [q, profiles.active])
  // hotkey captures happen while this tab is in the background, so refresh on return
  useEffect(() => { window.addEventListener('focus', load); return () => window.removeEventListener('focus', load) })

  const switchProfile = async (name: string) => {
    if (name === '+') name = prompt('New profile name')?.trim() || ''
    if (!name) return
    await api('profiles', { name })
    setProfiles(await api('profiles'))
  }

  const save = async () => {
    if (!draft.trim()) return
    await api('items', { content: draft })
    setDraft('')
    load()
  }

  return (
    <main>
      <header>
        <select value={profiles.active} onChange={e => switchProfile(e.target.value)}>
          {profiles.all.map(p => <option key={p}>{p}</option>)}
          <option value="+">+ new profile</option>
        </select>
        <input placeholder="search" value={q} onChange={e => setQ(e.target.value)} autoFocus />
      </header>
      <header>
        <input placeholder="remember a note, folder path or link, press enter" value={draft}
          onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
      </header>
      <ul>
        {items.map(it => (
          <li key={it.id}>
            <div className="meta">
              <span>{it.kind} · {it.created_at}{it.app && ` · ${it.app}`}</span>
              <button onClick={() => api(`items/${it.id}`, undefined, 'DELETE').then(load)}>delete</button>
            </div>
            {it.file && <a href={`/api/shots/${it.file}`} target="_blank"><img loading="lazy" src={`/api/shots/${it.file}`} /></a>}
            {it.kind === 'link' ? <p><a href={it.content.split(' ')[0]} target="_blank">{it.content}</a></p>
              : it.kind === 'path' ? <p><code title="click to copy" onClick={() => navigator.clipboard.writeText(it.content)}>{it.content}</code></p>
              : <p>{it.file ? it.content.slice(0, 300) : it.content}</p>}
          </li>
        ))}
      </ul>
    </main>
  )
}
