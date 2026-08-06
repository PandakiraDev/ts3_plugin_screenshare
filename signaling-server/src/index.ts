import { resolvePort } from './config.js'
import { startSignalingServer } from './server.js'

const port = resolvePort(process.env['PORT'])

startSignalingServer({ port })
  .then((server) => {
    console.log(`Signaling server nasłuchuje na ws://0.0.0.0:${server.port}`)
  })
  .catch((err: unknown) => {
    // Sam komunikat, bez stack trace'u — przy zajętym porcie ślad stosu
    // prowadzi w głąb `ws` i tylko zaciemnia to, co trzeba zrobić.
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
