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
  const first = await startSignalingServer({ port: 0 })
  running.push(first)

  await expect(startSignalingServer({ port: first.port })).rejects.toThrow(
    new RegExp(`${first.port}`)
  )
})

test('błąd zajętego portu mówi wprost, co jest nie tak', async () => {
  const first = await startSignalingServer({ port: 0 })
  running.push(first)

  await expect(startSignalingServer({ port: first.port })).rejects.toThrow(/zajęty/i)
})

test('po zamknięciu serwera port da się użyć ponownie', async () => {
  const first = await startSignalingServer({ port: 0 })
  const port = first.port
  await first.close()

  const second = await startSignalingServer({ port })
  running.push(second)

  expect(second.port).toBe(port)
})
