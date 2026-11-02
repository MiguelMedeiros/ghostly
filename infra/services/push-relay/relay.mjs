import { createServer } from 'node:http'

/**
 * A push relay for Ghostly's wake-up push (WISP 401 § Wake-up push). A browser page may not post to a push
 * service itself (the services answer without CORS), so the app can hand the finished request to a relay the
 * person chose (Settings → Network → Push relay), which posts it as it is and answers with the push service's
 * status. The request is already encrypted and signed by the app: the relay holds no key and reads no content.
 * It learns what the push service learns (that a push to that endpoint happened, and when), plus the sender's
 * address. Nothing is stored or logged but counts.
 *
 *     POST /   {"endpoint":"https://…","headers":{"Authorization":"vapid …","TTL":"3600",…},"body":"<base64url>"}
 *     → 200    {"status":<the push service's status>}
 */

/** Push services a relay posts to by default: Google (Chrome, Android, Edge on Android), Apple, Mozilla, Microsoft. */
export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/]
/** Only these headers go through: what Web Push needs, nothing the sender could use to reach anything else. */
const HEADERS = ['authorization', 'ttl', 'urgency', 'topic', 'content-encoding', 'content-type']

/**
 * `tracked`: addresses whose counts are kept at most. Past it, the ones idle for a minute go first, then the oldest:
 * a full table forgets a count rather than turn away every newcomer.
 * `requestMs`: how long a client has to send a whole request (headers and body) before the connection is closed.
 */
export const DEFAULT_LIMITS = { bodyBytes: 8 * 1024, perMinute: 30, tracked: 10_000, requestMs: 15_000 }
/** RFC 8292's `vapid t=<JWT>, k=<key>`: a request without one is not a Web Push the relay would forward. */
const VAPID = /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, ?k=[A-Za-z0-9_-]+$/

const b64url = text => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** The request to forward, or a reason it is refused. */
export function readRelayRequest (text, { hosts = PUSH_HOSTS, bodyBytes = DEFAULT_LIMITS.bodyBytes } = {}) {
  let request
  try { request = JSON.parse(text) } catch { return { error: 'Not JSON' } }
  const { endpoint, headers, body } = request ?? {}
  let url
  try { url = new URL(endpoint) } catch { return { error: 'No endpoint' } }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.some(host => host.test(url.hostname))) return { error: 'Not a push service' }
  if (typeof body !== 'string' || !/^[A-Za-z0-9_-]*$/.test(body)) return { error: 'No body' }
  const bytes = b64url(body)
  if (bytes.length > bodyBytes) return { error: 'Too large' }
  const forwarded = {}
  const seen = new Set()
  for (const [name, value] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    const lower = name.toLowerCase()
    // A header named twice (in two spellings) is refused: the check below reads one, the push service would get both.
    if (seen.has(lower)) return { error: `${name} twice` }
    seen.add(lower)
    if (HEADERS.includes(lower) && typeof value === 'string' && value.length < 2048 && !/[\r\n]/.test(value)) forwarded[name] = value
  }
  const authorization = Object.entries(forwarded).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  if (!authorization || !VAPID.test(authorization)) return { error: 'No VAPID authorization' }
  return { endpoint: url.href, headers: forwarded, body: bytes }
}

/**
 * Why a forward failed, as a word an operator can act on: `timeout`, `redirect`, or the system's or TLS's code
 * (`ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`). Never the message, which can hold the endpoint.
 */
export function failure (error) {
  if (error?.name === 'TimeoutError') return 'timeout'
  const code = error?.cause?.code ?? error?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code
  return error?.cause?.message === 'unexpected redirect' ? 'redirect' : 'error'
}

/**
 * The address a request counts against. Behind `proxies` reverse proxies (a tunnel, nginx), the socket's address is the
 * last proxy's, so the client's is the entry that many from the end of `X-Forwarded-For` (the ones before it are the
 * client's to write). With none configured, the header is ignored.
 */
export function clientAddress (req, proxies = 0) {
  const socket = req.socket.remoteAddress ?? ''
  if (!proxies) return socket
  const header = req.headers['x-forwarded-for']
  const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return hops.length >= proxies ? hops[hops.length - proxies] : socket
}

/**
 * What a limit counts: an IPv4 address as it is (an IPv4-mapped IPv6 one too), an IPv6 address by its /64, the block
 * one subscriber usually holds whole.
 */
