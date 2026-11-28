import { createPublicKey, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { BlockList, isIP, isIPv6 } from 'node:net'
import { WebSocketServer } from 'ws'

// Every span of time the relay measures reads a monotonic clock so an NTP step or VM resume never stretches or shrinks
// rate windows, cache TTLs, or circuit-breaker cooldowns.
const monotonicNow = () => performance.now()

/** Mainline DHT (BEP44) caps the value of a mutable item at 1000 bytes. */
export const MAX_DNS_PACKET_BYTES = 1000
/** Minimum valid DNS header length (12 bytes). */
export const MIN_DNS_PACKET_BYTES = 12
export const SIGNATURE_LENGTH = 64
export const TIMESTAMP_LENGTH = 8
/** Smallest valid Pkarr relay payload: 64B signature + 8B timestamp + 12B DNS header (84 bytes). */
export const RELAY_PAYLOAD_MIN_BYTES = SIGNATURE_LENGTH + TIMESTAMP_LENGTH + MIN_DNS_PACKET_BYTES
/** Largest valid Pkarr relay payload: 64B signature + 8B timestamp + 1000B DNS packet (1072 bytes). */
export const RELAY_PAYLOAD_MAX_BYTES = SIGNATURE_LENGTH + TIMESTAMP_LENGTH + MAX_DNS_PACKET_BYTES
/** How far ahead of wall-clock time a packet timestamp may be before a current-time packet may replace it. */
export const PKARR_FUTURE_SKEW_MS = 10 * 60_000
/** Minimum byte charge per HTTP request or WS frame in the per-IP byte bucket so tiny-frame floods cannot bypass it. */
const FRAME_COST_BYTES = 64
const TIMER_MAX_MS = 2 ** 31 - 1

export const DEFAULT_LIMITS = Object.freeze({
  /** Maximum keys allowed in a single Batch GET or Batch PUT request. */
  maxBatchKeys: 64,
  /** Maximum HTTP request body size (bytes) for batch JSON requests. */
  maxBatchBodyBytes: 128 * 1024,
  /** Maximum HTTP requests per minute from one IP (IPv6 counted by /64). */
  requestsPerMinute: 120,
  /** Maximum WebSocket/SSE push connections opened per minute from one IP. */
  connectsPerMinutePerIp: 30,
  /** Maximum concurrent push (WebSocket + SSE) connections across all clients. */
  maxConnections: 1024,
  /** Maximum concurrent push (WebSocket + SSE) connections from one IP. */
  maxConnectionsPerIp: 16,
  /** Maximum z32 keys one push connection may subscribe to at once. */
  maxKeysPerConnection: 256,
  /** Maximum z32 keys all push connections from one IP may subscribe to together. */
  maxKeysPerIp: 512,
  /** Sustained byte budget per second shared across all requests and sockets of one IP (persists across reconnects). */
  bytesPerSecondPerIp: 128 * 1024,
  /** Burst byte budget shared across all requests and sockets of one IP (persists across reconnects). */
  burstBytesPerIp: 256 * 1024,
  /** Maximum cached Pkarr packets held in memory (LRU eviction past this). */
  maxCacheEntries: 10_000,
  /** How long a cached packet is served before refreshing from upstream (ms). */
  cacheTtlMs: 300_000,
  /** Maximum distinct IPs tracked in rate-limit and byte-bucket tables. */
  trackedIps: 10_000,
  /** Maximum time a client has to send HTTP headers and body (ms). */
  requestMs: 15_000,
  /** Interval for WebSocket ping and SSE keepalive comments (ms). */
  pingMs: 30_000,
  /** Maximum incoming WebSocket frame payload size (bytes). */
  wsMaxPayloadBytes: 32 * 1024,
  /** Maximum buffered outbound bytes per push subscriber before dropping as slow consumer. */
  wsQueuedBytes: 256 * 1024,
  /** Per-request timeout when talking to an upstream Pkarr relay (ms). */
  upstreamTimeoutMs: 5_000,
  /** Maximum concurrent in-flight HTTP requests to upstream Pkarr relays. */
  upstreamConcurrency: 8,
  /** Consecutive upstream failures before opening that upstream's circuit breaker. */
  upstreamBreakerThreshold: 5,
  /** Cooldown before half-open probing an open upstream circuit breaker (ms). */
  upstreamBreakerCooldownMs: 30_000,
  /** Interval for refreshing actively subscribed keys from upstream (ms; 0 disables background refresh). */
  upstreamRefreshMs: 30_000,
})

const ZERO_ALLOWED_LIMITS = new Set(['upstreamRefreshMs'])

const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const Z32_LOOKUP = new Int8Array(128).fill(-1)
for (let i = 0; i < Z32_ALPHABET.length; i++) Z32_LOOKUP[Z32_ALPHABET.charCodeAt(i)] = i

/** SubjectPublicKeyInfo prefix for an Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** Ed25519 field prime p = 2^255 - 19 for canonical y-coordinate validation. */
const ED25519_P = (1n << 255n) - 19n
/** Canonical encodings of the 8 small-order Ed25519 points (rejected as public keys). */
const ED25519_SMALL_ORDER = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  '0000000000000000000000000000000000000000000000000000000000000080',
])

export function encodeZ32 (bytes) {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += Z32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += Z32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Decodes a canonical 52-char z-base32 Ed25519 public key into 32 bytes, or returns null if invalid. */
export function decodeZ32PublicKey (z32) {
  if (typeof z32 !== 'string' || z32.length !== 52) return null
  const out = Buffer.allocUnsafe(32)
  let bits = 0
  let value = 0
  let index = 0
  for (let i = 0; i < 52; i++) {
    const code = z32.charCodeAt(i)
    const v = code < 128 ? Z32_LOOKUP[code] : -1
    if (v < 0) return null
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  // Trailing 4 padding bits must be zero so every 32-byte key has one canonical 52-char z32 spelling.
  if (value !== 0) return null
  return out
}

/** True iff `z32` is a valid canonical 52-char z-base32 Ed25519 public key. */
export function isValidZ32 (z32) {
  return decodeZ32PublicKey(z32) !== null
}

function isCanonicalNonSmallOrderEd25519Key (pubBytes) {
  if (pubBytes.length !== 32) return false
  if (ED25519_SMALL_ORDER.has(pubBytes.toString('hex'))) return false
  // Little-endian 255-bit y coordinate (clear sign bit in top byte).
  let y = 0n
  for (let i = 31; i >= 0; i--) {
    const byte = i === 31 ? pubBytes[i] & 0x7f : pubBytes[i]
    y = (y << 8n) | BigInt(byte)
  }
  return y < ED25519_P
}

// Bounded cache of parsed Ed25519 KeyObjects (keyed by z32) to keep verification fast under load.
const KEY_OBJECT_CACHE_MAX = 2048
const keyObjectCache = new Map()

function getEd25519KeyObject (z32, pubBytes) {
  let keyObj = keyObjectCache.get(z32)
  if (keyObj) {
    keyObjectCache.delete(z32)
    keyObjectCache.set(z32, keyObj)
    return keyObj
  }
  try {
    keyObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubBytes]),
      format: 'der',
      type: 'spki',
    })
  } catch {
    return null
  }
  if (keyObjectCache.size >= KEY_OBJECT_CACHE_MAX) {
    keyObjectCache.delete(keyObjectCache.keys().next().value)
  }
  keyObjectCache.set(z32, keyObj)
  return keyObj
}

/**
 * Validates a raw Pkarr relay payload for `pubKeyZ32`:
 * - Canonical 52-char z-base32 public key (non-small-order, canonical curve encoding)
 * - Size between 84 and 1072 bytes (64B signature + 8B big-endian timestamp + 12..1000B DNS packet)
 * - Valid Ed25519 signature over `3:seqi<seq>e1:v<len>:<dnsPacket>`
 */
