# Pkarr relay proxy (batch + push)

A self-hostable Node.js proxy for Pkarr relays that preserves standard single-key `GET /:z32` and `PUT /:z32` compatibility while adding:

- **Batch GET** (`POST /batch` and `GET /batch?keys=...`) to resolve up to 64 z-base32 public keys in one HTTP call.
- **Batch PUT** (`PUT /batch`) to publish multiple verified signed Pkarr packets in one HTTP call.
- **Push subscriptions** over WebSocket (`GET /subscribe` with `Upgrade: websocket`) and Server-Sent Events (`GET /subscribe?keys=...`) so clients receive updates immediately without polling.
- **Strict verification and abuse controls**: every packet is verified for canonical 52-character z-base32 key encoding, BEP44 size (84 to 1,072 bytes), Ed25519 signature, and monotonic timestamp before caching, forwarding, or fanning out.

The relay holds no user accounts, no private keys, and never decrypts DNS TXT payloads. Logs contain counts and refusal reasons only, never public keys, IP addresses, or packet bytes.

## Quick start

Requires Node.js 20 or later (the Docker image runs Node 22 LTS).

```bash
# Standalone local relay (in-memory LRU cache + push fan-out)
npm ci --omit=dev
node server.mjs

# Proxy in front of one or more upstream Pkarr relays
GHOSTLY_PKARR_UPSTREAMS=https://relay-a.example,https://relay-b.example node server.mjs

# Health check
curl -s http://127.0.0.1:49490/healthz
```

### Docker Compose

```bash
GHOSTLY_PKARR_UPSTREAMS=https://relay-a.example \
GHOSTLY_RELAY_ORIGINS=https://app.example \
docker compose up -d --build
```

The compose file binds to `127.0.0.1:49490` by default (override with `PKARR_RELAY_BIND`), runs as a non-root user on a read-only root filesystem, drops new privileges, and bounds CPU, memory, and PIDs. Put it behind HTTPS (nginx, Caddy, or a tunnel).

## Endpoints and wire schemas

