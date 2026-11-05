# Ghostly HyperDHT relay

Browsers have no UDP, so they cannot run HyperDHT (WISP 103) themselves. This relay runs the UDP half for them
and talks to each browser over one WebSocket, with Holepunch's
[`@hyperswarm/dht-relay`](https://github.com/holepunchto/hyperswarm-dht-relay) protocol. The web app and the
extension use it when a relay is set in **Settings → Network → HyperDHT relay** (`packages/browser/src/platform/hyperdhtRelay.ts`).

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

0.4.3 is dht-relay's latest release (2023). `relay.mjs` fixes five bugs in it:

1. Relayed listening could not sign announcements on hyperdht 6.x.
2. One client closing an incoming stream with an error could stop the process.
3. The relay waited forever for a signature from a browser that had left, and leaked the server.
4. A dial to a key the relay had reached before hung. The handshake goes through several DHT nodes at once, each
   brings back a reply, and dht-relay passed every reply to the browser, whose handshake then stopped. Only the
   first reply goes on now.
5. Every server a client had closed stayed in memory until the client left. It is freed when it closes now.

## Limits (per relay, `DEFAULT_LIMITS` in relay.mjs)

| | default | env |
|---|---|---|
| WebSockets at once | 512 | `GHOSTLY_RELAY_CLIENTS` |
| from one address | 16 | `GHOSTLY_RELAY_CLIENTS_PER_ADDRESS` |
| largest message | 256 KiB | `GHOSTLY_RELAY_PAYLOAD_BYTES` |
| bytes a client sends per second, burst | 512 KiB/s, 4 MiB | `GHOSTLY_RELAY_BYTES_PER_SECOND`, `GHOSTLY_RELAY_BURST_BYTES` |
| keys one client listens on | 16 | `GHOSTLY_RELAY_LISTENS` |
| listens per client per minute, refused ones too (an app starts at most 8 on start or reconnect) | 60 | `GHOSTLY_RELAY_LISTENS_PER_MINUTE` |
| dials per client per minute | 60 | `GHOSTLY_RELAY_CONNECTS_PER_MINUTE` |
| HyperDHT streams one client holds open (its dials and incoming ones) | 64 | `GHOSTLY_RELAY_STREAMS` |
| bytes waiting for a client that it has not read yet | 8 MiB | `GHOSTLY_RELAY_QUEUED_BYTES` |
| bytes waiting unread over all clients (past it, the client holding the most is dropped) | 96 MiB | `GHOSTLY_RELAY_QUEUED_TOTAL_BYTES` |
| a client with no listen open and no dial | 30 s | `GHOSTLY_RELAY_IDLE_MS` |
| ping, dropped when the last went unanswered | every 30 s | `GHOSTLY_RELAY_PING_MS` |
| a connection's request before it upgrades | 15 s | `GHOSTLY_RELAY_REQUEST_MS` |
| a client's part of a handshake (its answer) | 15 s | `GHOSTLY_RELAY_HANDSHAKE_MS` |
| handshakes waiting on one client's answer at once (its dials and incoming ones; one key's incoming ones at most a quarter, and a quarter kept for its dials) | 64 | `GHOSTLY_RELAY_HANDSHAKES` |

Past a limit the client is dropped, or its socket is paused (the byte rate), or an incoming stream past
`streams` is closed, or a handshake past `handshakes` is refused (`refused handshake <why>` in the log). Topic lookups and announcements
are refused: Ghostly never makes them, and they would make the relay an open crawler.

Other settings:

- `GHOSTLY_RELAY_ORIGINS` lists the allowed origins, comma-separated, each as a browser sends it: scheme, host and a
  port only (`https://app.ghostly.tools`, `chrome-extension://<id>`). Case, a default port (`:443`) and a trailing `/`
  do not matter; an entry with a path, a query or no scheme stops the start. Left out, any origin may connect. A
  refused one gets 403, and the log says `refused origin "<origin>"` once an hour per origin, for at most 16 origins
  an hour. It keeps other websites from using the relay; it is no defence against other programs.
- `GHOSTLY_RELAY_CLOUDFLARE=1` counts each client by `CF-Connecting-IP`, behind Cloudflare (a tunnel).
- `GHOSTLY_RELAY_PROXIES` is the number of reverse proxies in front of it (`1` for one nginx): each client then
  counts by the `X-Forwarded-For` entry that many from the end, the ones before it being the client's to write.
  Without either, the headers are ignored, and the first request that carries one logs which setting is missing
  (`requests carry CF-Connecting-IP but GHOSTLY_RELAY_CLOUDFLARE is not set`). A client that reaches the port past the proxy could write them itself,
  so publish it only where the proxy is (`HYPERDHT_RELAY_BIND`, loopback by default).

A setting that is there but empty or not of its kind (`PORT=`, `GHOSTLY_RELAY_PROXIES=one`, a limit of `0`) stops the
start with one line that names it; leave a setting out for its default. The start line says how clients are counted,
each limit set away from its default, and which origins it serves (`any origin` when none is set).

## Running it

It needs Node 22 (the image's `node:22-bookworm-slim`).

```bash
npm ci && node server.mjs                        # public HyperDHT, port 49443
GHOSTLY_HYPERDHT_BOOTSTRAP=host:port node server.mjs   # another HyperDHT network, by its bootstrap nodes
GHOSTLY_HYPERDHT_TESTNET=3 node server.mjs       # a private 3-node network in the process, nobody else on it (tests, e2e/infra)
docker compose up -d --build                     # the container, limits and all (docker-compose.yml)
```

The start line names the network: `(public HyperDHT)`, `(bootstrap 2 nodes)` or `(own testnet of 3 nodes)`. A testnet
with `GHOSTLY_HYPERDHT_BOOTSTRAP` set too does not start: the testnet would leave the bootstrap nodes out.

`GHOSTLY_HYPERDHT_BOOTSTRAP` (`host:port` nodes, comma-separated) points it at bootstrap nodes of your own instead of
the public ones; an entry without a port or with a port outside 1 to 65535, or an empty value, stops the start. So does
a port another program holds or one below 1024 this user may not take (`PORT`), and a `HOST` that is no address of this
machine or no name at all: one line names the setting instead of a stack trace, and nothing is left running.

`docker-compose.yml` is set up for one server, "zero" behind the Cloudflare tunnel: it counts each client by
`CF-Connecting-IP` and lets in only Ghostly's own app and extension. Anywhere else, set two variables (in the shell or
an `.env` file next to it):

- `GHOSTLY_RELAY_CLOUDFLARE=0`, or every client could name its own address in that header; behind nginx or Caddy add
  `GHOSTLY_RELAY_PROXIES=1`;
- `GHOSTLY_RELAY_ORIGINS` with the origins of the web app you serve, or every browser on it is refused (403).

`GET /healthz` answers with the counts (clients, accepted, refused, dropped) and the HyperDHT node's state: `nodes`
in its routing table, `firewalled`, and `sinceAnswerMs` since another node last answered it (`null`: never). It is
`ok: false` with HTTP 503 while `nodes` is 0: the node reaches no other one (no outgoing UDP, as behind a tunnel, a
firewall or a container network without it), so nobody reaches the browsers listening through it. The start log
says `bootstrap reached no node` then. The log has counts and reasons only: never a key, an address or anyone's
traffic.

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
