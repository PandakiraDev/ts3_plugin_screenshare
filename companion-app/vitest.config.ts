import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Vitest nie czyta `paths` z tsconfig.json, a electron-vite podaje ten alias
// tylko procesowi budowania. Bez tego pliku każdy import WARTOŚCI z @shared
// wywala testy — importy typów przechodzą tylko dlatego, że znikają przy
// kompilacji. Trafiliśmy na to w 0.3.1 i obeszliśmy ścieżką względną.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