All responses include `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. Browser CORS is enabled (restricted to `GHOSTLY_RELAY_ORIGINS` when configured) and exposes `Date`, `Retry-After`, and `X-Pkarr-Invalid-Packet-Seq`.

### `GET /healthz` and `HEAD /healthz`

Returns `200` while running and `503` while shutting down. Does not expose live connection or user counts.

```json
{
  "ok": true,
  "capabilities": {
    "batchGet": true,
    "batchPut": true,
    "pushWs": true,
    "pushSse": true,
    "maxBatchKeys": 64,
    "maxSubscribeKeys": 256
  }
}
```

### Single-key pass-through: `GET /:z32` and `PUT /:z32`

Compatible with standard Pkarr relays:

- `GET /:z32` (optional `?policy=NetworkOnly` to bypass the local cache): returns `200 application/octet-stream` with raw signed Pkarr bytes (`<64B signature><8B big-endian timestamp><DNS packet>`), `404` when absent, `400` for an invalid z32 key, `502`/`503` when all upstreams fail or have open circuit breakers.
- `PUT /:z32`: accepts raw signed Pkarr bytes (84 to 1,072 bytes). Validates key, size, Ed25519 signature, and monotonic timestamp (using a 10-minute future skew cap). Returns `204` on success, `400`/`413` on invalid or oversize input, `409` on stale timestamp, `502`/`503` on upstream failure. Newer packets are cached and fanned out immediately to active push subscribers.

### Batch GET: `POST /batch` and `GET /batch?keys=...`

Resolves 1 to `maxBatchKeys` (default 64) canonical 52-character z-base32 public keys in one call using the local LRU cache plus bounded concurrent upstream lookups.

- `POST /batch` request body:
  ```json
  {
    "keys": ["<z32-key-1>", "<z32-key-2>"],
    "policy": "CacheFirst"
  }
  ```
  (`policy` is optional; set `"NetworkOnly"` to bypass the local cache.)
- `GET /batch?keys=<z32-key-1>,<z32-key-2>` (optional `&policy=NetworkOnly`).
- Response (`200 application/json`, bounded by `4096 + 2048 * keyCount` bytes):
  ```json
  {
    "packets": {
      "<z32-key-1>": "<standard base64 raw Pkarr bytes>",
      "<z32-key-2>": null
    }
  }
  ```
  Missing keys (or individual corrupt upstream packets that fail signature verification) are returned as `null`. If every requested key fails due to upstream outage or open circuit breakers, the endpoint returns `502` or `503`.

### Batch PUT: `PUT /batch`

Publishes 1 to `maxBatchKeys` (default 64) signed Pkarr packets in one call. Each entry is validated independently (canonical z32 key, base64/base64url bytes, size, Ed25519 signature, monotonic timestamp) before forwarding upstream, caching, and fanning out to subscribers. Invalid items never affect valid siblings.

- Request body (`application/json`, max 128 KiB by default):
  ```json
  {
    "packets": {
      "<z32-key-1>": "<base64 or base64url raw Pkarr bytes>"
    }
  }
  ```
- Response (`200 application/json`):
  ```json
  {
    "results": {
      "<z32-key-1>": { "status": "ok", "seq": "1732800000000000" },
      "<z32-key-2>": { "status": "stale" },
      "<z32-key-3>": { "status": "invalid_signature", "error": "Invalid signature" }
    }
  }
  ```

### WebSocket Push: `GET /subscribe` (`Upgrade: websocket`)

Accepts optional initial keys via `?keys=<z32>,<z32>` (and `?initial=0` to suppress immediate cached snapshots).

Client messages (JSON text frames):

- Subscribe: `{"op":"subscribe","keys":["<z32>",...],"initial":true}` -> replies `{"op":"subscribed","keys":[...],"count":N}` and sends cached snapshots for newly subscribed keys unless `initial` is `false`.
- Unsubscribe: `{"op":"unsubscribe","keys":["<z32>",...]}` -> replies `{"op":"unsubscribed","keys":[...],"count":N}`.
- Ping: `{"op":"ping"}` -> replies `{"op":"pong"}`.

Server push events (sent only to clients subscribed to that exact key):

```json
{"op":"update","key":"<z32>","seq":"1732800000000000","packet":"<base64>"}
```

Server errors: `{"op":"error","code":"...","error":"..."}`. On graceful shutdown, all WebSockets close with code `1001` (`The relay is stopping`).

### SSE Push: `GET /subscribe?keys=<z32>,<z32>`

Streams Server-Sent Events (`text/event-stream`) with `X-Accel-Buffering: no`. Add `&initial=0` to skip immediate cached snapshots.

- Initial acknowledgement:
  ```text
  event: subscribed
  data: {"keys":["<z32>"],"count":1}
  ```
- Packet update:
  ```text
  event: update
  id: 1732800000000000
  data: {"key":"<z32>","seq":"1732800000000000","packet":"<base64>"}
  ```
- Periodic keepalive comment: `: ping`

## Configuration

All environment variables are optional. Invalid or empty numeric/flag/URL settings stop startup with a single error line naming the variable. Misspelled `GHOSTLY_RELAY_*` or `GHOSTLY_PKARR_*` variables are logged at startup with suggestions.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `49490` | Listening TCP port (`1` to `65535`). |
| `HOST` | `0.0.0.0` (`127.0.0.1` behind proxy/Cloudflare) | Bind address. Defaults to loopback when `GHOSTLY_RELAY_PROXIES` or `GHOSTLY_RELAY_CLOUDFLARE` is set. |
| `GHOSTLY_PKARR_UPSTREAMS` | empty (standalone) | Comma-separated upstream HTTP/HTTPS Pkarr relay URLs. |
| `GHOSTLY_RELAY_ORIGINS` | empty (any origin) | Comma-separated allowed browser origins (`scheme://host[:port]`). |
| `GHOSTLY_RELAY_PROXIES` | `0` | Number of trusted reverse proxies writing `X-Forwarded-For`. Cannot be combined with `GHOSTLY_RELAY_CLOUDFLARE=1`. |
| `GHOSTLY_RELAY_CLOUDFLARE` | `0` | Set `1` behind Cloudflare to count clients by `CF-Connecting-IP`. Cannot be combined with `GHOSTLY_RELAY_PROXIES`. |

### Limits (`GHOSTLY_RELAY_<LIMIT>`)

