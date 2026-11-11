import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import DHT from 'hyperdht'
import { relay } from '@hyperswarm/dht-relay'
import WsStream from '@hyperswarm/dht-relay/ws'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)

/**
 * What one relay accepts. A Ghostly browser holds one WebSocket, listens once per saved chat or group link (at most
 * eight native listeners per app, and one per linked device) and dials a contact now and then; everything above that
 * is someone else's traffic.
 */
export const DEFAULT_LIMITS = Object.freeze({
  /**
   * WebSockets at once, over all clients. A full relay still lets in an address holding fewer than another one would
   * after it: the oldest client of the address holding the most is dropped for it (see makeRoom).
   */
  clients: 512,
  /** WebSockets at once from one address (an IPv6 /64 counts as one, see addressKey). */
  clientsPerAddress: 16,
  /** Largest relay protocol message a client may send. */
  payloadBytes: 256 * 1024,
  /** Bytes a client may send per second, on average, and in one burst. The relay pauses its socket past that. */
  bytesPerSecond: 512 * 1024,
  burstBytes: 4 * 1024 * 1024,
  /** Keys one client may listen on at once. */
  listens: 16,
  /**
   * Listens one client may start per minute, refused ones too. Each is an announcement on the DHT and its close an
   * unannouncement. A browser starts at most eight on start and eight again when it reconnects (measured, 30 chats).
   */
  listensPerMinute: 60,
  /** Dials one client may start per minute. */
  connectsPerMinute: 60,
  /** HyperDHT streams one client may hold open at once: its dials and the connections its servers get. */
  streams: 64,
  /** How long a client may hold its WebSocket with no listen open and no dial started (a browser listens within seconds). */
  idleMs: 30_000,
  /** How often the relay pings each client; one that has not answered the last ping by the next is dropped. */
  pingMs: 30_000,
  /** How long a connection may take to send its request (headers included) before it upgrades. */
  requestMs: 15_000,
  /** How long the relay waits for a client's part of a handshake (a browser answers in one round trip). */
  handshakeMs: 15_000,
  /**
   * Handshakes that may wait on one client's answer at once: its dials and the connections its servers get. One server's
   * incoming ones take at most a quarter of it, and all of them together leave that quarter to the dials (see crowded).
   */
  handshakes: 64,
  /**
   * Bytes the relay may hold for one client that the client has not read yet, and that its far peers have not taken yet
   * of what it sent them (a chat's files have at most 2 MiB out). One stream holding more than half of it toward its far
   * peer is closed; a client holding more than all of it, both ways together, is dropped.
   */
  queuedBytes: 8 * 1024 * 1024,
  /**
   * Bytes the relay may hold over all clients that they have not read yet or their far peers have not taken yet (see
   * `queuedBytes`); past it, the client holding the most is
   * dropped. `clients` times `queuedBytes` is far more than the 512 MiB docker-compose.yml gives the process, and each
   * byte counted costs about three in the process while clients come and go (every ~1.4 KiB message is a Buffer of its
   * own, with its objects): at 96 MiB, 256 clients that stop reading keep it near 400 MiB.
   */
  queuedTotalBytes: 96 * 1024 * 1024,
})

/**
 * The congestion window of the relay's one HyperDHT node: requests it may have out per 750 ms tick before the rest wait
 * in its queue, for every client together. dht-rpc's default (80) is sized for one app, and each listen's announcer pings
 * its 3 nodes every 3 s, about one request a second per listen: measured on loopback, 80 keeps up with about 1,000
 * listens and 320 with 4,096, so a window of listens / 12 sends them all. At the defaults 512 × 16 / 12 = 683. Never
 * below dht-rpc's 80; at most 2048 (24,576 listens), past which a relay is better split in two.
 */
export const relayWindow = ({ clients, listens }) => Math.min(2048, Math.max(80, Math.ceil(clients * listens / 12)))

/**
 * dht-relay 0.4.3 (its latest release) hands a browser the announce record where the browser expects the
 * record's relay addresses, so signing an announcement throws and nobody can reach a browser that listens.
 * The browser signs `{ publicKey, relayAddresses }` itself; this gives it the list it signs.
 */
/**
 * The browser signs its announcements, so a relay waiting for a signature from a browser that has gone
 * would wait forever (the server it closes on that browser's behalf never finishes unannouncing, and holds
 * on). A signature comes within `SIGN_MS` or while the browser is there, or not at all. `onLeave(fail)` calls `fail`
 * when the browser leaves (at once if it has) and returns what forgets it: a wait on the client's `gone` itself stayed
 * there for every signature after it came, until the browser left.
 */
const SIGN_MS = 10_000
const fixSign = (sign, onLeave) => sign && ((target, token, id, ann, keyPair) => {
  let timer
  let forget = () => {}
  return Promise.race([
    sign(target, token, id, { peer: ann.peer.relayAddresses }, keyPair),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('No signature')), SIGN_MS)
      forget = onLeave(() => reject(new Error('The browser left')))
    }),
  ]).finally(() => { clearTimeout(timer); forget() })
})
const fixOptions = (options = {}, onLeave) => ({ ...options, signAnnounce: fixSign(options.signAnnounce, onLeave), signUnannounce: fixSign(options.signUnannounce, onLeave) })

/**
 * Whether the client holds the secret key of the key it asks to listen on. HyperDHT's own node does not check it: its
 * announcer sends every signature it is given and goes on when the nodes it announces to turn them all down, so a
 * listen on a key whose secret the client does not hold would still resolve, and hold the key on this relay's node.
 * Before that, the client signs an announcement over a token and a node id the relay draws at random (dht-relay's own
 * `signAnnounce`, no message of its own), checked as a HyperDHT node checks one. No node issued that token, so the
 * signature announces nothing anywhere; no node needs to answer, and the key is not held while the client signs.
 * A custodial client hands the relay its secret key, which signs the same way.
 */
const hyperdht = createRequire(require.resolve('hyperdht'))
const sodium = hyperdht('sodium-universal')
const { encode } = hyperdht('compact-encoding')
const { NS } = hyperdht('./lib/constants.js')
const { peer: peerEncoding } = hyperdht('./lib/messages.js')
const Persistent = hyperdht('./lib/persistent.js')
async function holdsKey(keyPair, options, onLeave) {
  const publicKey = keyPair?.publicKey
  if (!publicKey || publicKey.byteLength !== 32) return false
  const target = Buffer.alloc(32)
  sodium.crypto_generichash(target, publicKey)
  const token = randomBytes(32)
  const id = randomBytes(32)
  const ann = { peer: { publicKey, relayAddresses: [] }, refresh: null, signature: null }
  const sign = fixSign(options?.signAnnounce, onLeave) ?? Persistent.signAnnounce
  let signature
  try { signature = await sign(target, token, id, ann, keyPair) } catch { return false }
  if (!signature || signature.byteLength !== 64) return false
  const signable = Buffer.alloc(64)
  signable.set(NS.ANNOUNCE, 0)
  sodium.crypto_generichash_batch(signable.subarray(32), [target, id, token, encode(peerEncoding, ann.peer)])
  return sodium.crypto_sign_verify_detached(signature, signable, publicKey)
}
/**
 * Where a dial's stream goes. A far server that says it is open has HyperDHT connect the dial's UDX stream to the first
 * public address it names, whatever that is, and send it everything the client writes: through the relay, anyone could
 * have its node send UDP to any public host and port, from the relay's address. The public addresses a far server names
 * are dropped from its reply to a dial here, so HyperDHT connects to the address the DHT node that relayed the handshake
 * saw it at (an open server names that one itself). Its private ones stay: HyperDHT tries them only on a LAN, by a ping.
 * Every other way a dial connects follows a packet from the far peer.
 */
