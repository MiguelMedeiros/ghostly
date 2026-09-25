# Ghostly HyperDHT relay

Browsers have no UDP, so they cannot run HyperDHT (WISP 103) themselves. This relay runs the UDP half for them
and talks to each browser over one WebSocket, with Holepunch's
[`@hyperswarm/dht-relay`](https://github.com/holepunchto/hyperswarm-dht-relay) protocol. The web app and the
extension use it when a relay is set in **Settings, Network** (`packages/browser/src/platform/hyperdhtRelay.ts`).

## What it sees, and what it doesn't

The browser uses the **non-custodial** mode:

- it keeps its keys;
- it runs the Noise handshake and the encrypted stream itself;
- it signs its own announcements.

The relay forwards handshake messages and ciphertext. It sees:

- the browser's address;
- the per-chat HyperDHT keys it listens on and dials;
- when and how much it sends.

It never sees a message, a secret key or the handshake hash that Ghostly's session binding is made of. Details
are in WISP 103, "Browser profile".

## Fixes over dht-relay 0.4.3

0.4.3 is dht-relay's latest release (2023). `relay.mjs` fixes three bugs in it:

1. Relayed listening could not sign announcements on hyperdht 6.x.
2. One client closing an incoming stream with an error could stop the process.
3. The relay waited forever for a signature from a browser that had left, and leaked the server.

## Limits (per relay, `DEFAULT_LIMITS` in relay.mjs)

| | default | env |
|---|---|---|
| WebSockets at once | 512 | `GHOSTLY_RELAY_CLIENTS` |
| from one address | 16 | `GHOSTLY_RELAY_CLIENTS_PER_ADDRESS` |
| largest message | 256 KiB | `GHOSTLY_RELAY_PAYLOAD_BYTES` |
| bytes a client sends per second, burst | 512 KiB/s, 4 MiB | `GHOSTLY_RELAY_BYTES_PER_SECOND`, `GHOSTLY_RELAY_BURST_BYTES` |
| keys one client listens on | 16 | `GHOSTLY_RELAY_LISTENS` |
| dials per client per minute | 60 | `GHOSTLY_RELAY_CONNECTS_PER_MINUTE` |

Past a limit the client is dropped, or its socket is paused (the byte rate). Topic lookups and announcements
are refused: Ghostly never makes them, and they would make the relay an open crawler.

Other settings:

- `GHOSTLY_RELAY_ORIGINS` lists the allowed `Origin` values. It keeps other websites from using the relay; it is
  no defence against other programs.
- `GHOSTLY_RELAY_TRUST_PROXY=1` counts addresses from `CF-Connecting-IP` behind a tunnel.

## Running it

```bash
npm ci && node server.mjs                        # public HyperDHT, port 49443
GHOSTLY_HYPERDHT_TESTNET=3 node server.mjs       # its own HyperDHT network (tests, e2e/infra)
docker compose up -d --build                     # the container, limits and all (docker-compose.yml)
```

`GET /healthz` answers with the counts (clients, accepted, refused, dropped). The log has counts and reasons
only: never a key, an address or anyone's traffic.

## Cost, measured

The Docker image is 410 MB (Debian slim, for the glibc prebuilds of `udx-native` and `sodium-native`).

| | memory |
|---|---|
| idle | 46 MB |
| 100 browsers listening | 100 MB |
| after 50 streams pushed 50 MiB through it in 2.2 s | 182 MB |

The proposed container is capped at 0.5 CPU and 512 MB. The running cost is bandwidth: every byte of a
relayed chat crosses the relay twice (in and out).

## Deploying (proposal, not done)

Nobody runs a public dht-relay for Ghostly.

- **Proposal:** this container on "zero" behind the Cloudflare tunnel, as `wss://hyperdht-relay.ghostly.tools`
  (`HYPERDHT_RELAY_BIND=<LAN address>:49443`).
- **Origins:** the app's origin and the extension's.
- **App default:** it stays off (`DEFAULT_HYPERDHT_RELAY` in `packages/browser/src/shared/hyperdhtRelay.ts`)
  until the relay runs.
