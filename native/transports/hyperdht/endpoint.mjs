import DHT from 'hyperdht'

export const MAX_FRAME = 60 * 1024
const PREFACE = 'ghostly/paired-chat/1'

/** Native UDP + NoiseSecretStream. The binding comes from the authenticated
 * stream itself, never from an application frame supplied by the other peer. */
export async function createHyperEndpoint(seed, options = {}) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Invalid HyperDHT seed')
  const keyPair = DHT.keyPair(Buffer.from(seed))
  const node = new DHT({ ...options, keyPair })
  const channels = new Set()
  let stopped = false
  let incomingHandler = null
  const waiting = []
  const descriptor = { publicKey: keyPair.publicKey.toString('hex') }

  async function attach(socket) {
    if (stopped || channels.size >= 2) { socket.destroy(); throw new Error('Native connection limit reached') }
    let reader = null
    let closeHandler = null
    let closed = false
    let pending = []
    let buffer = Buffer.alloc(0)
    let preface = false
    let resolveOpen, rejectOpen
    const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject })
    const timer = setTimeout(() => { socket.destroy(new Error('HyperDHT handshake timed out')) }, 20000)
    const channel = {
      get bufferedAmount() { return socket.writableLength || 0 },
      get onMessage() { return reader },
      set onMessage(value) { reader = value; if (value) for (const text of pending.splice(0)) value(text) },
      get onClose() { return closeHandler },
      set onClose(value) { closeHandler = value; if (closed) value?.() },
      send(text) {
        if (closed || typeof text !== 'string' || !text.length || Buffer.byteLength(text) > MAX_FRAME || this.bufferedAmount > 120 * 1024)
          throw new Error('Native channel is closed or exceeds its frame budget')
        const payload = Buffer.from(text)
        const header = Buffer.alloc(4); header.writeUInt32BE(payload.length)
        socket.write(Buffer.concat([header, payload]))
      },
      drained() {
        if (!this.bufferedAmount) return Promise.resolve()
        return new Promise((resolve, reject) => {
          const done = () => { socket.off('close', gone); resolve() }
          const gone = () => { socket.off('drain', done); reject(new Error('Native channel closed')) }
          socket.once('drain', done); socket.once('close', gone)
        })
      },
      close() { socket.destroy() },
    }
    channels.add(channel)
    socket.on('error', error => rejectOpen(error))
    socket.on('close', () => {
      closed = true; pending = []; clearTimeout(timer); channels.delete(channel)
      rejectOpen(new Error('Native channel closed')); closeHandler?.()
    })
    const opened = () => {
      if (socket.handshakeHash?.length !== 64 || socket.publicKey?.length !== 32 || socket.remotePublicKey?.length !== 32) {
        socket.destroy(new Error('Noise session binding unavailable')); return
      }
      channel.send(PREFACE)
    }
    socket.on('data', chunk => {
      // Secretstream chunks are bounded by its record layer. Process all frames
      // before retaining a partial one; never allocate based on an unchecked size.
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length === 0 || length > MAX_FRAME) { socket.destroy(new Error('Invalid frame length')); return }
        if (buffer.length < 4 + length) break
        let text
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4, 4 + length)) }
        catch { socket.destroy(new Error('Invalid UTF-8 frame')); return }
        buffer = buffer.subarray(4 + length)
        if (!preface) {
          if (text !== PREFACE) { socket.destroy(new Error('Unexpected application protocol')); return }
          preface = true; clearTimeout(timer)
          resolveOpen({ channel, binding: { transport: 'hyperdht/1', context: socket.handshakeHash.toString('hex'),
            identities: [socket.publicKey.toString('hex'), socket.remotePublicKey.toString('hex')].sort() } })
        } else if (reader) reader(text)
        else if (pending.length < 64) pending.push(text)
        else { socket.destroy(new Error('Receive queue exceeded')); return }
      }
    })
    void socket.opened.then(ok => { if (ok) opened(); else rejectOpen(new Error('Noise handshake failed')) })
    return ready
  }

  const server = node.createServer(socket => {
    void attach(socket).then(bound => {
      if (stopped) bound.channel.close()
      else if (incomingHandler) incomingHandler(bound)
      else waiting.push(bound)
    }).catch(() => {})
  })
  try { await server.listen(keyPair) }
  catch (error) { await node.destroy(); throw error }
  return {
    transport: 'hyperdht/1', descriptor, onDescriptor: null,
    get onConnection() { return incomingHandler },
    set onConnection(value) { incomingHandler = value; if (value) for (const bound of waiting.splice(0)) value(bound) },
    async connect(address) {
      if (stopped || !address || !/^[a-f0-9]{64}$/.test(address.publicKey)) throw new Error('Invalid HyperDHT endpoint')
      return attach(node.connect(Buffer.from(address.publicKey, 'hex'), { keyPair }))
    },
    async close() { stopped = true; for (const channel of channels) channel.close(); waiting.length = 0; await server.close(); await node.destroy() },
  }
}
