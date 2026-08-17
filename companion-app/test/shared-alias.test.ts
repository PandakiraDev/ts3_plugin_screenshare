import { expect, test } from 'vitest'
// Import WARTOŚCI, nie typu — typ zniknąłby przy kompilacji i test niczego by
// nie pilnował. Ta stała istnieje od 0.3.1 i nie zmienia się.
import { QUALITY_REPORT_INTERVAL_MS } from '@shared/viewerQuality'

test('alias @shared działa w testach, a nie tylko w budowaniu', () => {
  // Ten test nie sprawdza logiki jakości odbioru — sprawdza, czy vitest
  // w ogóle potrafi rozwiązać ścieżkę @shared. Bez konfiguracji wywala się
  // na imporcie i nie dochodzi nawet do asercji.
  expect(QUALITY_REPORT_INTERVAL_MS).toBe(5_000)
})
