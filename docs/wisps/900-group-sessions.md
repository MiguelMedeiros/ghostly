# WISP 900 — Group Session Negotiation

| Field | Value |
|---|---|
| Candidate number | 900; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-24 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md), [100](100-transports.md), [800](800-invite-join.md) |
| Implementation | Two profiles: [`group-mesh/1`](9xx-group-mesh.md) (private, up to eight) and [`group-community/1`](9xx-group-community.md) (a link anyone can open, hundreds of members, admission by any member); core, engine, UI, e2e and a headless load test; text only |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose and implementation state

Define how a group of Ghostly peers agrees on who is in it, protects what they say across membership changes, and moves it between them without touching Pkarr/DHT. Revision 0.1 was a proposal with every choice open. Revision 0.2 recorded the choices made for the first distribution profile, [9xx · Group Mesh](9xx-group-mesh.md). Revision 0.3 adds a second, [9xx · Group Community](9xx-group-community.md), for the group whose link is the way in: posted in a large community, anyone who opens it joins whether or not the admin is online, for hundreds of members. The contract below is what any group profile of Ghostly must provide; where the two profiles differ, it says so.

## Separate the layers

| Layer | Responsibility | Explicit non-guarantee |
|---|---|---|
| Ghost rendezvous | Signed, bounded hints to reach a member: in the mesh profile, one pairwise Pkarr link per pair of members | No message history, member roster, per-recipient group fanout or public join queue in DHT. The group id and roster never touch the DHT. |
| Admission control | Validate the invitation, the joiner's member key and the admitter's authority (the admin in the mesh; any member in a community) | Knowing a group id is not membership; a contact chat or an entry session is only the authenticated path an admission travels on |
| Group security | Authenticate membership changes (a signed commit chain) and protect application content across epochs (a fresh secret per epoch, sealed per member) | Removal does not erase what a member already holds; a compromised member key is healed by removal, not rotation |
| Delivery | Route protected envelopes over the selected topology: in the mesh, author to every member directly; in a community, through hubs the online members elect | Live delivery; catch-up from bounded logs (the author's in the mesh, anyone's in a community); no total order |
| Local application | History, gaps, permissions and moderation UI | Remote copies cannot be recalled |

## Distribution is a negotiated family of profiles

The three contracts stay independent: (a) admission and group security, (b) distribution, (c) authenticated transport between adjacent peers. A group profile names all three and their bounds. Members of one group MUST run the same profile, and **a group declares its profile from its first commit**: a `group-mesh/1` chain is made of version-1 commits, a `group-community/1` chain of version-2 commits, and a group never changes profile. Its link says it too: `group1/…` for the mesh, `group2/…` for a community. The profiles are `group-mesh/1`, a bounded full mesh of [paired-chat/1](401-paired-chat.md) edges, and `group-community/1`, the same edges between members and a few elected hubs. A GossipSub-like flooding profile ([901](901-gossipsub.md)) remains a candidate beyond a few hundred members; bridges between profiles are not assumed.

A profile is negotiated per pairwise session, not per group: an app announces `{ "t": "paired-groups", "v": [1, 2] }` on an open paired session, after the handshake (an app with only the mesh announced `[1]`). Frames of a version flow only where both sides announced it. A contact whose app never announces it cannot be invited and never receives a `group-*` frame. Nothing about 1:1 chat changes.

## Topology of the first profile

A **mesh of dedicated pairwise edges** between members, one per pair, derived by both members from the X25519 secret of their member keys and the group id: rendezvous identities for both sides and the symmetric key of their discovery records. No edge parameters are distributed; the admin cannot compute an edge it is not on; the paired session of an edge is pinned in advance to the roster's member keys, so the only trust step is admission. The mesh is capped at eight members, which is a first-profile bound, not a measured limit: connection cost is quadratic and every edge polls its own rendezvous.

A relay or rendezvous-based fan-out was considered and rejected for the first profile: it would make the admin's availability a condition for anyone to talk, and it would make an admin change (a member with edges to nobody) impossible without redistributing links. The mesh makes offline catch-up and admin transfer natural.

## Coordinator, roster and epochs

The community profile departs from what follows in three ways, detailed in [its document](9xx-group-community.md): any member may admit (commit `add`) and commit a departure on the leaver's signed request, the admin keeping removal, role, rotation and the link; adding derives the next secret instead of sealing a fresh one to everyone; and concurrent commits by different members are a race settled by a deterministic rule (longest branch, then lowest hash), while two commits by the admin after the same commit are still a fork. In the mesh:

Exactly **one admin** per epoch is the membership coordinator. The admin signs every change as a commit that carries the whole roster after it and the hash of the previous commit; the chain from the genesis is the authenticated roster of every epoch. Roles are `admin` and `member`; the role moves by a commit. There is no election: an admin who loses its key leaves a group that must be re-formed. Descriptor revision, connection attempt and cryptographic epoch are one counter here, the epoch: every commit (admission, removal, role transfer, rotation) is a new epoch with a new secret, and a network reconnect is not a commit.