export function verifyPkarrPacket (pubKeyZ32, payload) {
  const pubBytes = decodeZ32PublicKey(pubKeyZ32)
  if (!pubBytes || !isCanonicalNonSmallOrderEd25519Key(pubBytes)) {
    return { ok: false, code: 'invalid_key', error: 'Invalid public key' }
  }
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (buf.length < RELAY_PAYLOAD_MIN_BYTES) {
    return { ok: false, code: 'packet_too_short', error: 'Packet too short' }
  }
  if (buf.length > RELAY_PAYLOAD_MAX_BYTES) {
    return { ok: false, code: 'packet_too_large', error: 'Packet too large' }
  }
  const signature = buf.subarray(0, SIGNATURE_LENGTH)
  const seq = buf.readBigUInt64BE(SIGNATURE_LENGTH)
  const dnsPacket = buf.subarray(SIGNATURE_LENGTH + TIMESTAMP_LENGTH)
  const prefix = Buffer.from(`3:seqi${seq}e1:v${dnsPacket.length}:`, 'utf8')
  const signable = Buffer.concat([prefix, dnsPacket])
  const keyObj = getEd25519KeyObject(pubKeyZ32, pubBytes)
  if (!keyObj) return { ok: false, code: 'invalid_key', error: 'Invalid public key' }
  let valid = false
  try {
    valid = verify(null, signable, keyObj, signature)
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, code: 'invalid_signature', error: 'Invalid signature' }
  return { ok: true, seq, payload: buf }
}

/**
 * Compares a newly verified packet against an existing cached packet using Ghostly's monotonic + future-skew rule.
 * Returns 'newer', 'same', or 'stale'.
 */
export function comparePacketSeq (existing, incoming, nowMs = Date.now()) {
  if (!existing) return 'newer'
  if (existing.seq === incoming.seq && existing.payload.equals(incoming.payload)) return 'same'
  const limit = BigInt(nowMs + PKARR_FUTURE_SKEW_MS) * 1000n
  const existingAhead = existing.seq > limit
  const incomingAhead = incoming.seq > limit
  if (existingAhead !== incomingAhead) return existingAhead ? 'newer' : 'stale'
  return incoming.seq > existing.seq ? 'newer' : 'stale'
}

/** Decodes strict base64 or base64url into a Buffer, or returns null on invalid input. */
function decodeBase64Any (str) {
  if (typeof str !== 'string' || !str.length) return null
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(str)) return null
  // Standard base64 with URL-safe characters normalized.
  let normalized = str.replace(/-/g, '+').replace(/_/g, '/')
  const rem = normalized.length % 4
  if (rem === 1) return null
  if (rem > 0) normalized += '='.repeat(4 - rem)
  const buf = Buffer.from(normalized, 'base64')
  if (buf.toString('base64') !== normalized) return null
  return buf
}

/**
 * Address trust and rate-key normalization, matching infra/services/push-relay and hyperdht-relay.
 */
const NEARBY = new BlockList()
for (const [network, prefix, type] of [
  ['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
]) NEARBY.addSubnet(network, prefix, type)

export const nearbyAddress = address => isIP(address ?? '') > 0 && NEARBY.check(address, isIPv6(address) ? 'ipv6' : 'ipv4')

export function forwardedHops (req) {
  const header = req.headers['x-forwarded-for']
  return (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(item => item.trim()).filter(Boolean)
}

export function forwardedAddress (req, proxies = 0, cloudflare = false) {
  if (cloudflare) {
    const cf = req.headers['cf-connecting-ip']
    const value = (Array.isArray(cf) ? cf[0] : cf ?? '').trim()
    return value || null
  }
  if (!proxies) return null
  const hops = forwardedHops(req)
  return hops.length >= proxies ? hops[hops.length - proxies] : null
}

export function clientAddress (req, proxies = 0, cloudflare = false) {
  return forwardedAddress(req, proxies, cloudflare) ?? req.socket.remoteAddress ?? ''
}

export function fewerHops (entries, proxies) {
  const before = 'until now a client writing the header itself could choose the address it counts as'
  if (!entries) return `requests arrive without X-Forwarded-For though GHOSTLY_RELAY_PROXIES is set: ${before}; from now on the header is ignored and each counts as the proxy, so have the proxy write it or leave the setting out`
  return `requests carry ${entries} X-Forwarded-For ${entries === 1 ? 'entry' : 'entries'} though GHOSTLY_RELAY_PROXIES is ${proxies}: ${before}; from now on each counts by entry ${entries} from the end, so set it to the number of proxies that write the header`
}

/** Normalizes IPv4, IPv4-mapped IPv6, bracketed/port-suffixed addresses, and groups IPv6 by /64. */
export function rateKey (address) {
  address = /^\[([^\]]+)\](?::\d+)?$/.exec(address)?.[1] ?? /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{1,5}$/.exec(address)?.[1] ?? address
  if (!address.includes(':')) return address
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

/** Counted log aggregator: logs the first occurrence immediately, then once-a-minute counts. */
export function countedLog (log, word) {
  const pending = new Map()
  let total = 0
  return {
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

export function refusalLog (log) {
  const { total, count, flush } = countedLog(log, 'refused')
  return { total, refuse: count, flush }
}

/** Monotonic sliding-minute counter per key with idle/under-limit eviction. */
function minuteCounts (perMinute, tracked) {
  const recent = new Map()
  let pruned = 0
  const prune = now => {
    pruned = now
    for (const [key, times] of recent) {
      if (!times.some(t => now - t < 60_000)) recent.delete(key)
    }
  }
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
      if (times.length >= perMinute) {
        recent.set(key, times)
        const waitMs = Math.max(1000, 60_000 - (now - times[0]))
        return { ok: false, retryAfterSec: Math.ceil(waitMs / 1000) }
      }
      times.push(now)
      recent.delete(key)
      recent.set(key, times)
      return { ok: true, retryAfterSec: 0 }
    },
  }
}

/**
 * Shared per-IP byte token bucket that persists across all requests, concurrent sockets, and reconnects.
 * Prevents both multi-socket amplification and disconnect/reconnect burst resets.
 */
function addressByteBuckets (bytesPerSecond, burstBytes, tracked) {
  const buckets = new Map()
  let pruned = 0
  const refilled = (entry, now) => {
    const elapsedSec = Math.max(0, (now - entry.at) / 1000)
    return Math.min(burstBytes, entry.tokens + elapsedSec * bytesPerSecond)
  }
  const prune = now => {
    pruned = now
    for (const [key, entry] of buckets) {
      if (refilled(entry, now) >= burstBytes) buckets.delete(key)
    }
  }
  const dropCandidate = now => {
    for (const [key, entry] of buckets) {
      if (refilled(entry, now) >= burstBytes * 0.5) return key
    }
    return buckets.keys().next().value
  }
  return {
    size: () => buckets.size,
    prune,
    spend: (key, rawBytes, now) => {
      const cost = Math.max(FRAME_COST_BYTES, rawBytes)
      if (buckets.size >= tracked && !buckets.has(key) && now - pruned >= 1000) prune(now)
      if (buckets.size >= tracked && !buckets.has(key)) buckets.delete(dropCandidate(now))
      const prev = buckets.get(key)
      const tokens = prev ? refilled(prev, now) : burstBytes
      if (tokens < cost) {
        const deficit = cost - tokens
        const retryAfterSec = Math.max(1, Math.ceil(deficit / Math.max(1, bytesPerSecond)))
        buckets.delete(key)
        buckets.set(key, { tokens, at: now })
        return { ok: false, retryAfterSec }
      }
      buckets.delete(key)
      buckets.set(key, { tokens: tokens - cost, at: now })
      return { ok: true, retryAfterSec: 0 }
    },
  }
}

/** Bounded LRU cache for verified Pkarr packets. */
function createPacketCache (maxEntries, ttlMs) {
  const map = new Map()
  return {
    size: () => map.size,
    /** Returns fresh entry (within TTL) or null if absent/expired. */
    get: (key, now) => {
      const entry = map.get(key)
      if (!entry) return null
      if (now - entry.fetchedAt > ttlMs) {
        map.delete(key)
        return null
      }
      map.delete(key)
      map.set(key, entry)
      return entry
    },
    /** Returns entry regardless of TTL (used for monotonic comparison before replacing). */
    peek: (key) => map.get(key) ?? null,
    set: (key, entry) => {
      if (map.has(key)) map.delete(key)
      else if (map.size >= maxEntries) map.delete(map.keys().next().value)
      map.set(key, entry)
    },
    prune: (now) => {
      for (const [key, entry] of map) {
        if (now - entry.fetchedAt > ttlMs) map.delete(key)
      }
    },
  }
}

/** Simple async semaphore to cap concurrent upstream requests. */
function createSemaphore (max) {
  let active = 0
  const waiters = []
  return {
    run: async (fn) => {
      if (active >= max) {
        await new Promise(resolve => waiters.push(resolve))
      }
      active++
      try {
        return await fn()
      } finally {
        active--
        const next = waiters.shift()
        if (next) next()
      }
    },
  }
}

/** Reads an HTTP response body up to `maxBytes` strictly, cancelling the stream if exceeded. */
async function readBoundedResponse (response, maxBytes) {
  const cl = Number(response.headers.get('content-length'))
  if (Number.isFinite(cl) && cl > maxBytes) {
    response.body?.cancel().catch(() => {})
    return null
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks, total)
}

/** Reads an IncomingMessage body up to `maxBytes`. Resolves `{ ok: true, body }` or `{ ok: false, reason }`. */
function readRequestBody (req, maxBytes) {
  return new Promise(resolve => {
    const cl = Number(req.headers['content-length'])
    if (Number.isFinite(cl) && cl > maxBytes) {
      resolve({ ok: false, reason: 'size' })
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = result => {
      if (done) return
      done = true
      resolve(result)
    }
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, reason: 'size' })
        if (!req.destroyed) req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks, size) }))
    req.on('error', () => finish({ ok: false, reason: 'aborted' }))
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }))
  })
}

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
})

