// Private stdio bridge launched by the desktop host. No TCP/HTTP control port,
// arbitrary module loading, shell commands, or secret-bearing process arguments.
// One process per app: every chat's endpoint lives here, under the number the
// host gave it, and the process ends with the host.
import { createHyperEndpoint } from './endpoint.mjs'
import { createInterface } from 'node:readline'

const MAX_ENDPOINTS = 8
const MAX_QUEUED = 32
/**
 * The longest line read or written here (and the host's `MAX_LINE` in hyperdht.rs). A frame is at most 60 KiB, and
 * JSON writes a control character as `\u0001`, six bytes for one: 60 KiB of them is a line of 360 KiB.
 */
const MAX_LINE = 512 * 1024
/**
 * Bytes a connection's socket may hold when a send is answered. Past it, the answer waits until the socket drained,
 * so the host counts the frame against the page's send budget while it is not on the wire.
 */
const SEND_ROOM = 64 * 1024
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const message = error => error instanceof Error ? error.message : String(error)
// GHOSTLY_HYPERDHT_BOOTSTRAP ("host:port,…") replaces the public bootstrap nodes: a private network, or the
// end-to-end tests' own (hyperdht/testnet). A network all on loopback is announced on loopback too.
const bootstrap = (process.env.GHOSTLY_HYPERDHT_BOOTSTRAP ?? '').split(',').map(node => node.trim()).filter(Boolean)
const loopback = bootstrap.length > 0 && bootstrap.every(node => /^(127\.0\.0\.1|localhost):\d+$/.test(node))
const network = bootstrap.length ? { bootstrap, ...(loopback ? { host: '127.0.0.1' } : {}) } : {}
const endpoints = new Map()
let next = 0
let exiting = false

function attach(record, bound, incoming) {
  if (record.stopped) { bound.channel.close(); return 0 }
  const id = ++next
  record.connections.set(id, bound.channel)
  emit({ type: 'open', endpoint: record.id, id, binding: bound.binding, incoming })
  // A binary message (WISP 103 § Frames) goes on the line as `bytes`, in base64; text as `text`.
  bound.channel.onMessage = data => {
    const frame = typeof data === 'string' ? { type: 'frame', endpoint: record.id, id, text: data }
      : data instanceof Uint8Array ? { type: 'frame', endpoint: record.id, id, bytes: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') }
        : null
    if (!frame) return
    const line = JSON.stringify(frame)
    // A line the host would not read stops the whole runtime there: only this connection closes.
    if (Buffer.byteLength(line) > MAX_LINE) { bound.channel.close(); return }
    process.stdout.write(line + '\n')
  }
  bound.channel.onClose = () => { if (record.connections.delete(id)) emit({ type: 'closed', endpoint: record.id, id }) }
  return id
}

function start(id, seedB64) {
  if (endpoints.has(id) || endpoints.size >= MAX_ENDPOINTS) {
    emit({ type: 'error', endpoint: id, command: 'start', message: 'Native endpoint limit reached' }); return
  }
  const record = { id, connections: new Map(), queued: 0, stopped: false, endpoint: null }
  endpoints.set(id, record)
  record.starting = (async () => {
    const seed = Buffer.from(String(seedB64), 'base64url')
    try {
      if (seed.length !== 32) throw new Error('Invalid native seed')
      return await createHyperEndpoint(seed, network)
    } finally { seed.fill(0) }
  })()
  record.chain = record.starting.then(endpoint => {
    // Stopped while starting: stop() closes it once it is up.
    if (record.stopped) return
    record.endpoint = endpoint
    endpoint.onConnection = bound => attach(record, bound, true)
    emit({ type: 'started', endpoint: id, descriptor: endpoint.descriptor })
  }, error => {
    record.stopped = true
    if (endpoints.get(id) === record) endpoints.delete(id)
    emit({ type: 'error', endpoint: id, command: 'start', message: message(error) })
  })
}

/** Commands for one endpoint run in order; another endpoint's never wait for them. */
function queue(record, command) {
  if (record.queued >= MAX_QUEUED) {
    void stop(record)
    emit({ type: 'stopped', endpoint: record.id })
    return
  }
  record.queued++
  record.chain = record.chain.then(async () => {
    if (record.stopped) return
    if (command.type === 'connect') {
      const id = attach(record, await record.endpoint.connect(command.descriptor), false)
      if (id) emit({ type: 'result', endpoint: record.id, id })
    } else if (command.type === 'send') {
      const channel = record.connections.get(command.id)
      if (!channel) throw new Error('Native channel is closed')
      channel.send(typeof command.bytes === 'string' ? new Uint8Array(Buffer.from(command.bytes, 'base64')) : command.text)
      // Answered once the socket has room, out of this endpoint's line: a close or another connection's send never waits on it.
      void room(record, command.id, channel).then(() => emit({ type: 'sent', endpoint: record.id, id: command.id, seq: command.seq }),
        error => emit({ type: 'error', endpoint: record.id, command: 'send', id: command.id, seq: command.seq, message: message(error) }))
    }
    else record.connections.get(command.id)?.close()
  }).catch(error => {
    if (record.stopped) return
    const send = command.type === 'send' ? { id: command.id, seq: command.seq } : {}
    emit({ type: 'error', endpoint: record.id, command: command.type, ...send, message: message(error) })
  }).finally(() => { record.queued-- })
}

/** Resolves once `channel` holds no more than `SEND_ROOM`; throws once it closed. */
async function room(record, id, channel) {
  while (channel.bufferedAmount > SEND_ROOM) {
    if (record.connections.get(id) !== channel) throw new Error('Native channel is closed')
    await channel.drained()
  }
}

async function stop(record) {
  if (endpoints.get(record.id) !== record) return
  record.stopped = true
  endpoints.delete(record.id)
  const channels = [...record.connections.values()]
  record.connections.clear()
  for (const channel of channels) channel.close()
  const endpoint = await record.starting.catch(() => null)
  await endpoint?.close().catch(() => {})
}

/** Closes every endpoint and exits, even if one of them never finishes closing. */
async function shutdown() {
  if (exiting) return
  exiting = true
  setTimeout(() => process.exit(0), 3000).unref()
  await Promise.allSettled([...endpoints.values()].map(stop))
  process.exit(0)
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (exiting) return
  let command
  try { if (line.length <= MAX_LINE) command = JSON.parse(line) } catch { /* A host that sends this is not ours. */ }
  if (command?.type === 'shutdown') { void shutdown(); return }
  const id = command?.endpoint
  if (!Number.isSafeInteger(id) || id < 1) { void shutdown(); return }
  if (command.type === 'start') { start(id, command.seedB64); return }
  if (!['connect', 'send', 'close', 'stop'].includes(command.type)) { void shutdown(); return }
  // Commands for an endpoint that is already gone are late, not wrong.
  const record = endpoints.get(id)
  if (!record) return
  if (command.type === 'stop') void stop(record)
  else queue(record, command)
}).on('close', () => void shutdown())

// The host going away in any way (quit, crash, force-quit) closes this pipe's
// other end, and ends the line reader above. The parent check covers a pipe
// that somehow stays open: an orphan is handed to another parent.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) void shutdown() }, 2000).unref()
process.stdout.on('error', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
