import { problemText, type ConnectionProblem } from '@shared/connectionHealth'

/**
 * Jeden pasek na wszystkie kłopoty z połączeniem. Gaśnie sam, gdy przyczyna
 * ustaje — dlatego nie ma tu przycisku zamykania.
 */
export function ConnectionNotice({
  problem
}: {
  problem: ConnectionProblem | null
}): JSX.Element | null {
  if (!problem) return null
  return (
    <div className="app__connection" role="status">
      {problemText(problem)}
    </div>
  )
}
