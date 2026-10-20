import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Hotbar from './Hotbar'
import Library from './Library'

function Root() {
  const [hotbar, setHotbar] = useState(location.hash === '#hotbar')
  useEffect(() => {
    const f = () => setHotbar(location.hash === '#hotbar')
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  useEffect(() => { document.documentElement.dataset.view = hotbar ? 'hotbar' : 'main' }, [hotbar])
  return hotbar ? <Hotbar /> : <Library />
}

// Keys for an input method reach no shortcut. WebKit sends the Enter that confirms the text with keyCode 229.
window.addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) e.stopImmediatePropagation() }, true)

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
