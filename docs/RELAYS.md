# Pkarr relays

Ghostly finds contacts through Pkarr records on the Mainline DHT (WISP 01). A Pkarr relay is an HTTP bridge to that DHT. It sees signed, encrypted packets, the public keys that are published or looked up, and the address that asks. It never carries messages, calls or services.

## Who uses them, and how

| Client | Reads | Writes |
|---|---|---|
| Web app, extension | Through the relays: a page cannot send UDP | To every relay |
| Desktop | On the DHT directly. Relay reads only with Settings, Network, "Also use Pkarr relays" | To the DHT and to every relay |
| CLI | On the DHT directly. Relay reads only with `--read-relays` | To the DHT and to pkarr's default relays |

Native clients still write to the relays because a browser contact can only read relays, and a relay keeps serving the copy it holds. Measured on 2026-09-25: after a newer packet went to the DHT alone, `pkarr.pubky.org` still served the older one 30 s later, even with a record TTL of 1 s. `pkarr.pubky.app` refreshed with a TTL of 1 s and not with 300 s.

## The list

The defaults are `DEFAULT_RELAYS` in `packages/core/src/relay.ts`. The Desktop gets them from Settings as it starts, so that list is the only one to edit. Everything below was checked on 2026-09-25 with throwaway keys, at most about ten requests per relay.

| Relay | Operator | In the defaults | Notes |
|---|---|---|---|
| `https://pkarr.pubky.org` | Pubky (Synonym) | Yes | Writes through to the DHT. CORS allows `*` and `If-Match`. `x-ratelimit-limit: 50` a minute per address. Same IP as `pkarr.pubky.app`. |
| `https://pkarr.pubky.app` | Pubky (Synonym) | Yes | Writes through to the DHT. CORS as above. `x-ratelimit-limit: 1000`. In the Rust pkarr crate's own defaults. |
| `https://relay.pkarr.org` | pkarr.org | No | Writes through to the DHT, CORS allows both origins and `If-Match`, and it enforces `If-Match` (412). It allows 10 requests a minute per address, too few for a default, and on 2026-09-25 its PUTs stored the packet but did not answer within 20 s (a browser publish no longer waits for that, since it returns on the first relay that took the packet). Add it by hand for a relay run by someone other than Pubky; the client gives it 5 requests a minute (`RELAY_REQUESTS_PER_MINUTE`). |
| `https://dns.iroh.link/pkarr` | n0 (iroh) | No | A separate namespace: it does not read or write the DHT (iroh's own code says so), so a Desktop reading the DHT never sees what is put there. Its CORS preflight does not allow `If-Match`, and it accepts stale sequence numbers without an error. n0 rate-limits its public servers and guarantees no uptime. |
| `https://staging-dns.iroh.link/pkarr` | n0 (iroh) | No | As above, and marked as a testing server. |
| `pkarr-*.anytype.io/pkarr` | Anytype | No | Anytype's own infrastructure, not the DHT. |

No broader list of public relays exists: the pkarr repository's `relays.txt` names the three `pkarr.*` relays above. Neither Pubky nor pkarr.org publishes terms for third-party use; being listed in the pkarr crate and `relays.txt` is the only sign that public use is intended.

## What a default relay must do

1. Speak the relay protocol (`GET`/`PUT /<z-base-32 key>`, the 64-byte signature, 8-byte timestamp and DNS packet payload), and write what it gets through to the Mainline DHT. A relay with its own namespace splits browser contacts from native ones.
2. Answer a `PUT` in a few seconds. A publish returns on the first relay that took the packet, but a relay that never answers still counts against its breaker.
3. Send CORS headers a browser and the extension accept: `Access-Control-Allow-Origin`, and `If-Match` among the allowed headers.
4. Reject stale sequence numbers (409), so write conflicts show up.
5. Allow enough requests per address for several peers behind one IP. Say it in `x-ratelimit-limit` if possible.
6. Be run by someone who is fine with third-party apps using it, and be independent of the relays already listed.

## Adding a relay

- For one profile: Settings, Network, Pkarr relays, one URL per line.
- For everyone: append the URL to `DEFAULT_RELAYS` in `packages/core/src/relay.ts`, and put the list as it was into `PREVIOUS_DEFAULT_RELAYS`, so profiles that still hold the old defaults move to the new ones. If the relay allows few requests, give it a share in `RELAY_REQUESTS_PER_MINUTE`.
- For a private network or the tests: `GHOSTLY_PKARR_RELAYS` (comma-separated URLs) on the Desktop. Alone, it replaces the DHT. With `GHOSTLY_PKARR_DHT_BOOTSTRAP` (`ip:port`, comma-separated), those relays are written to and the DHT is reached through those nodes.

## When a relay fails

Every client keeps a circuit breaker per relay (`packages/core/src/relayBreaker.ts`, and the same rule in `src-tauri/src/pkarr_network.rs`). After three failures in a row (no answer, a server error, or its rate limit, 429) the relay is left alone for a minute. Each time it trips again the wait doubles, up to five minutes. When the wait is over, one request probes it, and an answer closes the breaker. Meanwhile reads rotate among the other relays; on the Desktop with relay reads on, they go to the DHT while every relay is left alone. Answers the protocol expects (404, 409, 412, 428) never count as failures. Each trip is logged with the relay and the reason, never a key. The connection panel's Details show the path discovery took (DHT direct, or the relay that answered last) and each relay's state.