export function rateKey (address) {
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
 * Refusals as counts, so a flood of them stays quiet: the first of a kind in a quiet minute is logged at once
 * (`refused rate`), the rest of that minute as one line when `flush` runs (`refused rate 41 more`).
 */
export function refusalLog (log) {
  // Kind → refusals since its last line. Present: a line for it went out in this minute.
  const pending = new Map()
  let total = 0
  return {
    /** Refusals since the start, of every kind. */
    total: () => total,
    refuse: why => {
      total++
      if (pending.has(why)) pending.set(why, pending.get(why) + 1)
      else { pending.set(why, 0); log('refused', why) }
    },
    flush: () => {
      for (const [why, more] of pending) {
        if (more) { log('refused', why, `${more} more`); pending.set(why, 0) } else pending.delete(why)
      }
    },
  }
}

export function startRelay ({ port = 0, host = '127.0.0.1', origins = [], hosts = PUSH_HOSTS, limits = {}, proxies = 0, log = () => {} } = {}) {
  const { bodyBytes, perMinute, tracked, requestMs } = { ...DEFAULT_LIMITS, ...limits }
  // The JSON around a body of `bodyBytes`: base64url is a third longer, and the headers add a few KB.
  const requestBytes = bodyBytes * 2
  const recent = new Map()
  let pruned = 0
  const prune = now => { pruned = now; for (const [ip, times] of recent) if (!times.some(t => now - t < 60_000)) recent.delete(ip) }
  const refusals = refusalLog(log)
  const stats = { forwarded: 0, failed: 0 }
  const pruning = setInterval(() => { prune(Date.now()); refusals.flush() }, 60_000)
  pruning.unref?.()
  const allowOrigin = origin => (origins.length === 0 ? '*' : origins.includes(origin) ? origin : null)

  // A slow client is closed after `requestMs`, checked every second (Node's default waits up to five minutes).
  const server = createServer({ requestTimeout: requestMs, headersTimeout: requestMs, connectionsCheckingInterval: Math.min(1000, requestMs) }, (req, res) => {
    const origin = allowOrigin(req.headers.origin ?? '')
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {}
    const answer = (status, value) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    const refuse = (why, status, value) => { refusals.refuse(why); answer(status, value) }
    // An operator's check (curl, a monitor): up, with counts since the start, and nothing about any client.
    if (req.method === 'GET' && req.url.split('?')[0] === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, ...stats, refused: refusals.total(), tracked: recent.size }))
      return
    }
    if (req.method === 'OPTIONS') { if (!origin) refusals.refuse('origin'); res.writeHead(origin ? 204 : 403, cors); res.end(); return }
    if (req.method !== 'POST') return refuse('method', 405, { error: 'No' })
    if (!origin) return refuse('origin', 403, { error: 'No' })

    const ip = rateKey(clientAddress(req, proxies))
    const now = Date.now()
    // A newcomer to a full table: the idle go (a scan at most once a second), else the oldest entry.
    if (recent.size >= tracked && !recent.has(ip) && now - pruned >= 1000) prune(now)
    if (recent.size >= tracked && !recent.has(ip)) recent.delete(recent.keys().next().value)
    const times = (recent.get(ip) ?? []).filter(t => now - t < 60_000)
    if (times.length >= perMinute) return refuse('rate', 429, { error: 'Too many' })
    times.push(now)
    // Last in the map's order: the first entry is always the one seen longest ago.
    recent.delete(ip)
    recent.set(ip, times)

    if (Number(req.headers['content-length']) > requestBytes) return refuse('size', 413, { error: 'Too large' })
    const chunks = []
    let size = 0
    // Bytes, not characters: text of many-byte characters counts for what it weighs.
    req.on('data', chunk => {
      size += chunk.length
      if (size <= requestBytes) chunks.push(chunk)
      else if (!req.destroyed) { refusals.refuse('size'); req.destroy() }
    })
    req.on('end', async () => {
      const request = readRelayRequest(Buffer.concat(chunks).toString('utf8'), { hosts, bodyBytes })
      // `<name> twice` names a header the client chose: the log says only which kind it was.
      if (request.error) return refuse(request.error.endsWith(' twice') ? 'header twice' : request.error, 400, { error: request.error })
      try {
        const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
        stats.forwarded++
        log('forwarded', response.status)
        answer(200, { status: response.status })
      } catch (error) {
        stats.failed++
        log('failed', failure(error))
        answer(502, { error: 'The push service did not answer' })
      }
    })
  })

  return new Promise(resolve => server.listen(port, host, () => resolve({
    port: server.address().port,
    tracked: () => recent.size,
    /** Open connections, a request in them or not. */
    clients: () => new Promise(done => server.getConnections((_, count) => done(count ?? 0))),
    // `server.close` stops the check that ends a slow request, so a client holding half a request would hold the
    // close for as long as it stays: a request still open after `stopMs` (a forward in flight, a slow client) is cut.
    close: ({ stopMs = 3000 } = {}) => new Promise(done => {
      clearInterval(pruning)
      refusals.flush()
      const cut = setTimeout(() => server.closeAllConnections(), stopMs)
      server.close(() => { clearTimeout(cut); done() })
    }),
  })))
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

/**
 * The relay's settings from its environment (server.mjs): PORT (49480), HOST (0.0.0.0; 127.0.0.1 behind proxies),
 * GHOSTLY_RELAY_ORIGINS, GHOSTLY_RELAY_PROXIES (0). Throws on one present but not of its kind.
 */
export function readSettings (env) {
  const proxies = setting(env, 'GHOSTLY_RELAY_PROXIES', 0, 'count')
  return {
    port: setting(env, 'PORT', 49480, 'port'),
    host: setting(env, 'HOST', proxies ? '127.0.0.1' : '0.0.0.0', 'text'),
    origins: list(env.GHOSTLY_RELAY_ORIGINS),
    proxies,
  }
}
