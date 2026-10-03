# Transports

How Ghostly finds a contact and how a chat's bytes travel. The wire formats are in [PROTOCOL.md](PROTOCOL.md) and the WISPs linked below; this page is the map.

## Two layers

Every 1:1 chat has two layers ([WISP 400](wisps/400-chat.md), [WISP 100](wisps/100-transports.md)):

| Layer | What | Carries |
|---|---|---|
| 0: the DHT | Signed [Pkarr](https://github.com/pubky/pkarr) records on the Mainline DHT | Rendezvous, signaling, the capability record, and short text when nothing else connects ([DHT text](wisps/403-dht-text.md), 256 bytes) |
| 1: a stream | WebRTC, Iroh or HyperDHT | The chat session: text, files, payments, calls signaling, shared apps |

- The DHT is always there underneath. It is never "selected" and never fails a chat.
- A chat is `live` (a stream carries it), `on-dht` (no stream yet, retried in the background) or `dht-chosen` (either side picked **DHT only**).
- First contact runs on the DHT and on a stream at once. Whichever verifies first pins the contact's key.
- When a stream drops, unconfirmed text goes over the DHT under the same ids, and the stream is retried for as long as the app runs.
- Details of the DHT path: [DHT-DELIVERY.md](DHT-DELIVERY.md).

## Layer 1: streams

| Transport | Web app, extension | Desktop | Headless CLI | Spec |
|---|---|---|---|---|
| WebRTC (`webrtc/1`) | Direct (STUN, optional TURN) | macOS and Windows. Not on Linux: WebKitGTK has no WebRTC | `node-datachannel` (libdatachannel) | [WISP 101](wisps/101-webrtc.md) |
| Iroh (`iroh/1`) | Relayed only, Iroh 1.2 compiled to wasm | Native Iroh 1.2, direct or through its home relay | Relayed only, the same wasm build | [WISP 102](wisps/102-iroh.md) |
| HyperDHT (`hyperdht/1`) | Through a HyperDHT relay, **off by default** | Native, one Node sidecar per app | Native, in its own process | [WISP 103](wisps/103-hyperdht.md) |

Every transport runs the same authenticated chat session ([WISP 401](wisps/401-paired-chat.md)). A transport's own handshake (DTLS fingerprint, TLS exporter, Noise hash) is bound into the session, so the contact's pinned key is checked the same way on each.

### WebRTC

- One `RTCPeerConnection` per chat with the `ghostly/1` DataChannel. Its signals (`_rtc`) ride the chat's signed Pkarr record.
- STUN: Google's public servers (`packages/core/src/callSignal.ts`). A TURN server is optional: Settings, Advanced, Network.
- Calls always use a WebRTC connection of their own, whatever carries the chat ([WISP 601](wisps/601-webrtc-media.md#paired-profile)). The Linux Desktop, whose WebView has no WebRTC, runs that connection itself (WebRTC in Rust, media in GStreamer): the same calls on the same wire ([WISP 601](wisps/601-webrtc-media.md#desktop-on-linux)).

### Iroh

- **Desktop:** native Iroh (`native/transports/`, `apps/desktop/src/paired_transport.rs`) on n0's public relays.
- **Web and extension** ([#225](https://github.com/MiguelMedeiros/ghostly/pull/225)): the same Iroh 1.2 built for browsers (`native/transports/iroh-web`, shipped as `packages/iroh-web`). A page cannot send UDP, so every packet goes through an Iroh relay. The QUIC/TLS session is still end to end.
- Default Iroh relays (`DEFAULT_IROH_RELAYS` in `packages/browser/src/platform/irohWeb.ts`), editable in Settings, Advanced, Network (up to four):
  - `https://use1-1.relay.n0.iroh.link/`
  - `https://euc1-1.relay.n0.iroh.link/`
  - `https://aps1-1.relay.n0.iroh.link/`
  - `https://usw1-1.relay.n0.iroh.link/`
- Iroh compares relay URLs as text, and native Iroh names n0's relays with the trailing dot of a full domain name (`use1-1.relay.n0.iroh.link.`), which WebKit (Safari, the iPhone app) refuses to open. So a relay URL is put in one spelling before it goes into an endpoint (`irohRelayUrl` in `packages/core/src/pairedTransports.ts`): without the dot for the browser build, with it for the Desktop. `https://relay.example.com/` and `https://relay.example.com./` are then the same relay, in Settings and in a contact's record, and no browser is asked to open a dotted host.
- The wasm (about 1.1 MB gzipped) loads only when a chat first starts an endpoint.
- **Web to Desktop** ([#270](https://github.com/MiguelMedeiros/ghostly/pull/270)): a Desktop's Iroh learns its home relay a few seconds after it starts. The capability record is republished when that happens, so a browser can dial the Desktop through that relay. This is the path when WebRTC between a browser and a Desktop does not connect.
- The relay sees which endpoints talk, when and how much. It never sees frames.

### HyperDHT

- **Desktop** ([#187](https://github.com/MiguelMedeiros/ghostly/pull/187)): `hyperdht` 6.34 runs in a Node sidecar (`apps/desktop/native-runtime`, bundled with the app). One sidecar per app, started on first use, stopped with the last chat, and it exits with the app.
- **Web and extension** ([#231](https://github.com/MiguelMedeiros/ghostly/pull/231)): through a HyperDHT relay (Holepunch's `@hyperswarm/dht-relay`, fixed in `infra/services/hyperdht-relay`). Always non-custodial: the browser keeps its keys and runs the Noise handshake and the encrypted stream. The relay forwards ciphertext and sees the browser's address, the per-chat keys and timing.
- **Off by default:** `DEFAULT_HYPERDHT_RELAY` is empty and no public Ghostly relay is run. Set a `wss://` relay in Settings, Advanced, Network to turn it on.

### Choosing a transport

- **Automatic** (the default): both apps rank the transports they share. A relayed path ranks after every direct one. When WebRTC fails, the dialling side goes on to the next one (often a relayed Iroh) before the chat stays on the DHT.
- WebRTC that cannot connect on a network (a VPN, a firewall) does not hold the chat back: an answered offer with no connection after 6 s is raced by what ranks after it, relayed transports too (`RACE_ANSWERED_MS`), and a side that gathers no candidate dials its other transports itself and tries WebRTC last for 10 minutes (`RTC_UNSTARTED_MS`). See [WISP 100](wisps/100-transports.md#webrtc-that-cannot-connect-on-this-network).
- A transport or **DHT only** can be chosen per chat in the connection panel (the connection icon in the chat header). A choice made with no stream open travels in the capability record, so the contact dials it first.
- A native transport that fails three attempts in a row is tried last for an hour.
- Native listeners start one at a time per transport, the transports side by side (`nativeQueues` in `packages/browser/src/engine/node.ts`). HyperDHT with its DHT out of reach (UDP blocked, a VPN) takes about 6 s to start listening; in one shared queue each chat's Iroh listener waited that long per chat ahead of it.
- While live, the chat does not probe for a better transport. It changes when the current one drops or someone switches.

### When direct connections are blocked

A VPN, a firewall or a carrier's NAT can stop every direct path. The app cannot see a VPN; it sees its own WebRTC attempts fail, and says so in the chat's connection panel and in Settings, Advanced, Network: "Direct connections are blocked on this network (a VPN or firewall?). Chats still work through relays, but connect more slowly." It never says a VPN was found.

- **What counts** (`DataLink` reports per attempt, `DirectPathWatch` in `packages/core/src/directPath.ts` decides):
  - `no-public`: both descriptions were exchanged, nothing connected, and this device had no public candidate (no STUN server answered, or no candidate at all).
  - `symmetric`: nothing connected, and this device's public address had three or more ports on one address: a mapping per destination.
  - `no-path`: this device's offer was answered, it had public candidates, and nothing connected. The contact may be the blocked one.
- **The rule:** no WebRTC connection open now, none opened since, and either two attempts with this device's own evidence (`no-public`, `symmetric`) or failed attempts with three different contacts. One failed dial shows nothing.
- **It clears by itself:** when a WebRTC connection opens, when the network changes (the browser's `online` event), and when the evidence is older than 30 minutes.
- An offer nobody answered says nothing: the contact may be away. An answerer reports only its own evidence.
- The note is kept in memory. After a restart it comes back only when attempts fail again; a chat that resumes straight on a relayed transport makes no WebRTC attempt.
- Clients without WebRTC (Desktop on Linux, the headless CLI's UI-less daemon) show no note.

### When this device's clock is off

Ghostly dates what it publishes by the device's clock, and a clock a few minutes off makes chats slow to connect, or not connect at all with apps that have not been updated. The app cannot set the clock; it notices and says so, in the chat's connection panel and in Settings, Network: "This device's clock seems to be off by about 2 minutes. Chats may be slow to connect.", with which way, why it matters and what to do behind the ⓘ.

What it goes by (`ClockWatch` in `packages/core/src/clockWatch.ts`):

- **A relay's own time**: the `Date` header of a Pkarr relay's answer, where the app may read it. The CLI can; a browser only when the relay exposes that header to other origins. An answer a cache kept (it has an `Age`) is not a clock.
- **A contact's clock**: the time of a pinned contact's packet that came between two reads of its record at most 15 s apart, both answered by the network. Group edges do not count, and a contact counts once, by its participation key.

The Desktop's own Pkarr client passes on neither a relay's time nor whether a read was answered by the network, so the Desktop has no evidence yet and shows no note.

The rule is slow to say yes, and never goes by one contact, whose clock is as likely the one that is off: two relays that agree; or one relay and a contact, with no contact saying otherwise; or three contacts that agree, with at least three for each one that does not. A relay that says the clock is right outweighs any number of contacts. Under a minute off is not off. The note goes away by itself when the next answers agree with the clock, and the evidence is forgotten after half an hour.

## Layer 0: Pkarr and the Mainline DHT

A Pkarr record is a small DNS packet (at most 1,000 bytes), signed with Ed25519 and stored in the Mainline DHT (BEP 44). Ghostly publishes several kinds per chat: the link's presence and signals, the DHT mailboxes, the capability record and the hold pointer. See [PROTOCOL.md](PROTOCOL.md#records-on-the-dht).

### Who reads and writes where

| Client | Reads | Writes |
|---|---|---|
| Web app, extension | Through the Pkarr relays: a page cannot send UDP | Every relay. The publish returns on the first relay that took the packet ([#293](https://github.com/MiguelMedeiros/ghostly/pull/293)) |
| Desktop | The Mainline DHT directly ([#289](https://github.com/MiguelMedeiros/ghostly/pull/289)). Relay reads only with Settings, Advanced, Network, "Also use Pkarr relays", or while no DHT node answers at all (UDP blocked, a VPN): two lookups in a row that heard from nobody send reads to the relays until one hears from a node again (`DHT_SILENT_LOOKUPS` in `apps/desktop/src/pkarr_network.rs`) | The DHT and every relay |
| Headless CLI (`ghostly`) | The relays first, the Mainline DHT when every relay fails ([#392](https://github.com/MiguelMedeiros/ghostly/pull/392), `RelaysAndDht` in `packages/cli/src/runtime/mainline.ts`). `GHOSTLY_DHT=0` leaves the DHT out ([CLI.md](CLI.md#pkarr-relays-and-the-mainline-dht)) | The DHT and every relay |

- Native apps still write to the relays because a browser contact can only read relays, and a relay keeps serving the copy it holds. Measured on 2026-09-25: after a newer packet went to the DHT alone, `pkarr.pubky.org` still served the older one 30 s later, even with a record TTL of 1 s.
- A Desktop read of an unknown key waits for the lookup's first answer (about 0.7 s), not the whole lookup (about 3.4 s).
- Between two packets under one key the later one wins, but a packet dated more than 10 minutes ahead of this clock never wins over one dated now or before ([#472](https://github.com/MiguelMedeiros/ghostly/pull/472), `newerPacket` and `PKARR_FUTURE_SKEW_MS` in `packages/core/src/pkarr.ts`). The relay client of the web app, the extension and the headless CLI applies it, and the CLI when it weighs the DHT's answer against the relays'.

### Relay budget: a wait, not an error

- A browser allows itself 30 requests a minute per relay (reads and publishes together, shared by every chat; `REQUESTS_PER_MINUTE` in `packages/core/src/relay.ts`), and 60 on `pkarr.pubky.app`, which allows 1000 an address (`RELAY_REQUESTS_PER_MINUTE`). Background reads have a share of 20 on each.
- Who goes first when links want more than that ([#401](https://github.com/MiguelMedeiros/ghostly/pull/401), [#434](https://github.com/MiguelMedeiros/ghostly/pull/434)):
  - A 1:1 chat that polls fast (a signal from its contact due any moment), or whose request the budget refused, keeps the last 10 requests of each relay's minute for itself. Group requests stop at 20, until a minute after the chat last needed them, or until the chat reads its contact at a slow pace again (it is live): each chat's part of the reserve is its own. Kept for the minute, a daemon back after a restart with its chats live in 18 s held a group's edge that had just missed a read for 48 s more (bug hunt r6a, 2026-09-29).
  - A 1:1 chat's new WebRTC offer or answer, its fast reads for the answer to its own offer, and the reads of a DHT-only contact's mailbox once the contact shows it is leaving (a fresh link packet, or its offer), up to three while it still says DHT only (`signal` on the request, `LEAVING_SIGNAL_READS`), may go over a relay's minute by a fifth of it (`SIGNALING_ALLOWANCE_SHARE`: 6 on 30, 12 on 60, 1 on relay.pkarr.org's 5), and never beyond that in any minute; the reads leave the last of those to a write. A chat that left DHT only in the minute its pairing and texts over the DHT had spent held its offer or answer 40 s while the contact's attempt gave up: the matrix's extension chat stayed "On DHT · retrying live" in 46 of 120 runs (2026-09-30).
  - While any link polls fast, background reads (a community's lookups, slow mailbox checks) drop to 5 a relay per minute. A community door's reads of its knock bell do not: they stay within the background share of 20.
  - After a window that looked fast for a contact's offer, a link slows down step by step (4, 4, 8, 16 s on the relays), not straight to its background pace: an offer held back by the other side's budget can land just after the window.
  - A signal's fast window counts from when the signal went out, not from when it was made.
  - Groups' fast reads (their edges looking for a signal) take at most a quarter of a relay's minute in any 15 s (`GROUP_BURST_MS`), so they never spend it in a burst and have requests left when the answers come.
  - An offer to a saved contact (a chat, a group's edge) is looked at every 2 s for 10 s, then every 4 to 8 s for as long as the offer stands (90 s), not every 2 s for 45 s and then at the background pace (`OFFER_FAST_MS`, `OFFER_STEP_MAX` in `packages/core/src/link.ts`; on the DHT, where reads cost no relay budget, every 1.4 to 2.8 s). A contact that is there answers in seconds; one that still holds the session of an app that was killed answers only once that session goes (about 20 s with node-datachannel, 45 s where liveness finds out). A daemon back after a kill, with a chat and a private group's edge to each of two members, had its edges live again 75 to 110 s after the restart, on the default relays: its edges' fast reads spent the groups' share of the minute before the answers came (bug hunt r5a, 2026-09-29).
- A publish goes to every relay and counts once one took it, and a read goes to one relay with requests left, for each key the one after the relay that answered its last read (a relay that lacks a key's newest packet, say one that rate limited its publish, answers it at most once in a row), so the larger share is room for signaling once `pkarr.pubky.org`'s 30 are spent. A web pairing costs about ten requests a relay: with 30 on both, three pairings in a minute were the whole minute, and a fourth waited for it to free (2026-09-28).
- A read does not wait on a slow relay ([#1141](https://github.com/MiguelMedeiros/ghostly/pull/1141)): when the relay it asked has not answered within 1.5 s (`HEDGE_MS` in `packages/core/src/relay.ts`), it asks the next relay too, takes the first good answer and drops the other request. A relay that fails is replaced at once. Measured on 2026-10-03: a relay hands over a packet it holds in 0.25 s (0.7 s on a new connection) and fetches one it lacks from the DHT in about 2.7 s, while a key nobody published takes it 3 to 5 s to answer 404, every time. So a key whose last read found nothing waits 6 s before a hedge (`HEDGE_MISSING_MS`), and polling a key not published yet costs one request, not two. Reads used to ask the next relay only once the first failed, up to its 10 s timeout: one relay that hung (pkarr.pubky.org on 2026-10-03) made every read of a pairing that slow.
  - A hedge spends a second request, so it goes only to a relay whose minute has more left than what groups leave a chat (`CHAT_RESERVE`, or a third of a smaller budget), never for a background read, and goes through the budget like any read.
  - A relay that lost a hedge to one that answered with the packet, or that took more than 3 s to hand over a packet (`SLOW_MS`), goes after the others in every read for a minute (`SLOW_DEMOTE_MS`), unless it answers fast meanwhile, and counts as a failure for its breaker (below).
- Fewer requests for the same answer ([#427](https://github.com/MiguelMedeiros/ghostly/pull/427)): a read of a key the relays answered under 500 ms ago is answered from that answer (`FRESH_READ_MS`); a publish under the key clears it. The spare invite that replaces a taken one is warmed 30 s later (`SPARE_INVITE_WARM_AFTER_TAKE_MS` in `packages/browser/src/engine/node.ts`), not in the second a new chat signals on the same budget.
- A read this budget holds back answers the newer of the last packet read and the last one this client published under that key ([#501](https://github.com/MiguelMedeiros/ghostly/pull/501)): a community hub never takes its own beacon entry for an older one. A read that found a relay down answers only what it read, so an outage still shows as "Discovery unavailable" ([#538](https://github.com/MiguelMedeiros/ghostly/pull/538)).
- A request this budget holds back, or a relay's 429, is a **wait** ([#271](https://github.com/MiguelMedeiros/ghostly/pull/271)). `RelayTransport` throws a typed `DiscoveryBudgetError` with the time until a request frees, and every publisher retries then. It never counts as a failed attempt and the UI shows no error.

### Circuit breaker per relay

Every client keeps one per relay (`packages/core/src/relayBreaker.ts`, and the same rule in `apps/desktop/src/pkarr_network.rs`, [#289](https://github.com/MiguelMedeiros/ghostly/pull/289)):

- Three failures in a row (no answer, a server error, the relay's 429, or a slow answer: a hedge lost to a relay that answered with the packet, or a packet that took more than 3 s) trip it, and the log says why (`tripped (slow)`). A slow answer counts only while another relay can be asked: a slow answer beats none. A slow 404 never counts.
- The relay is then left alone for 1 minute, doubling on each trip up to 5 minutes. One probe goes out after the wait; an answer closes the breaker.
- While every relay is left alone for failing (none only for its rate limit), one of them, the one whose wait ends first, is asked anyway every 15 seconds: with nothing else to try, the long wait only delayed noticing that the relays answer again. A group's edge stayed down for minutes after the relays stopped answering HTTP 500 (2026-09-27). The Desktop does the same in Rust: its DHT covers reads, but with UDP blocked (a VPN) there was no way at all to publish for minutes after a restart, and a private group showed "0 of 7 reachable".
- Back online (the app's `online` event: another network, a VPN up or down), every breaker is forgotten and every relay is asked again at once (`wake({ network: true })`, `networkChanged` on the transport, `pkarr_network_changed` on the Desktop).
- A link whose connection details could not go out says why and when it tries again: "Retrying in N s", the soonest a relay is asked.
- A relay that answers again tells the links: each looks at once and publishes what it could not, instead of waiting for its own pace. A relay that answers a kind of request (a read, a write) is no longer kept out of the next one of that kind by an earlier network failure.
- 404, 409, 412 and 428 are normal answers and never count.
- A relay's answer is read only up to what a Pkarr packet can be: 1,072 bytes in the TypeScript client (`RELAY_PAYLOAD_MAX_BYTES` in `packages/core/src/pkarr.ts`: signature, timestamp and 1,000 bytes of DNS packet), 4 KiB in the Desktop's Rust client (`MAX_BODY`); anything longer is refused ([#299](https://github.com/MiguelMedeiros/ghostly/pull/299)).
- Reads rotate among healthy relays, the ones found slow in the last minute last. On a Desktop with relay reads on, reads go to the DHT while every relay is tripped.
- Trips are logged by relay and reason, never with a key.

### Discovery health in the connection panel

The connection panel's **Details** (`apps/ui/src/components/DiscoveryHealth.tsx`) shows:

- **Discovery:** the path the last read took: "DHT direct" or "Relay: <host>".
- **Relays:** each relay's state: ok, throttled until hh:mm, or failing until hh:mm.

## Pkarr relays

A Pkarr relay is an HTTP bridge to the Mainline DHT. It sees signed, encrypted packets, the public keys published or looked up, and the address that asks. It never carries messages, calls or services.

### The default list

`DEFAULT_RELAYS` in `packages/core/src/relay.ts`. Desktop gets the same list from Settings when it starts, so that is the only list to edit.

- `https://pkarr.pubky.org`
- `https://pkarr.pubky.app`

Checked on 2026-09-25 with throwaway keys, at most about ten requests per relay:

| Relay | Operator | Default | Notes |
|---|---|---|---|
| `https://pkarr.pubky.org` | Pubky (Synonym) | Yes | Writes through to the DHT. CORS allows `*` and `If-Match`. `x-ratelimit-limit: 50` a minute per address. Same IP as `pkarr.pubky.app` |
| `https://pkarr.pubky.app` | Pubky (Synonym) | Yes | Writes through to the DHT. CORS as above. `x-ratelimit-limit: 1000`. In the Rust pkarr crate's own defaults. The client gives it 60 requests a minute (`RELAY_REQUESTS_PER_MINUTE`) |
| `https://relay.pkarr.org` | pkarr.org | No | Writes through, CORS ok, enforces `If-Match` (412). Allows 10 requests a minute per address, too few for a default. On 2026-09-25 its PUTs stored the packet but did not answer within 20 s. Add it by hand for a relay run by someone other than Pubky; the client gives it 5 requests a minute (`RELAY_REQUESTS_PER_MINUTE`). On 2026-10-03 a read of a missing key got no answer in 15 s, then a 404 in 7.4 s; a web pairing costs about ten requests a relay, two minutes of its share |
| `https://dns.iroh.link/pkarr` | n0 (iroh) | No | Its own namespace: it does not read or write the DHT. Its CORS preflight does not allow `If-Match`, and it accepts stale sequence numbers |
| `https://staging-dns.iroh.link/pkarr` | n0 (iroh) | No | As above, and marked as a testing server |
| `pkarr-*.anytype.io/pkarr` | Anytype | No | Anytype's own infrastructure, not the DHT |

No broader list of public relays exists: the pkarr repository's `relays.txt` names the three `pkarr.*` relays above. Neither Pubky nor pkarr.org publishes terms for third-party use.

### What a default relay must do

1. Speak the relay protocol (`GET`/`PUT /<z-base-32 key>` with the 64-byte signature, 8-byte timestamp and DNS packet) and write through to the Mainline DHT. A relay with its own namespace splits browser contacts from native ones.
2. Answer a `PUT` within a few seconds. A relay that never answers still counts against its breaker.
3. Send CORS headers the web app and the extension accept, with `If-Match` among the allowed headers.
4. Reject stale sequence numbers (409).
5. Allow enough requests per address for several peers behind one IP, ideally stated in `x-ratelimit-limit`.
6. Be run by someone fine with third-party apps using it, independent of the relays already listed.

### Adding a relay

- **One profile:** Settings, Advanced, Network, Pkarr relays, one URL per line.
- **Everyone:** append the URL to `DEFAULT_RELAYS`, and put the old list into `PREVIOUS_DEFAULT_RELAYS` so profiles on the old defaults move with it. A relay that allows few requests gets a share in `RELAY_REQUESTS_PER_MINUTE`.
- **Private network or tests (Desktop):** `GHOSTLY_PKARR_RELAYS` (comma-separated URLs) alone replaces the DHT. With `GHOSTLY_PKARR_DHT_BOOTSTRAP` (`ip:port`, comma-separated), those relays are written to and the DHT is reached through those nodes.
- **Private network or tests (headless CLI):** `GHOSTLY_PKARR_RELAYS` (comma-separated URLs) as on the Desktop: the only relays from the first publish, the setting unused, and the Mainline DHT left out unless `GHOSTLY_DHT_BOOTSTRAP` is given. Otherwise `settings set relays '["http://…"]'` sets the relays, `GHOSTLY_DHT=0` leaves the Mainline DHT out, `GHOSTLY_DHT_BOOTSTRAP` (`host:port`, comma-separated) replaces its bootstrap routers, and `GHOSTLY_HYPERDHT_BOOTSTRAP` HyperDHT's ([CLI.md](CLI.md#pkarr-relays-and-the-mainline-dht)).

## What observers see

| Who | Sees | Never sees |
|---|---|---|
| Pkarr relays, DHT nodes | Public keys, signed encrypted packets, sizes, timing, the asking IP (relays) | Plaintext, link secrets |
| STUN, TURN | Addresses; TURN relays encrypted WebRTC packets | Plaintext |
| Iroh relay | Endpoint ids, IPs, timing, volume | Frames |
| HyperDHT relay | The browser's IP, per-chat transport keys, timing | Frames, secret keys |

None of this is anonymity. See the [security model](ARCHITECTURE.md#security-model).
