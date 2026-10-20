import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const paths = {
  screenshot: <><rect x="2" y="3.5" width="12" height="9" rx="2" /><path d="M2.5 11l3-3 2.5 2.5 2-2 3.5 3.5" /></>,
  area: <path d="M2.5 5.5v-2a1 1 0 011-1h2M10.5 2.5h2a1 1 0 011 1v2M13.5 10.5v2a1 1 0 01-1 1h-2M5.5 13.5h-2a1 1 0 01-1-1v-2M6 8h4M8 6v4" />,
  clip: <><rect x="3.5" y="3" width="9" height="10.5" rx="1.5" /><path d="M6 3v-.5h4V3M6 7h4M6 9.5h4" /></>,
  files: <path d="M5.5 2.5h4l2.5 2.5v6.5H5.5zM9.5 2.5V5H12M3.5 5v8.5H10" />,
  text: <path d="M3 4h10M3 8h10M3 12h6" />,
  voice: <path d="M3.5 6.5v3M6.2 4v8M8.9 2.5v11M11.6 5v6M14 7v2" />,
  path: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  link: <path d="M6.8 9.2l2.4-2.4M7.2 4.8l.9-.9a2.4 2.4 0 013.4 3.4l-.9.9M8.8 11.2l-.9.9a2.4 2.4 0 01-3.4-3.4l.9-.9" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></>,
  open: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 6.5h12" /></>,
  quit: <path d="M8 2v5.5M4.7 4.3a5 5 0 106.6 0" />,
  compose: <path d="M13 8.8v3.4a1.3 1.3 0 01-1.3 1.3H3.8a1.3 1.3 0 01-1.3-1.3V4.3A1.3 1.3 0 013.8 3h3.4M11.4 2.4a1.4 1.4 0 012 2L8.6 9.2l-2.5.7.7-2.5z" />,
  ctext: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 3.5v-.2a1 1 0 00-1-1H3.8a1 1 0 00-1 1v5.7a1 1 0 001 1h.2M7.8 8.3h3.4M7.8 10.7h2.2" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 3.5v-.2a1 1 0 00-1-1H3.8a1 1 0 00-1 1v5.7a1 1 0 001 1h.2" /></>,
  edit: <path d="M3 13l.6-2.8L10.8 3a1.6 1.6 0 012.2 2.2L5.8 12.4zM9.6 4.3l2.1 2.1" />,
  move: <path d="M2 4.5h4l1.5 1.5H14v6.5H2zM6.5 9.3h4M9 7.8l1.5 1.5L9 10.8" />,
  trash: <path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.3 4.5l.5 8.2h6.4l.5-8.2M6.8 7v3.8M9.2 7v3.8" />,
  reveal: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5v2.7a1 1 0 01-1 1H3.8a1 1 0 01-1-1V6a1 1 0 011-1h2.7" />,
  more: <><circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" /></>,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  play: <path d="M5.5 3.8v8.4L12.2 8z" />,
  pause: <path d="M5.5 3.8v8.4M10.5 3.8v8.4" />,
  filter: <path d="M2.5 4.5h11M4.8 8h6.4M7 11.5h2" />,
  caret: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  updown: <path d="M5.5 6.2L8 3.7l2.5 2.5M5.5 9.8L8 12.3l2.5-2.5" />,
  chevron: <path d="M6.5 4.5L10 8l-3.5 3.5" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M6.9 2h2.2l.4 1.6 1.2.5 1.4-.9 1.5 1.5-.9 1.4.5 1.2 1.6.4v2.2l-1.6.4-.5 1.2.9 1.4-1.5 1.5-1.4-.9-1.2.5-.4 1.6H6.9l-.4-1.6-1.2-.5-1.4.9-1.5-1.5.9-1.4-.5-1.2L2 9.1V6.9l1.6-.4.5-1.2-.9-1.4 1.5-1.5 1.4.9 1.2-.5z" /></>,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  hotbar: <><rect x="2" y="4.5" width="12" height="7" rx="2" /><path d="M5 8h3.5" /></>,
  term: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M5 6.5L7 8l-2 1.5M8.5 10H11" /></>,
  spark: <path d="M8 2.5v3.2M8 10.3v3.2M2.5 8h3.2M10.3 8h3.2M4.1 4.1l2.2 2.2M9.7 9.7l2.2 2.2M11.9 4.1L9.7 6.3M6.3 9.7l-2.2 2.2" />,
  stack: <path d="M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.2L8 11.2l5.5-3M2.5 10.7L8 13.7l5.5-3" />,
  plug: <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 01-7 0zM8 11v2.5" />,
}
export type IconName = keyof typeof paths

