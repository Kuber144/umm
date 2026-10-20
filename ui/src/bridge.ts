import { api, type Ctx } from './api'

type Msg =
  | { type: 'hide' | 'quit' }
  | { type: 'paste'; detail?: string }
  | { type: 'saved' | 'error'; label?: string; detail?: string; kind?: string }
  | { type: 'capture' | 'area'; note?: string; record?: boolean }
  | { type: 'openMain'; query?: string }
  | { type: 'recording'; on: boolean }
  | { type: 'resize'; height: number }
  | { type: 'appearance'; mode?: string }
  | { type: 'openExternal'; url: string }
  | { type: 'loginItem'; on: boolean }
  | { type: 'settings' | 'chooseFolder' | 'accessibility' }

declare global {
  interface Window {
    webkit?: { messageHandlers?: { umm?: { postMessage(m: Msg): void } } }
    ummShow?: (c: Ctx, mode?: string) => void
    ummSettings?: (s: { loginItem?: 'on' | 'approval' | 'off' | 'missing'; version?: string; accessibility?: boolean }) => void
    ummFolder?: (path: string) => void
    ummDrop?: (d: { paths: string[] }) => void
    ummOpen?: (o: { query?: string }) => void
  }
}

const handler = window.webkit?.messageHandlers?.umm
export const native = !!handler

// Swift may call these before React mounts, so keep the last call until a view takes it.
export const pending: { show?: Ctx; mode?: string; open?: { query?: string } } = {}
window.ummShow = (c, mode) => { pending.show = c; pending.mode = mode }
window.ummOpen = o => { pending.open = o }

export function send(m: Msg) {
  if (handler) return handler.postMessage(m)
  if (m.type === 'capture' || m.type === 'area') api.capture(undefined, m.type === 'area', m.note).catch(() => {})
  else if (m.type === 'openExternal') window.open(m.url, '_blank', 'noopener')
  else if (m.type === 'openMain') {
    location.hash = ''
    setTimeout(() => window.ummOpen?.({ query: m.query }), 60)
  }
}
