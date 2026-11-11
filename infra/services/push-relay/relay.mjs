import { createHash } from 'node:crypto'
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
/** Only these headers go through (by their name in lower case): what Web Push needs, nothing the sender could use to reach anything else. */
const HEADERS = { authorization: 'Authorization', ttl: 'TTL', urgency: 'Urgency', topic: 'Topic', 'content-encoding': 'Content-Encoding', 'content-type': 'Content-Type' }
/**
 * A header value `fetch` sends: bytes, with no NUL, line break, other control or DEL. Anything else it throws on before
 * connecting, which the relay would take for a push service that did not answer.
 */
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/**
 * `perMinute`: requests a minute from one address. `perEndpoint`: forwards a minute to one subscription (its endpoint
 * and VAPID key), from all addresses together: a contact wakes it once per message every 5 minutes at most and twice a
 * minute while calling, so 30 is fifteen contacts calling it at once, and no pool of addresses wakes it more. A forward
 * the push service refuses (a 4xx other than 429) wakes nothing and is not counted there.
 * `tracked`: addresses, and subscriptions apart, whose counts are kept at most. Past it, the ones idle for a minute go
 * first, then the oldest under its limit: a full table forgets a count rather than turn away every newcomer.
 * `requestMs`: how long a client has to send a whole request (headers and body) before the connection is closed.
 */
export const DEFAULT_LIMITS = { bodyBytes: 8 * 1024, perMinute: 30, perEndpoint: 30, tracked: 10_000, requestMs: 15_000 }
/** RFC 8292's `vapid t=<JWT>, k=<key>`: a request without one is not a Web Push the relay would forward. */
const VAPID = /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, ?k=[A-Za-z0-9_-]+$/

const b64url = text => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/**
 * The endpoint as the push service receives it, so one subscription is one count however it is spelt: no fragment
 * (`fetch` never sends one) and no empty `?`. The rest `URL` already writes one way (host case, a default port, `./`).
 */
const asSent = url => { url.hash = ''; if (!url.search) url.search = ''; return url }

/** The request to forward, or a reason it is refused. */
export function readRelayRequest (text, { hosts = PUSH_HOSTS, bodyBytes = DEFAULT_LIMITS.bodyBytes } = {}) {
  let request
  try { request = JSON.parse(text) } catch { return { error: 'Not JSON' } }
  const { endpoint, headers, body } = request ?? {}
  let url
  try { url = asSent(new URL(endpoint)) } catch { return { error: 'No endpoint' } }
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
    if (!Object.hasOwn(HEADERS, lower) || typeof value !== 'string' || value.length >= 2048) continue
    // Named in the answer, so a sender sees what in its own request is wrong; the log gets one of six fixed names.
    if (!FIELD_VALUE.test(value)) return { error: `Bad ${HEADERS[lower]} value` }
    forwarded[name] = value
  }
  const authorization = Object.entries(forwarded).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  if (!authorization || !VAPID.test(authorization)) return { error: 'No VAPID authorization' }
  // The subscription it wakes: a push service refuses a key the subscription was not made with, so another key wakes
  // nothing. Hashed, so the relay's table holds no endpoint and an entry weighs the same however long the URL.
  const subscription = createHash('sha256').update(`${url.href} ${authorization.split('k=').pop()}`).digest('base64')
  return { endpoint: url.href, headers: forwarded, body: bytes, subscription }
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
 * Whether `fetch` threw on the request itself: a `TypeError` without a cause (an invalid header value, a character
 * above U+00FF) or with undici's invalid-argument code (a control character). A network failure is a `TypeError`
 * `fetch failed` with its cause.
 */
/**
 * Whether the push service refused the request for what it is (400, 401, 403, 404, 410, 413…): delivered nowhere. Its
 * 429 is not one (it is swamped, the request may be fine), nor a 5xx (the push may have gone).
 */
const refusedPush = status => status >= 400 && status < 500 && status !== 429

const refusedByFetch = error => error instanceof TypeError && (!('cause' in error) || error.cause?.code === 'UND_ERR_INVALID_ARG')

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
 * one subscriber usually holds whole. A port some proxies write with it (`203.0.113.7:51234`, `[2001:db8::1]:51234`)
 * and IPv6 brackets are dropped first: each connection has a new port, so keyed with it the limit never applies.
 */
