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

export function startRelay ({ port = 0, host = '127.0.0.1', origins = [], hosts = PUSH_HOSTS, limits = {}, proxies = 0, log = () => {} } = {}) {
  const { bodyBytes, perMinute, tracked, requestMs } = { ...DEFAULT_LIMITS, ...limits }
  // The JSON around a body of `bodyBytes`: base64url is a third longer, and the headers add a few KB.
  const requestBytes = bodyBytes * 2
  const recent = new Map()
  let pruned = 0
  const prune = now => { pruned = now; for (const [ip, times] of recent) if (!times.some(t => now - t < 60_000)) recent.delete(ip) }
  const pruning = setInterval(() => prune(Date.now()), 60_000)
  pruning.unref?.()
  const allowOrigin = origin => (origins.length === 0 ? '*' : origins.includes(origin) ? origin : null)

  // A slow client is closed after `requestMs`, checked every second (Node's default waits up to five minutes).
  const server = createServer({ requestTimeout: requestMs, headersTimeout: requestMs, connectionsCheckingInterval: Math.min(1000, requestMs) }, (req, res) => {
    const origin = allowOrigin(req.headers.origin ?? '')
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {}
    const answer = (status, value) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'OPTIONS') { res.writeHead(origin ? 204 : 403, cors); res.end(); return }
    if (req.method !== 'POST' || !origin) return answer(req.method === 'POST' ? 403 : 405, { error: 'No' })

    const ip = rateKey(clientAddress(req, proxies))
    const now = Date.now()
    // A newcomer to a full table: the idle go (a scan at most once a second), else the oldest entry.
    if (recent.size >= tracked && !recent.has(ip) && now - pruned >= 1000) prune(now)
    if (recent.size >= tracked && !recent.has(ip)) recent.delete(recent.keys().next().value)
    const times = (recent.get(ip) ?? []).filter(t => now - t < 60_000)
    if (times.length >= perMinute) return answer(429, { error: 'Too many' })
    times.push(now)
    // Last in the map's order: the first entry is always the one seen longest ago.
    recent.delete(ip)
    recent.set(ip, times)

    if (Number(req.headers['content-length']) > requestBytes) return answer(413, { error: 'Too large' })
    const chunks = []
    let size = 0
    // Bytes, not characters: text of many-byte characters counts for what it weighs.
    req.on('data', chunk => { size += chunk.length; if (size > requestBytes) req.destroy(); else chunks.push(chunk) })
    req.on('end', async () => {
      const request = readRelayRequest(Buffer.concat(chunks).toString('utf8'), { hosts, bodyBytes })
      if (request.error) { log('refused', request.error); return answer(400, { error: request.error }) }
      try {
        const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
        log('forwarded', response.status)
        answer(200, { status: response.status })
      } catch {
        log('failed')
        answer(502, { error: 'The push service did not answer' })
      }
    })
  })

  return new Promise(resolve => server.listen(port, host, () => resolve({
    port: server.address().port,
    tracked: () => recent.size,
    close: () => new Promise(done => { clearInterval(pruning); server.close(() => done()) }),
  })))
}
