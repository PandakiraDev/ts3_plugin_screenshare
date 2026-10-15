import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Diagnostics } from './components/Diagnostics'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/*
      Rodzeństwo, nie dziecko: `App` ma własne wczesne wyjścia, a wskaźniki
      zużycia mają być widoczne także wtedy, gdy pokazuje „Uruchamianie…"
      albo błąd argumentów wywołania.
    */}
    <Diagnostics />
  </React.StrictMode>
)
