// Stands in for endpoint.mjs when tests run the real sidecar.mjs: endpoints of
// one process reach each other in memory, with no DHT and no network.
// FAKE_ENDPOINT_HANG_CLOSE=1 makes close() never finish, and keeps the process
// busy, as a stuck socket would. FAKE_ENDPOINT_DELAY_MS holds each frame that
// long in the sender's buffer before it reaches the other end, as a slow link.
const registry = new Map()
const delay = Number(process.env.FAKE_ENDPOINT_DELAY_MS ?? 0)

function pair(bindingContext) {
  const ends = [0, 1].map(() => ({ reader: null, pending: [], closeHandler: null, closed: false, buffered: 0, waiting: [] }))
  const binding = { transport: 'hyperdht/1', context: bindingContext, identities: [] }
  const channel = (self, other) => ({
    get bufferedAmount() { return self.buffered },
    get onMessage() { return self.reader },
    set onMessage(value) { self.reader = value; if (value) for (const text of self.pending.splice(0)) value(text) },
    get onClose() { return self.closeHandler },
    set onClose(value) { self.closeHandler = value; if (self.closed) value?.() },
    send(text) {
      if (self.closed) throw new Error('Native channel is closed')
      self.buffered += text.length
      const deliver = () => {
        self.buffered -= text.length
        if (!other.closed) { if (other.reader) other.reader(text); else other.pending.push(text) }
        if (!self.buffered) for (const { resolve } of self.waiting.splice(0)) resolve()
      }
      if (delay) setTimeout(deliver, delay); else queueMicrotask(deliver)
    },
    drained() {
      if (!self.buffered) return Promise.resolve()
      return new Promise((resolve, reject) => self.waiting.push({ resolve, reject }))
    },
    close() {
      for (const end of ends) if (!end.closed) {
        end.closed = true
        for (const { reject } of end.waiting.splice(0)) reject(new Error('Native channel closed'))
        end.closeHandler?.()
      }
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
