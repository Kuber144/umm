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

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
