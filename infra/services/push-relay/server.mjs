import { listenProblem, readSettings, startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49480), HOST (0.0.0.0; 127.0.0.1 behind proxies)
//   GHOSTLY_RELAY_ORIGINS   allowed origins, comma-separated (empty: any): https://app.example, read as a browser
//                           sends it (no path; case, a default port and a trailing / do not matter)
//   GHOSTLY_RELAY_PROXIES   reverse proxies in front of it (0): each request then counts against the address
//                           that many entries from the end of X-Forwarded-For, not the proxy's. A client that reached
//                           the relay past the proxies could write that header itself, so HOST is loopback by default.
let settings
try { settings = readSettings(process.env) } catch (error) {
  console.error(new Date().toISOString(), `Ghostly push relay not started: ${error.message}`)
  process.exit(1)
}
// A misspelt name (GHOSTLY_RELAY_ORIGIN) or one of the HyperDHT relay's (GHOSTLY_RELAY_CLOUDFLARE): said, not dropped.
if (settings.ignored.length) console.log(new Date().toISOString(), `${settings.ignored.join(', ')} ${settings.ignored.length === 1 ? 'is not a setting' : 'are not settings'} of this relay; ignored`)
// A port in use or below 1024, a HOST that is no address here: one line naming the setting, not Node's stack.
const start = options => startRelay(options).catch(error => {
  const problem = listenProblem(error, settings)
  if (!problem) throw error
  console.error(new Date().toISOString(), `Ghostly push relay not started: ${problem}`)
  process.exit(1)
})
const relay = await start({
  ...settings,
  // Counts and reasons only: never an endpoint, an address or a byte of a push.
  log: (...words) => console.log(new Date().toISOString(), ...words),
})
// Which pages it serves: a misspelt origin shows here, not only as browsers turned away.
const serves = settings.origins.length ? `origins ${settings.origins.join(' ')}` : 'any origin'
console.log(new Date().toISOString(), `Ghostly push relay on port ${relay.port}`, settings.proxies ? `(behind ${settings.proxies} ${settings.proxies === 1 ? 'proxy' : 'proxies'}, on ${settings.host}),` : `(no proxy, on ${settings.host}),`, serves)
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return
  closing = true
  const clients = await relay.clients()
  console.log(new Date().toISOString(), `Ghostly push relay stopping (${clients} ${clients === 1 ? 'client' : 'clients'})`)
  void relay.close().finally(() => {
    console.log(new Date().toISOString(), 'Ghostly push relay stopped')
    process.exit(0)
  })
})