const originShown = origin => (origin === undefined ? '(none)' : JSON.stringify(String(origin).slice(0, 200)))

export function startRelay ({
  port = 0,
  host = '127.0.0.1',
  upstreams = [],
  origins = [],
  limits: customLimits = {},
  proxies = 0,
  cloudflare = false,
  fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits }
  const upstreamUrls = upstreams.map(u => u.replace(/\/+$/, ''))
  const cache = createPacketCache(limits.maxCacheEntries, limits.cacheTtlMs)
  const reqCounts = minuteCounts(limits.requestsPerMinute, limits.trackedIps)
  const connectCounts = minuteCounts(limits.connectsPerMinutePerIp, limits.trackedIps)
  const byteBuckets = addressByteBuckets(limits.bytesPerSecondPerIp, limits.burstBytesPerIp, limits.trackedIps)
  const upstreamSem = createSemaphore(limits.upstreamConcurrency)

  // Per-upstream circuit breaker state.
  const breakers = upstreamUrls.map(url => ({
    url,
    failures: 0,
    openUntil: 0,
    halfOpen: false,
  }))

  const refusals = refusalLog(log)
  const upstreamErrors = countedLog(log, 'upstream')
  const flush = () => { refusals.flush(); upstreamErrors.flush() }

  // Subscription state shared across WebSocket and SSE clients.
  // key (z32) -> Set<subscriber>
  const keySubscribers = new Map()
  // All active subscribers (WS and SSE).
  const subscribers = new Set()
  // ip -> active push connection count
  const connectionsByIp = new Map()
  // ip -> total subscribed keys across all active push connections of that IP
  const keysByIp = new Map()

  let stopping = false
  let hintedProxy = false
  let hintedCloudflare = false
  let nearbyHinted = false
  let trusted = proxies
  const allowedOrigins = new Set(origins.map(o => originOf(o) ?? o))

  const statsCounters = {
    gets: 0,
    puts: 0,
    batchGets: 0,
    batchPuts: 0,
    cacheHits: 0,
    upstreamFetches: 0,
    pushEventsSent: 0,
  }

  function corsHeadersFor (req) {
    const origin = req.headers.origin
    if (origin === undefined) return {}
    return {
      'Access-Control-Allow-Origin': allowedOrigins.size ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
      'Access-Control-Expose-Headers': 'Date, Retry-After, X-Pkarr-Invalid-Packet-Seq',
      Vary: 'Origin',
    }
  }

  function originRefused (req) {
    return allowedOrigins.size > 0 && !allowedOrigins.has(req.headers.origin)
  }

  function resolveIp (req) {
    if (!proxies && !cloudflare && !hintedProxy && req.headers['x-forwarded-for'] !== undefined) {
      hintedProxy = true
      log('requests carry X-Forwarded-For but GHOSTLY_RELAY_PROXIES is not set: every client counts as the proxy')
    } else if (!cloudflare && !hintedCloudflare && req.headers['cf-connecting-ip'] !== undefined) {
      hintedCloudflare = true
      log('requests carry CF-Connecting-IP but GHOSTLY_RELAY_CLOUDFLARE is not set: every client counts as the proxy')
    } else if (proxies) {
      const entries = forwardedHops(req).length
      if (entries < trusted) {
        trusted = entries
        log(fewerHops(entries, proxies))
      }
    }
    return rateKey(forwardedAddress(req, trusted, cloudflare) ?? req.socket.remoteAddress ?? '')
  }

  function maybeHintNearby (req) {
    if (!proxies && !cloudflare && !nearbyHinted && req.headers['x-forwarded-for'] === undefined && nearbyAddress(req.socket.remoteAddress)) {
      nearbyHinted = true
      log(`requests refused at the rate of ${limits.requestsPerMinute} a minute from one address come from a loopback or private address: if they come through a proxy, set GHOSTLY_RELAY_PROXIES or GHOSTLY_RELAY_CLOUDFLARE, or every client shares that rate`)
    }
  }

  // --- Upstream circuit breaker & proxy ---

  function breakerAllows (b, now) {
    if (b.openUntil === 0) return true
    if (now < b.openUntil) return false
    if (b.halfOpen) return false
    b.halfOpen = true
    return true
  }

  function breakerSuccess (b) {
    b.failures = 0
    b.openUntil = 0
    b.halfOpen = false
  }

  function breakerFail (b, now, reason) {
    b.halfOpen = false
    b.failures++
    upstreamErrors.count(reason)
    if (b.failures >= limits.upstreamBreakerThreshold) {
      b.openUntil = now + limits.upstreamBreakerCooldownMs
    }
  }

  function classifyFetchError (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout'
    const code = error?.cause?.code ?? error?.code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code
    return error?.cause?.message === 'unexpected redirect' ? 'redirect' : 'error'
  }

  /**
   * Stores a verified packet in cache if newer than existing, and fans out to subscribers when newer.
   * Returns `{ status: 'newer' | 'same' | 'stale', seq }`.
   */
  function storeAndFanout (key, verified, nowMono = monotonicNow(), nowWall = Date.now()) {
    const existing = cache.peek(key)
    const cmp = comparePacketSeq(existing, verified, nowWall)
    if (cmp === 'stale') return { status: 'stale', seq: existing.seq }
    cache.set(key, {
      payload: verified.payload,
      seq: verified.seq,
      storedAt: nowMono,
      fetchedAt: nowMono,
    })
    if (cmp === 'newer') {
      fanoutUpdate(key, verified.seq, verified.payload)
    }
    return { status: cmp, seq: verified.seq }
  }

  function fanoutUpdate (key, seq, payload) {
    const subs = keySubscribers.get(key)
    if (!subs || subs.size === 0) return
    const packetB64 = payload.toString('base64')
    const seqStr = seq.toString()
    const wsFrame = JSON.stringify({ op: 'update', key, seq: seqStr, packet: packetB64 })
    const sseFrame = `event: update\nid: ${seqStr}\ndata: ${JSON.stringify({ key, seq: seqStr, packet: packetB64 })}\n\n`
    for (const sub of [...subs]) {
      sub.sendUpdate(wsFrame, sseFrame)
      statsCounters.pushEventsSent++
    }
  }

  async function fetchFromUpstreams (key, { networkOnly = false } = {}) {
    if (breakers.length === 0) return { status: 'not_found' }
    let saw404 = false
    let invalidSeqHeader = null
    let hadUpstreamError = false
    let allOpen = true
    for (const b of breakers) {
      const now = monotonicNow()
      if (!breakerAllows(b, now)) continue
      allOpen = false
      const result = await upstreamSem.run(async () => {
        statsCounters.upstreamFetches++
        const suffix = networkOnly ? '?policy=NetworkOnly' : ''
        try {
          let response = await fetchFn(`${b.url}/${key}${suffix}`, {
            method: 'GET',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(limits.upstreamTimeoutMs),
          })
          // Older Pkarr relays reject ?policy=NetworkOnly with 400; retry plainly once.
          if (networkOnly && response.status === 400) {
            response.body?.cancel().catch(() => {})
            response = await fetchFn(`${b.url}/${key}`, {
              method: 'GET',
              redirect: 'error',
              cache: 'no-store',
              signal: AbortSignal.timeout(limits.upstreamTimeoutMs),
            })
          }
          if (response.status === 404) {
            const inv = response.headers.get('x-pkarr-invalid-packet-seq')
            response.body?.cancel().catch(() => {})
            breakerSuccess(b)
            return { kind: 'not_found', invalidSeq: inv && /^\d{1,19}$/.test(inv) ? inv : null }
          }
          if (response.status === 200) {
            const raw = await readBoundedResponse(response, RELAY_PAYLOAD_MAX_BYTES)
            if (!raw) {
              breakerFail(b, monotonicNow(), 'oversize')
              return { kind: 'error' }
            }
            const verified = verifyPkarrPacket(key, raw)
            if (!verified.ok) {
              breakerFail(b, monotonicNow(), 'invalid_upstream_packet')
              return { kind: 'error' }
            }
            breakerSuccess(b)
            return { kind: 'ok', verified }
          }
          response.body?.cancel().catch(() => {})
          breakerFail(b, monotonicNow(), `http_${response.status}`)
          return { kind: 'error' }
        } catch (error) {
          breakerFail(b, monotonicNow(), classifyFetchError(error))
          return { kind: 'error' }
        }
      })
      if (result.kind === 'ok') {
        storeAndFanout(key, result.verified)
        return { status: 'ok', payload: result.verified.payload, seq: result.verified.seq }
      }
      if (result.kind === 'not_found') {
        saw404 = true
        if (result.invalidSeq && !invalidSeqHeader) invalidSeqHeader = result.invalidSeq
      } else {
        hadUpstreamError = true
      }
    }
    if (saw404) return { status: 'not_found', invalidSeq: invalidSeqHeader }
    if (allOpen) return { status: 'circuit_open' }
    return { status: hadUpstreamError ? 'upstream_error' : 'not_found' }
  }

  async function forwardPutToUpstreams (key, payload) {
    if (breakers.length === 0) return { status: 'ok' }
    let accepted = false
    let sawConflict = false
    let attempted = 0
    await Promise.all(breakers.map(async b => {
      const now = monotonicNow()
      if (!breakerAllows(b, now)) return
      attempted++
      await upstreamSem.run(async () => {
        try {
          const response = await fetchFn(`${b.url}/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: payload,
            redirect: 'error',
            signal: AbortSignal.timeout(limits.upstreamTimeoutMs),
          })
          response.body?.cancel().catch(() => {})
          if (response.status >= 200 && response.status < 300) {
            breakerSuccess(b)
            accepted = true
          } else if (response.status === 409) {
            breakerSuccess(b)
            sawConflict = true
          } else {
            breakerFail(b, monotonicNow(), `put_http_${response.status}`)
          }
        } catch (error) {
          breakerFail(b, monotonicNow(), `put_${classifyFetchError(error)}`)
        }
      })
    }))
    if (accepted) return { status: 'ok' }
    if (sawConflict) return { status: 'stale' }
    if (attempted === 0) return { status: 'circuit_open' }
    return { status: 'upstream_error' }
  }

  async function resolveKey (key, { networkOnly = false } = {}) {
    const now = monotonicNow()
    if (!networkOnly) {
      const hit = cache.get(key, now)
      if (hit) {
        statsCounters.cacheHits++
        return { status: 'ok', payload: hit.payload, seq: hit.seq, cached: true }
      }
    }
    const fetched = await fetchFromUpstreams(key, { networkOnly })
    if (fetched.status === 'ok') return { ...fetched, cached: false }
    return fetched
  }

  // --- Subscriber lifecycle & isolation ---

  function registerSubscriber (sub) {
    subscribers.add(sub)
    connectionsByIp.set(sub.ip, (connectionsByIp.get(sub.ip) ?? 0) + 1)
  }

  function unregisterSubscriber (sub) {
    if (!subscribers.delete(sub)) return
    const prevConns = connectionsByIp.get(sub.ip) ?? 0
    if (prevConns <= 1) connectionsByIp.delete(sub.ip)
    else connectionsByIp.set(sub.ip, prevConns - 1)

    let removed = 0
    for (const key of sub.keys) {
      const set = keySubscribers.get(key)
      if (set) {
        set.delete(sub)
        if (set.size === 0) keySubscribers.delete(key)
      }
      removed++
    }
    sub.keys.clear()
    if (removed > 0) {
      const prevKeys = keysByIp.get(sub.ip) ?? 0
      if (prevKeys <= removed) keysByIp.delete(sub.ip)
      else keysByIp.set(sub.ip, prevKeys - removed)
    }
  }

  function addSubscriberKeys (sub, rawKeys) {
    if (!Array.isArray(rawKeys)) return { ok: false, code: 'invalid_request', error: 'keys must be an array' }
    const uniqueNew = []
    const seen = new Set()
    for (const k of rawKeys) {
      if (!isValidZ32(k)) return { ok: false, code: 'invalid_key', error: 'Invalid public key' }
      if (!sub.keys.has(k) && !seen.has(k)) {
        seen.add(k)
        uniqueNew.push(k)
      }
    }
    if (sub.keys.size + uniqueNew.length > limits.maxKeysPerConnection) {
      refusals.refuse('subscribe keys per connection', `(${limits.maxKeysPerConnection} keys per connection)`)
      return { ok: false, code: 'max_keys_per_connection', error: `At most ${limits.maxKeysPerConnection} keys per connection` }
    }
    const ipTotal = keysByIp.get(sub.ip) ?? 0
    if (ipTotal + uniqueNew.length > limits.maxKeysPerIp) {
      refusals.refuse('subscribe keys per IP', `(${limits.maxKeysPerIp} keys per address)`)
      return { ok: false, code: 'max_keys_per_ip', error: `At most ${limits.maxKeysPerIp} keys per address` }
    }
    for (const key of uniqueNew) {
      sub.keys.add(key)
      let set = keySubscribers.get(key)
      if (!set) { set = new Set(); keySubscribers.set(key, set) }
      set.add(sub)
    }
    if (uniqueNew.length > 0) keysByIp.set(sub.ip, ipTotal + uniqueNew.length)
    return { ok: true, added: uniqueNew }
  }

  function removeSubscriberKeys (sub, rawKeys) {
    if (!Array.isArray(rawKeys)) return { ok: false, code: 'invalid_request', error: 'keys must be an array' }
    const removed = []
    for (const k of rawKeys) {
      if (typeof k !== 'string') continue
      if (sub.keys.delete(k)) {
        removed.push(k)
        const set = keySubscribers.get(k)
        if (set) {
          set.delete(sub)
          if (set.size === 0) keySubscribers.delete(k)
        }
      }
    }
    if (removed.length > 0) {
      const prevKeys = keysByIp.get(sub.ip) ?? 0
      if (prevKeys <= removed.length) keysByIp.delete(sub.ip)
      else keysByIp.set(sub.ip, prevKeys - removed.length)
    }
    return { ok: true, removed }
  }

  function sendCachedSnapshot (sub, keys) {
    const now = monotonicNow()
    for (const key of keys) {
      const hit = cache.get(key, now)
      if (!hit) continue
      const packetB64 = hit.payload.toString('base64')
      const seqStr = hit.seq.toString()
      const wsFrame = JSON.stringify({ op: 'update', key, seq: seqStr, packet: packetB64 })
      const sseFrame = `event: update\nid: ${seqStr}\ndata: ${JSON.stringify({ key, seq: seqStr, packet: packetB64 })}\n\n`
      sub.sendUpdate(wsFrame, sseFrame)
      statsCounters.pushEventsSent++
    }
  }

  function checkConnectionLimits (ip, now) {
    if (stopping) return { status: 503, why: 'stopping', error: 'Relay is stopping' }
    const connRate = connectCounts.take(ip, now)
    if (!connRate.ok) {
      return {
        status: 429,
        why: 'connect rate',
        detail: `(${limits.connectsPerMinutePerIp} connects a minute from one address)`,
        error: 'Too many connections',
        headers: { 'Retry-After': String(connRate.retryAfterSec) },
      }
    }
    if (subscribers.size >= limits.maxConnections) {
      return { status: 503, why: 'max connections', error: 'Relay at connection capacity' }
    }
    if ((connectionsByIp.get(ip) ?? 0) >= limits.maxConnectionsPerIp) {
      return {
        status: 429,
        why: 'connections per IP',
        detail: `(${limits.maxConnectionsPerIp} connections from one address)`,
        error: 'Too many concurrent connections',
      }
    }
    return null
  }

  // --- HTTP & WebSocket Server ---

  const capabilities = Object.freeze({
    batchGet: true,
    batchPut: true,
    pushWs: true,
    pushSse: true,
    maxBatchKeys: limits.maxBatchKeys,
    maxSubscribeKeys: limits.maxKeysPerConnection,
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.wsMaxPayloadBytes })

  const server = createServer(
    {
      requestTimeout: limits.requestMs,
      headersTimeout: limits.requestMs,
      connectionsCheckingInterval: Math.min(1000, limits.requestMs),
    },
    (req, res) => {
      void handleHttp(req, res)
    },
  )

  function writeJson (res, status, value, extraHeaders = {}) {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      ...extraHeaders,
    })
    res.end(JSON.stringify(value))
  }

  async function handleHttp (req, res) {
    const cors = corsHeadersFor(req)
    const answerJson = (status, value, extra = {}) => writeJson(res, status, value, { ...cors, ...extra })
    const refuse = (why, status, value, detail, extra = {}) => {
      refusals.refuse(why, detail)
      answerJson(status, value, extra)
    }

    let url
    try {
      url = new URL(req.url ?? '/', 'http://relay')
    } catch {
      return refuse('bad url', 400, { error: 'Bad URL' })
    }
    const pathname = url.pathname

    // Health check: no counts, no rate limit, works with GET/HEAD and query string.
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/healthz') {
      const status = stopping ? 503 : 200
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(stopping ? { ok: false } : { ok: true, capabilities }))
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...SECURITY_HEADERS, ...cors })
      res.end()
      return
    }

    if (stopping) {
      return refuse('stopping', 503, { error: 'Relay is stopping' })
    }

    if (originRefused(req)) {
      return refuse('origin', 403, { error: 'Origin not allowed' }, originShown(req.headers.origin))
    }

    // Root info endpoint (human/operator check).
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/') {
      return answerJson(200, { service: 'ghostly-pkarr-relay', capabilities })
    }

    if (!['GET', 'PUT', 'POST', 'HEAD'].includes(req.method ?? '')) {
      return refuse('method', 405, { error: 'Method not allowed' }, undefined, { Allow: 'GET, PUT, POST, OPTIONS, HEAD' })
    }

    const ip = resolveIp(req)
    const now = monotonicNow()

    // SSE Push endpoint: GET /subscribe?keys=...
    if (req.method === 'GET' && pathname === '/subscribe') {
      return handleSseSubscribe(req, res, url, ip, cors, refuse)
    }

    // Per-IP request rate limit for all HTTP API endpoints.
    const rate = reqCounts.take(ip, now)
    if (!rate.ok) {
      maybeHintNearby(req)
      return refuse(
        'rate',
        429,
        { error: 'Too many requests' },
        `(${limits.requestsPerMinute} requests a minute from one address)`,
        { 'Retry-After': String(rate.retryAfterSec) },
      )
    }

    // Batch GET: GET /batch?keys=... or POST /batch
    if (pathname === '/batch' && (req.method === 'GET' || req.method === 'POST')) {
      return handleBatchGet(req, res, url, ip, answerJson, refuse)
    }

    // Batch PUT: PUT /batch
    if (pathname === '/batch' && req.method === 'PUT') {
      return handleBatchPut(req, res, ip, answerJson, refuse)
    }

    // Legacy single-key endpoints: GET /:z32 and PUT /:z32
    const segments = pathname.split('/').filter(Boolean)
    if (segments.length === 1) {
      const key = segments[0]
      if (req.method === 'GET' || req.method === 'HEAD') {
        return handleSingleGet(req, res, url, key, ip, cors, answerJson, refuse)
      }
      if (req.method === 'PUT') {
        return handleSinglePut(req, res, key, ip, answerJson, refuse)
      }
      return refuse('method', 405, { error: 'Method not allowed' }, undefined, { Allow: 'GET, PUT, OPTIONS, HEAD' })
    }

    return refuse('not found', 404, { error: 'Not found' })
  }

  async function handleSingleGet (req, res, url, key, ip, cors, answerJson, refuse) {
    if (!isValidZ32(key)) return refuse('invalid key', 400, { error: 'Invalid public key' })
    const budget = byteBuckets.spend(ip, FRAME_COST_BYTES, monotonicNow())
    if (!budget.ok) {
      return refuse('byte rate', 429, { error: 'Bandwidth limit exceeded' }, undefined, { 'Retry-After': String(budget.retryAfterSec) })
    }
    statsCounters.gets++
    const networkOnly = url.searchParams.get('policy') === 'NetworkOnly'
    const result = await resolveKey(key, { networkOnly })
    if (res.writableEnded || res.destroyed) return
    if (result.status === 'ok') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(result.payload.length),
        'Cache-Control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : result.payload)
      return
    }
    if (result.status === 'not_found') {
      const extra = result.invalidSeq ? { 'X-Pkarr-Invalid-Packet-Seq': result.invalidSeq } : {}
      return answerJson(404, { error: 'Not found' }, extra)
    }
    if (result.status === 'circuit_open') {
      return answerJson(503, { error: 'Upstream relay circuit open' })
    }
    return answerJson(502, { error: 'Upstream relay unavailable' })
  }

  async function handleSinglePut (req, res, key, ip, answerJson, refuse) {
    if (!isValidZ32(key)) return refuse('invalid key', 400, { error: 'Invalid public key' })
    const read = await readRequestBody(req, RELAY_PAYLOAD_MAX_BYTES)
    if (!read.ok) {
      if (read.reason === 'size') return refuse('size', 413, { error: 'Packet too large' })
      return
    }
    const budget = byteBuckets.spend(ip, read.body.length, monotonicNow())
    if (!budget.ok) {
      return refuse('byte rate', 429, { error: 'Bandwidth limit exceeded' }, undefined, { 'Retry-After': String(budget.retryAfterSec) })
    }
    statsCounters.puts++
    const verified = verifyPkarrPacket(key, read.body)
    if (!verified.ok) {
      const status = verified.code === 'packet_too_large' ? 413 : 400
      return refuse(verified.code, status, { error: verified.error })
    }
    const existing = cache.peek(key)
    const cmp = comparePacketSeq(existing, verified)
    if (cmp === 'stale') {
      return refuse('stale', 409, { error: 'Stale packet' })
    }
    const upstream = await forwardPutToUpstreams(key, verified.payload)
    if (upstream.status === 'stale') {
      return refuse('stale', 409, { error: 'Stale packet' })
    }
    if (upstream.status === 'circuit_open') {
      return answerJson(503, { error: 'Upstream relay circuit open' })
    }
    if (upstream.status === 'upstream_error') {
      return answerJson(502, { error: 'Upstream relay unavailable' })
    }
    storeAndFanout(key, verified)
    res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeadersFor(req), 'Cache-Control': 'no-store' })
    res.end()
  }

  async function handleBatchGet (req, res, url, ip, answerJson, refuse) {
    let rawKeys
    let networkOnly = url.searchParams.get('policy') === 'NetworkOnly'
    if (req.method === 'GET') {
      const param = url.searchParams.get('keys') ?? ''
      rawKeys = param.split(',').map(k => k.trim()).filter(Boolean)
      const budget = byteBuckets.spend(ip, Math.max(FRAME_COST_BYTES, param.length), monotonicNow())
      if (!budget.ok) {
        return refuse('byte rate', 429, { error: 'Bandwidth limit exceeded' }, undefined, { 'Retry-After': String(budget.retryAfterSec) })
      }
    } else {
      const read = await readRequestBody(req, limits.maxBatchBodyBytes)
      if (!read.ok) {
        if (read.reason === 'size') return refuse('size', 413, { error: 'Request too large' })
        return
      }
      const budget = byteBuckets.spend(ip, read.body.length, monotonicNow())
      if (!budget.ok) {
        return refuse('byte rate', 429, { error: 'Bandwidth limit exceeded' }, undefined, { 'Retry-After': String(budget.retryAfterSec) })
      }
      let parsed
      try { parsed = JSON.parse(read.body.toString('utf8')) } catch {
        return refuse('not json', 400, { error: 'Invalid JSON' })
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) {
        return refuse('bad batch', 400, { error: 'Expected JSON object with keys array' })
      }
      rawKeys = parsed.keys
      if (parsed.policy === 'NetworkOnly') networkOnly = true
    }

    if (rawKeys.length === 0 || rawKeys.length > limits.maxBatchKeys) {
      return refuse('batch size', 400, { error: `Batch size must be between 1 and ${limits.maxBatchKeys}` })
    }
    const keys = []
    const seen = new Set()
    for (const k of rawKeys) {
      if (!isValidZ32(k)) return refuse('invalid key', 400, { error: 'Invalid public key' })
      if (!seen.has(k)) { seen.add(k); keys.push(k) }
    }

    statsCounters.batchGets++
    const results = Object.create(null)
    await Promise.all(keys.map(async key => {
      const r = await resolveKey(key, { networkOnly })
      if (r.status === 'ok') {
        results[key] = {
          status: 'ok',
          packet: r.payload.toString('base64'),
          seq: r.seq.toString(),
          cached: r.cached,
        }
      } else if (r.status === 'not_found') {
        results[key] = { status: 'not_found' }
      } else if (r.status === 'circuit_open') {
        results[key] = { status: 'error', error: 'upstream_circuit_open' }
      } else {
        results[key] = { status: 'error', error: 'upstream_unavailable' }
      }
    }))
    return answerJson(200, { results })
  }

  async function handleBatchPut (req, res, ip, answerJson, refuse) {
    const read = await readRequestBody(req, limits.maxBatchBodyBytes)
    if (!read.ok) {
      if (read.reason === 'size') return refuse('size', 413, { error: 'Request too large' })
      return
    }
    const budget = byteBuckets.spend(ip, read.body.length, monotonicNow())
    if (!budget.ok) {
      return refuse('byte rate', 429, { error: 'Bandwidth limit exceeded' }, undefined, { 'Retry-After': String(budget.retryAfterSec) })
    }
    let parsed
    try { parsed = JSON.parse(read.body.toString('utf8')) } catch {
      return refuse('not json', 400, { error: 'Invalid JSON' })
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.packets || typeof parsed.packets !== 'object' || Array.isArray(parsed.packets)) {
      return refuse('bad batch', 400, { error: 'Expected JSON object with packets map' })
    }
    const entries = Object.entries(parsed.packets)
    if (entries.length === 0 || entries.length > limits.maxBatchKeys) {
      return refuse('batch size', 400, { error: `Batch size must be between 1 and ${limits.maxBatchKeys}` })
    }

    statsCounters.batchPuts++
    const results = Object.create(null)
    await Promise.all(entries.map(async ([key, encoded]) => {
      if (!isValidZ32(key)) {
        results[key] = { status: 'invalid_key', error: 'Invalid public key' }
        return
      }
      const bytes = decodeBase64Any(encoded)
      if (!bytes) {
        results[key] = { status: 'invalid_packet', error: 'Invalid base64 packet' }
        return
      }
      const verified = verifyPkarrPacket(key, bytes)
      if (!verified.ok) {
        results[key] = { status: verified.code, error: verified.error }
        return
      }
      const existing = cache.peek(key)
      const cmp = comparePacketSeq(existing, verified)
      if (cmp === 'stale') {
        results[key] = { status: 'stale' }
        return
      }
      const upstream = await forwardPutToUpstreams(key, verified.payload)
      if (upstream.status === 'stale') {
        results[key] = { status: 'stale' }
        return
      }
      if (upstream.status === 'circuit_open' || upstream.status === 'upstream_error') {
        results[key] = { status: 'error', error: upstream.status === 'circuit_open' ? 'upstream_circuit_open' : 'upstream_unavailable' }
        return
      }
      storeAndFanout(key, verified)
      results[key] = { status: 'ok', seq: verified.seq.toString() }
    }))
    return answerJson(200, { results })
  }

  function handleSseSubscribe (req, res, url, ip, cors, refuse) {
    const now = monotonicNow()
    const blocked = checkConnectionLimits(ip, now)
    if (blocked) {
      return refuse(blocked.why, blocked.status, { error: blocked.error }, blocked.detail, blocked.headers)
    }
    const param = url.searchParams.get('keys') ?? ''
    const keys = param.split(',').map(k => k.trim()).filter(Boolean)
    if (keys.length === 0) {
      return refuse('invalid request', 400, { error: 'At least one key is required' })
    }
    const budget = byteBuckets.spend(ip, Math.max(FRAME_COST_BYTES, param.length), now)
    if (!budget.ok) {
      return refuse('byte rate', 429, { error: 'Bandwidth limit exceeded' }, undefined, { 'Retry-After': String(budget.retryAfterSec) })
    }

    const sub = {
      kind: 'sse',
      ip,
      keys: new Set(),
      sendUpdate: (_wsFrame, sseFrame) => {
        if (res.writableEnded || res.destroyed) { cleanup(); return }
        if (res.writableLength > limits.wsQueuedBytes) {
          refusals.refuse('slow consumer')
          cleanup()
          res.destroy()
          return
        }
        res.write(sseFrame)
      },
      ping: () => {
        if (res.writableEnded || res.destroyed) { cleanup(); return }
        if (res.writableLength > limits.wsQueuedBytes) {
          refusals.refuse('slow consumer')
          cleanup()
          res.destroy()
          return
        }
        res.write(': ping\n\n')
      },
      close: () => {
        cleanup()
        if (!res.writableEnded && !res.destroyed) res.end()
      },
    }

    const cleanup = () => unregisterSubscriber(sub)

    registerSubscriber(sub)
    const added = addSubscriberKeys(sub, keys)
    if (!added.ok) {
      unregisterSubscriber(sub)
      const status = added.code === 'invalid_key' ? 400 : 429
      return writeJson(res, status, { error: added.error, code: added.code }, cors)
    }

    // SSE connections live longer than requestMs.
    req.setTimeout(0)
    res.setTimeout(0)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`event: subscribed\ndata: ${JSON.stringify({ keys: added.added, count: sub.keys.size })}\n\n`)
    if (url.searchParams.get('initial') !== '0') {
      sendCachedSnapshot(sub, added.added)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  // WebSocket upgrade handler: /subscribe (or /)
  server.on('upgrade', (req, socket, head) => {
    const rejectUpgrade = (status, text, why, detail, extraHeaders = {}) => {
      if (why) refusals.refuse(why, detail)
      const headers = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n')
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${headers ? `${headers}\r\n` : ''}\r\n`)
      socket.destroy()
    }

    let url
    try { url = new URL(req.url ?? '/', 'http://relay') } catch {
      return rejectUpgrade(400, 'Bad Request', 'bad url')
    }
    if (url.pathname !== '/subscribe' && url.pathname !== '/') {
      return rejectUpgrade(404, 'Not Found', 'not found')
    }
    if (stopping) return rejectUpgrade(503, 'Service Unavailable', 'stopping')
    if (originRefused(req)) return rejectUpgrade(403, 'Forbidden', 'origin', originShown(req.headers.origin))

    const ip = resolveIp(req)
    const now = monotonicNow()
    const blocked = checkConnectionLimits(ip, now)
    if (blocked) {
      return rejectUpgrade(blocked.status, blocked.status === 429 ? 'Too Many Requests' : 'Service Unavailable', blocked.why, blocked.detail, blocked.headers)
    }
    const budget = byteBuckets.spend(ip, FRAME_COST_BYTES, now)
    if (!budget.ok) {
      return rejectUpgrade(429, 'Too Many Requests', 'byte rate', undefined, { 'Retry-After': String(budget.retryAfterSec) })
    }

    // Validate optional initial keys in query string before upgrading.
    const param = url.searchParams.get('keys') ?? ''
    const initialKeys = param ? param.split(',').map(k => k.trim()).filter(Boolean) : []
    for (const k of initialKeys) {
      if (!isValidZ32(k)) return rejectUpgrade(400, 'Bad Request', 'invalid key')
    }

    wss.handleUpgrade(req, socket, head, ws => {
      let alive = true
      const sub = {
        kind: 'ws',
        ip,
        keys: new Set(),
        sendUpdate: (wsFrame) => {
          if (ws.readyState !== 1) return
          if (ws.bufferedAmount > limits.wsQueuedBytes) {
            refusals.refuse('slow consumer')
            ws.close(1008, 'Slow consumer')
            return
          }
          ws.send(wsFrame)
        },
        ping: () => {
          if (ws.readyState !== 1) return
          if (!alive) {
            ws.terminate()
            return
          }
          alive = false
          ws.ping()
        },
        close: () => {
          if (ws.readyState === 1) ws.close(1001, 'The relay is stopping')
          else ws.terminate()
        },
        ws,
      }

      const sendWs = obj => {
        if (ws.readyState !== 1) return
        if (ws.bufferedAmount > limits.wsQueuedBytes) {
          refusals.refuse('slow consumer')
          ws.close(1008, 'Slow consumer')
          return
        }
        ws.send(JSON.stringify(obj))
      }

      registerSubscriber(sub)

      if (initialKeys.length > 0) {
        const added = addSubscriberKeys(sub, initialKeys)
        if (!added.ok) {
          sendWs({ op: 'error', code: added.code, error: added.error })
          unregisterSubscriber(sub)
          ws.close(1008, added.error)
          return
        }
        sendWs({ op: 'subscribed', keys: added.added, count: sub.keys.size })
        if (url.searchParams.get('initial') !== '0') {
          sendCachedSnapshot(sub, added.added)
        }
      }

      ws.on('pong', () => { alive = true })
      ws.on('close', () => unregisterSubscriber(sub))
      ws.on('error', () => unregisterSubscriber(sub))
      ws.on('message', (data, isBinary) => {
        alive = true
        const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
        const spend = byteBuckets.spend(ip, size, monotonicNow())
        if (!spend.ok) {
          refusals.refuse('ws byte rate')
          sendWs({ op: 'error', code: 'rate_limited', error: 'Rate limit exceeded' })
          ws.close(1008, 'Rate limit exceeded')
          return
        }
        if (isBinary) {
          sendWs({ op: 'error', code: 'invalid_message', error: 'Expected JSON text frame' })
          return
        }
        let msg
        try { msg = JSON.parse(data.toString('utf8')) } catch {
          sendWs({ op: 'error', code: 'invalid_json', error: 'Invalid JSON' })
          return
        }
        if (!msg || typeof msg !== 'object') {
          sendWs({ op: 'error', code: 'invalid_message', error: 'Expected JSON object' })
          return
        }
        if (msg.op === 'ping') {
          sendWs({ op: 'pong' })
          return
        }
        if (msg.op === 'subscribe') {
          const added = addSubscriberKeys(sub, msg.keys)
          if (!added.ok) {
            sendWs({ op: 'error', code: added.code, error: added.error })
            return
          }
          sendWs({ op: 'subscribed', keys: added.added, count: sub.keys.size })
          if (msg.initial !== false) {
            sendCachedSnapshot(sub, added.added)
          }
          return
        }
        if (msg.op === 'unsubscribe') {
          const removed = removeSubscriberKeys(sub, msg.keys)
          if (!removed.ok) {
            sendWs({ op: 'error', code: removed.code, error: removed.error })
            return
          }
          sendWs({ op: 'unsubscribed', keys: removed.removed, count: sub.keys.size })
          return
        }
        sendWs({ op: 'error', code: 'unknown_op', error: 'Unknown op' })
      })
    })
  })

  // Periodic maintenance: prune rate/byte/cache tables and flush counted logs.
  const maintenanceTimer = setInterval(() => {
    const now = monotonicNow()
    reqCounts.prune(now)
    connectCounts.prune(now)
    byteBuckets.prune(now)
    cache.prune(now)
    flush()
  }, 60_000)
  maintenanceTimer.unref?.()

  // Periodic ping / keepalive for active push subscribers.
  const pingTimer = setInterval(() => {
    for (const sub of [...subscribers]) sub.ping()
  }, limits.pingMs)
  pingTimer.unref?.()

  // Periodic upstream refresh of actively subscribed keys (when upstreams are configured).
  let refreshing = false
  let refreshCursor = 0
  let refreshTimer = null
  if (breakers.length > 0 && limits.upstreamRefreshMs > 0) {
    refreshTimer = setInterval(async () => {
      if (stopping || refreshing || keySubscribers.size === 0) return
      refreshing = true
      try {
        const allKeys = [...keySubscribers.keys()]
        const count = Math.min(allKeys.length, limits.maxBatchKeys)
        const now = monotonicNow()
        const due = []
        for (let i = 0; i < count; i++) {
          const key = allKeys[(refreshCursor + i) % allKeys.length]
          const entry = cache.peek(key)
          if (!entry || now - entry.fetchedAt >= limits.upstreamRefreshMs) {
            due.push(key)
          }
        }
        refreshCursor = (refreshCursor + count) % Math.max(1, allKeys.length)
        await Promise.all(due.map(key => fetchFromUpstreams(key, { networkOnly: true })))
      } finally {
        refreshing = false
      }
    }, limits.upstreamRefreshMs)
    refreshTimer.unref?.()
  }

  return new Promise((resolve, reject) => {
    server.once('error', error => {
      clearInterval(maintenanceTimer)
      clearInterval(pingTimer)
      if (refreshTimer) clearInterval(refreshTimer)
      reject(error)
    })
    server.listen(port, host, () => {
      const boundPort = server.address().port
      resolve({
        port: boundPort,
        stats: () => ({
          ...statsCounters,
          refused: refusals.total(),
          upstreamErrors: upstreamErrors.total(),
          cached: cache.size(),
          subscribers: subscribers.size,
          subscribedKeys: keySubscribers.size,
          trackedIps: reqCounts.size(),
        }),
        clients: () => new Promise(done => server.getConnections((_, count) => done(count ?? 0))),
        async close ({ stopMs = 2000 } = {}) {
          stopping = true
          clearInterval(maintenanceTimer)
          clearInterval(pingTimer)
          if (refreshTimer) clearInterval(refreshTimer)

          const wsClosers = []
          for (const sub of [...subscribers]) {
            if (sub.kind === 'ws' && sub.ws) {
              wsClosers.push(new Promise(done => {
                if (sub.ws.readyState === 3) { done(); return }
                sub.ws.once('close', done)
              }))
            }
            sub.close()
          }
          if (wsClosers.length) {
            let timer
            await Promise.race([
              Promise.all(wsClosers),
              new Promise(done => { timer = setTimeout(done, Math.min(stopMs, 1000)) }),
            ])
            clearTimeout(timer)
          }
          for (const sub of [...subscribers]) {
            if (sub.kind === 'ws' && sub.ws) sub.ws.terminate()
            unregisterSubscriber(sub)
          }
          await new Promise(done => {
            const cut = setTimeout(() => server.closeAllConnections(), stopMs)
            wss.close()
            server.close(() => {
              clearTimeout(cut)
              flush()
              done()
            })
            server.closeIdleConnections?.()
          })
        },
      })
    })
  })
}

/**
 * Parses a browser origin (scheme + host + optional port, no path/query/fragment).
 */
export function originOf (entry) {
  let url
  try { url = new URL(entry) } catch { return null }
  if (url.protocol === 'file:' || !url.host || url.username || url.password || !['', '/'].includes(url.pathname) || /[?#]/.test(entry)) return null
  return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`
}

/** Validates an upstream Pkarr relay URL (http or https, host, no credentials/query/fragment). */
export function upstreamOf (entry) {
  let url
  try { url = new URL(entry) } catch { return null }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean)

function setting (env, name, fallback, kind) {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = raw.trim()
  const fail = expected => { throw new Error(`${name}=${JSON.stringify(raw)}: expected ${expected}`) }
  if (kind === 'port') return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : fail('a port from 1 to 65535')
  if (kind === 'count') return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fail('a whole number of 0 or more')
  if (kind === 'positive') return /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Number(value) : fail('a whole number above 0')
  if (kind === 'ms') return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= TIMER_MAX_MS ? Number(value) : fail(`a whole number above 0, at most ${TIMER_MAX_MS} (about 24 days)`)
  if (kind === 'msOrZero') return /^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= TIMER_MAX_MS ? Number(value) : fail(`a whole number from 0 to ${TIMER_MAX_MS}`)
  if (kind === 'flag') return value === '1' ? true : value === '0' ? false : fail('1 or 0')
  if (kind === 'text') return value || fail('a value (leave it out for the default)')
  if (kind === 'origins') {
    const entries = list(value)
    const wrong = entries.find(entry => !originOf(entry))
    if (wrong !== undefined) fail(`origins like https://app.example, comma-separated: a scheme, a host and a port only (${JSON.stringify(wrong)} is not one)`)
    return [...new Set(entries.map(originOf))]
  }
  if (kind === 'upstreams') {
    const entries = list(value)
    const wrong = entries.find(entry => !upstreamOf(entry))
    if (wrong !== undefined) fail(`HTTP(S) upstream Pkarr relay URLs, comma-separated (${JSON.stringify(wrong)} is not one)`)
    return [...new Set(entries.map(upstreamOf))]
  }
  return value
}

function editDistance (a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

function ignoredSettings (env, known) {
  return Object.keys(env).filter(name => /^GHOSTLY_(RELAY|PKARR)_/.test(name) && !known.includes(name)).sort().map(name => {
    const [closest] = known.map(other => ({ other, edits: editDistance(name, other) })).sort((a, b) => a.edits - b.edits)
    return closest && closest.edits <= 3 ? `${name} (${closest.other}?)` : name
  })
}

/** `GHOSTLY_RELAY_<LIMIT>` for a limit's name in DEFAULT_LIMITS. */
export const limitVariable = name => `GHOSTLY_RELAY_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`

export function readSettings (env) {
  const limits = {}
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    const kind = ZERO_ALLOWED_LIMITS.has(name) ? 'msOrZero' : name.endsWith('Ms') ? 'ms' : 'positive'
    const value = setting(env, limitVariable(name), undefined, kind)
    if (value !== undefined) limits[name] = value
  }
  const proxies = setting(env, 'GHOSTLY_RELAY_PROXIES', 0, 'count')
  const cloudflare = setting(env, 'GHOSTLY_RELAY_CLOUDFLARE', false, 'flag')
  if (proxies && cloudflare) {
    throw new Error(`GHOSTLY_RELAY_PROXIES=${JSON.stringify(env.GHOSTLY_RELAY_PROXIES)}: expected no GHOSTLY_RELAY_CLOUDFLARE=1 with it (behind Cloudflare set GHOSTLY_RELAY_CLOUDFLARE alone; behind nginx or Caddy set GHOSTLY_RELAY_CLOUDFLARE=0)`)
  }
  return {
    port: setting(env, 'PORT', 49490, 'port'),
    host: setting(env, 'HOST', proxies || cloudflare ? '127.0.0.1' : '0.0.0.0', 'text'),
    upstreams: setting(env, 'GHOSTLY_PKARR_UPSTREAMS', [], 'upstreams'),
    origins: setting(env, 'GHOSTLY_RELAY_ORIGINS', [], 'origins'),
    proxies,
    cloudflare,
    limits,
    ignored: ignoredSettings(env, [
      ...Object.keys(DEFAULT_LIMITS).map(limitVariable),
      'GHOSTLY_PKARR_UPSTREAMS',
      'GHOSTLY_RELAY_ORIGINS',
      'GHOSTLY_RELAY_CLOUDFLARE',
      'GHOSTLY_RELAY_PROXIES',
    ]),
  }
}

export function listenProblem (error, { port, host }) {
  switch (error?.code) {
    case 'EADDRINUSE': return `port ${port} on ${host} is already in use (PORT)`
    case 'EACCES': return `port ${port} on ${host} needs more rights than this user has (PORT): below 1024, root or the cap_net_bind_service capability`
    case 'EADDRNOTAVAIL': return `cannot listen on ${host}: it is no address of this machine (HOST)`
    case 'ENOTFOUND': case 'EAI_AGAIN': case 'EAI_FAIL': case 'EAI_NONAME': return `cannot listen on ${JSON.stringify(host)}: no such host (HOST)`
    default: return null
  }
}
