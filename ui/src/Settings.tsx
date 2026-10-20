import { useEffect, useState, type ReactNode } from 'react'
import { api, type Profiles, type Settings as Conf, type Storage } from './api'
import { native, send } from './bridge'
import { Cmd, Dot, Icon, Kbd } from './ui'
import './settings.css'

const LANGS: [string, string][] = [['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ru', 'Russian']]
const MODELS = { small: 'Faster and lighter on memory, misses more words.', medium: 'Slower and about 2 GB of memory while it runs, more accurate.' }
const KIND_NAMES = { screenshot: 'screenshots', text: 'notes', path: 'paths', link: 'links', voice: 'recordings' }
const size = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(1)} GB`)

const Row = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <div className="srow"><div className="lbl"><b>{label}</b>{hint && <span>{hint}</span>}</div><div className="ctl">{children}</div></div>
)
const Switch = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
  <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => set(!on)}><i /></button>
)

export default function Settings({ profiles, onActive }: { profiles: Profiles; onActive: (name: string) => void }) {
  const [s, setS] = useState<Conf | null>(null)
  const [store, setStore] = useState<Storage | null>(null)
  const [login, setLogin] = useState<{ loginItem?: string; version?: string }>({})
  const [err, setErr] = useState(false)
  const [setup, setSetup] = useState<{ mcp: string; cli: string } | null>(null)

  useEffect(() => {
    api.settings().then(setS, () => setErr(true))
    api.storage().then(setStore, () => {})
    api.setup().then(setSetup, () => {})
    if (native) { window.ummSettings = setLogin; send({ type: 'settings' }) }
    return () => { window.ummSettings = undefined }
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
  const names = profiles.all.map(p => p.name)
  const loginOn = login.loginItem === 'on' || login.loginItem === 'approval'

  return (
    <main className="settings">
      <header className="top">
        <div className="title">
          <h1>Settings</h1>
          <p>{err ? 'Could not save, try again.' : 'Changes save as you make them.'}</p>
        </div>
      </header>
      <div className="scroll">{s && <div className="sets">
        <section>
          <h2>Saving</h2>
          <Row label="Hotkey saves go to" hint="The profile new saves land in.">
            <label className="pick"><Dot name={profiles.active} />
              <select value={profiles.active} onChange={e => onActive(e.target.value)} aria-label="Default profile">
                {names.map(n => <option key={n}>{n}</option>)}
              </select><Icon name="caret" />
            </label>
          </Row>
        </section>

        <section>
          <h2>Voice</h2>
          <Row label="Languages" hint="Detection picks from these. Turn all off to allow any language.">
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
        </section>

        <section>
          <h2>Privacy</h2>
          <Row label="Excluded apps" hint="The hotbar screenshot refuses to capture while one of these is in front, for example a password manager.">
            <div className="apps">
              {s.excluded_apps.map(a => <button key={a} className="tag" title="Remove" onClick={() => patch({ excluded_apps: s.excluded_apps.filter(x => x !== a) })}>{a}<Icon name="x" /></button>)}
              <input placeholder="App name, then Enter" aria-label="Add an excluded app" spellCheck={false}
                onKeyDown={e => { if (e.key === 'Enter') { addApp(e.currentTarget.value); e.currentTarget.value = '' } }} />
            </div>
          </Row>
          <Row label="Look up links" hint="Fetch the title and description of saved links.">
            <Switch on={s.enrich_links} set={v => patch({ enrich_links: v })} label="Look up links" />
          </Row>
        </section>

        <section>
          <h2>Storage</h2>
          <Row label={store ? size(store.bytes) : 'Size'} hint={store && (Object.entries(store.kinds).map(([k, n]) => `${n} ${KIND_NAMES[k as keyof typeof KIND_NAMES] ?? k}`).join(', ') || 'Nothing saved yet')}>
            <button className="btn" disabled={!store} onClick={() => store && api.reveal(store.path + '/umm.db')}><Icon name="reveal" />Open data folder</button>
          </Row>
        </section>

        <section>
          <h2>Agents</h2>
          <Row label="Claude Code" hint="Run once. Any MCP client can use the same command. Connected agents are listed under Connections.">{setup && <Cmd text={setup.mcp} copy={api.copy} />}</Row>
          <Row label="Command line" hint="Installs the umm command.">{setup && <Cmd text={setup.cli} copy={api.copy} />}</Row>
        </section>

        {native && <section>
          <h2>Startup</h2>
          <Row label="Open umm at login" hint={login.loginItem === 'approval' ? 'Allow umm in System Settings, General, Login Items.' : 'umm starts in the menu bar.'}>
            <Switch on={loginOn} set={on => send({ type: 'loginItem', on })} label="Open umm at login" />
          </Row>
        </section>}

        <section>
          <h2>About</h2>
          <Row label={'umm ' + (login.version ?? '')} hint="Everything stays on this Mac."><span className="dim">Hotbar <Kbd>Ctrl Shift Space</Kbd></span></Row>
        </section>
      </div>}</div>
    </main>
  )
}