export function rateKey (address) {
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
 * Events of one `word` as counts, so a flood of them stays quiet: the first of a kind in a quiet minute is logged at
 * once (`refused rate`, `forwarded 201`), the rest of that minute as one line when `flush` runs (`refused rate 41 more`).
 * `detail` goes on that first line only (`refused origin "https://app.example"`): it names one case, the count covers
 * the rest.
 */
export function countedLog (log, word) {
  // Kind → events since its last line. Present: a line for it went out in this minute.
  const pending = new Map()
  let total = 0
  return {
    /** Events since the start, of every kind. */
    total: () => total,
    count: (kind, detail) => {
      total++
      if (pending.has(kind)) pending.set(kind, pending.get(kind) + 1)
      else { pending.set(kind, 0); log(word, kind, ...(detail === undefined ? [] : [detail])) }
    },
    flush: () => {
      for (const [kind, more] of pending) {
        if (more) { log(word, kind, `${more} more`); pending.set(kind, 0) } else pending.delete(kind)
      }
    },
  }
}

/** Refusals as counts (countedLog): `refused <kind>`. */
export function refusalLog (log) {
  const { total, count, flush } = countedLog(log, 'refused')
  return { total, refuse: count, flush }
}

/**
 * Counts of the last minute by key, at most `perMinute` each, for at most `tracked` keys. `take` counts one for a key
 * and says whether it was under its limit; a newcomer to a full table drops the idle (a scan at most once a second),
 * else the entry seen longest ago that is under its limit (the oldest of all only when every one is at it). Dropped at
 * its limit, a key would start its minute over: newcomers enough would buy it another `perMinute`.
 */
function minuteCounts (perMinute, tracked) {
  const recent = new Map()
  let pruned = 0
  const prune = now => { pruned = now; for (const [key, times] of recent) if (!times.some(t => now - t < 60_000)) recent.delete(key) }
  // Times are kept in the order taken, so the `perMinute`-th last one says whether the key is at its limit.
  const atLimit = (times, now) => times.length >= perMinute && now - times[times.length - perMinute] < 60_000
  const dropped = now => {
    for (const [key, times] of recent) if (!atLimit(times, now)) return key
    return recent.keys().next().value
  }
  return {
    size: () => recent.size,
    prune,
    take: (key, now) => {
      if (recent.size >= tracked && !recent.has(key) && now - pruned >= 1000) prune(now)
      if (recent.size >= tracked && !recent.has(key)) recent.delete(dropped(now))
      const times = (recent.get(key) ?? []).filter(t => now - t < 60_000)
      if (times.length >= perMinute) return false
      times.push(now)
      // Last in the map's order: the first entry is always the one seen longest ago.
      recent.delete(key)
      recent.set(key, times)
      return true
    },
    /** Gives back the one `take` counted for a key at `now` (nothing if the table has forgotten it since). */
    giveBack: (key, now) => {
      const times = recent.get(key)
      const at = times?.indexOf(now) ?? -1
      if (at >= 0) times.splice(at, 1)
    },
  }
}

export function startRelay ({ port = 0, host = '127.0.0.1', origins = [], hosts = PUSH_HOSTS, limits = {}, proxies = 0, log = () => {} } = {}) {
  const { bodyBytes, perMinute, perEndpoint, tracked, requestMs } = { ...DEFAULT_LIMITS, ...limits }
  // The JSON around a body of `bodyBytes`: base64url is a third longer, and the headers add a few KB.
  const requestBytes = bodyBytes * 2
  const addresses = minuteCounts(perMinute, tracked)
  // Apart from the addresses: however many send to one subscription, it gets `perEndpoint` a minute through this relay.
  const subscriptions = minuteCounts(perEndpoint, tracked)
  const prune = now => { addresses.prune(now); subscriptions.prune(now) }
  const refusals = refusalLog(log)
  // A line per status and per cause a minute, like refusals: one per forward would grow the log with the traffic.
  const forwards = countedLog(log, 'forwarded')
  const failures = countedLog(log, 'failed')
  const flush = () => { refusals.flush(); forwards.flush(); failures.flush() }
  // Forwards waiting on the push service: counted once it answers, so the ones a stop cuts are said apart.
  let forwarding = 0
  const pruning = setInterval(() => { prune(Date.now()); flush() }, 60_000)
  pruning.unref?.()
  // Once per start: a proxy in front the relay was not told about makes every client count as that proxy.
  let hinted = false
  // Compared as a browser writes them: `https://app.example/` in the settings still lets https://app.example in.
  const allowed = new Set(origins.map(origin => originOf(origin) ?? origin))

  // A slow client is closed after `requestMs`, checked every second (Node's default waits up to five minutes).
  const server = createServer({ requestTimeout: requestMs, headersTimeout: requestMs, connectionsCheckingInterval: Math.min(1000, requestMs) }, (req, res) => {
    const origin = req.headers.origin
    const refused = allowed.size > 0 && !allowed.has(origin)
    // A refused page still gets its preflight and a readable 403 (it posts JSON, so the browser asks first): without
    // them its fetch fails as a CORS error and says nothing. The relay refuses the POST itself, forwarding nothing.
    const cors = origin === undefined ? {} : { 'Access-Control-Allow-Origin': allowed.size ? origin : '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    const answer = (status, value) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    const refuse = (why, status, value, detail) => { refusals.refuse(why, detail); answer(status, value) }
    // A monitor's check: up, and nothing else. Anyone may read it (behind a proxy every caller is on loopback), so it
    // has no counts: those move with each push, and on a relay one person runs they would tell when that person wakes
    // someone. The operator has them in the log. A monitor's HEAD and its query string are read as the GET (Node
    // sends no body for a HEAD), as the HyperDHT relay reads them: a HEAD refused here would count as a refused client.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.split('?')[0] === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    // The preflight is answered, not refused: the POST after it is the one refusal of that page's attempt.
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
    if (req.method !== 'POST') return refuse('method', 405, { error: 'No' })
    // A refusal of kind `origin`, its first line in a minute naming the origin so a misspelt GHOSTLY_RELAY_ORIGINS shows.
    if (refused) return refuse('origin', 403, { error: 'Origin not allowed' }, originShown(origin))

    const ip = rateKey(clientAddress(req, proxies))
    if (!proxies && !hinted && req.headers['x-forwarded-for'] !== undefined) {
      hinted = true
      log('requests carry X-Forwarded-For but GHOSTLY_RELAY_PROXIES is not set: every client counts as the proxy')
    }
    if (!addresses.take(ip, Date.now())) return refuse('rate', 429, { error: 'Too many' })

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
      // Counted only for a request it would forward: a refused one wakes nobody.
      const taken = Date.now()
      if (!subscriptions.take(request.subscription, taken)) return refuse('subscription rate', 429, { error: 'Too many' })
      forwarding++
      try {
        const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
        // The push service refused the request itself (a token it does not accept, a subscription gone, a malformed
        // push): it woke nobody, so the subscription's count is given back and only the sender's address has spent one.
        if (refusedPush(response.status)) subscriptions.giveBack(request.subscription, taken)
        forwards.count(response.status)
        answer(200, { status: response.status })
      } catch (error) {
        // `fetch` refusing what it was handed, before any connection, is a refusal of the request, not a failed forward.
        if (refusedByFetch(error)) return refuse('Not a request fetch can send', 400, { error: 'Not a request fetch can send' })
        failures.count(failure(error))
        answer(502, { error: 'The push service did not answer' })
      } finally {
        forwarding--
      }
    })
  })

  return new Promise((resolve, reject) => {
    // A port in use, a port it may not take, a host it cannot listen on: the caller says which (listenProblem).
    server.once('error', error => { clearInterval(pruning); reject(error) })
    server.listen(port, host, () => resolve({
      port: server.address().port,
      tracked: () => addresses.size(),
      endpoints: () => subscriptions.size(),
      /** Counts since the start, for the process that runs it (never served). */
      stats: () => ({ forwarded: forwards.total(), failed: failures.total(), refused: refusals.total(), tracked: addresses.size() }),
      /** Open connections, a request in them or not. */
      clients: () => new Promise(done => server.getConnections((_, count) => done(count ?? 0))),
      // `server.close` stops the check that ends a slow request, so a client holding half a request would hold the
      // close for as long as it stays: a request still open after `stopMs` (a forward in flight, a slow client) is cut.
      // The counts are written once the requests have ended or been cut, so a forward that ends while the relay stops
      // is in a line before it stops; one still waiting on the push service then (cut, or its client gone) is said as a
      // count, since its status will never be logged.
      close: ({ stopMs = 3000 } = {}) => new Promise(done => {
        clearInterval(pruning)
        const cut = setTimeout(() => server.closeAllConnections(), stopMs)
        server.close(() => {
          clearTimeout(cut)
          flush()
          if (forwarding) log('cut', `${forwarding} ${forwarding === 1 ? 'forward' : 'forwards'} in flight`)
          done()
        })
      }),
    }))
  })
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
 * A refused `Origin` as the log writes it: quoted and cut at 200 characters (`"https://app.example"`), so a value the
 * client chose cannot break the line; `(none)` for a request without one.
 */
const originShown = origin => (origin === undefined ? '(none)' : JSON.stringify(String(origin).slice(0, 200)))

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
  if (kind === 'origins') {
    const entries = list(value)
    const wrong = entries.find(entry => !originOf(entry))
    if (wrong !== undefined) fail(`origins like https://app.example, comma-separated: a scheme, a host and a port only (${JSON.stringify(wrong)} is not one)`)
    return [...new Set(entries.map(originOf))]
  }
  return value
}

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

/**
 * The relay's settings from its environment (server.mjs): PORT (49480), HOST (0.0.0.0; 127.0.0.1 behind proxies),
 * GHOSTLY_RELAY_ORIGINS, GHOSTLY_RELAY_PROXIES (0). Throws on one present but not of its kind. `ignored` names the
 * other GHOSTLY_RELAY_* and GHOSTLY_HYPERDHT_* variables (see ignoredSettings), for server.mjs to print.
 */
export function readSettings (env) {
  const proxies = setting(env, 'GHOSTLY_RELAY_PROXIES', 0, 'count')
  return {
    port: setting(env, 'PORT', 49480, 'port'),
    host: setting(env, 'HOST', proxies ? '127.0.0.1' : '0.0.0.0', 'text'),
    origins: setting(env, 'GHOSTLY_RELAY_ORIGINS', [], 'origins'),
    proxies,
    ignored: ignoredSettings(env, ['GHOSTLY_RELAY_ORIGINS', 'GHOSTLY_RELAY_PROXIES']),
  }
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
