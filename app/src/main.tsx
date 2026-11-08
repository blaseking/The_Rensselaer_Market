import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ActiveWalletProvider } from './context/ActiveWalletContext.tsx'
import { WalletContextProvider } from './context/WalletContextProvider.tsx'

window.Buffer = window.Buffer ?? Buffer

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletContextProvider>
      <ActiveWalletProvider>
        <App />
      </ActiveWalletProvider>
    </WalletContextProvider>
  </StrictMode>,
)
