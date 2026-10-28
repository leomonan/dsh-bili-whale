export function assertPlatformRuntime(runtime) {
  if (!runtime || typeof runtime.id !== 'string' || !runtime.id || typeof runtime.isPaused !== 'function') {
    throw new TypeError('platform runtime requires id and isPaused()')
  }
  const capabilities = runtime.capabilities ?? {}
  if (capabilities.comments?.read && typeof runtime.comments?.pollComments !== 'function') {
    throw new TypeError('comments.read requires comments.pollComments()')
  }
  if (capabilities.messages?.read && (typeof runtime.messages?.pollOnce !== 'function' || typeof runtime.messages?.ack !== 'function')) {
    throw new TypeError('messages.read requires messages.pollOnce() and messages.ack()')
  }
  if (capabilities.liveChat?.read && typeof runtime.liveChat?.start !== 'function') {
    throw new TypeError('liveChat.read requires liveChat.start()')
  }
  return runtime
}
