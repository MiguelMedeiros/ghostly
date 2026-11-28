import { countedLog, DEFAULT_LIMITS, limitVariable, listenProblem, readSettings, startRelay } from './relay.mjs'

// Configuration, all optional:
//   PORT (49490), HOST (0.0.0.0; 127.0.0.1 behind proxies or Cloudflare)
//   GHOSTLY_PKARR_UPSTREAMS  comma-separated upstream Pkarr relay URLs (empty: standalone local relay/cache)
//   GHOSTLY_RELAY_ORIGINS    allowed origins, comma-separated (empty: any)
//   GHOSTLY_RELAY_CLOUDFLARE "1" behind Cloudflare: count clients by CF-Connecting-IP (not with PROXIES)
//   GHOSTLY_RELAY_PROXIES    reverse proxies in front of it (0): count by X-Forwarded-For
//   GHOSTLY_RELAY_<LIMIT>    any limit in DEFAULT_LIMITS, e.g. GHOSTLY_RELAY_MAX_BATCH_KEYS=64

// A log that cannot be written (broken pipe, full disk) drops its lines rather than crashing the relay.
let logging = true
process.stdout.on('error', error => {
  if (!logging) return
  logging = false
  console.error(new Date().toISOString(), `Ghostly Pkarr relay log can't be written (${error.code ?? error.name}): its lines are dropped from now on`)
})
process.stderr.on('error', () => {})
const log = (...words) => { if (logging) console.log(new Date().toISOString(), ...words) }

let settings
try { settings = readSettings(process.env) } catch (error) {
  console.error(new Date().toISOString(), `Ghostly Pkarr relay not started: ${error.message}`)
  process.exit(1)
}

if (settings.ignored.length) {
  log(`${settings.ignored.join(', ')} ${settings.ignored.length === 1 ? 'is not a setting' : 'are not settings'} of this relay; ignored`)
}

const start = options => startRelay(options).catch(error => {
  const problem = listenProblem(error, settings)
  if (!problem) throw error
  console.error(new Date().toISOString(), `Ghostly Pkarr relay not started: ${problem}`)
  process.exit(1)
})

const relay = await start({
  ...settings,
  // Counts and reasons only: never a public key, an address, or payload bytes.
  log,
})

const mode = settings.upstreams.length
  ? `(proxy to ${settings.upstreams.length} ${settings.upstreams.length === 1 ? 'upstream' : 'upstreams'})`
  : '(standalone local relay)'
const counting = settings.cloudflare
  ? 'clients by CF-Connecting-IP'
  : settings.proxies
    ? `clients behind ${settings.proxies} ${settings.proxies === 1 ? 'proxy' : 'proxies'}`
    : 'clients by their own address'
const serves = settings.origins.length ? `origins ${settings.origins.join(' ')}` : 'any origin'
const changed = Object.entries(settings.limits)
  .filter(([name, value]) => value !== DEFAULT_LIMITS[name])
  .map(([name, value]) => `${limitVariable(name)}=${value}`)

log(
  `Ghostly Pkarr relay on port ${relay.port}`,
  mode,
  [`on ${settings.host}`, counting, ...(changed.length ? [`limits ${changed.join(' ')}`] : []), serves].join(', '),
)

const unhandled = countedLog(log, 'unhandled')
setInterval(unhandled.flush, 60_000).unref()
process.on('unhandledRejection', error => unhandled.count(error?.code ?? error?.name ?? 'error'))

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return
  closing = true
  const { subscribers } = relay.stats()
  log(`Ghostly Pkarr relay stopping (${subscribers} ${subscribers === 1 ? 'subscriber' : 'subscribers'})`)
  const stopped = () => {
    log('Ghostly Pkarr relay stopped')
    process.exit(0)
  }
  const timer = setTimeout(stopped, 3000)
  timer.unref()
  void relay.close().finally(() => { clearTimeout(timer); stopped() })
})
