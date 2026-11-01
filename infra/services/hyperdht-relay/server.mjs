import { DEFAULT_LIMITS, limitVariable, readSettings, startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49443), HOST (0.0.0.0)
//   GHOSTLY_HYPERDHT_BOOTSTRAP  "host:port,…" instead of the public bootstrap nodes
//   GHOSTLY_HYPERDHT_TESTNET    size of an in-process HyperDHT network instead of any other (e2e)
//   GHOSTLY_RELAY_ORIGINS       allowed Origin values, comma-separated (empty: any)
//   GHOSTLY_RELAY_CLOUDFLARE    "1" behind Cloudflare (a tunnel): each client counts by CF-Connecting-IP
//   GHOSTLY_RELAY_PROXIES       reverse proxies in front of it (0): each client counts by the X-Forwarded-For entry
//                               that many from the end. A client that reaches the port past them could write either
//                               header itself: publish the port only where the proxy is.
//   GHOSTLY_RELAY_<LIMIT>       any of the limits in relay.mjs, e.g. GHOSTLY_RELAY_CLIENTS=512
let settings
try { settings = readSettings(process.env) } catch (error) {
  console.error(new Date().toISOString(), `Ghostly HyperDHT relay not started: ${error.message}`)
  process.exit(1)
}
const relay = await startRelay({
  ...settings,
  // Counts and reasons only: never a key, an address or a byte of anyone's traffic.
  log: (...words) => console.log(new Date().toISOString(), ...words),
})
// What it counts clients by, and each limit set away from its default: a setting meant to apply shows that it does.
const counting = settings.cloudflare ? 'clients by CF-Connecting-IP' : settings.proxies ? `clients behind ${settings.proxies} ${settings.proxies === 1 ? 'proxy' : 'proxies'}` : 'clients by their own address'
const changed = Object.entries(settings.limits).filter(([name, value]) => value !== DEFAULT_LIMITS[name]).map(([name, value]) => `${limitVariable(name)}=${value}`)
console.log(new Date().toISOString(), `Ghostly HyperDHT relay on port ${relay.port}`, relay.bootstrap.length ? `(bootstrap ${relay.bootstrap.length} nodes)` : '(public HyperDHT)', [`on ${settings.host}`, counting, ...(changed.length ? [`limits ${changed.join(' ')}`] : [])].join(', '))

// One client's request that fails where nothing catches it must not end the relay for every other client.
process.on('unhandledRejection', error => console.log(new Date().toISOString(), 'unhandled', error?.code ?? error?.name ?? 'error'))

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(0), 3000).unref()
  void relay.close().finally(() => process.exit(0))
})
