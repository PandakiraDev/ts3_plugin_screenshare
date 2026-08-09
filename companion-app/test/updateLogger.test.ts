import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createUpdateLogger } from '../src/main/updateLogger'

// Ten plik NIE importuje 'electron' — createUpdateLogger przyjmuje sciezke
// jako parametr wlasnie po to, zeby dalo sie go sprawdzic w golym vitest,
// bez granicy main-process opisanej w update.ts.

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'update-logger-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('kazdy poziom dopisuje wpis ze znacznikiem czasu', () => {
  const logger = createUpdateLogger(workDir)
  logger.info('sprawdzam aktualizacje')
  logger.warn('brak sieci')
  logger.error('pobieranie nie powiodlo sie')
  logger.debug('szczegol')

  const content = readFileSync(join(workDir, 'update.log'), 'utf8')
  expect(content).toContain('[info] sprawdzam aktualizacje')
  expect(content).toContain('[warn] brak sieci')
  expect(content).toContain('[error] pobieranie nie powiodlo sie')
  expect(content).toContain('[debug] szczegol')
  // Format ISO na poczatku kazdej linii.
  expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
})

test('duzy istniejacy log zostaje obciety zamiast rosnac w nieskonczonosc', () => {
  const logPath = join(workDir, 'update.log')
  writeFileSync(logPath, 'x'.repeat(300 * 1024))

  const logger = createUpdateLogger(workDir)
  logger.info('nowy wpis po obcieciu')

  const content = readFileSync(logPath, 'utf8')
  expect(content.length).toBeLessThan(300 * 1024)
  expect(content).toContain('nowy wpis po obcieciu')
})

test('maly istniejacy log NIE jest kasowany przy kolejnym starcie', () => {
  const first = createUpdateLogger(workDir)
  first.info('sesja 1')

  const second = createUpdateLogger(workDir)
  second.info('sesja 2')

  const content = readFileSync(join(workDir, 'update.log'), 'utf8')
  expect(content).toContain('sesja 1')
  expect(content).toContain('sesja 2')
})

test('zapis do logu nie rzuca, gdy katalog nie istnieje', () => {
  const missingDir = join(workDir, 'nie-ma-takiego-katalogu')
  const logger = createUpdateLogger(missingDir)

  expect(() => logger.error('cokolwiek')).not.toThrow()
  expect(existsSync(join(missingDir, 'update.log'))).toBe(false)
})
