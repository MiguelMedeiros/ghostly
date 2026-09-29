import http from 'node:http'
import DHT from 'hyperdht'
import { relay } from '@hyperswarm/dht-relay'
import WsStream from '@hyperswarm/dht-relay/ws'
import { WebSocketServer } from 'ws'

/**
 * What one relay accepts. A Ghostly browser holds one WebSocket, listens once per saved chat (at most eight
 * native listeners per app) and dials a contact now and then; everything above that is someone else's traffic.
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** WebSockets at once, over all clients. */
  clients: 512,
  /** WebSockets at once from one address. */
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
 * the client is dropped.
 */
function clientDht(dht, limits, drop, gone) {
  let listening = 0
  let dials = []
  return new Proxy(dht, {
    get(target, prop) {
      if (prop === 'createServer') return (options, onconnection) => {
        if (++listening > limits.listens) { drop('listen limit'); throw new Error('Listen limit reached') }
        const server = target.createServer(options, onconnection)
        const listen = server.listen.bind(server)
        server.listen = (keyPair, listenOptions) => listen(keyPair, fixOptions(listenOptions, gone))
        server.once('close', () => { listening-- })
        return server
      }
      if (prop === 'connect') return (publicKey, options) => {
        const now = Date.now()
        dials = dials.filter(at => now - at < 60_000)
        if (dials.push(now) > limits.connectsPerMinute) { drop('dial limit'); throw new Error('Dial limit reached') }
        return target.connect(publicKey, options)
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

/** The address a client connects from: the proxy's word for it only when the relay is told to trust one. */
function addressOf(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['cf-connecting-ip'] ?? String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (forwarded) return String(forwarded)
  }
  return request.socket.remoteAddress ?? 'unknown'
}

/**
 * Starts a relay: an HTTP server whose WebSocket upgrades each carry one browser's HyperDHT (dht-relay,
 * non-custodial: the browser keeps its keys and runs the Noise handshake and the encrypted stream itself;
 * the relay moves handshake messages and ciphertext). `GET /healthz` answers with the counts.
 *
 * options: port, host, bootstrap (host:port list), testnet (size of an in-process HyperDHT network, for tests
 * and e2e), limits, origins (allowed `Origin` values; empty allows any), trustProxy, log.
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
  const dht = options.dht ?? new DHT(bootstrap.length ? { bootstrap, ...(loopback ? { host: '127.0.0.1' } : {}) } : {})
  await dht.ready()

  const clients = new Set()
  const perAddress = new Map()
  const stats = { accepted: 0, refused: 0, dropped: 0 }
  const origins = new Set(options.origins ?? [])

  const server = http.createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, clients: clients.size, ...stats, firewalled: dht.firewalled }))
      return
    }
    response.writeHead(426, { 'content-type': 'text/plain' }); response.end('Ghostly HyperDHT relay: connect with a WebSocket\n')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.payloadBytes, perMessageDeflate: false })

  server.on('upgrade', (request, socket, head) => {
    const address = addressOf(request, options.trustProxy)
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
    let leave
    const gone = new Promise(resolve => { leave = resolve })
    ws.once('close', () => {
      leave()
      clients.delete(ws)
      const left = (perAddress.get(address) ?? 1) - 1
      if (left > 0) perAddress.set(address, left)
      else perAddress.delete(address)
    })
    ws.on('error', () => drop('socket error'))
    const stream = new WsStream(false, ws)
    stream.on('error', () => drop('stream error'))
    void relay(clientDht(dht, limits, drop, gone), stream).then(node => guardProtocol(node._protocol, drop))
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
    stats: () => ({ clients: clients.size, ...stats }),
    async close() {
      for (const ws of clients) ws.terminate()
      await new Promise(resolve => { wss.close(); server.close(() => resolve()) })
      if (!options.dht) await dht.destroy()
      if (testnet) await testnet.destroy()
    },
  }
}