Admission: the admin invites a contact over their authenticated chat; the contact accepts with a member key generated for this group; the admin commits `add`, tells the members over their edges and sends the joiner a welcome holding the chain and the new epoch's secret sealed to it. Trust on first use is of the **admin**: the welcome's chain must admit the joiner in a commit signed by the inviter's member key, learned over the contact chat. Member keys are asserted by the admin's signed commits and pinned on the edges.

## Group metadata

What a group looks like, beside who is in it (today its picture), is **not** part of the membership chain, so no chain rule changes and older apps keep verifying chains they understand. It is a statement signed by the admin and bound to a commit of the chain, sent sealed under an epoch key; members keep the newest one whose signer is the current admin, and hand it on at sync, so late joiners get it without the admin. Both profiles use it: see [9xx · Group Mesh § Metadata](9xx-group-mesh.md#metadata) and [9xx · Group Community § Metadata](9xx-group-community.md#metadata).

## Security profile

MLS (RFC 9420) was evaluated and not adopted for this profile: with at most eight static members, a ratchet tree buys logarithmic commit cost and healing of individual leaf keys, at the price of a large dependency without a small, maintained browser implementation to pin, and of state-deletion and delivery-service integration rules the profile would then have to prove. The profile uses instead a **fresh random epoch secret per commit, sealed to each member with an ephemeral X25519 exchange against the member's Ed25519 key**, HKDF-derived message and confirmation keys, XChaCha20-Poly1305 with the message header as associated data, and an Ed25519 signature by the sender on every message. Details, guarantees and their limits are in [9xx](9xx-group-mesh.md#keys-and-epochs). Single epoch secrets copied to every invite, a reused pairwise seed, or transport encryption alone are still not a group security profile.

## Ordering, partitions and concurrent changes

The admin serializes commits locally; two admissions made before either newcomer's edge is up produce two epochs, and the newcomers converge on meeting anyone ahead of them. Application messages carry sender, epoch and a per-epoch sequence; receivers keep, per sender and epoch, the highest sequence and a window of 256 below it, accept any order and report gaps per sender. Messages for an epoch ahead of the receiver's chain wait, bounded, while the receiver asks the sender to catch it up. No total order is promised.

Two validly signed commits after the same epoch are a **fork**: the group halts on every member that sees both, and the admin re-forms it. A claim of a different history without a signed commit is answered with the commit, not believed.

## Offline delivery

Live delivery only. A member whose edge was down gets, when the edge opens, the commits it lacks with their secrets (from any member that holds them and was in the roster), and the messages it lacks from each **author's** bounded log of its own recent messages. Nobody re-sends another member's messages. If the author is gone or the log rolled over, the gap is reported per sender. A new member gets no history: the welcome carries no earlier secret and authors do not re-send earlier epochs to it. DHT TTL does not create an archive; a negotiated store is a later profile.

## Moderation and resource limits

In a community, anyone with the link joins and any member can let people in: the link is a bearer capability, and removing someone does not stop them from opening it again; the admin replaces the link to keep them out. In the mesh:

The admin invites, removes and transfers its role; any member leaves. Local blocking is separate from removal. Bounds of the first profile: eight members, 1024 commits, 16 KiB of text, 32 own messages and 128 KiB kept for catch-up, 64 waiting frames and 1 MiB, 16 epoch secrets, 256 sequence numbers of replay window, one catch-up request per member per ten seconds. Coordination failure is visible: a group is `active`, `left`, `removed` or `forked`, with a reason.

## Compatibility and open decisions

Legacy and current 1:1 clients keep working unchanged; an app without groups is shown as needing an update to be invited. Mesh groups, their links and frames are unchanged by the community profile; an app that knows only the mesh never receives a community frame and says a `group2/` link is not one it can open. Open before Proposed: multiple admins; member key updates; approval, expiry and use counts on links; group files and media as capabilities of their own (payments between members are in the mesh profile, [9xx § Payments](9xx-group-mesh.md#payments), not yet in communities); native transports on edges; a profile beyond a few hundred members; interoperability with a second implementation.

## Conformance

The core test suite creates a group, admits two members, has everyone read everyone, takes one offline through a rotation and catches it up, removes one and shows it cannot read or forge, transfers the admin, refuses the former admin, forks on conflicting signed histories, and bounds every buffer: see [9xx · Conformance](9xx-group-mesh.md#conformance). Four browsers exercise the same through the UI, one relay and real WebRTC edges; see the profile's conformance section. For the community profile, unit tests cover its commit rules, races and forks, and hub topology; six browsers join by link with the admin's app closed, read each other, catch up through members who are not the authors, see a removal and a late joiner; a headless load test measures the member cap: see [its conformance section](9xx-group-community.md#conformance).

## References

[Group mesh profile](9xx-group-mesh.md), [group community profile](9xx-group-community.md), [invite/admission](800-invite-join.md), [keys](02-peer-keys.md), [chat](400-chat.md), [GossipSub candidate](901-gossipsub.md), [interoperability gates](INTEROP.md).
