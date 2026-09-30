// Private stdio bridge launched by the desktop host. No TCP/HTTP control port,
// arbitrary module loading, shell commands, or secret-bearing process arguments.
// One process per app: every chat's endpoint lives here, under the number the
// host gave it, and the process ends with the host.
import { createHyperEndpoint } from './endpoint.mjs'
import { createInterface } from 'node:readline'

const MAX_ENDPOINTS = 8
const MAX_QUEUED = 32
const MAX_LINE = 256 * 1024
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
  bound.channel.onMessage = text => emit({ type: 'frame', endpoint: record.id, id, text })
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
    } else if (command.type === 'send') record.connections.get(command.id)?.send(command.text)
    else record.connections.get(command.id)?.close()
  }).catch(error => {
    if (!record.stopped) emit({ type: 'error', endpoint: record.id, command: command.type, message: message(error) })
  }).finally(() => { record.queued-- })
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
