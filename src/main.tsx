import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'streamdown/styles.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'

installMobileViewportGuards()

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    let refreshingForServiceWorkerUpdate = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshingForServiceWorkerUpdate) return
      refreshingForServiceWorkerUpdate = true
      window.location.reload()
    })

    window.addEventListener('load', () => {
      const serviceWorkerUrl = `${import.meta.env.BASE_URL}sw.js?v=${encodeURIComponent(__APP_VERSION__)}&build=${encodeURIComponent(__BUILD_ID__)}`
      navigator.serviceWorker.register(serviceWorkerUrl)
        .then((registration) => registration.update())
        .catch((error) => {
          console.error('Service worker registration failed:', error)
        })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