const { isBogon } = hyperdht('bogon')
const NoiseWrap = hyperdht('./lib/noise-wrap.js')
const noiseWrap = (keyPair, remotePublicKey) => new NoiseWrap(keyPair, remotePublicKey)
const reached = payload => payload?.addresses4?.length ? { ...payload, addresses4: payload.addresses4.filter(address => isBogon(address.host)) } : payload
const reachedOnly = create => (...args) => {
  const handshake = create(...args)
  const recv = handshake.recv.bind(handshake)
  // NoiseWrap answers at once, the client's handshake (HandshakeProxy) in a promise.
  handshake.recv = (...message) => {
    const payload = recv(...message)
    return typeof payload?.then === 'function' ? payload.then(reached) : reached(payload)
  }
  return handshake
}
const listensOn = (dht, keyPair) => [...dht.listening].some(server => server._keyPair && keyPair?.publicKey && Buffer.compare(server._keyPair.publicKey, keyPair.publicKey) === 0)

/**
 * The DHT one client's relay session sees: listen and dial within its budget, nothing else. Topic lookups
 * and announcements are refused (Ghostly never uses them), so the relay is no open crawler. Past a limit
 * the client is dropped, and so is one that holds its slot with no listen open and no dial for `idleMs`.
 *
 * Every client shares the relay's one HyperDHT node, which refuses a second listen on a key it already listens
 * on (`KEYPAIR_ALREADY_USED`, whoever asked first). dht-relay 0.4.3 does not catch that rejection, so it would end
 * the process and every client with it. A listen the node refuses closes that server only: the client that holds
 * the key, and the asking client's other listens, go on. The asking client is told: dht-relay has no message for a
 * refusal and its client drops a `closed` for a server that has had no `listening`, so the server says `listening` at
 * no address (0.0.0.0:0, the browser's sign of a refusal), then `closed`. A listen by a client that does not sign for
 * the key (holdsKey) is refused the same way, before the node holds the key.
 */
