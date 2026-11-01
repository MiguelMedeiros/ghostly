import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import DHT from 'hyperdht'
import { relay } from '@hyperswarm/dht-relay'
import WsStream from '@hyperswarm/dht-relay/ws'
import { WebSocketServer } from 'ws'

/**
 * What one relay accepts. A Ghostly browser holds one WebSocket, listens once per saved chat or group link (at most
 * eight native listeners per app, and one per linked device) and dials a contact now and then; everything above that
 * is someone else's traffic.
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** WebSockets at once, over all clients. */
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
  /** Handshakes that may wait on one client's answer at once: its dials and the connections its servers get. */
  handshakes: 64,
})

/**
 * dht-relay 0.4.3 (its latest release) hands a browser the announce record where the browser expects the
 * record's relay addresses, so signing an announcement throws and nobody can reach a browser that listens.
 * The browser signs `{ publicKey, relayAddresses }` itself; this gives it the list it signs.
 */
/**
 * The browser signs its announcements, so a relay waiting for a signature from a browser that has gone
 * would wait forever (the server it closes on that browser's behalf never finishes unannouncing, and holds
 * on). A signature comes within `SIGN_MS` or while the browser is there, or not at all.
 */
const SIGN_MS = 10_000
const fixSign = (sign, gone) => sign && ((target, token, id, ann, keyPair) => {
  let timer
  return Promise.race([
    sign(target, token, id, { peer: ann.peer.relayAddresses }, keyPair),
    gone.then(() => { throw new Error('The browser left') }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No signature')), SIGN_MS) }),
  ]).finally(() => clearTimeout(timer))
})
const fixOptions = (options = {}, gone) => ({ ...options, signAnnounce: fixSign(options.signAnnounce, gone), signUnannounce: fixSign(options.signUnannounce, gone) })

/**
 * The DHT one client's relay session sees: listen and dial within its budget, nothing else. Topic lookups
 * and announcements are refused (Ghostly never uses them), so the relay is no open crawler. Past a limit
 * the client is dropped, and so is one that holds its slot with no listen open and no dial for `idleMs`.
 *
 * Every client shares the relay's one HyperDHT node, which refuses a second listen on a key it already listens
 * on (`KEYPAIR_ALREADY_USED`, whoever asked first). dht-relay 0.4.3 does not catch that rejection, so it would end
 * the process and every client with it. A listen the node refuses closes that server only: the client that holds
 * the key, and the asking client's other listens, go on.
 */
function clientDht(dht, limits, drop, gone, log) {
  let listening = 0
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
  const streams = new Set()
  const hold = stream => {
    if (left || streams.size >= limits.streams) { stream.destroy(); return stream }
    streams.add(stream)
    stream.once('close', () => streams.delete(stream))
    return stream
  }
  void gone.then(() => {
    clearTimeout(idle)
    left = true
    for (const stream of streams) stream.destroy()
    streams.clear()
  })
  return new Proxy(dht, {
    get(target, prop) {
      if (prop === 'createServer') return (options, onconnection) => {
        if (++listening > limits.listens) { drop('listen limit'); throw new Error('Listen limit reached') }
        watchIdle()
        const server = target.createServer({ ...options, createHandshake: untracked(options?.createHandshake) }, onconnection)
        const listen = server.listen.bind(server)
        server.listen = (keyPair, listenOptions) => listen(keyPair, fixOptions(listenOptions, gone)).catch(error => {
          log('refused listen', error?.code ?? 'error')
          void server.close().catch(() => {})
        })
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
        return hold(target.connect(publicKey, { ...options, createHandshake: untracked(options?.createHandshake) }))
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

const require = createRequire(import.meta.url)
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
const roundTrip = original => function (payload) {
  const handshakes = this._node._handshakes
  const limits = this._node._limits ?? DEFAULT_LIMITS
  if (handshakes.size >= limits.handshakes) return Promise.reject(new Error('Too many handshakes'))
  handshakes.set(this._id, this)
  let timer
  return Promise.race([
    original.call(this, payload),
    new Promise((_, reject) => {
      timer = setTimeout(() => { this._onNoiseReply = null; reject(new Error('No handshake answer')) }, limits.handshakeMs)
    }),
  ]).finally(() => {
    clearTimeout(timer)
    if (handshakes.get(this._id) === this) handshakes.delete(this._id)
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
function bound(node, limits, gone) {
  node._limits = limits
  const signatures = new Signatures()
  for (const [id, signature] of node._signatures) signatures.set(id, signature)
  node._signatures = signatures
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
 * /64, the block one subscriber usually holds whole. The push relay's `rateKey`; the two services ship separately.
 */
export function addressKey(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return mapped[1]
  if (!address.includes(':')) return address
  const [head, tail] = address.split('%')[0].split('::')
  const before = head ? head.split(':') : []
  const after = tail ? tail.split(':') : []
  const groups = tail === undefined ? before : [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after]
  const prefix = groups.slice(0, 4).map(group => parseInt(group, 16))
  return prefix.length === 4 && prefix.every(n => n >= 0 && n <= 0xffff) ? `${prefix.map(n => n.toString(16)).join(':')}::/64` : address
}

/**
 * Starts a relay: an HTTP server whose WebSocket upgrades each carry one browser's HyperDHT (dht-relay,
 * non-custodial: the browser keeps its keys and runs the Noise handshake and the encrypted stream itself;
 * the relay moves handshake messages and ciphertext). `GET /healthz` answers with the counts and the node's state,
 * 503 while its routing table is empty.
 *
 * options: port, host, bootstrap (host:port list), testnet (size of an in-process HyperDHT network, for tests
 * and e2e), limits, origins (allowed `Origin` values; empty allows any), proxies, cloudflare (see addressOf), log.
 */
export async function startRelay(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
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
  const dht = options.dht ?? new DHT(bootstrap.length ? { bootstrap, ...(loopback ? { host: '127.0.0.1', firewalled: false } : {}) } : {})
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
  const perAddress = new Map()
  const stats = { accepted: 0, refused: 0, dropped: 0 }
  const origins = new Set(options.origins ?? [])

  // Node's defaults (60 s for the headers, 300 s for the request) let a connection that never upgrades sit for minutes.
  const server = http.createServer({ requestTimeout: limits.requestMs, headersTimeout: limits.requestMs, connectionsCheckingInterval: Math.min(1000, limits.requestMs) }, (request, response) => {
    if (request.url === '/healthz') {
      // Healthy while the node's routing table holds another node: with none, nobody reaches what it announces.
      const reached = dht.toArray().length
      response.writeHead(reached > 0 ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: reached > 0, clients: clients.size, ...stats, firewalled: dht.firewalled, nodes: reached, sinceAnswerMs: answeredAt === null ? null : Date.now() - answeredAt }))
      return
    }
    response.writeHead(426, { 'content-type': 'text/plain' }); response.end('Ghostly HyperDHT relay: connect with a WebSocket\n')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.payloadBytes, perMessageDeflate: false })

  server.on('upgrade', (request, socket, head) => {
    const address = addressKey(addressOf(request, { proxies: options.proxies, cloudflare: options.cloudflare }))
    const origin = request.headers.origin
    const refuse = (status, why) => {
      stats.refused++; log('refused', why)
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    }
    if (origins.size && !origins.has(origin)) return refuse('403 Forbidden', 'origin')
    if (clients.size >= limits.clients) return refuse('503 Service Unavailable', 'full')
    if ((perAddress.get(address) ?? 0) >= limits.clientsPerAddress) return refuse('429 Too Many Requests', 'address')
    wss.handleUpgrade(request, socket, head, ws => accept(ws, address))
  })

  function accept(ws, address) {
    stats.accepted++
    clients.add(ws)
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1)
    let dropped = false
    const drop = why => {
      if (dropped) return
      dropped = true; stats.dropped++; log('dropped', why)
      ws.terminate()
    }
    // A token bucket on what the client sends: past it, the relay stops reading its socket for a while.
    let tokens = limits.burstBytes
    let last = Date.now()
    let paused = false
    ws.on('message', data => {
      const now = Date.now()
      tokens = Math.min(limits.burstBytes, tokens + (now - last) * limits.bytesPerSecond / 1000)
      last = now
      tokens -= data.length ?? data.byteLength ?? 0
      if (tokens < 0 && !paused && ws._socket) {
        paused = true
        ws._socket.pause()
        setTimeout(() => { paused = false; ws._socket?.resume() }, Math.ceil(-tokens / limits.bytesPerSecond * 1000))
      }
    })
    // A peer that has gone without closing (a sleeping laptop, a dead route) still holds its slot: one that has not
    // answered the last ping by the next is dropped.
    let answered = true
    ws.on('pong', () => { answered = true })
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
      clearInterval(ping)
      leave()
      clients.delete(ws)
      const left = (perAddress.get(address) ?? 1) - 1
      if (left > 0) perAddress.set(address, left)
      else perAddress.delete(address)
    })
    ws.on('error', () => drop('socket error'))
    const stream = new WsStream(false, ws)
    stream.on('error', () => drop('stream error'))
    void relay(clientDht(dht, limits, drop, gone, log), stream).then(node => {
      guardProtocol(node._protocol, drop)
      bound(node, limits, gone)
      nodes.add(node)
      void gone.then(() => nodes.delete(node))
    })
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
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
      held: [...nodes].reduce((held, node) => ({ handshakes: held.handshakes + node._handshakes.size, signatures: held.signatures + node._signatures.size }), { handshakes: 0, signatures: 0 }),
    }),
    async close() {
      for (const ws of clients) ws.terminate()
      await new Promise(resolve => { wss.close(); server.close(() => resolve()) })
      if (!options.dht) await dht.destroy()
      if (testnet) await testnet.destroy()
    },
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
  if (kind === 'flag') return value === '1' ? true : value === '0' ? false : fail('1 or 0')
  if (kind === 'text') return value || fail('a value (leave it out for the default)')
  return value
}

const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean)

/** `GHOSTLY_RELAY_<LIMIT>` for a limit's name in DEFAULT_LIMITS: `clientsPerAddress` is GHOSTLY_RELAY_CLIENTS_PER_ADDRESS. */
export const limitVariable = name => `GHOSTLY_RELAY_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`

/**
 * The relay's settings from its environment (server.mjs): PORT (49443), HOST (0.0.0.0), GHOSTLY_HYPERDHT_BOOTSTRAP,
 * GHOSTLY_HYPERDHT_TESTNET, GHOSTLY_RELAY_ORIGINS, GHOSTLY_RELAY_CLOUDFLARE (1 or 0), GHOSTLY_RELAY_PROXIES (0) and
 * GHOSTLY_RELAY_<LIMIT>. Throws on one present but not of its kind.
 */
export function readSettings (env) {
  const limits = {}
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    const value = setting(env, limitVariable(name), undefined, 'positive')
    if (value !== undefined) limits[name] = value
  }
  return {
    port: setting(env, 'PORT', 49443, 'port'),
    host: setting(env, 'HOST', '0.0.0.0', 'text'),
    bootstrap: list(env.GHOSTLY_HYPERDHT_BOOTSTRAP),
    testnet: setting(env, 'GHOSTLY_HYPERDHT_TESTNET', 0, 'count') || undefined,
    origins: list(env.GHOSTLY_RELAY_ORIGINS),
    proxies: setting(env, 'GHOSTLY_RELAY_PROXIES', 0, 'count'),
    cloudflare: setting(env, 'GHOSTLY_RELAY_CLOUDFLARE', false, 'flag'),
    limits,
  }
}
