import type { ReactNode } from 'react'

const paths = {
  screenshot: <><rect x="2" y="3.5" width="12" height="9" rx="2" /><path d="M2.5 11l3-3 2.5 2.5 2-2 3.5 3.5" /></>,
  clip: <><rect x="3.5" y="3" width="9" height="10.5" rx="1.5" /><path d="M6 3v-.5h4V3M6 7h4M6 9.5h4" /></>,
  text: <path d="M3 4h10M3 8h10M3 12h6" />,
  voice: <path d="M3.5 6.5v3M6.2 4v8M8.9 2.5v11M11.6 5v6M14 7v2" />,
  path: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  link: <path d="M6.8 9.2l2.4-2.4M7.2 4.8l.9-.9a2.4 2.4 0 013.4 3.4l-.9.9M8.8 11.2l-.9.9a2.4 2.4 0 01-3.4-3.4l.9-.9" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></>,
  open: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 6.5h12" /></>,
  quit: <path d="M8 2v5.5M4.7 4.3a5 5 0 106.6 0" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
}
export type IconName = keyof typeof paths

export const Icon = ({ name }: { name: IconName }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">{paths[name]}</svg>
)

// Identity colour per profile: user and agent are fixed, others get a stable hue.
export const profileColor = (n: string) =>
  n === 'user' ? 'var(--accent)' : n === 'agent' ? 'var(--agent)'
    : `hsl(${[...n].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 40% 55%)`

export const Dot = ({ name }: { name: string }) => <i className="dot" style={{ background: profileColor(name) }} />

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// Highlight the words of the query inside text.
export function hl(text: string, q: string): ReactNode {
  const words = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return text
  return text.split(new RegExp(`(${words.join('|')})`, 'gi')).map((p, i) => i % 2 ? <mark key={i}>{p}</mark> : p)
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
export const when = (s: string) => new Date(s.replace(' ', 'T'))
export function ago(s: string) {
  const d = (Date.now() - when(s).getTime()) / 1000
  if (d < 45) return 'just now'
  if (d < 3600) return rtf.format(-Math.round(d / 60), 'minute')
  if (d < 86400) return rtf.format(-Math.round(d / 3600), 'hour')
  if (d < 7 * 86400) return rtf.format(-Math.floor(d / 86400), 'day')
  return when(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: when(s).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
