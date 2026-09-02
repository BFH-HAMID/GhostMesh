import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/index.css'
import App from './App'

// Apply persisted theme before first paint to avoid a flash
document.documentElement.dataset['theme'] = localStorage.getItem('gm.theme') === 'neon-hud' ? 'neon-hud' : 'amoled'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
