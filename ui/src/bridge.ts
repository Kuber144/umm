import { api, type Ctx } from './api'

type Msg =
  | { type: 'hide' | 'saved' | 'error' | 'capture' | 'quit' }
  | { type: 'openMain'; query?: string }
  | { type: 'recording'; on: boolean }
  | { type: 'resize'; height: number }
  | { type: 'openExternal'; url: string }

declare global {
  interface Window {
    webkit?: { messageHandlers?: { umm?: { postMessage(m: Msg): void } } }
    ummShow?: (c: Ctx) => void
    ummOpen?: (o: { query?: string }) => void
  }
}

const handler = window.webkit?.messageHandlers?.umm
export const native = !!handler

// Swift may call these before React mounts, so keep the last call until a view takes it.
export const pending: { show?: Ctx; open?: { query?: string } } = {}
window.ummShow = c => { pending.show = c }
window.ummOpen = o => { pending.open = o }

export function send(m: Msg) {
  if (handler) return handler.postMessage(m)
  if (m.type === 'capture') api.capture().catch(() => {})
  else if (m.type === 'openExternal') window.open(m.url, '_blank', 'noopener')
  else if (m.type === 'openMain') {
    location.hash = ''
    setTimeout(() => window.ummOpen?.({ query: m.query }), 60)
  }
}
