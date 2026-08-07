/**
 * Generuje klucz dostępu do wklejenia w zmienną API_KEYS na hostingu.
 *
 *   npm run keys -- Ola
 *
 * Świadomie bez bazy danych: darmowy Postgres na Renderze jest kasowany co
 * 30 dni, a dla kilku osób lista w zmiennej środowiskowej daje to samo
 * zabezpieczenie bez comiesięcznej obsługi.
 */
import { generateApiKey } from './keys.js'

const label = process.argv[2] ?? 'nowy'
const key = generateApiKey()

console.log('')
console.log(`Klucz dla "${label}":`)
console.log('')
console.log(`  ${key}`)
console.log('')
console.log('Co dalej:')
console.log('  1. Render -> Twoja usluga -> Environment -> zmienna API_KEYS')
console.log('  2. Dopisz ten klucz w nowej linii (albo po przecinku)')
console.log('  3. Save -> usluga sama sie zrestartuje')
console.log('  4. Wyslij klucz tej osobie; wpisuje go raz w aplikacji')
console.log('')
console.log('Odebranie dostepu: usun linie z API_KEYS i zapisz.')
console.log('')
