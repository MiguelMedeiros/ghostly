# WISP 100: Transport Negotiation

| Field | Value |
|---|---|
| Candidate number | 100; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.7 |
| Updated | 2026-09-27 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [03](03-capabilities.md), [403](403-dht-text.md) |
| Implementation | Experimental: rank-sum negotiation, the DHT floor, background retry and upgrade in every new chat; relayed transports; a choice made while not live travels in the capability record |
| Summary | Pick a data path both peers support, in order of preference; fall back only when both allow it. |
| Availability | Available |
| Feature | [The connection comes alive](https://ghostly.tools/#alive) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## The DHT floor, upgrade and downgrade (revision 0.2)

Every 1:1 chat of [400](400-chat.md) has two layers. Layer 0 is the DHT: the rendezvous, and the floor that carries short text ([403](403-dht-text.md)) when nothing else connects. Layer 1 is the transport this document selects: WebRTC ([101](101-webrtc.md)), Iroh ([102](102-iroh.md)) or HyperDHT ([103](103-hyperdht.md)).

**The DHT is not a candidate.** It is never in a `pair-offer`'s `transports`, never in the rank sum, and never "selected". It is always there underneath. An empty intersection, or every candidate failing, does not fail the chat: it leaves it `on-dht` ([400](400-chat.md#states-of-a-chat)). The explicit no-common-transport result of the candidate negotiation below is reported as the reason (`no-common-transport`), not as an error.

### Inputs

Each side's candidates come from its layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)) before any stream exists, and from the transcript-bound `pair-offer` once a session is ready ([401](401-paired-chat.md)). The record carries, per native transport, a minimal descriptor that is enough to dial: the Iroh endpoint id, the HyperDHT public key. Before revision 0.2, native descriptors were exchanged only inside an authenticated WebRTC session, so two desktops whose WebRTC never connected never tried Iroh or HyperDHT. With descriptors on layer 0 they do: two Linux Desktops with no WebRTC go live on Iroh or HyperDHT from each other's record (end-to-end tested).

### Upgrade

Once the contact is pinned, and unless either side is `dht-chosen`:

1. The dialling side (the lower rendezvous key, as today) ranks the intersection of both sides' transports by the implemented rank sum ([TRANSPORT-INCREMENT](TRANSPORT-INCREMENT.md#agreement-and-fallback)).
2. It tries them in that order, each within its own bounded attempt (WebRTC 15 s for a first pairing and 90 s later, as the pairing-latency work sets; Iroh and HyperDHT their dial timeouts). A WebRTC offer with no answer does not hold back what ranks after it for all of its attempt ([An unanswered offer](#an-unanswered-offer-revision-07)). The first transport whose session authenticates ([401](401-paired-chat.md)) is used. With **Allow fallback** off, only the preferred transport is tried, as today, and the chat stays `on-dht` when it does not connect.
3. The chat moves to `live` on that transport, and the outbox flushes in order.

### Downgrade

Layer 1 is lost when its channel closes, when its runtime goes away (the native bridge exits, the browser suspends the page), or when liveness gives up (three pings in a row unanswered, [401](401-paired-chat.md#liveness-and-reconnection)). The chat then:

1. moves to `on-dht` at once, which the header's connection icon shows; the timeline gets a row only if the outage outlasts a short drop ([400](400-chat.md#transport-rows));
2. marks every unconfirmed layer-1 text `queued`, and sends the ones that fit over the DHT under the same ids ([403](403-dht-text.md#when-text-goes-over-the-dht));
3. keeps files, payment requests and long texts waiting, or holds them ([4xx](4xx-store-and-forward.md)) where both sides allow it;
4. speeds its DHT mailbox reads back up ([403](403-dht-text.md#poll-pace)) and starts the background retry below.

A security rejection is not a downgrade: it stops the chat on both layers ([400](400-chat.md#candidate-requirements-for-the-one-chat)).

### Background retry and upgrade

Layer 1 is retried for as long as the app runs and the chat is not `dht-chosen`. There is no give-up timer (Q3 of [400](400-chat.md#compatibility-security-and-decisions)). The pace is today's, made the rule:

| Trigger | What happens |
|---|---|
| The contact is seen (a fresh presence packet under 30 s old) after being away, or a link that worked has just dropped | Dial at once |
| An attempt failed while the contact is online | Wait 20 s, doubling to at most 3 min, then the next attempt over the full ranked list |
| The person opens the chat, or brings the app to the front | Look for the contact at once and restart the wait; the non-dialling side republishes its presence |
| The network changes (online event, a new interface) | Restart the wait |
| The contact is not seen | Do not dial; keep reading its presence at the background pace |
| Both sides leave DHT only | Dial or answer at once, replaying a held offer ([403](403-dht-text.md#choosing-dht-only)) |

A transport that fails three attempts in a row while the contact is online MUST be moved to the end of this side's local order for an hour, so a path that is always blocked (a firewall eating UDP) does not delay the others at every retry. Its place is restored when it succeeds or the hour passes.

While `live`, the chat does not probe for a higher-ranked transport by itself; it changes only when the current one drops or someone switches ([transport switch](TRANSPORT-INCREMENT.md#agreement-and-fallback)). Probing while live was considered and decided against (below).

**After a drop, both sides end on the same transport, whichever side dials.** A standing explicit choice is one made in the Connection menu and carried as a switch intent (the higher intent wins; on a tie, the lower rendezvous key). The redial tries that choice's transport first, then the rest by rank sum. With both sides on Automatic, the rank sum alone decides, and it is symmetric. When the new session is ready, both sides agree again from their current policies, as for any fresh session. A switch still in flight when the link dropped, or one that was kept on a fallback transport, does not carry over. If the session is not on the agreed transport, the coordinator moves it once, and the timeline shows one line for coming back. This is not probing: it applies choices already made, at the moment the chat changes transport anyway. With no explicit choice on either side, nothing moves.

### Back after a restart (revision 0.6)

An app that quits or crashes with the chat live leaves its contact holding a session that is dead. Before revision 0.6 the contact noticed only when its liveness gave up or the transport timed out (30 s for Iroh), refused the restarted app's dial meanwhile, and the dial's wait (20 s, then 40 s) made the way back a minute or more. Now:

1. **Goodbye.** An app going away sends `paired-bye` on every live session first ([401](401-paired-chat.md#liveness-and-reconnection)); a Desktop whose quit cannot wait (macOS ends the process) closes its native connections instead, which its contacts see at once. The contact ends the session and **watches**: its signaling pace for 30 s, then the active pace, for 2 minutes in all. The dialling side dials once a packet newer than the one the contact left behind shows it back.
2. **A dial in takes over a held session.** A connection dialled in from the pinned contact while a session is held is the contact with no session of its own: it authenticates first, then replaces the held one. One that does not authenticate is closed and changes nothing. Before the pin, a held session keeps the chat.
3. **Resume.** A chat that was live when the app last ran (its connection history ends on a live stretch) dials that transport first, once, by **either** side, whichever key it has: the contact may still hold the old session and would not dial. A native one is dialled as soon as its endpoint starts, and a resume dial that does not connect is not counted as a failure (the contact may be away). A WebRTC offer reaches the contact's held session as "the contact lost the connection", which it answers ([101](101-webrtc.md)); two offers crossing keep the lower key's.
4. **Crossed dials.** When both sides dial at once, the lower rendezvous key's connection carries the chat on both sides. The lower key's side keeps the contact's connection waiting until its own connects (then drops it), fails, or 3 seconds pass (then takes it).
5. **After any drop,** the contact is watched the same way, and the first new packet from it ends the wait failed attempts built up, once per drop. A WebRTC connection gone `disconnected` (the contact's app may have crashed) reads the contact's packet at once rather than at the minute pace of a live chat, so a restarted contact's offer is answered then.

Measured in process (two links, relay pace, chat in the background), from the restart to live on both sides: Iroh 28-61 s before, under 1 s after (2 s when the quit only closed its connections); WebRTC 16-18 s before, 2-5 s after, a crash included. Discovery stays at 3-7 requests a minute. Two browser pages (e2e): a reload about 3 s before and after (the browser closes the connection itself); a crashed tab 18-19 s before, about 3 s after.

### An unanswered offer (revision 0.7)

A WebRTC offer needs the contact to read it and publish an answer, both through the relays. The contact may not read it for a while (a live chat reads every minute, one in the background every 30 s), and the relays' request budget (30 requests a minute per relay, for every chat of the app) may hold its answer back. Found in the headless CLI after a restart: the contact's answer was held back until its answering connection gave up (ICE, 31 s), nothing else answered, and the offer ran to its 90 s attempt timeout before the HyperDHT ranked after it was dialled. That dial connected in 0.1 s. Now:

1. **Dialled meanwhile.** When the dialling side's offer has no answer after **8 s**, the direct transports ranked after WebRTC are dialled while the offer stands. Relayed ones wait **40 s**, once a contact reading in the background has had its look: a chat that goes live over a relay stays there (no probing, above), where the answer would have made it direct.
2. **First live wins.** A native session that authenticates ends the WebRTC attempt still under way, on both sides (the offer, or an answer the budget still holds), and clears its signal. An offer answered first carries the chat, and the native connection is closed.
3. **Once per attempt.** Each transport is dialled once per attempt: the offer that times out later goes on to what was not dialled yet, never to these again, so the failures that demote a transport (above) count as before.
4. **No request.** A native dial asks nothing of the relays. Ending the offer sooner also ends its fast reads sooner.

An offer that has been answered is left alone: ICE is under way, and WebRTC settles as before ([Relayed transports](#relayed-transports-revision-03)).

Measured in process (the CLI's case: WebRTC then HyperDHT, the staying side's publishes held back for 45 s, its answer given up after 31 s), from the restart to live on both sides: 90.7 s before (48.4 s when the staying side had the lower key and offered once the budget freed), 8.7-9.0 s after, over HyperDHT; the busier app's requests went from 19.5 to 6.5 a minute. With Iroh through its relay in place of HyperDHT: 90.7 s before, 40.6 s after, 19.5 to 15.5 requests a minute.

### Why a chat is not live (revision 0.5)

The background retry above is silent by design: no timeline rows. It must not be silent when asked. Each side keeps the last attempt to go live that did not, as it saw it, and shows it where the connection is explained (the connection panel), never as a row:

- **The dialling side** (the lower rendezvous key, or the joiner of a first pairing): each transport it tried, in order, with why it did not connect, as its adapter said ("The contact has no Iroh relay", "Iroh connection timed out", an offer not answered), or why nothing could be tried ("No transport both apps allow is available yet"), and when it dials again.
- **The answering side:** that its contact dials, and what reached it: an offer it answered that did not connect. An attempt that never reached it (a native dial that failed at the contact's end) is not something it can know, and it does not guess.

Both are cleared when the chat goes live. Found between a browser and a desktop on one machine: the desktop answered WebRTC offers that never connected, the browser's Iroh failed with no relay to dial, and both said only "On DHT · retrying live".

### A chosen transport not reached yet (revision 0.4)

The transports a chat allows come from both sides' policies: a transport chosen in the Connection menu, and **Fallback**, which, when off, limits the chat to that one. When the transport the policies name is not the one carrying the chat, the chat is **waiting** for it. Waiting is not failing, and nothing about it is final while both apps run.

1. **Why it waits.** One of:
   - `unknown`: the contact's app has not said whether it has the transport (no capability record read yet, no session);
   - `starting`: the contact's record lists it, but the contact has not given a way to dial it yet (no descriptor, or its session policy does not list it yet): its endpoint is starting;
   - `connecting`: an attempt is under way;
   - `unreachable`: both sides have it, and the last attempt did not connect; the attempt's error is kept for the details;
   - `waiting`: both sides have it and no attempt failed yet;
   - `contact-lacks`: the contact's latest capability record does not list it, so its app does not have it (no such adapter, or one turned off, such as a browser with no HyperDHT relay). A session policy alone never says so: a session can open before every endpoint has started ([03](03-capabilities.md#layer-0-capability-record));
   - `app-lacks`: the contact chose it, and this app does not have it.

   With no session open, only a transport missing on a side (`contact-lacks`, `starting`, `app-lacks`) is shown as a wait. A contact that has it and is away, or not reached yet, is the chat retrying live, as for any chat on the DHT.
2. **Retried, never given up.** The switch, or with no session the dial, is tried again at once when the contact's capability record (re)appears or names the transport or a descriptor for it, when the contact's session policy changes, and when either side chooses again. Otherwise it follows the background pace above: 20 s after a failed attempt, doubling to at most 3 minutes, while the contact is online. The lower rendezvous key still coordinates. Applying a standing choice is not probing (above).
3. **Where the chat is meanwhile.** With Fallback on for both, the chat stays live on the transport it is on, and the connection panel says the choice is waiting. With Fallback off on either side, no other transport may carry the chat: it is `on-dht` ([400](400-chat.md#states-of-a-chat)), short text goes over the DHT, the rest waits, and the header says "On DHT · waiting for <transport>". An authenticated session already open on another transport MAY stay open to coordinate the switch. It carries nothing of the chat (no text, files, payments or calls), and it is not `live`.
4. **Said plainly.** `contact-lacks` reads as "<contact>'s app doesn't have <transport>", with **Automatic** offered beside it. The chat keeps watching: a newer record that lists the transport makes it `starting` again, and the switch follows by itself.
5. **Quiet.** Waiting shows in the header's connection icon and its panel, never as timeline rows ([400](400-chat.md#transport-rows)). The choice is one row. A switch that could not connect while the chat stayed live on another transport is one row the first time; later attempts go to the connection history only. When the chat reaches the chosen transport, the choice's row becomes the switch ("You switched to HyperDHT"), however long it waited.

### A choice made while not live (revision 0.5)

A choice made in the Connection menu is a switch intent on the open session. With no session open (the chat is `on-dht`, or the contact is away), there is nothing to raise an intent on, and before this revision the contact never heard of the choice. Found between a browser and a desktop whose WebRTC could not connect: the browser chose Iroh, the desktop showed nothing, and the chat stayed "On DHT · retrying live".

1. **Carried in the record.** The chooser's capability record names the choice (`choice`, [03](03-capabilities.md#layer-0-capability-record)), and Automatic removes it. The record goes out as for any change, and a DHT envelope names its new revision, so the contact reads it.
2. **Told once.** The contact's timeline gets one row, "<contact> chose <transport>", as for a choice made on a session. A choice it already told, from a session or an earlier record, is not told again. With a session open, the session's intents are the contact's word, and a record that may be older is not.
3. **Dialled first.** The dialling side tries the chosen transport first, even when it is relayed and even with no session behind it ("Explicit choice wins" below). The dial goes at once, not after the wait failed attempts built up. When both sides chose and the choices differ, the lower rendezvous key's goes first, as a tie between intents is settled.
4. **Carried into the session.** The next session begins with the choice as a switch intent, above the contact's last one, as if it had been made on it. A session that opened on another transport (a fallback, while the chosen one could not connect) is then moved by the coordinator, retried and said as in [A chosen transport not reached yet](#a-chosen-transport-not-reached-yet-revision-04).
5. **Said plainly.** With no session, a choice names what the chat waits for, even with Fallback on. A side that lacks the transport says so (`contact-lacks` on the chooser, `app-lacks` on the contact), as with Fallback off.

### Relayed transports (revision 0.3)

A transport is **relayed** on a chat when either side's descriptor says it reaches the contact only through a relay server: `"relayed": true`, or an Iroh descriptor with no direct address (a browser's, [102](102-iroh.md#browser-profile-relay-only-revision-03)). Both sides hold both descriptors after the exchange, so both reach the same verdict.

1. **Rank.** A relayed transport ranks after every direct one; within each group the rank sum and the fixed order decide as before. The result stays the same from either side. A relayed path is never chosen over a working direct one by the rule alone.
2. **Explicit choice wins.** A transport chosen in the Connection menu is used even when relayed.
3. **Fallback after WebRTC.** WebRTC settles late (ICE can fail long after the offer). When the dialling side's WebRTC attempt ends without opening, it goes on to the next ranked transports, typically a relayed Iroh, before the chat is left `on-dht`. An offer still unanswered after 40 s has it dialled already ([An unanswered offer](#an-unanswered-offer-revision-07)). With **Allow fallback** off on either side, it does not.
4. **No probing.** A live relayed session is kept while it works, as any other (above, and [open decisions](#open-decisions)). The next dial, after a drop or a restart, ranks direct paths first again, so a network that lets WebRTC through again is used then.
5. **Shown.** The connection indicator says "relayed" and names the relays, which see who talks to whom and when, never what is said.

The same flag serves a browser's HyperDHT, which goes through a HyperDHT relay ([103](103-hyperdht.md#browser-profile-through-a-hyperdht-relay-revision-03)). The chat's timeline marks a move onto a relayed transport as such, not as a direct path found.

### DHT only as a choice

The per-chat Connection menu lists **DHT only** beside Automatic and the transports both apps support ([400](400-chat.md#pairing-progress-and-transport-rows)). Choosing it closes layer 1 and releases native endpoints for that chat, exactly as today's DHT-only mode does. It travels as the envelope's `mode` ([403](403-dht-text.md)), not as a `paired-policy` intent, because it must reach a contact that has no layer-1 session.

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Local experimental increment

The [chat session increment](PAIRED-CHAT-INCREMENT.md), now the live session of every new chat ([401](401-paired-chat.md)), exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Scope and baseline

Choose an application transport without a global winner. Today `GhostLink` constructs `DataLink` directly; `PkarrTransport` abstracts rendezvous access, not data transport selection. PeerJS is a WebRTC implementation choice, not another adapter. Raw QUIC is not a separate milestone in this series.

## Candidate deterministic negotiation

This is a reviewable algorithm proposal, not an agreed wire standard:

1. Each authenticated offer contains the attempt context, allowed adapter/profile versions in local preference order, connectivity parameters and hard policy constraints. Exclude options prohibited by local privacy/security policy before ranking.
2. Intersect compatible adapter profiles and all hard constraints. Return an explicit no-common-transport result when empty. Missing optional external proofs need not prevent an otherwise allowed transport.
3. For two peers, use the lexicographically lower participation public key as selection coordinator. Follow that peer's advertised order within the common set; resolve any tied entries by canonical adapter/profile identifier. Both peers recompute and explicitly confirm the same choice and offer transcript before use. This simple asymmetric preference rule is a candidate for review, not an established fairness guarantee.
4. Attempt the selected adapter within a bounded, profile-defined timeout. Bind its authenticated remote endpoint to the participation keys and negotiation transcript before application traffic.
5. On failure, agree an incremented attempt and the next untried common candidate. Limit retries per attempt; the chat as a whole falls back to layer 0 and retries later (above), rather than failing. Never silently enable a relay, expose an address class or send DHT text to a party whose capability record forbids it (no `dht-text/1`). Changed policy/offer requires fresh agreement.

The adapter contract needs connect/accept, authenticated remote identity binding, send/receive with framing boundaries, backpressure, cancellation, error and close semantics. Support for reliable streams, datagrams and media is declared explicitly; adapters are not assumed interchangeable for every capability.

## Compatibility and security

Legacy WebRTC negotiation remains a distinct profile. New offers MUST NOT be interpreted as legacy `_rtc`. Compare signed/authenticated offers, selected versions and endpoint bindings to detect downgrade/substitution. A successful socket alone is insufficient. Group routing selection follows 900; the two-peer coordinator rule is not a group consensus algorithm.

## Open decisions

Decided (2026-09-25): a `live` chat does not probe for a higher-ranked transport in the background; a switch is explicit or follows a drop, which avoids churn on a working chat. The demotion window is three failures, one hour: long enough to stop paying for a blocked path, short enough to notice a network that changed. The native descriptors in the capability record carry no direct addresses: the Iroh endpoint id and the HyperDHT key are dialable through their own discovery, and addresses would expose network location in a record any invite holder can read before the pin.

Fix canonical encodings, adapter IDs, timeout/retry values, simultaneous negotiation resolution, transcript binding and protection against forced repeated failures. Latency measurement and weighted scoring are experiments, not requirements. Browser/native availability must be reported honestly; a bridge is a separate trust/visibility choice.

## Conformance

Revision 0.7: a restarted app whose WebRTC offer the contact cannot answer (its answer held back by the relays' budget until its attempt gave up) is live again over a direct native transport ranked after WebRTC within 15 s, and over a relayed one within 45 s; each transport is dialled once per attempt, and nothing dials an app that is not there.

Revision 0.6: an app that quits, is quit, or crashes, and starts again is live again with its contact within 5 s (graceful or closed) or 15 s (a crash), on Iroh and WebRTC, whichever side has the lower key, within the relays' budget; a dial in from another key than the pinned one leaves the held session as it was; two apps that restart together settle on one connection.

Revision 0.5: a choice made while not live shows on the contact as one row and is dialled first by whichever side dials; a browser whose WebRTC cannot reach a desktop goes live over relayed Iroh once the desktop's record names its relay, including when the relay came after the endpoint started.

Revision 0.4: a transport chosen with Fallback off before the contact's record names it is waited for, not failed, and the chat ends live on it once the contact has it, with no action and no connection error in between; one the contact's app lacks is said so, with Automatic offered; a switch whose transport did not connect is retried until it does.

Revision 0.2: with every transport blocked the chat ends `on-dht` and chats; unblocking one moves it to `live` without action; two native peers whose WebRTC is blocked reach Iroh or HyperDHT from layer-0 descriptors; a drop mid-conversation falls back and returns with no loss or duplicate; a drop while a switch is in flight ends both sides on the agreed transport, whichever side redials or plans the switch; a transport that always fails is demoted and restored.

Reverse offer arrival order and still choose the same result; exercise disjoint sets, crossed attempts, policy-prohibited relay fallback, timeout, stale selection and substituted endpoint keys. Demonstrate the same chat capability over at least two adapters before claiming interchangeability.

## References

[Current composition](../../packages/core/src/ghostlink.ts), [rendezvous interface](../../packages/core/src/transport.ts), [WebRTC adapter](101-webrtc.md), [group session](900-group-sessions.md).

## Revision log

- 0.7 (2026-09-27): an unanswered WebRTC offer has the transports ranked after it dialled meanwhile (direct after 8 s, relayed after 40 s); the first live session wins and ends the other attempt.
- 0.6 (2026-09-27): back after a restart: goodbye and watch, a dial in from the pinned contact takes over a held session, resume dials by either side, crossed dials settled by key.
- 0.5 (2026-09-25): a choice made while not live travels in the capability record, is told once on the contact, is dialled first, and begins the next session as a switch intent; each side keeps and shows why its last attempt to go live did not.
- 0.4 (2026-09-25): a chosen transport not reached yet is waited for, never failed: why it waits, when it is retried, where the chat is meanwhile (live on a fallback, or on the DHT with Fallback off), and no timeline rows for it.
- 0.3 (2026-09-25): relayed transports: rank after direct ones, fallback after a failed WebRTC attempt, shown as relayed.
- 0.3 (2026-09-25, later): a browser's HyperDHT through a HyperDHT relay is relayed too ([103](103-hyperdht.md)).
- 0.2 (2026-09-25): the DHT as the floor under every transport, never a candidate; inputs from the layer-0 capability record; upgrade, downgrade and background retry rules; DHT only as a per-chat choice; after a drop, the redial and the agreement that follows it.
- 0.1 (2026-09-20): initial review draft.
