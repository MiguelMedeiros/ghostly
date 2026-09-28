import { startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49480), HOST (0.0.0.0; 127.0.0.1 behind proxies)
//   GHOSTLY_RELAY_ORIGINS   allowed Origin values, comma-separated (empty: any)
//   GHOSTLY_RELAY_PROXIES   reverse proxies in front of it (0): each request then counts against the address
//                           that many entries from the end of X-Forwarded-For, not the proxy's. A client that reached
//                           the relay past the proxies could write that header itself, so HOST is loopback by default.
const env = process.env
const origins = (env.GHOSTLY_RELAY_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
const proxies = Math.max(0, Math.floor(Number(env.GHOSTLY_RELAY_PROXIES ?? 0)) || 0)
const relay = await startRelay({
  port: Number(env.PORT ?? 49480),
  host: env.HOST ?? (proxies ? '127.0.0.1' : '0.0.0.0'),
  origins,
  proxies,
  // Counts and reasons only: never an endpoint, an address or a byte of a push.
  log: (...words) => console.log(new Date().toISOString(), ...words),
})
console.log(new Date().toISOString(), `Ghostly push relay on port ${relay.port}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void relay.close().finally(() => process.exit(0)))
