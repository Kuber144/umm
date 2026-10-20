import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Profiles, type Settings as Conf, type Storage } from './api'
import { native, send } from './bridge'
import { Cmd, Dot, Icon, Kbd, home } from './ui'
import './settings.css'

const LANGS: [string, string][] = [['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ru', 'Russian']]
const MODELS = { small: 'Faster, lighter, misses more words.', medium: 'More accurate. Uses about 2 GB while it runs.' }
const DAYS: [number, string][] = [[0, 'Forever'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']]
const KIND_NAMES = { screenshot: 'screenshot', text: 'note', path: 'path', link: 'link', voice: 'recording' }
const size = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(1)} GB`)

const Row = ({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) => (
  <div className={'srow' + (wide ? ' wide' : '')}><div className="lbl"><b>{label}</b>{hint && <span>{hint}</span>}</div><div className="ctl">{children}</div></div>
)
const Group = ({ title, children }: { title: string; children: ReactNode }) => <section><h2>{title}</h2><div className="group">{children}</div></section>
const Switch = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
  <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => set(!on)}><i /></button>
)
const Pick = ({ value, set, label, children, dot }: { value: string | number; set: (v: string) => void; label: string; children: ReactNode; dot?: string }) => (
  <label className="pick">{dot && <Dot name={dot} />}
    <select value={value} onChange={e => set(e.target.value)} aria-label={label}>{children}</select><Icon name="caret" />
  </label>
)

// Moving the data folder: pick a parent, the data goes into <parent>/umm. The backend restarts there,
// so this polls GET /api/storage until the path changes.
function Move({ from, done }: { from: string; done: (s: Storage) => void }) {
  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState('')
  const [state, setState] = useState<{ moving?: number; err?: string }>({})
  const timer = useRef(0)
  useEffect(() => () => clearInterval(timer.current), [])
  useEffect(() => {
    window.ummFolder = p => { if (p) setDir(p) }
    return () => { window.ummFolder = undefined }
  }, [])
  const target = dir.trim() ? dir.trim().replace(/\/+$/, '') + '/umm' : ''
  const move = () => {
    setState({ moving: 0 })
    api.moveStorage(target).then(() => {
      const start = Date.now()
      timer.current = window.setInterval(() => {
        const s = Math.round((Date.now() - start) / 1000)
        if (s > 60) { clearInterval(timer.current); setState({ err: 'umm did not come back after 60 seconds. Your data is safe. Quit and open umm again.' }); return }
        setState({ moving: s })
        api.storage().then(st => { if (st.path !== from) { clearInterval(timer.current); setState({}); setOpen(false); setDir(''); done(st) } }, () => {})
      }, 1000)
    }, e => setState({ err: e.message === 'Not Found' ? 'This version of umm cannot move its data yet.' : e.message }))
  }
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Change...</button>
  return (
    <div className="move">
      <div className="pathin">
        <input autoFocus value={dir} onChange={e => setDir(e.target.value)} placeholder="Folder, for example ~/Documents" aria-label="New folder" spellCheck={false} disabled={state.moving !== undefined} />
        {native && <button className="btn" onClick={() => send({ type: 'chooseFolder' })} disabled={state.moving !== undefined}>Choose...</button>}
      </div>
      {state.moving !== undefined
        ? <div className="moving"><i className="bar" /><span>Moving to {home(target)}. umm restarts when it is done. {state.moving}s</span></div>
        : <>
          {target && <p className="to">Data will move to <code>{home(target)}</code></p>}
          {state.err && <p className="err">{state.err}</p>}
          <div className="btns">
            <button className="btn" onClick={() => { setOpen(false); setState({}) }}>Cancel</button>
            <button className="btn primary" disabled={!target} onClick={move}>Move data</button>
          </div>
        </>}
    </div>
  )
}

export default function Settings({ profiles, onActive }: { profiles: Profiles; onActive: (name: string) => void }) {
  const [s, setS] = useState<Conf | null>(null)
  const [store, setStore] = useState<Storage | null>(null)
  const [mac, setMac] = useState<{ loginItem?: string; version?: string; accessibility?: boolean }>({})
  const [err, setErr] = useState(false)
  const [setup, setSetup] = useState<{ mcp: string; cli: string } | null>(null)

  useEffect(() => {
    api.settings().then(setS, () => setErr(true))
    api.storage().then(setStore, () => {})
    api.setup().then(setSetup, () => {})
    if (!native) return
    // ask again on focus, so a permission granted in System Settings shows up
    const ask = () => send({ type: 'settings' })
    window.ummSettings = setMac; ask()
    window.addEventListener('focus', ask)
    return () => { window.ummSettings = undefined; window.removeEventListener('focus', ask) }
  }, [])

  const patch = (p: Partial<Conf>) => {
    setErr(false)
    setS(c => c && { ...c, ...p })
    api.setSettings(p).then(setS, () => { setErr(true); api.settings().then(setS, () => {}) })
  }
  const addApp = (v: string) => {
    const name = v.trim()
    if (name && s && !s.excluded_apps.some(a => a.toLowerCase() === name.toLowerCase())) patch({ excluded_apps: [...s.excluded_apps, name] })
  }
  const loginOn = mac.loginItem === 'on' || mac.loginItem === 'approval'

  return (
    <main className="settings">
      <header className="top">
        <div className="title">
          <h1>Settings</h1>
          <p className={err ? 'err' : ''}>{err ? 'Could not save. Try again.' : 'Changes save as you make them'}</p>
        </div>
      </header>
      <div className="scroll">{s && <div className="sets">
        <Group title="General">
          <Row label="Hotkey saves go to" hint="The profile new saves land in.">
            <Pick value={profiles.active} set={onActive} label="Profile for new saves" dot={profiles.active}>
              {profiles.all.map(p => <option key={p.name}>{p.name}</option>)}
            </Pick>
          </Row>
          {native && <Row label="Open at login" hint={mac.loginItem === 'approval' ? 'Allow umm in System Settings, General, Login Items.' : 'umm starts in the menu bar.'}>
            <Switch on={loginOn} set={on => send({ type: 'loginItem', on })} label="Open at login" />
          </Row>}
          <Row label="Hotbar"><Kbd>Ctrl Shift Space</Kbd></Row>
        </Group>

        <Group title="Screenshots">
          {s.screenshot_days !== undefined && <Row label="Keep images" hint="After that, the image is removed. Its text stays searchable.">
            <Pick value={s.screenshot_days} set={v => patch({ screenshot_days: +v })} label="Keep screenshot images">
              {DAYS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
            </Pick>
          </Row>}
          {mac.accessibility !== undefined && <Row label="Page addresses" hint={mac.accessibility ? 'Screenshots remember the page or document they show.' : 'Allow Accessibility so screenshots remember the page URL.'}>
            {mac.accessibility ? <span className="ok"><Icon name="check" />Allowed</span> : <button className="btn" onClick={() => send({ type: 'accessibility' })}>Allow...</button>}
          </Row>}
          <Row label="Excluded apps" hint="Never captured while in front, for example a password manager." wide>
            <div className="apps">
              {s.excluded_apps.map(a => <button key={a} className="tag" title="Remove" onClick={() => patch({ excluded_apps: s.excluded_apps.filter(x => x !== a) })}>{a}<Icon name="x" /></button>)}
              <input placeholder="Add an app, then Enter" aria-label="Add an excluded app" spellCheck={false}
                onKeyDown={e => { if (e.key === 'Enter') { addApp(e.currentTarget.value); e.currentTarget.value = '' } }} />
            </div>
          </Row>
        </Group>

        <Group title="Voice">
          <Row label="Languages" hint="Detection picks from these. None selected allows any." wide>
            <div className="chips">
              {LANGS.map(([k, n]) => (
                <button key={k} className={'chip' + (s.languages.includes(k) ? ' on' : '')} aria-pressed={s.languages.includes(k)}
                  onClick={() => patch({ languages: s.languages.includes(k) ? s.languages.filter(x => x !== k) : [...s.languages, k] })}>{n}</button>
              ))}
            </div>
          </Row>
          <Row label="Model" hint={MODELS[s.model]}>
            <div className="seg">
              {(['small', 'medium'] as const).map(m => (
                <button key={m} className={s.model === m ? 'on' : ''} aria-pressed={s.model === m} onClick={() => patch({ model: m })}>{m[0].toUpperCase() + m.slice(1)}</button>
              ))}
            </div>
          </Row>
        </Group>

        <Group title="Links">
          <Row label="Look up links" hint="Fetch the title and description of saved links.">
            <Switch on={s.enrich_links} set={v => patch({ enrich_links: v })} label="Look up links" />
          </Row>
        </Group>

        <Group title="Storage">
          <Row label={store ? size(store.bytes) : 'Size'} hint={store && (Object.entries(store.kinds).map(([k, n]) => `${n} ${KIND_NAMES[k as keyof typeof KIND_NAMES] ?? k}${n === 1 ? '' : 's'}`).join(', ') || 'Nothing saved yet')}>
            <button className="btn" disabled={!store} onClick={() => store && api.reveal(store.path + '/umm.db')}>Show in Finder</button>
          </Row>
          {store && <Row label="Location" hint={<code title={store.path}>{home(store.path)}</code>}>
            <Move from={store.path} done={setStore} />
          </Row>}
        </Group>

        <Group title="Agents">
          <Row label="Claude Code" hint="Run once in a terminal. Other MCP clients take the same command." wide>{setup && <Cmd text={setup.mcp} copy={api.copy} />}</Row>
          <Row label="Command line" hint="Installs the umm command." wide>{setup && <Cmd text={setup.cli} copy={api.copy} />}</Row>
        </Group>

        <p className="about">umm {mac.version ?? ''}<span>Everything stays on this Mac.</span></p>
      </div>}</div>
    </main>
  )
}
