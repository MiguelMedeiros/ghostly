import { DEFAULT_LIMITS, startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49443), HOST (0.0.0.0)
//   GHOSTLY_HYPERDHT_BOOTSTRAP  "host:port,…" instead of the public bootstrap nodes
//   GHOSTLY_HYPERDHT_TESTNET    size of an in-process HyperDHT network instead of any other (e2e)
//   GHOSTLY_RELAY_ORIGINS       allowed Origin values, comma-separated (empty: any)
//   GHOSTLY_RELAY_TRUST_PROXY   "1" behind a proxy that sets CF-Connecting-IP / X-Forwarded-For
//   GHOSTLY_RELAY_<LIMIT>       any of the limits in relay.mjs, e.g. GHOSTLY_RELAY_CLIENTS=512
const env = process.env
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean)
const limits = {}
for (const name of Object.keys(DEFAULT_LIMITS)) {
  const value = env[`GHOSTLY_RELAY_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]
  if (value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0) limits[name] = Number(value)
}

const relay = await startRelay({
  port: Number(env.PORT ?? 49443),
  host: env.HOST ?? '0.0.0.0',
  bootstrap: list(env.GHOSTLY_HYPERDHT_BOOTSTRAP),
  testnet: Number(env.GHOSTLY_HYPERDHT_TESTNET ?? 0) || undefined,
  origins: list(env.GHOSTLY_RELAY_ORIGINS),
  trustProxy: env.GHOSTLY_RELAY_TRUST_PROXY === '1',
  limits,
  // Counts and reasons only: never a key, an address or a byte of anyone's traffic.
  log: (...words) => console.log(new Date().toISOString(), ...words),
})
console.log(new Date().toISOString(), `Ghostly HyperDHT relay on port ${relay.port}`, relay.bootstrap.length ? `(bootstrap ${relay.bootstrap.length} nodes)` : '(public HyperDHT)')

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(0), 3000).unref()
  void relay.close().finally(() => process.exit(0))
})
