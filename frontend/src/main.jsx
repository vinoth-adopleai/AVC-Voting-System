import '@fontsource/noto-sans/400.css'
import '@fontsource/noto-sans/500.css'
import '@fontsource/noto-sans/600.css'
import '@fontsource/noto-sans/700.css'
import '@fontsource/noto-sans-tamil/400.css'
import '@fontsource/noto-sans-tamil/500.css'
import '@fontsource/noto-sans-tamil/600.css'
import '@fontsource/noto-sans-tamil/700.css'
import React from 'react'
import { createRoot } from 'react-dom/client'

import App from './app/App.jsx'
import './i18n/index.js'
import './styles/index.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