function clientDht(dht, limits, drop, gone, log, wrote) {
  let listening = 0
  let listens = []
  let dials = []
  let idle = null
  // Once the client has gone, its servers still close one by one: none of them may arm the idle timer again.
  let left = false
  const watchIdle = () => {
    clearTimeout(idle)
    idle = left || listening > 0 ? null : setTimeout(() => drop('idle'), limits.idleMs)
  }
  watchIdle()
  // Every HyperDHT stream the relay holds for this client: its dials and the connections its servers get, taken or
  // not. dht-relay forgets some of them (a dial whose alias the client reuses, an incoming one the client never
  // takes) and would leave them open after the client has gone, outside every limit; they all close with it. While
  // it stays, it holds at most `streams` of them: a dial past that drops it, an incoming one past that is closed.
  // dht-relay writes each of them what the client sends and never looks at what it returns: after each write, `wrote`
  // weighs what the stream holds (see unsent).
  const streams = new Set()
  const hold = stream => {
    if (left || streams.size >= limits.streams) { stream.destroy(); return stream }
    streams.add(stream)
    stream.once('close', () => streams.delete(stream))
    const write = stream.write
    stream.write = function (...args) {
      const ok = write.apply(this, args)
      wrote(stream)
      return ok
    }
    return stream
  }
  // The signatures waiting on this client (fixSign): each fails when it leaves.
  const signing = new Set()
  const onLeave = fail => {
    if (left) { fail(); return () => {} }
    signing.add(fail)
    return () => signing.delete(fail)
  }
  void gone.then(() => {
    clearTimeout(idle)
    left = true
    for (const stream of streams) stream.destroy()
    streams.clear()
    for (const fail of signing) fail()
    signing.clear()
  })
  return new Proxy(dht, {
    get(target, prop) {
      if (prop === 'createServer') return (options, onconnection) => {
        const now = Date.now()
        listens = listens.filter(at => now - at < 60_000)
        if (listens.push(now) > limits.listensPerMinute) { drop('listen rate'); throw new Error('Listen rate reached') }
        if (++listening > limits.listens) { drop('listen limit'); throw new Error('Listen limit reached') }
        watchIdle()
        const server = target.createServer({ ...options, createHandshake: untracked(options?.createHandshake) }, onconnection)
        const listen = server.listen.bind(server)
        server.listen = async (keyPair, listenOptions) => {
          try {
            // A key the node already listens on is refused by the node itself (KEYPAIR_ALREADY_USED), at once: no signature asked.
            const held = listensOn(target, keyPair) || await holdsKey(keyPair, listenOptions, onLeave)
            // Closed while it signed (the client let go of it, or left): a listen now would stay in the node's list.
            if (server._closing || left) return
            if (!held) throw Object.assign(new Error('The client did not sign for this key'), { code: 'unsigned' })
            return await listen(keyPair, fixOptions(listenOptions, onLeave))
          } catch (error) {
            log('refused listen', error?.code ?? 'error')
            server.address = () => ({ publicKey: keyPair?.publicKey, host: '0.0.0.0', port: 0 })
            server.emit('listening')
            void server.close().catch(() => {})
          }
        }
        server.once('close', () => { listening--; watchIdle() })
        server.on('connection', hold)
        return server
      }
      if (prop === 'connect') return (publicKey, options) => {
        const now = Date.now()
        dials = dials.filter(at => now - at < 60_000)
        if (dials.push(now) > limits.connectsPerMinute) { drop('dial limit'); throw new Error('Dial limit reached') }
        if (streams.size >= limits.streams) { drop('stream limit'); throw new Error('Stream limit reached') }
        watchIdle()
        return hold(target.connect(publicKey, { ...options, createHandshake: reachedOnly(untracked(options?.createHandshake) ?? noiseWrap) }))
      }
      if (prop === 'lookup' || prop === 'announce' || prop === 'lookupAndUnannounce' || prop === 'unannounce') return () => {
        drop('topic query'); throw new Error('Topic queries are not relayed')
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Bytes a HyperDHT stream holds toward its far peer that the far peer has not taken yet: what waits in the stream itself
 * (all of it while a dial has not opened), in its UDX stream, and in the writes that UDX stream has handed to its native
 * side, each held until the far end acks it (udx-native's `_wreqs`; its buffers are not copied). That far end sets the
 * pace, and dht-relay 0.4.3 writes on whatever the stream says: unbounded, a far peer that stops acking has the relay
 * hold everything its client sends. A stream is weighed after every write, so this costs the same however much it holds.
 */
const unsent = stream => {
  let bytes = stream._writableState?.buffered ?? 0
  const raw = stream.rawStream
  if (!raw) return bytes
  return bytes + (raw._writableState?.buffered ?? 0) + (raw._unacked ?? 0)
}

/**
 * What each UDX stream has handed to its native side and not had acked yet (`_unacked`), counted as each write goes down
 * and as its ack comes: going over its writes after each one cost the relay the square of them. UDX batches small writes
 * while its far end does not ack, and 100,000 writes of 16 bytes had it look at 747 million buffers, the whole relay
 * stalled for 0.4 s. udx-native hands its native side `_onack` as each stream is made, so the prototype's is replaced
 * here, before the relay's node makes any. An ack frees exactly what its write held (its `buffer` or `buffers`, which
 * udx-native drops then); a write the native side refuses (not connected) throws before it is counted.
 */
const UDXStream = createRequire(hyperdht.resolve('dht-rpc'))('udx-native/lib/stream.js')
const writeBytes = write => {
  if (write.buffer) return write.buffer.byteLength
  let bytes = 0
  if (write.buffers) for (const buffer of write.buffers) bytes += buffer.byteLength
  return bytes
}
const handDown = UDXStream.prototype._writev
UDXStream.prototype._writev = function (buffers, cb) {
  let bytes = 0
  for (const buffer of buffers) bytes += buffer.byteLength
  this._unacked = (this._unacked ?? 0) + bytes
  try { return handDown.call(this, buffers, cb) } catch (error) { this._unacked -= bytes; throw error }
}
const acked = UDXStream.prototype._onack
UDXStream.prototype._onack = function (id) {
  const write = this._wreqs[id]
  if (write) this._unacked = Math.max(0, (this._unacked ?? 0) - writeBytes(write))
  return acked.call(this, id)
}

/**
 * dht-relay 0.4.3 tells a browser that one of its incoming streams failed with a message it cannot encode
 * (no `paired`, so it encodes a missing alias), and the throw comes out of an event handler: one browser
 * closing a stream with an error would take the whole relay down. The browser keys incoming streams by the
 * relay's alias, so the message is a paired one. Any other message that cannot be sent drops that client,
 * never the process.
 */
function guardProtocol(protocol, drop) {
  for (const [name, message] of Object.entries(protocol)) {
    if (!message || typeof message.send !== 'function') continue
    const send = message.send.bind(message)
    message.send = m => {
      if (name === 'destroy' && m && m.paired === undefined && m.remoteAlias === undefined) m = { ...m, paired: true }
      try { return send(m) } catch { drop(`unsendable ${name}`) }
    }
  }
}

/**
 * protomux hands every error a client's messages raise (one it cannot decode, a throw in dht-relay's handler for it) to
 * safety-catch, which throws a TypeError or a RangeError again where nothing catches it: one client's message would end
 * the process and every client with it. The client's own mux now drops that client only.
 */
function guardMux(mux, drop) {
  const fail = error => {
    drop('protocol error')
    mux._destroying = true
    mux.stream.destroy(error)
  }
  mux._safeDestroy = fail
  mux._safeDestroyBound = fail
  mux._warn = error => mux.stream.emit('warning', error)
}

// Not in the package's exports: loaded by path, the same module dht-relay itself uses (0.4.3 is pinned).
const { HandshakeProxy } = require(join(dirname(require.resolve('@hyperswarm/dht-relay')), 'lib', 'handshake-proxy.js'))

/**
 * dht-relay 0.4.3 keeps every handshake it makes for a client (each dial, each connection one of its servers gets) in
 * a map it frees only when the handshake is denied, and every signature it asks the client for in another it never
 * frees: both grow for as long as the client's WebSocket stays open. A handshake is now in its map only while it
 * waits for the client's answer, for at most `handshakeMs` and `handshakes` at once, and a signature only until it
 * comes or `SIGN_MS` has passed. The map is there only to route those answers back.
 */
const untracked = create => create && ((...args) => {
  const handshake = create(...args)
  handshake._node._handshakes.delete(handshake._id)
  return handshake
})
/**
 * Why a handshake may not wait on its client now (a word for the log), or null. The connections a client's servers
 * get are started by whoever knows the key, so one contact dialling its own chat over and over would fill the client's
 * whole `handshakes` and leave its other chats unreachable and its dials refused. A server's incoming handshakes take at
 * most a quarter of it, and all servers' together leave that quarter to the client's dials.
 */
function crowded(handshake, handshakes, limits) {
  if (handshakes.size >= limits.handshakes) return 'limit'
  // A dial's handshake has no server.
  if (handshake._serverAlias == null) return null
  const quarter = Math.floor(limits.handshakes / 4)
  let incoming = 0
  let server = 0
  for (const other of handshakes.values()) {
    if (other._serverAlias == null) continue
    incoming++
    if (other._serverAlias === handshake._serverAlias) server++
  }
  if (server >= Math.max(1, quarter)) return 'listen share'
  if (incoming >= limits.handshakes - quarter) return 'incoming'
  return null
}
const roundTrip = original => function (payload) {
  const handshakes = this._node._handshakes
  const limits = this._node._limits ?? DEFAULT_LIMITS
  const why = crowded(this, handshakes, limits)
  if (why) {
    this._node._refused?.('refused handshake', why)
    return Promise.reject(new Error('Too many handshakes'))
  }
  handshakes.set(this._id, this)
  // Out of the map as the answer comes (or the wait ends), not once the race settles a few microtasks later: dht-relay
  // hands every answer with this id to a handshake in the map, and the same answer twice in one batch from the client
  // reached a handshake whose answer slot the first had emptied.
  const forget = () => { if (handshakes.get(this._id) === this) handshakes.delete(this._id) }
  const answer = original.call(this, payload)
  const onAnswer = this._onNoiseReply
  this._onNoiseReply = message => { forget(); onAnswer(message) }
  let timer
  return Promise.race([
    answer,
    new Promise((_, reject) => {
      timer = setTimeout(() => { forget(); this._onNoiseReply = null; reject(new Error('No handshake answer')) }, limits.handshakeMs)
    }),
  ]).finally(() => {
    clearTimeout(timer)
    forget()
  })
}
HandshakeProxy.prototype.send = roundTrip(HandshakeProxy.prototype.send)
class Signatures extends Map {
  set(id, { resolve }) {
    const timer = setTimeout(() => this.delete(id), SIGN_MS)
    timer.unref?.()
    return super.set(id, { timer, resolve: signature => { this.delete(id); resolve(signature) } })
  }
  delete(id) {
    clearTimeout(super.get(id)?.timer)
    return super.delete(id)
  }
  clear() {
    for (const id of [...this.keys()]) this.delete(id)
  }
}
/**
 * Each server dht-relay 0.4.3 runs for a client waits for the client's stream to close (to close itself) and never
 * stops waiting once it has closed: every server the client had ever opened stayed in memory, 3 to 6 KiB each, until
 * the client left. A server now stops waiting when it closes.
 */
class Servers extends Map {
  set(alias, proxy) {
    proxy._server.once('close', () => proxy._protocol._stream.off('close', proxy._onStreamClose))
    return super.set(alias, proxy)
  }
}
function bound(node, limits, gone, refused) {
  node._limits = limits
  node._refused = refused
  const signatures = new Signatures()
  for (const [id, signature] of node._signatures) signatures.set(id, signature)
  node._signatures = signatures
  const servers = new Servers()
  for (const [alias, proxy] of node._servers) servers.set(alias, proxy)
  node._servers = servers
  void gone.then(() => { signatures.clear(); node._handshakes.clear() })
}

/**
 * A dial sends its handshake through several DHT nodes at once (hyperdht's `findPeer` runs two in parallel, three
 * when it remembers the nodes of an earlier connection to that key), and each one brings back the server's reply.
 * hyperdht reads only the first, but its check comes after `recv`, and a browser's `recv` is a round trip: every
 * reply reaches the browser. dht-relay 0.4.3 keeps one reply slot per handshake, and the browser's Noise state
 * throws on a second message, so the dial hangs until the browser gives up. It happened on every dial after the
 * first to the same key through one relay (a contact reached again, or after a reload). A dialling handshake now
 * passes on its first reply only; the others get `null`, which hyperdht takes as "nothing to do".
 */
const recvHandshake = roundTrip(HandshakeProxy.prototype.recv)
HandshakeProxy.prototype.recv = function (payload) {
  if (!this._isInitiator) return recvHandshake.call(this, payload)
  if (this._received) return Promise.resolve(null)
  this._received = true
  return recvHandshake.call(this, payload)
}

/**
 * A custodial client (it hands the relay its secret key) runs no handshake of its own: HyperDHT runs it on the relay and
 * asks the client's firewall whether to take each connection, and dht-relay 0.4.3 waits for that answer with no end.
 * HyperDHT holds the handshake, its Noise state and the far peer's request until it comes, so a client that never
 * answers would have the relay hold every handshake anyone sent its key. Its answer now counts as the handshakes above
 * do: denied after `handshakeMs`, and one asked for only within the client's share of `handshakes` (a server's quarter,
 * all servers' together leaving a quarter to its dials), else denied without asking.
 */
const { FirewallProxy } = require(join(dirname(require.resolve('@hyperswarm/dht-relay')), 'lib', 'firewall-proxy.js'))
function firewallCrowded(firewall, limits) {
  const quarter = Math.max(1, Math.floor(limits.handshakes / 4))
  if (firewall._requests.size >= quarter) return 'listen share'
  let waiting = 0
  for (const server of firewall._node._servers.values()) waiting += server._firewall?._requests.size ?? 0
  return waiting >= limits.handshakes - quarter ? 'incoming' : null
}
Object.defineProperty(FirewallProxy.prototype, '_deny', {
  // dht-relay sets its own `_deny` in the constructor; this keeps a bounded one in its place.
  set(deny) {
    Object.defineProperty(this, '_deny', {
      value: (...args) => {
        const limits = this._node._limits ?? DEFAULT_LIMITS
        const why = firewallCrowded(this, limits)
        if (why) {
          this._node._refused?.('refused handshake', why)
          return Promise.resolve(true)
        }
        const answer = deny(...args)
        // deny() has just put its request last in the map: answered as a deny once the wait is over.
        const id = [...this._requests.keys()].at(-1)
        const timer = setTimeout(() => this._requests.get(id)?.(true), limits.handshakeMs)
        return answer.finally(() => clearTimeout(timer))
      },
    })
  },
})

/**
 * The address a client counts against. Behind Cloudflare (`cloudflare`), `CF-Connecting-IP`, which its edge writes
 * over the client's. Behind `proxies` reverse proxies (a tunnel, nginx), the entry that many from the end of
 * `X-Forwarded-For` (the ones before it are the client's to write). Otherwise, or without the header, the socket's.
 */
export function addressOf(request, { proxies = 0, cloudflare = false } = {}) {
  const socket = request.socket.remoteAddress ?? 'unknown'
  if (cloudflare) {
    const header = request.headers['cf-connecting-ip']
    const connecting = String(Array.isArray(header) ? header[0] : header ?? '').trim()
    if (connecting) return connecting
  }
  if (!proxies) return socket
  const header = request.headers['x-forwarded-for']
  const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return hops.length >= proxies ? hops[hops.length - proxies] : socket
}

/**
 * What `clientsPerAddress` counts: an IPv4 address as it is (an IPv4-mapped IPv6 one too), an IPv6 address by its
 * /64, the block one subscriber usually holds whole. A port some proxies write with it (`203.0.113.7:51234`,
 * `[2001:db8::1]:51234`) and IPv6 brackets are dropped first: each connection has a new port, so keyed with it the
 * limit never applies. The push relay's `rateKey`; the two services ship separately.
 */
export function addressKey(address) {
  address = /^\[([^\]]+)\](?::\d+)?$/.exec(address)?.[1] ?? /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{1,5}$/.exec(address)?.[1] ?? address
  if (!address.includes(':')) return address
  // The eight groups, whichever way the address is written: zone dropped, a dotted IPv4 tail as its two groups, `::`
  // filled with zeros. An IPv4-mapped one (`::ffff:192.0.2.1`, `::ffff:c000:201`, `0:0:0:0:0:ffff:...`) is its IPv4.
  const [head, tail] = address.split('%')[0].replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (dotted, ...octets) =>
    octets.slice(0, 4).every(octet => octet <= 255) ? `${(octets[0] * 256 + +octets[1]).toString(16)}:${(octets[2] * 256 + +octets[3]).toString(16)}` : dotted).split('::')
  const before = head ? head.split(':') : []
  const after = tail ? tail.split(':') : []
  const groups = tail === undefined ? before : [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after]
  const words = groups.map(group => /^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN)
  if (words.length === 8 && words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff && words.every(word => word >= 0)) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.')
  }
  const prefix = groups.slice(0, 4).map(group => parseInt(group, 16))
  return prefix.length === 4 && prefix.every(n => n >= 0 && n <= 0xffff) ? `${prefix.map(n => n.toString(16)).join(':')}::/64` : address
}

/**
 * The relay's lines about refusals and drops (`refused address`, `refused listen KEYPAIR_ALREADY_USED`, `dropped idle`):
 * the first `most` of each kind in a minute, then, once a minute while it goes on, one line with how many were left out
 * (`refused address (812 more this minute, not logged)`). A client repeating what it is refused for would otherwise write
 * a line per attempt, thousands a second, and rotate the whole log away. The push relay's refusalLog, with a few lines.
 */
export function refusalLines (log, { most = 5 } = {}) {
  // Kind → lines written and lines left out since the last flush. Present: the kind has had a line in this minute.
  const kinds = new Map()
  return {
    line: (...words) => {
      const kind = words.join(' ')
      const seen = kinds.get(kind) ?? { shown: 0, more: 0 }
      kinds.set(kind, seen)
      if (seen.shown < most) { seen.shown++; log(...words) } else seen.more++
    },
    flush: () => {
      for (const [kind, seen] of kinds) {
        // A kind still going on keeps its lines spent: one line a minute from it while it lasts.
        if (seen.more) { log(kind, `(${seen.more} more this minute, not logged)`); seen.more = 0; seen.shown = most } else kinds.delete(kind)
      }
    },
  }
}

/** How often one address may have a client dropped to make room for its own on a full relay (see makeRoom). */
const ROOM_MS = 10_000

/**
 * Starts a relay: an HTTP server whose WebSocket upgrades each carry one browser's HyperDHT (dht-relay,
 * non-custodial: the browser keeps its keys and runs the Noise handshake and the encrypted stream itself;
 * the relay moves handshake messages and ciphertext). `GET /healthz` answers with the node's state, never a count,
 * 503 while its routing table is empty; `stats()` has the counts.
 *
 * options: port, host, bootstrap (host:port list), testnet (size of an in-process HyperDHT network, for tests
 * and e2e), limits, origins (allowed `Origin` values, see originOf; empty allows any), proxies, cloudflare (see addressOf), log.
 */
export async function startRelay(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  // Each message waiting for a client is a small Buffer, and Node cuts small Buffers out of shared slabs (8 KiB, 64 KiB
  // from Node 26): one waiting message keeps its whole slab, with the other clients' messages in it, so dropping a
  // client freed almost nothing and `queuedTotalBytes` bounded only a part of what the process held. Unpooled, a
  // dropped client's messages are freed with it.
  Buffer.poolSize = 0
  const log = options.log ?? (() => {})
  let testnet = null
  let bootstrap = options.bootstrap ?? []
  if (options.testnet) {
    const { default: createTestnet } = await import('hyperdht/testnet.js')
    testnet = await createTestnet(options.testnet, { host: '127.0.0.1' })
    bootstrap = testnet.bootstrap.map(node => `${node.host}:${node.port}`)
  }
  const loopback = bootstrap.length > 0 && bootstrap.every(node => /^(127\.0\.0\.1|localhost):\d+$/.test(String(node)))
  // A new node counts itself firewalled until its first network check, about 20 minutes in (dht-rpc's STABLE_TICKS).
  // Until then two browsers on this relay reach each other only by holepunching the relay's own socket, which on
  // loopback often fails. On loopback nothing stands between the nodes, so the relay says so from the start.
  const dht = options.dht ?? new DHT({ maxWindow: relayWindow(limits), ...(bootstrap.length ? { bootstrap, ...(loopback ? { host: '127.0.0.1', firewalled: false } : {}) } : {}) })
  // When another node last answered this one. With no outgoing UDP (a firewall, a tunnel, a container network) none
  // ever does: the node is up, its routing table stays empty, and a browser's listen through it still resolves.
  let answeredAt = null
  const onresponse = dht.io.onresponse
  dht.io.onresponse = (...args) => { answeredAt = Date.now(); return onresponse(...args) }
  await dht.ready()
  if (dht.toArray().length === 0) log('bootstrap reached no node')

  const clients = new Set()
  // Each client's dht-relay session, for what it holds (`stats().held`).
  const nodes = new Set()
  // Address → its clients, oldest first, each with what drops it to make room.
  const perAddress = new Map()
  const stats = { accepted: 0, refused: 0, dropped: 0 }
  // What each client had waiting, unread by it or untaken by its far peers, when the relay last wrote to it or for it,
  // and their sum. A count grows only on a write and shrinks as the client reads and its far peers take, so the sum is
  // never below what the relay holds: past `queuedTotalBytes` every client is counted again, and while the sum is still
  // past it the client holding the most is dropped.
  const queued = new Map()
  let queuedTotal = 0
  const recount = (ws, fresh = false) => {
    const entry = queued.get(ws)
    if (!entry) return
    const bytes = entry.held(fresh)
    queuedTotal += bytes - entry.bytes
    entry.bytes = bytes
  }
  const unqueue = ws => {
    queuedTotal -= queued.get(ws)?.bytes ?? 0
    queued.delete(ws)
  }
  const holdQueued = ws => {
    recount(ws)
    if (queuedTotal <= limits.queuedTotalBytes) return
    for (const client of queued.keys()) recount(client, true)
    while (queuedTotal > limits.queuedTotalBytes) {
      let most = null
      for (const [client, entry] of queued) if (!most || entry.bytes > most[1].bytes) most = [client, entry]
      most[1].drop('queue total')
    }
  }
  // Compared as a browser writes them: `https://app.example/` in the settings still lets https://app.example in.
  const origins = new Set((options.origins ?? []).map(origin => originOf(origin) ?? origin))
  const refusedOrigin = originRefusals(log)
  const refusals = refusalLines(log)
  const flushing = setInterval(refusals.flush, 60_000)
  flushing.unref?.()
  // Once per start each: a proxy in front the relay was not told about makes every client count as that proxy.
  const hinted = new Set()
  const hint = (header, setting) => {
    if (hinted.has(header)) return
    hinted.add(header)
    log(`requests carry ${header} but ${setting} is not set: every client counts as the proxy`)
  }

  /**
   * On a full relay, what makes room for a client from `address` (null: none is made). A client holding one listen and
   * answering pings is never idle, so the first `clients / clientsPerAddress` addresses would hold the relay for as long
   * as they stay. An address that would then hold fewer than the one holding the most gets in, in place of that one's
   * oldest client: every address that comes gets a share, down to an even split, and a household behind one address
   * still gets in. An address makes room once per `ROOM_MS`, so one that closes each client it opens bounces nobody
   * faster than that.
   */
  const madeRoom = new Map()
  const makeRoom = address => {
    if (Date.now() - (madeRoom.get(address) ?? -Infinity) < ROOM_MS) return null
    const own = perAddress.get(address)?.size ?? 0
    let most = null
    for (const held of perAddress.values()) if (!most || held.size > most.size) most = held
    if (!most || most.size <= own + 1) return null
    const [[, evict]] = most
    return () => { madeRoom.set(address, Date.now()); evict() }
  }
  const forgetRoom = setInterval(() => {
    for (const [address, at] of madeRoom) if (Date.now() - at >= ROOM_MS) madeRoom.delete(address)
  }, 60_000)
  forgetRoom.unref?.()

  // Set as close() starts: while it waits for its clients, a client that redials on its 1001 would be let in again and
  // cut with 1006 at the end of the wait, and a health check would keep sending new ones.
  let stopping = false
  // Node's defaults (60 s for the headers, 300 s for the request) let a connection that never upgrades sit for minutes.
  const server = http.createServer({ requestTimeout: limits.requestMs, headersTimeout: limits.requestMs, connectionsCheckingInterval: Math.min(1000, limits.requestMs) }, (request, response) => {
    // A GET or a monitor's HEAD (Node sends no body for it), with or without a query string, as the push relay reads it.
    const health = (request.method === 'GET' || request.method === 'HEAD') && request.url.split('?')[0] === '/healthz'
    if (health && stopping) {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: false, stopping: true }))
      return
    }
    if (health) {
      // Healthy while the node's routing table holds another node: with none, nobody reaches what it announces.
      // Anyone may read it (behind a proxy every caller is on loopback), so only the node's state: the client counts
      // and the time of the last answer move with each browser, and on a small relay would tell when one opens the app.
      const reached = dht.toArray().length
      response.writeHead(reached > 0 ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: reached > 0, firewalled: dht.firewalled, nodes: reached }))
      return
    }
    response.writeHead(426, { 'content-type': 'text/plain' }); response.end('Ghostly HyperDHT relay: connect with a WebSocket\n')
  })
  // A client's pings are answered by accept(), within its budget: ws's own answer (autoPong) read them past the budget
  // and queued a pong for each, unbounded until the relay next wrote to that client.
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.payloadBytes, perMessageDeflate: false, autoPong: false })

  server.on('upgrade', (request, socket, head) => {
    const address = addressKey(addressOf(request, { proxies: options.proxies, cloudflare: options.cloudflare }))
    // Cloudflare writes both headers: its own setting is the one to name.
    if (!options.cloudflare && !options.proxies) {
      if (request.headers['cf-connecting-ip'] !== undefined) hint('CF-Connecting-IP', 'GHOSTLY_RELAY_CLOUDFLARE')
      else if (request.headers['x-forwarded-for'] !== undefined) hint('X-Forwarded-For', 'GHOSTLY_RELAY_PROXIES')
    }
    const origin = request.headers.origin
    // A refusal goes straight to the raw socket, which nothing else listens on: a client that has already reset it
    // would make the write fail with an error nobody catches, and that ends the relay for every other client.
    const refuse = (status, why, headers = '') => {
      stats.refused++
      // The origin is logged by refusedOrigin, once per value: a crawler would otherwise write a line per attempt.
      if (why) refusals.line('refused', why)
      socket.on('error', () => {})
      socket.end(`HTTP/1.1 ${status}\r\n${headers}Connection: close\r\n\r\n`)
    }
    if (stopping) return refuse('503 Service Unavailable', 'stopping', 'Retry-After: 1\r\n')
    if (origins.size && !origins.has(origin)) { refusedOrigin(origin); return refuse('403 Forbidden') }
    const room = clients.size >= limits.clients ? makeRoom(address) : undefined
    if (room === null) return refuse('503 Service Unavailable', 'full')
    if ((perAddress.get(address)?.size ?? 0) >= limits.clientsPerAddress) return refuse('429 Too Many Requests', 'address')
    // Room is made once the upgrade is through (ws calls back at once then, or never): one it refuses drops nobody.
    wss.handleUpgrade(request, socket, head, ws => { room?.(); accept(ws, address) })
  })

  function accept(ws, address) {
    stats.accepted++
    clients.add(ws)
    let dropped = false
    const drop = why => {
      if (dropped) return
      dropped = true; stats.dropped++; refusals.line('dropped', why)
      unqueue(ws)
      ws.terminate()
    }
    // Its slot is free as it is dropped to make room, not once its socket has closed: the next upgrade counts it gone.
    const release = () => {
      if (!clients.delete(ws)) return
      const held = perAddress.get(address)
      held.delete(ws)
      if (!held.size) perAddress.delete(address)
    }
    if (!perAddress.has(address)) perAddress.set(address, new Map())
    perAddress.get(address).set(ws, () => { drop('room'); release() })
    // What each of the client's HyperDHT streams held toward its far peer when last weighed (see unsent), and their sum.
    // A stream is weighed as the client writes to it, so a weight only grows then; one past a bound is weighed again
    // with all the others before anyone is closed or dropped for it.
    const far = new Map()
    let farTotal = 0
    const weigh = stream => {
      const bytes = stream.destroying ? 0 : unsent(stream)
      farTotal += bytes - far.get(stream)
      far.set(stream, bytes)
    }
    // What the relay holds for the client: unread by it, and untaken by its far peers (`fresh`: every stream weighed now).
    const held = (fresh = false) => {
      if (fresh) for (const stream of far.keys()) weigh(stream)
      return ws.bufferedAmount + farTotal
    }
    const over = () => held() > limits.queuedBytes && held(true) > limits.queuedBytes
    queued.set(ws, { bytes: 0, drop, held })
    // After each write of what the client sends to one of its streams: a stream whose far peer has more than half of
    // `queuedBytes` untaken is closed (with an error, which tells the client), and the client is weighed as below.
    const wrote = stream => {
      if (dropped || stream.destroyed) return
      if (!far.has(stream)) {
        far.set(stream, 0)
        stream.once('close', () => { farTotal -= far.get(stream); far.delete(stream) })
      }
      weigh(stream)
      if (far.get(stream) > limits.queuedBytes / 2) {
        refusals.line('closed', 'far queue')
        stream.destroy(new Error('The far peer is not taking what is sent'))
        weigh(stream)
      }
      if (over()) drop('queue')
      else holdQueued(ws)
    }
    // A token bucket on what the client sends, its pings and pongs too: past it, the relay stops reading its socket for a while.
    let tokens = limits.burstBytes
    let last = Date.now()
    let paused = false
    const spend = bytes => {
      const now = Date.now()
      tokens = Math.min(limits.burstBytes, tokens + (now - last) * limits.bytesPerSecond / 1000)
      last = now
      tokens -= bytes
      if (tokens < 0 && !paused && ws._socket) {
        paused = true
        ws._socket.pause()
        setTimeout(() => { paused = false; ws._socket?.resume() }, Math.ceil(-tokens / limits.bytesPerSecond * 1000))
      }
    }
    ws.on('message', data => spend(data.length ?? data.byteLength ?? 0))
    // A control frame from a client is its payload and 6 bytes (header and mask), so an empty one still costs.
    const CONTROL_FRAME_BYTES = 6
    // At most one pong waits to be written: a ping that comes meanwhile is kept, the last one only, and answered once
    // it is (RFC 6455 5.5.3 lets a pong answer only the most recent ping). Each pong waiting cost the process about
    // 700 bytes, and one client sent a million pings a second. The payload is copied: it is a view into the chunk the
    // socket read, which a kept ping would hold whole.
    let ponging = false
    let nextPing = null
    const pong = data => {
      ponging = true
      ws.pong(data, false, () => {
        ponging = false
        const next = nextPing
        nextPing = null
        if (next && ws.readyState === ws.OPEN) pong(next)
      })
    }
    ws.on('ping', data => {
      spend(data.length + CONTROL_FRAME_BYTES)
      if (dropped) return
      if (ponging) nextPing = Buffer.from(data)
      else pong(Buffer.from(data))
    })
    // A peer that has gone without closing (a sleeping laptop, a dead route) still holds its slot: one that has not
    // answered the last ping by the next is dropped.
    let answered = true
    ws.on('pong', data => { spend(data.length + CONTROL_FRAME_BYTES); answered = true })
    const ping = setInterval(() => {
      if (!answered) return drop('no pong')
      answered = false
      ws.ping()
    }, limits.pingMs)
    let leave
    const gone = new Promise(resolve => { leave = resolve })
    ws.once('close', () => {
      // A client that has closed is no longer dropped, counted or logged.
      dropped = true
      unqueue(ws)
      clearInterval(ping)
      leave()
      release()
    })
    ws.on('error', () => drop('socket error'))
    const stream = new WsStream(false, ws)
    stream.on('error', () => drop('stream error'))
    // dht-relay 0.4.3 hands the WebSocket every chunk a HyperDHT stream brings, however slowly the client reads, and
    // a UDX stream has no receive window to slow its far end: a client that reads slowly or not at all would have the
    // relay hold everything its far peers send. Past `queuedBytes` waiting for it (with what waits for its far peers), it
    // is dropped, and past `queuedTotalBytes` over all clients, the one holding the most.
    stream._write = (data, cb) => {
      ws.send(data)
      if (over()) drop('queue')
      else holdQueued(ws)
      cb(null)
    }
    // protomux keeps itself on a stream whose userData is null (a WsStream has none), and relay() makes the client's
    // mux at once: guardMux gets it there.
    stream.userData = null
    const session = relay(clientDht(dht, limits, drop, gone, refusals.line, wrote), stream)
    guardMux(stream.userData, drop)
    void session.then(node => {
      guardProtocol(node._protocol, drop)
      bound(node, limits, gone, refusals.line)
      nodes.add(node)
      void gone.then(() => nodes.delete(node))
    })
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  }).catch(async error => {
    // The node (and a testnet) are up by now: a relay that cannot listen leaves none of them running.
    if (!options.dht) await dht.destroy()
    if (testnet) await testnet.destroy()
    throw error
  })
  const { port } = server.address()
  const host = options.host && options.host !== '0.0.0.0' ? options.host : '127.0.0.1'
  return {
    url: `ws://${host}:${port}`,
    port,
    bootstrap,
    dht,
    stats: () => ({
      clients: clients.size,
      ...stats,
      sinceAnswerMs: answeredAt === null ? null : Date.now() - answeredAt,
      held: [...nodes].reduce((held, node) => ({ handshakes: held.handshakes + node._handshakes.size, signatures: held.signatures + node._signatures.size }), { handshakes: 0, signatures: 0 }),
    }),
    // Each client is told the relay is going away (1001), so it reconnects as it would after a restart, not a crash;
    // one that has not closed within `stopMs` is cut. Meanwhile a new client is refused (503) and /healthz reads 503.
    async close({ stopMs = 1000 } = {}) {
      stopping = true
      for (const ws of clients) ws.close(1001, 'The relay is stopping')
      if (clients.size) {
        let timer
        await Promise.race([
          Promise.all([...clients].map(ws => new Promise(resolve => ws.once('close', resolve)))),
          new Promise(resolve => { timer = setTimeout(resolve, stopMs) }),
        ])
        clearTimeout(timer)
      }
      for (const ws of clients) ws.terminate()
      // What the last minute left out is said before the relay stops.
      clearInterval(flushing)
      clearInterval(forgetRoom)
      refusals.flush()
      await new Promise(resolve => { wss.close(); server.close(() => resolve()); server.closeAllConnections() })
      if (!options.dht) await dht.destroy()
      if (testnet) await testnet.destroy()
    },
  }
}

