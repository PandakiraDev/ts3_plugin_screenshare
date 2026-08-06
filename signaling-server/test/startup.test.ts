import { afterEach, expect, test } from 'vitest'
import { startSignalingServer, type SignalingServer } from '../src/server.js'

const running: SignalingServer[] = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
})

test('zajęty port zwraca czytelny błąd zamiast wywracać proces', async () => {
  // Najczęstszy scenariusz przy pracy lokalnej: poprzedni serwer został
  // uruchomiony i nie zamknięty. Bez tego Node wypluwa stack trace
  // z nieobsłużonego zdarzenia 'error', z którego nic nie wynika.
  const pierwszy = await startSignalingServer({ port: 0 })
  running.push(pierwszy)

  await expect(startSignalingServer({ port: pierwszy.port })).rejects.toThrow(
    new RegExp(`${pierwszy.port}`)
  )
})

test('błąd zajętego portu mówi wprost, co jest nie tak', async () => {
  const pierwszy = await startSignalingServer({ port: 0 })
  running.push(pierwszy)

  await expect(startSignalingServer({ port: pierwszy.port })).rejects.toThrow(/zajęty/i)
})

test('po zamknięciu serwera port da się użyć ponownie', async () => {
  const pierwszy = await startSignalingServer({ port: 0 })
  const port = pierwszy.port
  await pierwszy.close()

  const drugi = await startSignalingServer({ port })
  running.push(drugi)

  expect(drugi.port).toBe(port)
})
