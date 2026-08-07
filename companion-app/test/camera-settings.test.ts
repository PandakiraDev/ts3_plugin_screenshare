import { expect, test } from 'vitest'
import { cameraConstraints, CAMERA_DIMENSIONS } from '../src/shared/types'

// Kamera nigdy nie niesie dzwieku: glos jest w TeamSpeaku, a mikrofon
// w streamie odtworzylby echo, ktore naprawilismy przy dzwieku z aplikacji.
test('kamera nie prosi o dzwiek', () => {
  const c = cameraConstraints({ deviceId: null, resolution: '720p', fps: 30 })
  expect(c.audio).toBe(false)
})

test('rozdzielczosc i fps trafiaja do ograniczen', () => {
  const c = cameraConstraints({ deviceId: null, resolution: '720p', fps: 30 })
  expect(c.video).toMatchObject({
    width: { ideal: CAMERA_DIMENSIONS['720p'].width },
    height: { ideal: CAMERA_DIMENSIONS['720p'].height },
    frameRate: { ideal: 30, max: 30 }
  })
})

// Brak wyboru urzadzenia musi znaczyc "domyslne", a nie deviceId: null —
// to ostatnie wywala getUserMedia.
test('bez wybranego urzadzenia nie ma pola deviceId', () => {
  const c = cameraConstraints({ deviceId: null, resolution: '720p', fps: 30 })
  expect(c.video).not.toHaveProperty('deviceId')
})

test('wybrane urzadzenie jest wymagane, nie sugerowane', () => {
  // exact: uzytkownik wskazal konkretna kamere; ciche podstawienie innej
  // byloby myloce.
  const c = cameraConstraints({ deviceId: 'kam-1', resolution: '1080p', fps: 60 })
  expect(c.video).toMatchObject({ deviceId: { exact: 'kam-1' } })
})