/**
 * An entry of GHOSTLY_RELAY_ORIGINS as a browser writes it in `Origin`: scheme and host in lower case, a default port
 * left out, no trailing `/` (`HTTPS://App.Example:443/` is `https://app.example`). An extension's or an app's own
 * scheme (`chrome-extension://<id>`, `tauri://localhost`) keeps its host as written. Null for an entry that is no
 * origin (not a URL, no host, a user, a path past `/`, a query, a fragment, `file:`): a browser never sends one, so
 * such an entry would turn every browser away.
 */
export function originOf (entry) {
  let url
  try { url = new URL(entry) } catch { return null }
  if (url.protocol === 'file:' || !url.host || url.username || url.password || !['', '/'].includes(url.pathname) || /[?#]/.test(entry)) return null
  return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`
}

/**
 * Logs a refused `Origin` (`refused origin "https://app.example"`, `(none)` for a request without one), each value
 * once an hour and at most `most` values an hour, so a misspelt GHOSTLY_RELAY_ORIGINS shows in the log and a client
 * sending a new value each time cannot flood it.
 */
export function originRefusals (log, { most = 16, now = Date.now } = {}) {
  let seen = new Set()
  let since = now()
  let full = false
  return origin => {
    if (now() - since >= 3_600_000) { seen = new Set(); since = now(); full = false }
    const shown = origin === undefined ? '(none)' : JSON.stringify(String(origin).slice(0, 200))
    if (seen.has(shown)) return
    if (seen.size >= most) {
      if (!full) log('refused', 'origin', `(more than ${most} values this hour, not logged)`)
      full = true
      return
    }
    seen.add(shown)
    log('refused', 'origin', shown)
  }
}

/**
 * One setting from the environment: absent gives `fallback`; present, it must read as `kind` says, or the start stops
 * with one line naming it (an empty `PORT=` in an env file, `GHOSTLY_RELAY_PROXIES=one`), never a quiet default.
 */
function setting (env, name, fallback, kind) {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = raw.trim()
  const fail = expected => { throw new Error(`${name}=${JSON.stringify(raw)}: expected ${expected}`) }
  if (kind === 'port') return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : fail('a port from 1 to 65535')
  if (kind === 'count') return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fail('a whole number of 0 or more')
  if (kind === 'positive') return /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Number(value) : fail('a whole number above 0')
  // Node runs a timer past 2^31-1 ms after 1 ms: "about 35 days" would drop every client as it connects.
  if (kind === 'ms') return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= TIMER_MAX_MS ? Number(value) : fail(`a whole number above 0, at most ${TIMER_MAX_MS} (about 24 days)`)
  if (kind === 'flag') return value === '1' ? true : value === '0' ? false : fail('1 or 0')
  if (kind === 'text') return value || fail('a value (leave it out for the default)')
  if (kind === 'origins') {
    const entries = list(value)
    const wrong = entries.find(entry => !originOf(entry))
    if (wrong !== undefined) fail(`origins like https://app.example, comma-separated: a scheme, a host and a port only (${JSON.stringify(wrong)} is not one)`)
    return [...new Set(entries.map(originOf))]
  }
  return value
}

const TIMER_MAX_MS = 2 ** 31 - 1

const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean)

