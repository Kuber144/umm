export type Kind = 'screenshot' | 'text' | 'path' | 'link' | 'voice'
export type Source = 'hotbar' | 'app' | 'cli' | 'mcp'
export type LinkInfo = { site?: string; title?: string; author?: string; text?: string }
export type Meta = { source?: Source; agent?: string; agent_version?: string; cwd?: string; session?: string; link?: LinkInfo; icon?: string | null; url?: string; transcribing?: boolean }
export type Item = { id: number; profile: string; kind: Kind; content: string; file: string | null; app: string | null; meta?: Meta | null; created_at: string }
export type Rec = { on: boolean; seconds: number; transcribing: number }
export type Profiles = { active: string; all: { name: string; count: number }[] }
export type Ctx = { app: string; profile: string; clipboard: string; clipboard_kind: 'text' | 'image' | 'files' | null; recording: Rec; url?: string | null }
export type Settings = { languages: string[]; model: 'small' | 'medium'; enrich_links: boolean; excluded_apps: string[]; screenshot_days?: number }
export type Storage = { path: string; bytes: number; kinds: Partial<Record<Kind, number>> }
export type Origin = { source: Source | null; agent: string | null; cwd: string | null; count: number }
export type Agent = { agent: string; agent_version?: string; cwd: string; session: string; started: string; last_seen: string; connected: boolean; memories: number }
type Params = Record<string, string | number | undefined>

const call = <T = object>(path: string, method = 'GET', body?: object): Promise<T> =>
  fetch('/api/' + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body && JSON.stringify(body) })
    .then(async r => {
      if (r.ok) return r.json()
      const d = (await r.json().catch(() => null))?.detail  // FastAPI errors carry {detail}
      throw new Error(typeof d === 'string' ? d : r.statusText)
    })

const qs = (p: Params) => new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString()

export const fileUrl = (name: string) => '/api/files/' + name.split('/').map(encodeURIComponent).join('/')

export const api = {
  items: (p: Params) => call<Item[]>('items?' + qs(p)),
  apps: (profile: string) => call<{ app: string; count: number }[]>('apps?' + qs({ profile })),
  origins: (profile: string) => call<Origin[]>('origins?' + qs({ profile })),
  add: (content: string, source: Source, app?: string, profile?: string, url?: string | null) => call<{ id: number }>('items', 'POST', { content, app, profile, meta: { source, url: url || undefined } }),
  edit: (id: number, patch: { content?: string; profile?: string }) => call('items/' + id, 'PATCH', patch),
  del: (id: number) => call('items/' + id, 'DELETE'),
  capture: (app?: string, area?: boolean) => call('capture', 'POST', { app, area }),
  saveClipboard: (app?: string, source: Source = 'hotbar', profile?: string, url?: string | null) => call('clipboard', 'POST', { app, profile, meta: { source, url: url || undefined } }),
  import: (path: string, profile?: string) => call<{ id: number }>('import', 'POST', { path, profile }),
  copyImage: (id: number) => call('copy-image', 'POST', { id }),
  open: (id: number, reveal?: boolean) => call('open', 'POST', { id, reveal }),
  context: () => call<Ctx>('context'),
  profiles: () => call<Profiles>('profiles'),
  setProfile: (name: string) => call('profiles', 'POST', { name }),
  renameProfile: (from: string, to: string) => call('profiles/rename', 'POST', { from, to }),
  delProfile: (name: string) => call('profiles/' + encodeURIComponent(name), 'DELETE'),
  record: () => call<Rec>('record'),
  recStart: (source: Source, app?: string) => call<Rec>('record/start', 'POST', { app, meta: { source } }),
  recStop: () => call<Rec>('record/stop', 'POST'),
  copy: (text: string) => call('copy', 'POST', { text }),
  settings: () => call<Settings>('settings'),
  setSettings: (patch: Partial<Settings>) => call<Settings>('settings', 'PATCH', patch),
  storage: () => call<Storage>('storage'),
  moveStorage: (path: string) => call<{ path: string }>('storage/move', 'POST', { path }),
  reveal: (text: string) => call('reveal', 'POST', { text }),
  agents: () => call<Agent[]>('agents'),
  setup: () => call<{ mcp: string; cli: string }>('setup'),
}
