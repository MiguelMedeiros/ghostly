# WISP 9xx — Group Community Distribution Profile

| Field | Value |
|---|---|
| Number assignment | 9xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-24 |
| Document kind | Profile |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md), [400](400-chat.md), [401](401-paired-chat.md), [900](900-group-sessions.md), [9xx · Group Mesh](9xx-group-mesh.md) |
| Implementation | `group-community/1`: core protocol in [`groupCommunity.ts`](../../packages/core/src/groupCommunity.ts) and [`communityRendezvous.ts`](../../packages/core/src/communityRendezvous.ts); engine in [`community.ts`](../../packages/browser/src/engine/community.ts), payments in [`communityPay.ts`](../../packages/browser/src/engine/communityPay.ts); UI shared with the mesh; unit tests, a six-browser e2e, a three-browser payments e2e and a headless load test |

> This Draft documents the second distribution profile of [900](900-group-sessions.md) as implemented. Numbers and wire formats are not registered standards.

## What this profile is for

A group whose **link is the way in**: posted in a large community, anyone who opens it joins, whether or not the admin is online, and the group holds hundreds of members, not eight. [`group-mesh/1`](9xx-group-mesh.md) stays what it is (a small private group of contacts); a group says which of the two it is from its first commit, and never changes.

Four decisions separate it from the mesh:

1. **Admission is every member's right.** Any member may admit whoever presents the group's link, by appending an `add` commit it signs. The admin keeps removal, role transfer, rotation and the link itself. A departure is committed by any member on the leaver's signed request.
2. **Adding a member does not re-key everyone.** The secret of an epoch opened by `add`, `role` or `link` is derived from the previous epoch's secret and the commit; only the newcomer is sent it. Epochs that take someone out (`leave`, `remove`) and `rotate` get a fresh random secret sealed to every remaining member, as in the mesh.
3. **Concurrent commits are a race with a deterministic winner, not a fork.** The longest branch wins; between branches of equal length, the one whose first commit has the lowest hash. Two different commits by the admin after the same commit are still a fork and halt the group. To keep races rare, one hub at a time (the **door**: of the hubs that have been hubs for a minute, the one with the lowest key) answers knocks and commits leaves; the others step in, one at a time, only for someone still waiting.
4. **Hubs, not a mesh.** Online members elect a few **hubs** among themselves through a sealed Pkarr beacon; every other online member keeps an edge to one hub; hubs keep edges to each other and relay. Every member keeps a bounded store of recent frames from everyone, so whoever was away is caught up by whoever is there, not only by each author.

## The trust consequence of a link, plainly

The link is a bearer capability. **Anyone who has it is in**, and so is anyone a member chooses to let in: every member can admit, not only the admin. Removing someone does not stop them from opening the link again; the admin replaces the link (a `link` commit) to keep them out, and whoever holds only the old link reaches nobody. There is no approval step, expiry or use count in this revision. A member who wants to flood the roster with made-up keys can, up to the cap; the admin removes them and replaces the link. What the link does not give: reading anything sent before one's admission, or anything after one's removal.

## Identity and declaration

The group id is not random: `g = base64url(SHA-256("ghostly-group-community/1 id" ‖ creator key ‖ n)[0..16])`, where `n` is a 16-byte nonce in the genesis. A chain whose genesis does not produce its `g` is refused, so nobody can present another genesis for the id a link names.

The link is `group2/<group id>/<entry key>` (web: `https://…/#/join/group2/…`). The `group1/` links of the mesh keep their meaning. An app that does not know `group2/` says the link is not one it can open, and nothing else happens.

Apps announce `{ "t": "paired-groups", "v": [1, 2] }`. Community frames flow only on sessions where both sides announced 2, so a community group's edges and entry sessions run between apps that know the profile. A community is joined through its link; it is not offered to contacts from the members panel, where the link heads the list instead.

## Membership chain

```
{ v: 2, g, e, p, k, m: <roster hash>, by, s?, x?, n?, ls?, ts, c, sig }
```

`k` is one of `create`, `add`, `leave`, `remove`, `role`, `rotate`, `link`. Unlike `group-mesh/1`, a commit does not carry the roster, which would grow with every member of a large group: it carries `m`, the SHA-256 of the canonical roster after it, and every member replays the chain to know the roster. `x` is the entry key (`create`, `link`; empty turns the link off); `n` the genesis nonce; `ls` the leaver's signature over `["ghostly-group/2 leave", g, s]`. Hash and signature cover the canonical tuple of all fields but `sig`, as in the mesh.