export const Icon = ({ name }: { name: IconName }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">{paths[name]}</svg>
)

// Where an item was saved from, meta.source.
export const SOURCES: Record<string, [IconName, string]> = {
  hotbar: ['hotbar', 'Hotbar'], app: ['open', 'umm window'], cli: ['term', 'Command line'], mcp: ['spark', 'Agent'],
}

// Profile identity colours come from the icon: user is teal, agent is blush, the rest rotate through blue, sand and deep teal.
const swatch = ['#9AD8F0', '#D6BC84', '#3E8F82']
export const profileColor = (n: string) =>
  n === 'user' ? 'var(--teal)' : n === 'agent' ? 'var(--blush)' : swatch[[...n].reduce((h, c) => h + c.charCodeAt(0), 0) % swatch.length]

export const Dot = ({ name }: { name: string }) => <i className="dot" style={{ background: profileColor(name) }} />

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>

// The installed app's icon, else a monogram in an icon colour. Names without an app are remembered, so each is asked for once.
const noIcon = new Set<string>()
const tones = ['#F29A8A', '#9AD8F0', '#D6BC84', '#5FB3A5']
export function AppIcon({ name }: { name: string }) {
  const [bad, setBad] = useState(noIcon.has(name))
  if (!name) return null
  const [a = name, b = a.slice(1)] = name.split(/[\s_.-]+/).filter(Boolean)
  return bad
    ? <i className="appic mono" style={{ background: tones[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7) % 4] }} aria-hidden="true">
        {(a[0] + (b[0] ?? '')).toUpperCase()}</i>
    : <img className="appic" src={'/api/icon?app=' + encodeURIComponent(name)} alt="" onError={() => { noIcon.add(name); setBad(true) }} />
}

// A shell command with a copy button.
export function Cmd({ text, copy }: { text: string; copy: (t: string) => Promise<unknown> }) {
  const [done, setDone] = useState(false)
  const run = () => copy(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }, () => {})
  return <div className="cmd"><code>{text}</code><button className="btn" onClick={run}><Icon name={done ? 'check' : 'copy'} />{done ? 'Copied' : 'Copy'}</button></div>
}

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
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as Element).closest?.('[role=menu]')) { e.stopPropagation(); setOpen(false) } }
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

// Fixed position next to an anchor rect: below (or above when there is no room), inside the window.
function place(m: HTMLElement, r: DOMRect, center = false) {
  const w = m.offsetWidth, h = m.offsetHeight
  const x = center ? r.left + r.width / 2 - w / 2 : r.left
  m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px'
  m.style.top = (r.bottom + 4 + h <= innerHeight - 8 ? r.bottom + 4 : r.top - 4 - h >= 8 ? r.top - 4 - h : Math.max(8, innerHeight - 8 - h)) + 'px'
}

// One tooltip for the window, instead of WebKit's slow title tooltip. Any element with data-tip shows it at once
// on hover, data-keys is its shortcut. A click, a key or scrolling hides it until the pointer moves to another element.
export function Tips() {
  const [t, setT] = useState<{ el: HTMLElement; text: string; keys?: string } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cur: Element | null = null
    const hide = () => setT(null)
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>('[data-tip]') ?? null
      if (el === cur) return
      cur = el
      setT(el?.dataset.tip ? { el, text: el.dataset.tip, keys: el.dataset.keys } : null)
    }
    const out = (e: MouseEvent) => { if (!e.relatedTarget) { cur = null; hide() } }  // the pointer left the window
    const evs: [string, EventListener][] = [['mouseover', over as EventListener], ['mouseout', out as EventListener], ['mousedown', hide], ['keydown', hide], ['scroll', hide], ['blur', hide]]
    evs.forEach(([n, f]) => window.addEventListener(n, f, true))
    return () => evs.forEach(([n, f]) => window.removeEventListener(n, f, true))
  }, [])
  useLayoutEffect(() => { if (t) place(box.current!, t.el.getBoundingClientRect(), true) }, [t])
  return t && <div ref={box} className="tip" role="tooltip">{t.text}{t.keys && <kbd>{t.keys}</kbd>}</div>
}

