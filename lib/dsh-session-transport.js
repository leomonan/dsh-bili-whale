import { assertSessionTransport } from './session-transport.js'

/**
 * DSH adapter for the host-neutral session-delivery contract.
 * All DSH API details stay here, outside the delivery state machine.
 */
export function createDshSessionTransport({ controller, cwd }) {
  const transport = {
    async ensureSession({ sessionId }) {
      if (!controller || typeof controller.create !== 'function') {
        throw new Error('DSH sessionController.create is unavailable')
      }
      return controller.create({ sessionId, cwd })
    },
    async deliver({ request, sessionId, content, signal }) {
      if (!controller || typeof controller.prompt !== 'function') {
        throw new Error('DSH sessionController.prompt is unavailable')
      }
      return controller.prompt({ ...request, sessionId, content }, signal)
    },
  }
  return assertSessionTransport(transport)
}
