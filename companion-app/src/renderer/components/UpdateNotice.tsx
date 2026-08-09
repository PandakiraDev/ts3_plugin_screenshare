import { updateNoticeText, type UpdateState } from '@shared/update'

/** Plakietka w nagłówku — żeby przy pytaniu "jaką masz wersję?" nikt nie zgadywał. */
export function AppVersion({ version }: { version: string }): JSX.Element | null {
  if (!version) return null
  return <span className="app__version">v{version}</span>
}

/**
 * Pasek pojawia się WYŁĄCZNIE wtedy, gdy plik jest już na dysku i naprawdę się
 * zainstaluje. Sprawdzanie, pobieranie i błędy idą do konsoli — patrz
 * `src/main/update.ts`.
 */
export function UpdateNotice({ update }: { update: UpdateState }): JSX.Element | null {
  const text = updateNoticeText(update)
  if (!text) return null
  return <div className="app__update">{text}</div>
}
