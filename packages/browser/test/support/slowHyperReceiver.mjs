// A HyperDHT endpoint that reads slowly, in its own process (hyperdhtSidecarRoom.test.ts): it spends `delayMs` on each
// binary frame, so its stream's window fills and the sender's link is as slow as it reads. It prints its descriptor
// first, then each text frame it reads with the time it read it, one JSON line each.
import { createHyperEndpoint } from '../../../../native/transports/hyperdht/endpoint.mjs'

const [bootstrap, delayMs] = [JSON.parse(process.argv[2]), Number(process.argv[3])]
const endpoint = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: '127.0.0.1' })
const say = value => process.stdout.write(JSON.stringify(value) + '\n')
endpoint.onConnection = ({ channel }) => {
  channel.onMessage = data => {
    if (typeof data === 'string') { say({ text: data, at: Date.now() }); return }
    const until = Date.now() + delayMs
    while (Date.now() < until) { /* reading slowly */ }
  }
}
say({ descriptor: endpoint.descriptor })
process.stdin.on('data', () => {})
process.stdin.on('end', () => { void endpoint.close().then(() => process.exit(0)) })
