import { useEffect, useState } from 'react'
import { api, type Agent } from './api'
import { projectName } from './Memory'
import { AppIcon, Cmd, Icon, ago } from './ui'

// Agents that ran the umm MCP server: live ones first, then recent sessions. A click shows that session's memories.
export default function Connections({ onOpen }: { onOpen: (a: Agent) => void }) {
  const [list, setList] = useState<Agent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [setup, setSetup] = useState<{ mcp: string } | null>(null)
  useEffect(() => {
    const load = () => api.agents().then(l => { setList(l); setFailed(false) }, () => setFailed(true))
    load()
    api.setup().then(setSetup, () => {})
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])
  const live = list?.filter(a => a.connected) ?? []
  const past = list?.filter(a => !a.connected) ?? []
  const row = (a: Agent) => (
    <li key={a.session}>
      <button className="conn" onClick={() => onOpen(a)}>
        <span className="cicon"><AppIcon name={a.agent} />{a.connected && <i className="livedot" title="Connected" />}</span>
        <span className="cmain">
          <b>{a.agent}<span>{a.agent_version}</span></b>
          <span className="cwd" title={a.cwd}><Icon name="path" />{projectName(a.cwd)}</span>
        </span>
        <span className="cseen">{(a.connected ? 'Active ' : 'Last seen ') + ago(a.last_seen)}</span>
        <span className="cn">{a.memories}<span>{a.memories === 1 ? ' memory' : ' memories'}</span></span>
        <Icon name="chevron" />
      </button>
    </li>
  )
  return (
    <main className="connections">
      <header className="top">
        <div className="title">
          <h1>Connections</h1>
          <p>{failed ? 'Could not reach the umm backend.' : !list ? '' : live.length ? `${live.length} ${live.length === 1 ? 'agent' : 'agents'} connected now` : 'No agent is connected right now'}</p>
        </div>
      </header>
      <div className="scroll">
        <div className="sets">
          {list && !list.length && (
            <div className="empty left">
              <h2>No agent has connected yet</h2>
              <p>Run this once in a terminal. Claude Code then starts umm's MCP server in every session, and each one shows up here.</p>
            </div>
          )}
          {live.length > 0 && <section><h2>Connected now</h2><ul className="conns">{live.map(row)}</ul></section>}
          {past.length > 0 && <section><h2>Recent sessions</h2><ul className="conns">{past.map(row)}</ul></section>}
          <section>
            <h2>Connect an agent</h2>
            <p className="hint">Run this in a terminal for Claude Code. Other MCP clients take the same command in their config.</p>
            {setup && <Cmd text={setup.mcp} copy={api.copy} />}
          </section>
        </div>
      </div>
    </main>
  )
}
