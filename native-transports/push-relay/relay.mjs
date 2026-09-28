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

export const DEFAULT_LIMITS = { bodyBytes: 8 * 1024, perMinute: 30 }

const b64url = text => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** The request to forward, or a reason it is refused. */
export function readRelayRequest (text, { hosts = PUSH_HOSTS, bodyBytes = DEFAULT_LIMITS.bodyBytes } = {}) {
  let request
  try { request = JSON.parse(text) } catch { return { error: 'Not JSON' } }
  const { endpoint, headers, body } = request ?? {}
  let url
  try { url = new URL(endpoint) } catch { return { error: 'No endpoint' } }
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.some(host => host.test(url.hostname))) return { error: 'Not a push service' }
  if (typeof body !== 'string' || !/^[A-Za-z0-9_-]*$/.test(body)) return { error: 'No body' }
  const bytes = b64url(body)
  if (bytes.length > bodyBytes) return { error: 'Too large' }
  const forwarded = {}
  for (const [name, value] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    if (HEADERS.includes(name.toLowerCase()) && typeof value === 'string' && value.length < 2048 && !/[\r\n]/.test(value)) forwarded[name] = value
  }
  return { endpoint: url.href, headers: forwarded, body: bytes }
}

export function startRelay ({ port = 0, host = '127.0.0.1', origins = [], hosts = PUSH_HOSTS, limits = {}, log = () => {} } = {}) {
  const { bodyBytes, perMinute } = { ...DEFAULT_LIMITS, ...limits }
  const recent = new Map()
  const allowOrigin = origin => (origins.length === 0 ? '*' : origins.includes(origin) ? origin : null)

  const server = createServer((req, res) => {
    const origin = allowOrigin(req.headers.origin ?? '')
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {}
    const answer = (status, value) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'OPTIONS') { res.writeHead(origin ? 204 : 403, cors); res.end(); return }
    if (req.method !== 'POST' || !origin) return answer(req.method === 'POST' ? 403 : 405, { error: 'No' })

    const ip = req.socket.remoteAddress ?? ''
    const now = Date.now()
    const times = (recent.get(ip) ?? []).filter(t => now - t < 60_000)
    if (times.length >= perMinute) return answer(429, { error: 'Too many' })
    times.push(now)
    recent.set(ip, times)

    let text = ''
    let size = 0
    req.setEncoding('utf8')
    req.on('data', chunk => { size += chunk.length; if (size > bodyBytes * 2) req.destroy(); else text += chunk })
    req.on('end', async () => {
      const request = readRelayRequest(text, { hosts, bodyBytes })
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
    close: () => new Promise(done => server.close(() => done())),
  })))
}