| Kind | Who signs | Rule | Secret of the new epoch |
|---|---|---|---|
| `create` | the creator, who is admin | genesis only; `g` derives from `by` and `n` | fresh |
| `add` | any member | `s` not in the roster; roster below the cap | derived |
| `leave` | any member but `s` | `s` a member but not the admin; `ls` valid | fresh |
| `remove` | the admin | `s` a member, not the admin | fresh |
| `role` | the admin | `s` a member; becomes the admin, the signer a member | derived |
| `rotate` | the admin | nothing else changes | fresh |
| `link` | the admin | `x` a key, or empty | derived |

A derived secret is `HKDF-SHA-256(previous secret, salt = the commit's untagged hash, info = "ghostly-group/2 derived")`. Whoever holds the previous epoch computes it; a newcomer is sent it sealed and cannot go back. The confirmation tag, as in the mesh, is an HMAC under the new epoch's confirm key, so a member handing on a secret cannot hand on a wrong one.

### Races and forks

Any member may commit, so two members can commit after the same commit before hearing of each other. Every member keeps the commits it has seen off its branch (up to 512) and follows the **best branch**: the longest, however far back it parts from mine; between branches of the same length, the one whose first commit after their common parent has the lowest hash, if they part within the last 64 epochs. Everyone who has seen the same commits follows the same branch. A commit that loses is not an error: a newcomer whose `add` lost is not a member and knocks again, which any member answers; a leave that lost is committed again by the next member that sees the leaver's request. Messages sent under a losing commit stay readable, because a message names its commit (below) and members keep the secrets of losing commits they could derive or were sent.

A `group-sync` carries a **locator**, the hashes of the sender's branch 1, 2, 4, 8… commits back from its tip, so a member on a branch the other has never seen is sent the commits from where their branches part, and can compare.

Two different commits signed by the **admin** after the same commit are equivocation: that is a fork, and the group halts on every member that sees both, as in the mesh. A claim without a signed commit is answered with the commit.

## Topology: hubs elected through a beacon

Members share a **rendezvous secret**, created with the group and handed to every newcomer sealed in its welcome. From it every member derives:

- the **beacon**: a Pkarr identity and a sealing key. Its record lists up to eight hubs `[key, time, load, since]` (since when it is a hub), sealed with XChaCha20-Poly1305. Hubs republish their own entry every 30 seconds (read, merge, publish); an entry older than 90 seconds is stale.
- a **lobby** per hub: a Pkarr identity and key from the rendezvous secret and the hub's member key. A member that wants a hub writes `[member key, time]` there (at most six, fresh for two minutes) until the hub opens their edge.

