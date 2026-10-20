import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 3.5v-.2a1 1 0 00-1-1H3.8a1 1 0 00-1 1v5.7a1 1 0 001 1h.2" /></>,
  edit: <path d="M3 13l.6-2.8L10.8 3a1.6 1.6 0 012.2 2.2L5.8 12.4zM9.6 4.3l2.1 2.1" />,
  move: <path d="M2 4.5h4l1.5 1.5H14v6.5H2zM6.5 9.3h4M9 7.8l1.5 1.5L9 10.8" />,
  trash: <path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.3 4.5l.5 8.2h6.4l.5-8.2M6.8 7v3.8M9.2 7v3.8" />,
  reveal: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5v2.7a1 1 0 01-1 1H3.8a1 1 0 01-1-1V6a1 1 0 011-1h2.7" />,
  more: <><circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" /></>,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  play: <path d="M5.5 3.8v8.4L12.2 8z" />,
  filter: <path d="M2.5 4.5h11M4.8 8h6.4M7 11.5h2" />,
  caret: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
}
export type IconName = keyof typeof paths

export const Icon = ({ name }: { name: IconName }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">{paths[name]}</svg>
)

// Profile identity colours come from the icon: user is teal, agent is blush, the rest rotate through blue, sand and deep teal.
const swatch = ['#9AD8F0', '#D6BC84', '#3E8F82']
export const profileColor = (n: string) =>
  n === 'user' ? 'var(--teal)' : n === 'agent' ? 'var(--blush)' : swatch[[...n].reduce((h, c) => h + c.charCodeAt(0), 0) % swatch.length]

export const Dot = ({ name }: { name: string }) => <i className="dot" style={{ background: profileColor(name) }} />

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// A small popover: closes on outside click or Escape.
export function Pop({ trigger, children }: {
  trigger: (toggle: () => void, open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true) }
  }, [open])
  return (
    <div className="pop" ref={ref}>
      {trigger(() => setOpen(o => !o), open)}
      {open && <div className="popbody">{children(() => setOpen(false))}</div>}
    </div>
  )
}

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