// A macOS style pop-up menu. With value it is a select: the current item has a check.
// Arrows move, Enter or Space picks, Esc or Tab closes, typing jumps to an item.
export type Opt = { value: string; label: ReactNode; text?: string; danger?: boolean; disabled?: boolean }
export function Menu({ options, value, onPick, label, className = 'pick', tip, keys, children }: {
  options: Opt[]; value?: string; onPick: (v: string) => void; label: string; className?: string; tip?: string; keys?: string; children: ReactNode
}) {
  const [at, setAt] = useState<number | null>(null)  // the highlighted item while open, null when closed
  const btn = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const typed = useRef({ s: '', t: 0 })
  const open = at !== null
  const show = () => setAt(options.findIndex(o => o.value === value && !o.disabled))  // -1: open, nothing highlighted
  const close = (focus = true) => { setAt(null); if (focus) btn.current?.focus() }
  const pick = (o?: Opt) => { if (o && !o.disabled) { close(); onPick(o.value) } }
  useLayoutEffect(() => { if (open) { place(box.current!, btn.current!.getBoundingClientRect()); box.current!.focus() } }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) close(false) }
    window.addEventListener('resize', away); window.addEventListener('scroll', away, true)
    return () => { window.removeEventListener('resize', away); window.removeEventListener('scroll', away, true) }
  })
  const key = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    const n = options.length
    const step = (d: number) => {
      const i = at! >= 0 ? at! : d > 0 ? -1 : n
      for (let k = 1; k <= n; k++) if (!options[(i + d * k + n * k) % n].disabled) return setAt((i + d * k + n * k) % n)
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') step(e.key === 'ArrowDown' ? 1 : -1)
    else if (e.key === 'Enter' || e.key === ' ') pick(options[at!])
    else if (e.key === 'Escape' || e.key === 'Tab') close()
    else if (e.key.length === 1 && !e.metaKey) {
      const ty = typed.current
      ty.s = (Date.now() - ty.t < 700 ? ty.s : '') + e.key.toLowerCase(); ty.t = Date.now()
      const j = options.findIndex(o => !o.disabled && (o.text ?? String(o.label)).toLowerCase().startsWith(ty.s))
      if (j >= 0) setAt(j)
    } else return
    e.preventDefault()
  }
  return <>
    <button ref={btn} type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={open} data-tip={open ? undefined : tip} data-keys={keys}
      onMouseDown={e => open && e.preventDefault()} onClick={() => (open ? close() : show())}
      onKeyDown={e => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); show() } }}>{children}</button>
    {open && <div ref={box} role="menu" aria-label={label} tabIndex={-1} className={'menu' + (value === undefined ? '' : ' checks')}
      onKeyDown={key} onBlur={e => !box.current?.contains(e.relatedTarget) && close(false)}>
      {options.map((o, i) => (
        <button key={o.value} type="button" tabIndex={-1} role={value === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={value === undefined ? undefined : o.value === value}
          className={(i === at ? 'at' : '') + (o.danger ? ' danger' : '')} disabled={o.disabled}
          onMouseDown={e => e.preventDefault()} onMouseMove={() => !o.disabled && at !== i && setAt(i)} onClick={() => pick(o)}>
          {value !== undefined && (o.value === value ? <Icon name="check" /> : <i className="nocheck" />)}{o.label}
        </button>
      ))}
    </div>}
  </>
}

// Highlight the query words. Search matches word prefixes, so only a word's start is marked.
export function hl(text: string, q: string): ReactNode {
  const words = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length || text.length > 20000) return text
  // split gives text, the char before a match, the match, text, ...
  return text.split(new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])(${words.join('|')})`, 'giu')).map((p, i) => i % 3 === 2 ? <mark key={i}>{p}</mark> : p)
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
export const when = (s: string) => new Date(s.replace(' ', 'T'))
// Mail style list time: 14:52 today, then Yesterday, a weekday, a date.
export function stamp(s: string) {
  const d = when(s), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5)
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (days < 2) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
export const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
export const full = (s: string) => when(s).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
export function ago(s: string) {
  const d = (Date.now() - when(s).getTime()) / 1000
  if (d < 45) return 'just now'
  if (d < 3600) return rtf.format(-Math.round(d / 60), 'minute')
  if (d < 86400) return rtf.format(-Math.round(d / 3600), 'hour')
  if (d < 7 * 86400) return rtf.format(-Math.floor(d / 86400), 'day')
  return when(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: when(s).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
