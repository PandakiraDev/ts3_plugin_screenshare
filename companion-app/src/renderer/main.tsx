import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Diagnostics } from './components/Diagnostics'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/*
      Rodzeństwo, nie dziecko — ale nie z powodu, który stał tu do 0.3.4.
      `Diagnostics` rysuje dziś TRZY rzeczy i żadna nie jest częścią układu:
      guzik „Dziennik" (bezwarunkowy, `position: fixed`, prawy dolny róg
      okna), panel dziennika pod tym guzikiem i panel tabeli strumieni pod
      `Ctrl+Shift+D` — oba `position: fixed` nad oknem, oba z nasłuchem
      klawiatury na `window`. Dzieckiem właściciela układu być NIE MOŻE:
      pozycjonowanie nic by na tym nie zyskało, a odmontowanie zabierałoby
      i guzik, i skrót na każdym wczesnym wyjściu tego właściciela — a tych
      jest cztery (dwa w `App`, dwa w `LobbyView`). To jest dokładnie ta
      dziura, w którą wpadł licznik zużycia po przeniesieniu do
      `ResourceBadge`.
      Licznika ten komponent już NIE rysuje, więc dawne zdanie o „wskaźnikach
      zużycia widocznych także przy «Uruchamianie…» i błędzie argumentów
      wywołania" było tu nieprawdą: na tych dwóch ekranach licznika dziś nie
      ma (rachunek przy `ResourceBadge`). Tym, co trzyma `Diagnostics` w tym
      miejscu, jest dziennik i skrót, nie liczby.
    */}
    <Diagnostics />
  </React.StrictMode>
)