Every limit in `DEFAULT_LIMITS` can be overridden with `GHOSTLY_RELAY_<SCREAMING_SNAKE_CASE>`:

| Variable | Default | Purpose |
|---|---|---|
| `GHOSTLY_RELAY_MAX_BATCH_KEYS` | `64` | Max keys per Batch GET or Batch PUT. |
| `GHOSTLY_RELAY_MAX_BATCH_BODY_BYTES` | `131072` (128 KiB) | Max HTTP body bytes for batch requests. |
| `GHOSTLY_RELAY_REQUESTS_PER_MINUTE` | `120` | Max HTTP requests per minute per IP (IPv6 counted by `/64`). |
| `GHOSTLY_RELAY_CONNECTS_PER_MINUTE_PER_IP` | `30` | Max WS/SSE subscribe opens per minute per IP. |
| `GHOSTLY_RELAY_MAX_CONNECTIONS` | `1024` | Max concurrent push connections (WS + SSE) globally. |
| `GHOSTLY_RELAY_MAX_CONNECTIONS_PER_IP` | `16` | Max concurrent push connections per IP. |
| `GHOSTLY_RELAY_MAX_KEYS_PER_CONNECTION` | `256` | Max subscribed keys per connection. |
| `GHOSTLY_RELAY_MAX_KEYS_PER_IP` | `512` | Max subscribed keys across all connections from one IP. |
| `GHOSTLY_RELAY_BYTES_PER_SECOND_PER_IP` | `131072` (128 KiB/s) | Sustained byte budget shared across all requests and sockets of one IP (persists across reconnects). |
| `GHOSTLY_RELAY_BURST_BYTES_PER_IP` | `262144` (256 KiB) | Burst byte budget shared per IP (never reset on reconnect). |
| `GHOSTLY_RELAY_MAX_CACHE_ENTRIES` | `10000` | Max cached packets held in LRU memory. |
| `GHOSTLY_RELAY_CACHE_TTL_MS` | `300000` (5 min) | Cache TTL before refreshing from upstream. |
| `GHOSTLY_RELAY_TRACKED_IPS` | `10000` | Max IPs kept in rate and byte-budget tables. |
| `GHOSTLY_RELAY_REQUEST_MS` | `15000` | HTTP header/body read timeout. |
| `GHOSTLY_RELAY_PING_MS` | `30000` | WS ping and SSE keepalive interval. |
| `GHOSTLY_RELAY_WS_MAX_PAYLOAD_BYTES` | `32768` (32 KiB) | Max incoming WebSocket frame size. |
| `GHOSTLY_RELAY_WS_QUEUED_BYTES` | `262144` (256 KiB) | Max buffered outbound bytes per subscriber before dropping slow consumers. |
| `GHOSTLY_RELAY_UPSTREAM_TIMEOUT_MS` | `5000` | Timeout per upstream HTTP call. |
| `GHOSTLY_RELAY_UPSTREAM_CONCURRENCY` | `8` | Max concurrent in-flight upstream requests. |
| `GHOSTLY_RELAY_UPSTREAM_BREAKER_THRESHOLD` | `5` | Consecutive upstream failures to open circuit breaker. |
| `GHOSTLY_RELAY_UPSTREAM_BREAKER_COOLDOWN_MS` | `30000` | Circuit breaker cooldown before half-open probe. |
| `GHOSTLY_RELAY_UPSTREAM_REFRESH_MS` | `30000` | Background upstream refresh interval for subscribed keys (`0` disables). |

## Abuse protection notes

- IPv4 addresses are counted individually (including IPv4-mapped IPv6 forms like `::ffff:192.0.2.1`), and IPv6 addresses are grouped by `/64`.
- Per-IP byte and message budgets are shared across all concurrent connections from the same address and persist across disconnects/reconnects so reconnect loops cannot mint fresh bursts. Every HTTP request and WebSocket frame incurs a minimum 64-byte charge.
- When rate tables reach `trackedIps`, idle and under-limit entries are evicted first so newcomers cannot reset an at-limit address.
- All rate windows, cache TTLs, and circuit-breaker cooldowns read a monotonic clock (`performance.now()`), remaining unaffected by NTP clock steps.
