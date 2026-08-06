import { randomBytes, createHash } from 'node:crypto'

/**
 * Magazyn kluczy API. Interfejs, bo serwer musi działać w trzech sytuacjach:
 * z Postgresem na produkcji, na pamięci w testach i BEZ bazy w ogóle
 * (darmowy Postgres na Renderze jest kasowany po 30 dniach — brak bazy nie
 * może wywalać serwera).
 */
export interface KeyStore {
  /** Czy klucz jest znany i aktywny. */
  isValid: (key: string) => Promise<boolean>
  close: () => Promise<void>
}

/** Klucz pokazywany użytkownikowi. Bez znaków mylących w odczycie. */
export function generateApiKey(): string {
  // 32 bajty -> 64 znaki hex. Zgadywanie nierealne, a da się skopiować z czatu.
  return randomBytes(32).toString('hex')
}

/**
 * W bazie trzymamy wyłącznie skrót. Wyciek zrzutu bazy nie daje wtedy nikomu
 * działających kluczy — dokładnie z tego samego powodu, dla którego nie
 * trzyma się haseł otwartym tekstem.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex')
}

/**
 * Klucze z jednego tekstu — po jednym w linii, po przecinku albo średniku.
 * Tak wygląda zmienna środowiskowa wklejona w panelu hostingu.
 *
 * Świadomie BEZ bazy danych: darmowy Postgres na Renderze jest kasowany co
 * 30 dni, a dla kilku osób lista w zmiennej daje to samo zabezpieczenie bez
 * comiesięcznej obsługi. Dodanie dostępu to dopisanie linii, odebranie —
 * usunięcie jej.
 */
export function parseKeyList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[\n,;]+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
}

/** Implementacja na pamięci — testy, praca lokalna i klucze ze zmiennej. */
export class MemoryKeyStore implements KeyStore {
  private readonly hashes = new Set<string>()

  constructor(keys: string[] = []) {
    for (const key of keys) this.hashes.add(hashApiKey(key))
  }

  add(key: string): void {
    this.hashes.add(hashApiKey(key))
  }

  async isValid(key: string): Promise<boolean> {
    return this.hashes.has(hashApiKey(key))
  }

  async close(): Promise<void> {
    /* nic do zamknięcia */
  }
}

/**
 * Magazyn, który wpuszcza każdego. Używany, gdy nie skonfigurowano bazy —
 * serwer ma wtedy działać jak przed dodaniem autoryzacji, a nie odmawiać
 * wszystkim. Świadomy wybór: brak konfiguracji to nie to samo co zakaz.
 */
export class OpenKeyStore implements KeyStore {
  async isValid(): Promise<boolean> {
    return true
  }

  async close(): Promise<void> {
    /* nic do zamknięcia */
  }
}
