export function assertSessionTransport(transport) {
  if (!transport || typeof transport.ensureSession !== 'function' || typeof transport.deliver !== 'function') {
    throw new TypeError('transport must implement ensureSession() and deliver()')
  }
  return transport
}
