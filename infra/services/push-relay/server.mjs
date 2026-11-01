import { readSettings, startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49480), HOST (0.0.0.0; 127.0.0.1 behind proxies)
//   GHOSTLY_RELAY_ORIGINS   allowed Origin values, comma-separated (empty: any)
//   GHOSTLY_RELAY_PROXIES   reverse proxies in front of it (0): each request then counts against the address
//                           that many entries from the end of X-Forwarded-For, not the proxy's. A client that reached
//                           the relay past the proxies could write that header itself, so HOST is loopback by default.
let settings
try { settings = readSettings(process.env) } catch (error) {
  console.error(new Date().toISOString(), `Ghostly push relay not started: ${error.message}`)
  process.exit(1)
}
const relay = await startRelay({
  ...settings,
  // Counts and reasons only: never an endpoint, an address or a byte of a push.
  log: (...words) => console.log(new Date().toISOString(), ...words),
})
console.log(new Date().toISOString(), `Ghostly push relay on port ${relay.port}`, settings.proxies ? `(behind ${settings.proxies} ${settings.proxies === 1 ? 'proxy' : 'proxies'}, on ${settings.host})` : `(no proxy, on ${settings.host})`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void relay.close().finally(() => process.exit(0)))