An online member reads the beacon every ten seconds. With fewer than two fresh hubs, or all of them at capacity (48 members), and fewer than eight hubs, it becomes a hub after a random delay of up to three seconds (and a second reading). Otherwise it picks the least loaded hub and asks in its lobby; a hub that has not opened its edge within 20 seconds is avoided for a while (a newcomer starts with the hub that let it in), and a member that no hub takes becomes one. A hub polls its lobby every three seconds and opens an edge to every fresh key there that the chain has not taken out, up to its capacity (a member whose admission lost a race, or who is ahead of the hub's view of the roster, needs the edge to find out; the session hands nothing to a key that is not a member); hubs open edges to every other fresh hub in the beacon, and republish their entry every 30 seconds, or as soon as their load moves by eight. A hub with no members and nobody asking in its lobby for a minute steps down when two other fresh hubs remain and it has an edge up to one of them (a hub cut off from the others would only come back as one), closing any entry session it was running. A member whose admission lost a race stops being a hub at once and knocks again.

An edge that is up is kept while its other end was listed as a hub in the last three minutes, whatever one reading of the beacon says: a beacon is a record several hubs write in turn, and one reading that missed a hub must not cut the group in two. For the same reason nobody drops a hub it does not know from the beacon when it republishes: a member behind on the roster would erase the newest hubs.

Edges are the mesh's: a paired-chat/1 link per pair of member keys, derived from their X25519 secret and the group id and pinned in advance. Nothing new travels on the DHT but three sealed records (beacon, lobbies, knocks); relays see Pkarr keys and opaque values. Anyone who ever held the rendezvous secret (a removed member included) can read which member keys are hubs and when, and can write junk into these records, which is a nuisance, not a way in.

### Relaying

A hub that receives a frame it had not seen passes it on to every edge but the one it came on: its members and the other hubs. Each hub does so once per frame, since frames are deduplicated by their identity (a message by sender, epoch, commit and sequence; a commit by hash), so this is a bounded flood among at most eight hubs, and it does not need every pair of hubs to have its edge up, which after a change of hubs they do not. A hub relays only what it could verify: messages signed by a member of the epoch they name, commits that follow the chain or wait for a gap to fill. Nobody can read what they relay unless they are a member of that epoch, which a hub is.

A frame for one member (the secret of a fresh epoch sealed to it) carries `to`; a hub hands it to that member if it holds its edge, and otherwise to the other hubs, once per frame.

## Messages and catch-up

```
{ "t": "group-msg", "v": 2, "g", "e", "h": <first 16 hex of the epoch's commit hash>, "s", "n", "ts", "nn", "c", "sig" }
```

The ciphertext opens to `{ "text", "nick"? }`: a member's name travels encrypted with what it says, since most members never share an edge. Since revision 0.3 it may instead open to an application frame for the group, `{ "x": { … }, "nick"? }`, or to a payload for one member, `{ "p": { "to", "e", "n", "c" }, "nick"? }` (§ Payments); exactly one of `text`, `x` and `p`. Both are frames like any other: same signature, identity, deduplication, relaying, store and catch-up; they are handed to the application instead of the history. The associated data is `[g, e, h, s, n, ts]`; the signature covers `["ghostly-group/2 msg", g, e, h, s, n, ts, nn, c]`.

Every member keeps the last 256 frames of the group, from everyone (at most 1 MiB), and answers a `group-sync` with the commits the other lacks, the secrets of epochs it was in, and the stored frames above the other's high-water marks, for epochs the other was a member of. Frames are signed by their authors, so a relayed or re-sent frame is as authentic as a direct one, and per-sender sequence numbers still reveal gaps. A newcomer is not sent anything from before its admission. A member that lacks the current epoch's secret, or holds frames or commits it cannot place yet, asks its connected members with a `group-sync` every five seconds until it has them: a sealed secret lost on the way is not lost for good. Every member also sends a `group-sync` to whoever it is connected to every thirty seconds, so a commit or a message that went by while an edge was down reaches it without anything left waiting to ask about.

## Admission through the link

The joiner does what it does in the mesh: a member key, knocks, an entry session toward the entry key. Knocks are spread over four records (`<group id>.<n>` in place of the group id in the knock identity's derivation, `n` the first byte of the joiner's key modulo 4), so a crowd opening the link at once is not six at a time; a hub reads one of them every 1.25 seconds, in turn. Every member holds the entry key's seed (sealed in the welcome), so any member can answer, but never two at once: an entry session derives from the entry key and the joiner's key, the same for every hub, and two hubs answering one joiner collide on it and neither gets through. The hubs **at the door** are those that republished in the last 45 seconds and have been hubs for a minute (all of them, when none has), so that every hub, having read the beacon since, agrees on the set; the **door** is the lowest-keyed of them. Each attempt belongs to one hub, in turns of two minutes counted from when a hub first saw the knock with the current set of hubs at the door (when the set changes, say because the door's app closed, the count starts again and the new door answers at once, but only a joiner whose knock was refreshed in the last fifteen seconds, since the former door may still be letting it in; a joiner stops knocking as soon as it sees a member's side of its entry session): the door first, then the other hubs at the door, in the order they rank for this joiner (highest `SHA-256(knock key ‖ hub key)` first), round again. A hub opens a session only in the first 20 seconds of its turn, gives up on one nobody answered after 90 (a paired session over Pkarr can take the better part of a minute to come up), and after its first turn answers only a joiner still knocking. Over the entry session: `group-invite`, `group-accept`, then the welcome, in pieces when the chain is long:

```
{ "t": "group-welcome", "v": 2, "g", "name", "commits": [ … ], "secrets": [ { "e", "s" } ], "rv": <sealed rendezvous secret>, "entry": <sealed entry seed> }
```

The joiner checks the whole chain from its genesis, including that the genesis produces `g`, that the entry key the link named is the chain's current one (a replaced or turned-off link admits nobody), and that an `add` names it. Who sent the welcome does not matter: the entry session is pinned to the entry key, which only members hold, and the chain rules already require the `add` to be signed by a member. A member of the roster who knocks again (its welcome was lost) is sent a welcome again, with nothing committed; knocks from members count only when they are still being refreshed well after their admission.

## Leaving and removal

A member leaves by sending `{ "t": "group-leave", "v": 2, "g", "s", "ls" }` to its hubs and wiping its secrets; any member other than the leaver commits `leave` (the leaver cannot, since the committer chooses the next secret). An admin leaving first hands the role to a member (a `role` commit, preferably to one it is connected to), then leaves like anyone else; the app needs one edge up to carry the request. The group then goes from the leaver's device at once. The admin removes with `remove`; the removed member is sent the commit without a secret. Both give the remaining members a fresh secret, sealed to each and relayed by the hubs; members who were away get it from whoever they meet.

## Metadata

A community group has the mesh profile's metadata (its picture), with the same statement, body, box and rules ([9xx · Group Mesh § Metadata](9xx-group-mesh.md#metadata)). Here the frame carries `"v": 2`, `h` must be on the member's **main branch** at index `e`, and `k` is the **hash** of the commit whose epoch key seals the body (as messages name their commit), not an epoch number. The signer must be the admin after `h` and the admin now, so a statement is the admin's word whichever member admitted whom. A hub relays a statement it took as new, like any other frame, so members who reach each other only through hubs get it. A member let in by another member while the admin is away gets it at its first sync with whoever let it in. A new admin, including the member an admin hands its role to before leaving, signs it again.

## Payments

A payment in a community is, as in [`group-mesh/1`](9xx-group-mesh.md) § Payments, a payment **between two members** plus a **note** the rest of the group sees; a request to the whole group is paid **once**. What changes is the transport: two members of a community rarely share an edge, so what they say to each other about the money goes through the hubs, **sealed to the two of them**.

### Pair payloads

A member's payload for another member travels inside an ordinary `group-msg` of the group, as `p`:

```
{ "p": { "to": <recipient key>, "e": <ephemeral X25519 key>, "n": <24-byte nonce>, "c": <ciphertext> }, "nick"? }
```

- **Key.** `HKDF-SHA-256(ikm = X25519(ephemeral, recipient) ‖ X25519(sender, recipient), salt = ephemeral public key, info = "ghostly-group/2 pair" ‖ sender key ‖ recipient key)`, member keys taken to X25519 as for sealed secrets. The ephemeral half means a later leak of the sender's seed alone opens nothing; the static half means only the sender (or the recipient) can have made it, independently of the signature.
- **Cipher.** XChaCha20-Poly1305, associated data `["ghostly-group/2 pair", g, e, h, s, n, ts, to]`: the header of the frame that carries it, and whom it is for. A box lifted into another frame (another sender, sequence, epoch, group, or recipient) does not open.
- **Carrying.** The `group-msg` around it is sealed to the epoch and signed by the sender like text. So a pair payload is **authenticated** (only the sender signs its frames; a changed byte fails the signature, a hub's own frame opens as from that hub, never as from someone else), **deduplicated across the flood** (the frame identity: sender, epoch, commit, sequence; the replay window of 256 per sender and epoch; a frame older than the window's epochs is not placed at all), **relayed** by hubs once per frame, and **kept** in every member's store and handed to whoever was away at the next `group-sync`, like text. A member who is not `to` keeps and relays it and never opens it.
- **What a hub (or any member) learns.** That the sender sent the recipient something, when, and its size. Not the amount, the token, the invoice, the address or the memo. The note below tells the group who pays whom and how much anyway; nothing to pay with is ever readable by anyone but the recipient.

The payload is JSON of at most 8 KiB: `{ "pm": [<ways of paying the sender takes>], "hi"?: 1, "f"?: <payment frame> }`, where `f` is one of the ordinary frames of [200](200-payments.md) (`pay-ask`, `pay-req`, `pay`, `pay-res`), checked exactly as on a data link. `pm` does what `paired-payments` does on a chat: every payload says what its sender takes, and a member whose word is not in yet is taken to take Cashu and Lightning. `hi: 1` asks for an answer (`{ "pm" }`, at most every ten seconds per member): an app sends it when its person opens the payment composer on that member. Ecash is a bearer token: it only ever travels inside a pair payload to the payee, so no relayed copy is redeemable by anyone else.

### Everything else is the chat's

The payer's app pays or asks, reviews and approves exactly as in a chat; the payee's app redeems, answers `pay-res`, and the payer takes back ecash refused or never redeemed. A member who was away gets a request, a payment or a receipt from whoever is there when it returns; if the payee is away when the ecash is sent, the token waits sealed in the hubs' stores until it returns (or until the payer takes it back). Receipts are idempotent: a frame delivered twice is handed on once, and the desk answers a payment it already recorded from what it recorded.

### A request to the whole group

Not one `pay-req` per member: one **application frame** to everyone, `{ "x": { "t": "pay-req", "id", "ts", "v", "u", "memo"?, "e": [<one endpoint>], "pm": [...] } }`, sealed to the epoch like text (every member is asked to pay it, so every member may read it). The rules of `group-mesh/1` hold unchanged: **one rail** (Cashu or Lightning), **first valid payment wins** (each payer pays with a pair payload to the payee; the payee checks each token before redeeming it and refuses later ones unredeemed), and **everyone's copy closes**: when it settles, the payee sends `{ "x": { "t": "pay-res", "id": <request id>, "ok": true } }` to everyone. A request and a result are believed only from the member who made the request (the receiving app files them under that member).

### The note

The `group-pay` note of `group-mesh/1`, unchanged in content and rules, goes to everyone as an application frame, `{ "x": { "t": "group-pay", … } }`, instead of on every edge; its author is the frame's signer. It is not said again when an edge opens: the store and catch-up carry it.

### Why not a direct session for the payment

Two members could open an edge between them for the payment (the edges are derived pairwise already). It is not what this profile does, because: a request to the whole group would need an edge to every member, hundreds of them; a member who is away would get nothing until both apps happen to be open at once, whereas the group already keeps frames for whoever was away; and a paired session over Pkarr took 5 to 80 seconds to come up on the test machine, where a frame through the hubs takes a second. The pair payload gives what the edge would (only the two members read it; only the sender makes it), over a path the group maintains anyway.

## Compatibility

`group-mesh/1` groups, their links and their frames are unchanged. Community frames carry `v: 2`; an app from before metadata drops `group-meta` and relays none of it, and members that reach each other only through such a hub get the picture at their next sync with a newer member; a mesh session ignores them, and an app from before this profile never receives one, since it never announces 2. Community groups are not offered as contact invitations at all. An app of revision 0.2 drops a `group-msg` that opens to `x` or `p` (it expects `text`): it shows nothing and, as a hub, does not pass it on, so payments need the two members and the hubs between them on revision 0.3. Text is unaffected.

## Bounds

256 members; 2048 commits; 8 hubs, 48 members per hub, one hub per member; 256 stored frames and 1 MiB (payment frames included); 96 epoch secrets; 512 commits off the main branch; ties between branches decided within 64 epochs; 16 KiB of text; 8 KiB of application frame or pair payload; 60 KiB per frame; four knock records and lobbies of six entries each. The member cap is what the load test below measured; see Conformance.

## Security and privacy

- Every member can admit anyone, read every message of the epochs it is in, and relay. A member cannot forge another member's messages, read before its admission, or read after its removal.
- The admin cannot be bypassed for removal, role or link changes, and cannot equivocate without halting the group.
- A compromised member seed is healed by removal, as in the mesh; there are no member key updates.
- Hubs see who is connected to them and when, and relay ciphertext they can read (they are members), except pair payloads: those only their recipient opens.
- Payments: the group (hubs included) sees who pays or asks whom, how much, over what and the memo, through the note; it never sees a token, invoice or address sent between two members. A hub can drop a pair payload, like any frame; it cannot read, alter, forge or replay one. Another hub, or the next sync, carries it.

## Conformance

[`packages/core/test/groupCommunity.test.ts`](../../packages/core/test/groupCommunity.test.ts): the genesis binds the id; each kind's authority and roster arithmetic; derived and fresh secrets, and that a newcomer cannot derive an earlier one; a removed member cannot read the next epoch; races between members converge on one branch on every member whatever the order, losing messages stay readable, a losing newcomer is not a member; two admin commits after the same commit fork; stale branches are refused; catch-up of a member away through a removal from a member that is not the author. [`packages/core/test/communityPair.test.ts`](../../packages/core/test/communityPair.test.ts): a pair payload opens only for its recipient, only as from its sender, only in its frame; a member relaying it reads neither amount nor token; it is handed on once whatever the number of hubs and after a restart; it reaches a member who was away through someone who is not its author; app frames reach everyone once and never the text history. [`packages/browser/test/communityPayments.test.ts`](../../packages/browser/test/communityPayments.test.ts): the real desks over headless communities — a request and its ecash between two members with no edge between them, through the hubs, with nothing readable on any edge; a request and a payment to members who were away, each way; a request to the whole group paid once, the second token refused unredeemed. [`packages/browser/test/community.test.ts`](../../packages/browser/test/community.test.ts): hub election and step-down, lobbies, relaying and deduplication, admission by a member with the admin never online, and restart. [`e2e/web/group-community-payments.spec.ts`](../../e2e/web/group-community-payments.spec.ts): three browsers in a community with a local mint: one requests from another, the third sees it, the second pays through the hubs, all three see it paid; a request to the group paid once. [`e2e/web/group-community.spec.ts`](../../e2e/web/group-community.spec.ts): six browsers that never pair, through one relay and real WebRTC: the admin creates the group and closes its app; three people join through the link, let in by a member; everyone reads everyone by name; a member away while another speaks is caught up after the author has left; the admin returns, is caught up and removes someone, who reads nothing after; a late joiner reads only what comes after it. The picture: [`groupMetaSessions.test.ts`](../../packages/core/test/groupMetaSessions.test.ts) and [`groupPicture.test.ts`](../../packages/browser/test/groupPicture.test.ts) (six headless engines with hubs, someone let in while the admin is away, a restart), and [`e2e/web/group-picture.spec.ts`](../../e2e/web/group-picture.spec.ts).

### What was measured

`npm run test:group-load` ([`communityLoad.test.ts`](../../packages/browser/test/communityLoad.test.ts)) runs the real engines (`Groups`, `Communities`, `CommunitySession`) headless, one per member, on in-memory edges and Pkarr in one Node process, with simulated time. An edge is up when both ends opened it; two peers opening the same end collide, as they would on Pkarr. At 256 members (the cap), on 2026-09-24:

| | 128 members | 256 members |
|---|---|---|
| Admission of everyone through the link, in waves of 16, the admin's app closed after the first | 96 s simulated | 742 s simulated (about 21 a minute; 452 to 1248 s over four runs) |
| Everyone on one roster afterwards | 24 s | 10 s |
| Admissions that lost a race | 0 | 0 |
| Hubs; edges per hub (most, mean); edges per member | 3; 50, 43; 1 | 8; 55, 38; 1 |
| A message from every member to every member: frames sent per message (all peers, periodic syncs included) | 130 | 299 (1.17 per member) |
| … bytes sent per message (all peers) | 59 KB | 126 KB (about 490 bytes per member) |
| … messages not delivered within 10 s | 0 | 0 |
| A tenth away while twenty others speak, caught up on return | 1 s | 1 s |
| A removal: a fresh secret sealed to everyone else and relayed; everyone can send again | 1 s simulated | 1 s simulated |
| Memory of all engines together | 259 MiB | 511 MiB |

This measures the protocol, the topology rules and the cryptography at the cap. It does not measure what only real networks show: WebRTC between hundreds of browsers (the e2e has six), a browser holding the fifty-odd peer connections of a busy hub, public Pkarr relays' rate limits (the 256-member run made 18 035 Pkarr reads and writes in total), or an entry session over the public relays, which on the loaded test machine took from 5 to 80 seconds to come up. The cap is therefore a measured bound for the protocol and a stated one for the network.

## Open decisions

Approval of each entry, expiry and use count; several admins; member key updates; a checkpoint so a very long chain need not be replayed from its genesis; files and media; native transports on edges; a gossip profile ([901](901-gossipsub.md)) beyond a few hundred members.
