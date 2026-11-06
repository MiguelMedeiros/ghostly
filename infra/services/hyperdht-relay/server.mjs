import { DEFAULT_LIMITS, limitVariable, listenProblem, networkOf, readSettings, startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49443), HOST (0.0.0.0; 127.0.0.1 behind proxies or Cloudflare)
//   GHOSTLY_HYPERDHT_BOOTSTRAP  "host:port,…" instead of the public bootstrap nodes
//   GHOSTLY_HYPERDHT_TESTNET    size of an in-process HyperDHT network instead of any other (e2e); not with BOOTSTRAP
//   GHOSTLY_RELAY_ORIGINS       allowed origins, comma-separated (empty: any): https://app.example, read as a browser
//                               sends it (no path; case, a default port and a trailing / do not matter)
//   GHOSTLY_RELAY_CLOUDFLARE    "1" behind Cloudflare (a tunnel): each client counts by CF-Connecting-IP
//   GHOSTLY_RELAY_PROXIES       reverse proxies in front of it (0): each client counts by the X-Forwarded-For entry
//                               that many from the end. A client that reaches the port past them could write either
//                               header itself, so HOST is loopback by default with either set.
//   GHOSTLY_RELAY_<LIMIT>       any of the limits in relay.mjs, e.g. GHOSTLY_RELAY_CLIENTS=512
let settings
try { settings = readSettings(process.env) } catch (error) {
  console.error(new Date().toISOString(), `Ghostly HyperDHT relay not started: ${error.message}`)
  process.exit(1)
}
// A port in use or below 1024, a HOST that is no address here: one line naming the setting, not Node's stack.
const start = options => startRelay(options).catch(error => {
  const problem = listenProblem(error, settings)
  if (!problem) throw error
  console.error(new Date().toISOString(), `Ghostly HyperDHT relay not started: ${problem}`)
  process.exit(1)
})
const relay = await start({
  ...settings,
  // Counts and reasons only: never a key, an address or a byte of anyone's traffic.
  log: (...words) => console.log(new Date().toISOString(), ...words),
})
// What it counts clients by, and each limit set away from its default: a setting meant to apply shows that it does.
const counting = settings.cloudflare ? 'clients by CF-Connecting-IP' : settings.proxies ? `clients behind ${settings.proxies} ${settings.proxies === 1 ? 'proxy' : 'proxies'}` : 'clients by their own address'
// Which pages it serves: a misspelt origin shows here, not only as browsers turned away.
const serves = settings.origins.length ? `origins ${settings.origins.join(' ')}` : 'any origin'
const changed = Object.entries(settings.limits).filter(([name, value]) => value !== DEFAULT_LIMITS[name]).map(([name, value]) => `${limitVariable(name)}=${value}`)
console.log(new Date().toISOString(), `Ghostly HyperDHT relay on port ${relay.port}`, networkOf(settings), [`on ${settings.host}`, counting, ...(changed.length ? [`limits ${changed.join(' ')}`] : []), serves].join(', '))

// One client's request that fails where nothing catches it must not end the relay for every other client.
process.on('unhandledRejection', error => console.log(new Date().toISOString(), 'unhandled', error?.code ?? error?.name ?? 'error'))

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return
  closing = true
  const { clients } = relay.stats()
  console.log(new Date().toISOString(), `Ghostly HyperDHT relay stopping (${clients} ${clients === 1 ? 'client' : 'clients'})`)
  const stopped = () => {
    console.log(new Date().toISOString(), 'Ghostly HyperDHT relay stopped')
    process.exit(0)
  }
  setTimeout(stopped, 3000).unref()
  void relay.close().finally(stopped)
})
