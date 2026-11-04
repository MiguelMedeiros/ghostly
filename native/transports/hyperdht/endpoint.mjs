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
 * water mark and an app's quarter above it; the Desktop page, which stops a file once the sidecar says `full` past its
 * `SEND_ROOM`), so it trips only for one that ignores its own line.
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

/**
 * The DHT nodes of this process, by network: every chat's endpoint listens and dials on its network's one node, each
 * with its own key pair. A node per chat was a UDP socket, a routing table and dht-rpc's table pings per chat, on top
 * of each listener's announce keepalive; eight chats were eight of each. A node goes once its last endpoint closed.
 */
const nodes = new Map()

function shareNode(options) {
  const key = JSON.stringify([options.bootstrap ?? null, options.host ?? null, options.port ?? null])
  let shared = nodes.get(key)
  // A chat's listener is a DHT client for good: an adaptive node turns persistent after ~20 min wherever its UDP port is
  // reachable, and then joins the routing table and keeps strangers' records and values. Ephemeral, it still listens
  // (announced through other nodes) and holepunches.
  if (!shared) nodes.set(key, shared = { node: new DHT({ ...options, ephemeral: true }), users: 0, closing: new Map() })
  shared.users++
  let released = false
  return {
    node: shared.node,
    closing: shared.closing,
    async release() {
      if (released) return
      released = true
      if (--shared.users > 0) return
      if (nodes.get(key) === shared) nodes.delete(key)
      await shared.node.destroy()
    },
  }
}

/**
 * Stops or starts the announcing of a listener: its record on three DHT nodes, and the ping to each of them every 3 s
 * that keeps it reachable there (hyperdht's announcer, `lib/announcer.js`; hyperdht is pinned, and
 * hyperdhtEndpointShared.test.ts reads it). Only the announcer: `server.suspend()` would also end the handshakes it
 * holds, which for 10 s after a connection opened include that connection's stream. While stopped, the server still
 * answers a handshake that reaches it, and its connections go on.
 */
function announcing(server, on) {
  const announcer = server._announcer
  if (!announcer) return
  if (on) announcer.resume()
  else void announcer.suspend().catch(() => {})
}

/** Native UDP + NoiseSecretStream. The binding comes from the authenticated
 * stream itself, never from an application frame supplied by the other peer.
 *
 * The listener is announced only while no channel is live: with one, the contact already reached this chat, and it is
 * announced again as soon as the last one closes. A contact whose side lost the session first (its network changed,
 * its app was killed) can dial again only once this side's session ends too (its liveness, about a minute); this side
 * dials it meanwhile as well. */
export async function createHyperEndpoint(seed, options = {}) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Invalid HyperDHT seed')
  const keyPair = DHT.keyPair(Buffer.from(seed))
  const hex = keyPair.publicKey.toString('hex')
  const shared = shareNode(options)
  const node = shared.node
  // The same chat's listener closing a moment ago (its slot given back, the sidecar told to stop and start it): a key
  // listens once per node.
  await shared.closing.get(hex)?.catch(() => {})
  const channels = new Set()
  /** The channels whose contact's preface came: the chat is live on them. */
  const live = new Set()
  /** Every stream this endpoint dialled that is not closed yet: the node stays when the endpoint closes, they do not. */
  const dialled = new Set()
  let quiet = false
  let stopped = false
  let closing = null
  let incomingHandler = null
  const waiting = []
  const descriptor = { publicKey: hex }
  let server = null
  let listening = false

  function liveChanged() {
    const want = !stopped && live.size > 0
    if (want === quiet || !listening) return
    quiet = want
    announcing(server, !want)
  }

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
      if (live.delete(channel)) liveChanged()
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
          live.add(channel); liveChanged()
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

  server = node.createServer(socket => {
    void attach(socket).then(bound => {
      if (stopped) bound.channel.close()
      else if (incomingHandler) incomingHandler(bound)
      else waiting.push(bound)
    }).catch(() => {})
  })
  try { await server.listen(keyPair) }
  catch (error) { await server.close().catch(() => {}); await shared.release(); throw error }
  listening = true
  // A channel that went live while it was being announced (a contact's dial answered before `listen` resolved).
  liveChanged()
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
        dialled.add(socket)
        socket.once('close', () => dialled.delete(socket))
        if (stopped) socket.destroy()
        let counted = null
        const ready = attach(socket, channel => { counted = channel })
        return { opened: socket.opened, ready, rtt: () => socket.rawStream?.rtt ?? 0,
          close() { if (counted) channels.delete(counted); socket.destroy() } }
      })
    },
    // The channels end first (their last frames out, CLOSE_FLUSH_MS at most), then the listener and any dial still
    // under way. The node goes only with the last endpoint on it (`shareNode`).
    close() {
      if (closing) return closing
      stopped = true
      closing = (async () => {
        const ended = [...channels].map(channel => channel.close()); waiting.length = 0
        await Promise.all(ended)
        for (const socket of dialled) socket.destroy()
        await server.close()
        await shared.release()
      })()
      const done = closing.finally(() => { if (shared.closing.get(hex) === done) shared.closing.delete(hex) })
      done.catch(() => {})
      shared.closing.set(hex, done)
      return closing
    },
  }
}
