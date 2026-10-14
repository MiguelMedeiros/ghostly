import DHT from 'hyperdht'
import { redial } from './redial.mjs'

export const MAX_FRAME = 60 * 1024
/** The top bit of a frame's length word: the frame is a binary message, not UTF-8 text (WISP 103). */
const BINARY = 0x80000000
const PREFACE = 'ghostly/paired-chat/1'
/** How long a closing channel waits for what it sent last to go out before the stream is destroyed anyway. */
const CLOSE_FLUSH_MS = 300
/**
 * Bytes a channel may hold before `send` throws: above what every sender here lets itself queue (the CLI's 1 MiB high
 * water mark and an app's quarter above it; the Desktop page's send budget over the sidecar's `SEND_ROOM`), so it
 * trips only for one that ignores its own line.
 */
const MAX_BUFFERED = 2 * 1024 * 1024
/**
 * `drained()` resolves once a channel holds no more than this: no more than the sidecar's `SEND_ROOM`, so its wait for
 * room never spins on a `drained()` that resolves at once.
 */
const DRAINED_AT = 64 * 1024
/**
 * How often a wait in `drained()` looks again. Each stream says `drain` only once its own queue is empty, which on a fast
 * link comes first; on a slow one this finds the queue at `DRAINED_AT` before it runs dry.
 */
const DRAIN_POLL_MS = 10

/**
 * What a connection's stream still holds: secret-stream's queue and the UDX stream's under it. Both are streamx
 * streams, which count it in `_writableState.buffered` (hyperdht is pinned; hyperdhtEndpointBuffered.test.ts reads it).
 * secret-stream has no `writableLength`: read from there, it was always 0.
 */
function held(socket) {
  return (socket._writableState?.buffered ?? 0) + (socket.rawStream?._writableState?.buffered ?? 0)
}

/** Native UDP + NoiseSecretStream. The binding comes from the authenticated
 * stream itself, never from an application frame supplied by the other peer. */
export async function createHyperEndpoint(seed, options = {}) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Invalid HyperDHT seed')
  const keyPair = DHT.keyPair(Buffer.from(seed))
  // A chat's listener is a DHT client for good: an adaptive node turns persistent after ~20 min wherever its UDP port is
  // reachable, and then joins the routing table and keeps strangers' records and values. Ephemeral, it still listens
  // (announced through other nodes) and holepunches.
  const node = new DHT({ ...options, keyPair, ephemeral: true })
  const channels = new Set()
  let stopped = false
  let incomingHandler = null
  const waiting = []
  const descriptor = { publicKey: keyPair.publicKey.toString('hex') }

  /** `onChannel`: hears the channel as soon as it counts against the limit (a dial that stalls is dropped from it). */
  async function attach(socket, onChannel) {
    if (stopped || channels.size >= 2) { socket.destroy(); throw new Error('Native connection limit reached') }
    let reader = null
    let closeHandler = null
    let closed = false
    let ending = null
    let pending = []
    let buffer = Buffer.alloc(0)
    let preface = false
    let resolveOpen, rejectOpen
    const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject })
    const timer = setTimeout(() => { socket.destroy(new Error('HyperDHT handshake timed out')) }, 20000)
    const channel = {
      // It carries binary messages (WISP 100 § Text and binary messages): a capability that needs them may be offered.
      binary: true,
      get bufferedAmount() { return held(socket) },
      get onMessage() { return reader },
      set onMessage(value) { reader = value; if (value) for (const text of pending.splice(0)) value(text) },
      get onClose() { return closeHandler },
      set onClose(value) { closeHandler = value; if (closed) value?.() },
      send(data) {
        const binary = data instanceof Uint8Array
        if (closed || !(binary || typeof data === 'string') || !data.length || (binary ? data.length : Buffer.byteLength(data)) > MAX_FRAME || this.bufferedAmount > MAX_BUFFERED)
          throw new Error('Native channel is closed or exceeds its frame budget')
        const payload = binary ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
        const header = Buffer.alloc(4); header.writeUInt32BE((binary ? BINARY : 0) + payload.length)
        socket.write(Buffer.concat([header, payload]))
      },
      drained() {
        if (this.bufferedAmount <= DRAINED_AT) return Promise.resolve()
        if (closed) return Promise.reject(new Error('Native channel closed'))
        return new Promise((resolve, reject) => {
          const raw = socket.rawStream
          const check = () => { if (this.bufferedAmount <= DRAINED_AT) finish(resolve) }
          const gone = () => finish(() => reject(new Error('Native channel closed')))
          const poll = setInterval(check, DRAIN_POLL_MS)
          poll.unref?.()
          function finish(settle) {
            clearInterval(poll); socket.off('drain', check); raw?.off('drain', check); socket.off('close', gone); settle()
          }
          socket.on('drain', check); raw?.on('drain', check); socket.once('close', gone)
        })
      },
      // What was sent last (a goodbye, as an app stops) goes out before the stream ends: destroyed at once, it was
      // dropped unsent. A contact that never finishes the stream has CLOSE_FLUSH_MS.
      close() {
        if (closed || ending) return ending ?? Promise.resolve()
        ending = new Promise(resolve => { socket.once('close', resolve) })
        const timer = setTimeout(() => socket.destroy(), CLOSE_FLUSH_MS)
        timer.unref?.()
        socket.end()
        return ending
      },
    }
    channels.add(channel)
    onChannel?.(channel)
    socket.on('error', error => rejectOpen(error))
    // The contact ended its side (its channel closed): this one ends too, so the stream closes now, not on its timer.
    socket.on('end', () => socket.end())
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
        const word = buffer.readUInt32BE(0)
        const binary = word >= BINARY, length = word % BINARY
        // A binary frame before the preface is another protocol.
        if (length === 0 || length > MAX_FRAME || (binary && !preface)) { socket.destroy(new Error('Invalid frame length')); return }
        if (buffer.length < 4 + length) break
        let text
        if (binary) text = new Uint8Array(buffer.subarray(4, 4 + length))
        else {
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4, 4 + length)) }
          catch { socket.destroy(new Error('Invalid UTF-8 frame')); return }
        }
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
      const remote = Buffer.from(address.publicKey, 'hex')
      // A dial whose stream opened and carried nothing is made again (`redial.mjs`): it is dropped from the limit at
      // once, so the next one has its place even while another channel is live. The wait follows the stream's RTT.
      return redial(() => {
        const socket = node.connect(remote, { keyPair })
        let counted = null
        const ready = attach(socket, channel => { counted = channel })
        return { opened: socket.opened, ready, rtt: () => socket.rawStream?.rtt ?? 0,
          close() { if (counted) channels.delete(counted); socket.destroy() } }
      })
    },
    // The channels end first (their last frames out, CLOSE_FLUSH_MS at most): the node's socket goes with it.
    async close() { stopped = true; const ended = [...channels].map(channel => channel.close()); waiting.length = 0; await Promise.all(ended); await server.close(); await node.destroy() },
  }
}
