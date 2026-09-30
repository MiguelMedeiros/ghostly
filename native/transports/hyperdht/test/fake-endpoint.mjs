// Stands in for endpoint.mjs when tests run the real sidecar.mjs: endpoints of
// one process reach each other in memory, with no DHT and no network.
// FAKE_ENDPOINT_HANG_CLOSE=1 makes close() never finish, and keeps the process
// busy, as a stuck socket would.
const registry = new Map()

function pair(bindingContext) {
  const ends = [0, 1].map(() => ({ reader: null, pending: [], closeHandler: null, closed: false }))
  const binding = { transport: 'hyperdht/1', context: bindingContext, identities: [] }
  const channel = (self, other) => ({
    bufferedAmount: 0,
    get onMessage() { return self.reader },
    set onMessage(value) { self.reader = value; if (value) for (const text of self.pending.splice(0)) value(text) },
    get onClose() { return self.closeHandler },
    set onClose(value) { self.closeHandler = value; if (self.closed) value?.() },
    send(text) {
      if (self.closed) throw new Error('Native channel is closed')
      queueMicrotask(() => { if (other.reader) other.reader(text); else other.pending.push(text) })
    },
    drained: async () => {},
    close() {
      for (const end of ends) if (!end.closed) { end.closed = true; end.closeHandler?.() }
    },
  })
  return [{ channel: channel(ends[0], ends[1]), binding }, { channel: channel(ends[1], ends[0]), binding }]
}

export async function createHyperEndpoint(seed) {
  const publicKey = Buffer.from(seed).toString('hex')
  if (registry.has(publicKey)) throw new Error('Endpoint already listening')
  let incoming = null
  let closed = false
  const endpoint = {
    transport: 'hyperdht/1', descriptor: { publicKey }, onDescriptor: null,
    get onConnection() { return incoming },
    set onConnection(value) { incoming = value },
    async connect(address) {
      const target = registry.get(address?.publicKey)
      if (!target || closed) throw new Error('peer not found')
      const [local, remote] = pair(`${publicKey}:${address.publicKey}`)
      target.onConnection?.(remote)
      return local
    },
    async close() {
      closed = true
      registry.delete(publicKey)
      if (process.env.FAKE_ENDPOINT_HANG_CLOSE === '1') await new Promise(() => setInterval(() => {}, 1000))
    },
  }
  registry.set(publicKey, endpoint)
  return endpoint
}
