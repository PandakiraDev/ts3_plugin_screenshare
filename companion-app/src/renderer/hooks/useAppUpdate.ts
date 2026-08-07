import { useEffect, useState } from 'react'
import { NO_UPDATE, type UpdateState } from '@shared/update'

/**
 * Numer wersji i stan aktualizacji. Wołany raz, w `App` — stan schodzi niżej
 * propsami, żeby nie mnożyć subskrypcji tego samego kanału IPC.
 */
export function useAppUpdate(): { version: string; update: UpdateState } {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>(NO_UPDATE)

  useEffect(() => {
    void window.companion.getAppVersion().then(setVersion)
    // Stan dociągamy raz na starcie, bo main mógł już dostać `update-downloaded`
    // zanim ten komponent się zamontował — sama subskrypcja by to przegapiła.
    void window.companion.getUpdateState().then(setUpdate)
    return window.companion.onUpdateState(setUpdate)
  }, [])

  return { version, update }
}
