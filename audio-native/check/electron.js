#!/usr/bin/env node
//
// Sprawdza, czy modul dziala w ELECTRONIE — nie tylko w Node.
//
// Po co osobny sprawdzian, skoro sa testy: Electron wlacza klatke pamieci V8
// i odrzuca zewnetrzne bufory ("External buffers are not allowed"). Pierwsza
// wersja modulu przechodzila wszystkie testy w Node i oddawala ZERO probek
// w Electronie. Vitest w Node takiej roznicy nie zobaczy.
//
// Electrona bierzemy z companion-app, zeby nie sciagac drugiej kopii (~100 MB).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const electronPackage = path.join(__dirname, '..', '..', 'companion-app', 'node_modules', 'electron')

let electronExe
try {
  electronExe = require(electronPackage)
} catch {
  console.error('Nie znalazlem Electrona. Uruchom najpierw: cd ../companion-app && npm install')
  process.exit(1)
}

const resultFile = path.join(os.tmpdir(), `audio-check-${process.pid}.json`)

spawnSync(electronExe, [path.join(__dirname, 'electron-main.js')], {
  env: { ...process.env, AUDIO_CHECK_RESULT: resultFile },
  stdio: 'ignore'
})

if (!fs.existsSync(resultFile)) {
  console.error('Electron zakonczyl sie bez wyniku — modul prawdopodobnie wywalil proces.')
  process.exit(1)
}

const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
fs.unlinkSync(resultFile)

if (!result.ok) {
  console.error(`NIE DZIALA w Electronie: ${result.error ?? `tylko ${result.frames} ramek`}`)
  process.exit(1)
}

console.log(`OK — Electron ${result.electron}, ${result.frames} ramek w 1 s`)
