export type Kind = 'screenshot' | 'text' | 'path' | 'link' | 'voice'
export type Meta = { agent?: string; agent_version?: string; cwd?: string; session?: string }
export type Item = { id: number; profile: string; kind: Kind; content: string; file: string | null; app: string | null; meta?: Meta | null; created_at: string }
export type Rec = { on: boolean; seconds: number; transcribing: number }
export type Profiles = { active: string; all: { name: string; count: number }[] }
export type Ctx = { app: string; profile: string; clipboard: string; clipboard_kind: 'text' | 'image' | 'files' | null; recording: Rec }
type Params = Record<string, string | number | undefined>

const call = <T = object>(path: string, method = 'GET', body?: object): Promise<T> =>
  fetch('/api/' + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body && JSON.stringify(body) })
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })

const qs = (p: Params) => new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString()

export const fileUrl = (name: string) => '/api/files/' + encodeURIComponent(name)
export const thumbUrl = (name: string) => '/api/thumb/' + encodeURIComponent(name)

export const api = {
  items: (p: Params) => call<Item[]>('items?' + qs(p)),
  apps: (profile: string) => call<{ app: string; count: number }[]>('apps?' + qs({ profile })),
  add: (content: string, app?: string) => call<{ id: number }>('items', 'POST', { content, app }),
  edit: (id: number, patch: { content?: string; profile?: string }) => call('items/' + id, 'PATCH', patch),
  del: (id: number) => call('items/' + id, 'DELETE'),
  capture: (app?: string, area?: boolean) => call('capture', 'POST', { app, area }),
  saveClipboard: (app?: string) => call('clipboard', 'POST', { app }),
  context: () => call<Ctx>('context'),
  profiles: () => call<Profiles>('profiles'),
  setProfile: (name: string) => call('profiles', 'POST', { name }),
  renameProfile: (from: string, to: string) => call('profiles/rename', 'POST', { from, to }),
  delProfile: (name: string) => call('profiles/' + encodeURIComponent(name), 'DELETE'),
  record: () => call<Rec>('record'),
  recStart: (app?: string) => call<Rec>('record/start', 'POST', { app }),
  recStop: () => call<Rec>('record/stop', 'POST'),
  copy: (text: string) => call('copy', 'POST', { text }),
  reveal: (text: string) => call('reveal', 'POST', { text }),
}