/**
 * The GHOSTLY_RELAY_* and GHOSTLY_HYPERDHT_* variables in `env` that are none of `known`, sorted, each with the known
 * name at most 3 edits away when there is one (`GHOSTLY_RELAY_ORIGIN (GHOSTLY_RELAY_ORIGINS?)`): a misspelt name was the
 * default without a word, often the less safe one. Not a refusal: one env file may serve both relays.
 */
function ignoredSettings (env, known) {
  return Object.keys(env).filter(name => /^GHOSTLY_(RELAY|HYPERDHT)_/.test(name) && !known.includes(name)).sort().map(name => {
    const [closest] = known.map(other => ({ other, edits: editDistance(name, other) })).sort((a, b) => a.edits - b.edits)
    return closest && closest.edits <= 3 ? `${name} (${closest.other}?)` : name
  })
}

/** Levenshtein distance: the fewest characters to add, drop or change to turn `a` into `b`. */
function editDistance (a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** `GHOSTLY_RELAY_<LIMIT>` for a limit's name in DEFAULT_LIMITS: `clientsPerAddress` is GHOSTLY_RELAY_CLIENTS_PER_ADDRESS. */
export const limitVariable = name => `GHOSTLY_RELAY_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`

const nodeCount = count => `${count} ${count === 1 ? 'node' : 'nodes'}`

/** The HyperDHT network the relay's settings put it on, as the start line says it. */
export const networkOf = ({ testnet, bootstrap }) =>
  testnet ? `(own testnet of ${nodeCount(testnet)})` : bootstrap.length ? `(bootstrap ${nodeCount(bootstrap.length)})` : '(public HyperDHT)'

/**
 * The relay's settings from its environment (server.mjs): PORT (49443), HOST (0.0.0.0; 127.0.0.1 behind proxies
 * or Cloudflare), GHOSTLY_HYPERDHT_BOOTSTRAP,
 * GHOSTLY_HYPERDHT_TESTNET, GHOSTLY_RELAY_ORIGINS, GHOSTLY_RELAY_CLOUDFLARE (1 or 0), GHOSTLY_RELAY_PROXIES (0) and
 * GHOSTLY_RELAY_<LIMIT>. Throws on one present but not of its kind, and on a testnet with bootstrap nodes. `ignored`
 * names the other GHOSTLY_RELAY_* and GHOSTLY_HYPERDHT_* variables (see ignoredSettings), for server.mjs to print.
 */
export function readSettings (env) {
  const limits = {}
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    const value = setting(env, limitVariable(name), undefined, name.endsWith('Ms') ? 'ms' : 'positive')
    if (value !== undefined) limits[name] = value
  }
  const bootstrap = bootstrapSetting(env)
  const testnet = setting(env, 'GHOSTLY_HYPERDHT_TESTNET', 0, 'count') || undefined
  // startRelay drops the bootstrap nodes for the testnet: both set is one of them meant for another start.
  if (testnet && bootstrap.length) throw new Error(`GHOSTLY_HYPERDHT_TESTNET=${JSON.stringify(env.GHOSTLY_HYPERDHT_TESTNET)}: expected no GHOSTLY_HYPERDHT_BOOTSTRAP with it (the testnet is a network of its own)`)
  const proxies = setting(env, 'GHOSTLY_RELAY_PROXIES', 0, 'count')
  const cloudflare = setting(env, 'GHOSTLY_RELAY_CLOUDFLARE', false, 'flag')
  return {
    port: setting(env, 'PORT', 49443, 'port'),
    // Behind a proxy only the proxy should reach it: anyone else could write the header a client is counted by.
    host: setting(env, 'HOST', proxies || cloudflare ? '127.0.0.1' : '0.0.0.0', 'text'),
    bootstrap,
    testnet,
    origins: setting(env, 'GHOSTLY_RELAY_ORIGINS', [], 'origins'),
    proxies,
    cloudflare,
    limits,
    ignored: ignoredSettings(env, [
      ...Object.keys(DEFAULT_LIMITS).map(limitVariable), 'GHOSTLY_HYPERDHT_BOOTSTRAP', 'GHOSTLY_HYPERDHT_TESTNET',
      'GHOSTLY_RELAY_ORIGINS', 'GHOSTLY_RELAY_CLOUDFLARE', 'GHOSTLY_RELAY_PROXIES',
    ]),
  }
}

