// Private stdio bridge launched by the desktop host. No TCP/HTTP control port,
// arbitrary module loading, shell commands, or secret-bearing process arguments.
import { createHyperEndpoint } from './endpoint.mjs'
import { createInterface } from 'node:readline'

const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
let endpoint
let next = 0
const connections = new Map()
let chain = Promise.resolve()
let stopping = false
let queued = 0
function attach(bound, incoming) {
  const id = ++next
  connections.set(id, bound.channel)
  emit({ type: 'open', id, binding: bound.binding, incoming })
  bound.channel.onMessage = text => emit({ type: 'frame', id, text })
  bound.channel.onClose = () => { connections.delete(id); emit({ type: 'closed', id }) }
  return id
}
async function stop() {
  if (stopping) return
  stopping = true
  await endpoint?.close()
  process.exit(0)
}
createInterface({ input: process.stdin }).on('line', line => {
  if (++queued > 32 || line.length > 256 * 1024) { void stop(); return }
  chain = chain.then(async () => {
    const command = JSON.parse(line)
    if (command.type === 'start' && !endpoint) {
      const seed = Buffer.from(command.seedB64, 'base64url')
      if (seed.length !== 32) throw new Error('Invalid native seed')
      endpoint = await createHyperEndpoint(seed)
      seed.fill(0)
      endpoint.onConnection = bound => attach(bound, true)
      emit({ type: 'started', descriptor: endpoint.descriptor })
    } else if (command.type === 'connect' && endpoint) {
      const bound = await endpoint.connect(command.descriptor)
      const id = attach(bound, false)
      emit({ type: 'result', request: command.request, id })
    } else if (command.type === 'send') connections.get(command.id)?.send(command.text)
    else if (command.type === 'close') connections.get(command.id)?.close()
    else if (command.type === 'stop') await stop()
    else throw new Error('Unsupported native command')
  }).catch(error => emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })).finally(() => { queued-- })
}).on('close', () => void stop())
process.on('SIGTERM', () => void stop())