/**
 * GHOSTLY_HYPERDHT_BOOTSTRAP: `host:port` entries (`ip@host:port` too, as HyperDHT's own list), comma-separated, each
 * port from 1 to 65535. Left out, the public HyperDHT. One without a port (`127.0.0.1`) or with a word for one stops the
 * start here, by name, rather than as a stack out of dht-rpc; an empty one too, which would quietly be the public one.
 */
function bootstrapSetting (env) {
  const raw = env.GHOSTLY_HYPERDHT_BOOTSTRAP
  if (raw === undefined) return []
  const entries = list(raw)
  const wrong = entries.find(entry => {
    const match = /^[^\s:]+:(\d+)$/.exec(entry)
    return !match || Number(match[1]) < 1 || Number(match[1]) > 65535
  })
  if (entries.length && wrong === undefined) return entries
  throw new Error(`GHOSTLY_HYPERDHT_BOOTSTRAP=${JSON.stringify(raw)}: expected host:port nodes, comma-separated, each port from 1 to 65535 (leave it out for the public HyperDHT)${wrong === undefined ? '' : `; ${JSON.stringify(wrong)} is not one`}`)
}

/**
 * Why the relay could not listen, as one line naming the setting to change, for server.mjs to print instead of Node's
 * stack: a port another program holds, a port below 1024 for a user without the right, a HOST that is no address of
 * this machine or no name at all. Null for any other error, which keeps its stack.
 */
export function listenProblem (error, { port, host }) {
  switch (error?.code) {
    case 'EADDRINUSE': return `port ${port} on ${host} is already in use (PORT)`
    case 'EACCES': return `port ${port} on ${host} needs more rights than this user has (PORT): below 1024, root or the cap_net_bind_service capability`
    case 'EADDRNOTAVAIL': return `cannot listen on ${host}: it is no address of this machine (HOST)`
    case 'ENOTFOUND': case 'EAI_AGAIN': case 'EAI_FAIL': case 'EAI_NONAME': return `cannot listen on ${JSON.stringify(host)}: no such host (HOST)`
    default: return null
  }
}
