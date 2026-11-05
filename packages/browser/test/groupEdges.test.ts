import { describe, expect, it } from "vitest";
import { edgeView, keptMeshPeer, meshPeersKeeping, type EdgeLive } from "../src/engine/groupEdges";
// covers: groups.connection, groups.connection.auto-reconnect

/** An edge's link as the engine keeps it, closed and never heard from unless a test says otherwise. */
const live = (patch: Partial<EdgeLive> = {}): EdgeLive => ({
  stored: { id: "edge-1" }, link: { groupsSupport: false }, dataLink: "idle", presence: { lastPacketAt: 0 }, lastSyncAt: 0, ...patch,
});

describe("edgeView: how a group's edge to one member is doing", () => {
  it("open means group frames flow: reachable now, over the transport the pairing chose", () => {
    expect(edgeView(live({ link: { groupsSupport: true }, dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } }), 1_000))
      .toEqual({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: 0 });
  });

  it("an open edge's view is the same from one state to the next: what the pages compare by content is not drawn again", () => {
    // Its member is heard all along: a "last seen" of now made every group with a member connected a change on each
    // engine state, and the chat list drew each such group's row again on every one.
    const open = live({ link: { groupsSupport: true }, dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" }, lastSyncAt: 400 });
    expect(edgeView(open, 1_000)).toEqual(edgeView(open, 61_000));
    expect(edgeView(open, 1_000).lastSeenAt).toBe(400);
  });

  it("a data channel open without groups on the other side is not reachable: nothing of the group can cross it", () => {
    expect(edgeView(live({ link: { groupsSupport: false }, dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } })).state).toBe("connecting");
  });

  it("an edge being set up is connecting; a member merely seen online lately is not (presence lingers after an app closes)", () => {
    expect(edgeView(live({ dataLink: "offering" })).state).toBe("connecting");
    expect(edgeView(live({ dataLink: "connecting" })).state).toBe("connecting");
    expect(edgeView(live({ presence: { lastPacketAt: 5 } }))).toMatchObject({ state: "waiting", lastSeenAt: 5 });
  });

  it("nobody there: waiting, with when the member was last heard (the later of presence and the last open channel)", () => {
    expect(edgeView(live({ presence: { lastPacketAt: 400 }, lastSyncAt: 300 }), 1_000)).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 400, reconnecting: true });
    expect(edgeView(live({ presence: { lastPacketAt: 100 }, lastSyncAt: 300 })).lastSeenAt).toBe(300);
    expect(edgeView(live()).lastSeenAt).toBe(0);
  });

  it("a failed pairing or discovery says why; no transport is claimed while it is down", () => {
    expect(edgeView(live({ pairing: { status: "error", error: "Not the member this edge belongs to", transport: "webrtc/1" } })))
      .toEqual({ linkId: "edge-1", state: "error", lastSeenAt: 0, error: "Not the member this edge belongs to", cause: "other" });
    expect(edgeView(live({ discoveryError: "Could not read discovery: timeout" }))).toMatchObject({ state: "error", error: "Could not read discovery: timeout", cause: "relays" });
  });

  it("sums the error up for a short status: the relays, a session dropped, or else (2026-10-07)", () => {
    const pairing = (error: string) => edgeView(live({ pairing: { status: "error", error } })).cause;
    expect(pairing("Could not publish connection details: Publish failed on every relay: Error: https://a.test responded 500. Retrying in 60 s.")).toBe("relays");
    expect(pairing("Session receive queue full")).toBe("session");
    // A frame over the maximum breaks the protocol: not a drop to dial again past (packages/core pairedSession.ts).
    expect(pairing("Session frame too large")).toBe("other");
    expect(pairing("The peer did not finish authentication. Reconnect to try again.")).toBe("session");
    expect(pairing("Invalid session negotiation")).toBe("session");
    expect(pairing("Saved contact key mismatch. This invite is already paired with another participation key.")).toBe("other");
    expect(pairing("No common available transport")).toBe("other");
    expect(edgeView(live({ discoveryError: "Could not publish discovery: Publish failed on every relay: Error: https://a.test responded 500" })).cause).toBe("relays");
    // The pairing's error says more than the relays' when there are both.
    expect(edgeView(live({ pairing: { status: "error", error: "Session receive queue full" }, discoveryError: "Could not read discovery: x" })).cause).toBe("session");
  });

  it("an edge that was live and dropped is reconnecting by itself, with its attempt and when this side dials next", () => {
    const link = { groupsSupport: false, dialAttempts: 3, liveAttempt: { retryAt: 2_000 } };
    expect(edgeView(live({ link, lastSyncAt: 500 }), 1_000)).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 500, reconnecting: true, retryAt: 2_000, attempt: 3 });
    // Live when the app last ran: the same after a restart, before this run saw it live.
    expect(edgeView(live({ link, stored: { id: "edge-1", edgeLive: true } }), 1_000)).toMatchObject({ reconnecting: true, attempt: 3 });
    // Mid-dial it is connecting, still reconnecting; a retry time already past says nothing.
    expect(edgeView(live({ link, lastSyncAt: 500, dataLink: "offering" }), 3_000)).toEqual({ linkId: "edge-1", state: "connecting", lastSeenAt: 500, reconnecting: true, attempt: 3 });
    // The answering side dials nothing: no attempt to count.
    expect(edgeView(live({ link: { groupsSupport: false, dialAttempts: 0 }, lastSyncAt: 500 }))).not.toHaveProperty("attempt");
    // A session dropped is got past by itself; a refused key is not.
    expect(edgeView(live({ link, lastSyncAt: 500, pairing: { status: "error", error: "Session receive queue full" } }), 1_000).reconnecting).toBe(true);
    expect(edgeView(live({ link, lastSyncAt: 500, pairing: { status: "error", error: "Not the member this edge belongs to" } }), 1_000)).not.toHaveProperty("reconnecting");
  });

  it("a member not seen for presence's window is not reconnecting: the app does not dial them, and the row says when they were last seen", () => {
    const link = { groupsSupport: false, dialAttempts: 4, liveAttempt: { retryAt: 0 } };
    const days = 3 * 24 * 3_600_000, at = 1_800_000_000_000;
    // Live, then the member's app closed three days ago: last seen then, not "Reconnecting…" (and a pulsing icon) for good.
    expect(edgeView(live({ link, lastSyncAt: at - days, presence: { lastPacketAt: at - days } }), at)).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: at - days });
    expect(edgeView(live({ link, stored: { id: "edge-1", edgeLive: true }, lastSyncAt: 0, presence: { lastPacketAt: at - days } }), at)).not.toHaveProperty("reconnecting");
    // Back after a restart and no packet read since (the relays keep none of an app closed that long): the resume's
    // window, then not dialled, so not reconnecting either.
    const restarted = { link, stored: { id: "edge-1", edgeLive: true }, lastSyncAt: 0, edgeStartedAt: at };
    expect(edgeView(live(restarted), at + 5_000)).toMatchObject({ reconnecting: true });
    expect(edgeView(live(restarted), at + 11 * 60_000)).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 0 });
    // Within the window (10 minutes) it still is: a member who dropped a minute ago, or whose packet is fresh.
    expect(edgeView(live({ link, lastSyncAt: at - 60_000 }), at)).toMatchObject({ reconnecting: true, attempt: 4 });
    expect(edgeView(live({ link, lastSyncAt: at - days, presence: { lastPacketAt: at - 5_000 } }), at)).toMatchObject({ reconnecting: true });
  });

  it("a member never reached is not reconnecting: nothing dropped", () => {
    expect(edgeView(live({ link: { groupsSupport: false, dialAttempts: 2 }, presence: { lastPacketAt: 5 } }))).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 5 });
  });

  it("an open edge hides an old discovery error: what matters is that it works", () => {
    const view = edgeView(live({ link: { groupsSupport: true }, dataLink: "open", discoveryError: "Could not publish discovery: x", pairing: { status: "ready", transport: "webrtc/1" } }), 7);
    expect(view).toEqual({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: 0 });
  });
});

describe("keptMeshPeer: the edge each member of a private group keeps while it is not on screen (ghostly-agents#1509)", () => {
  /** A roster of `n` members in admission order, the creator first: keys that do not sort the way they were admitted. */
  const roster = (n: number) => Array.from({ length: n }, (_, i) => `k${String.fromCharCode(122 - i)}${i}`);
  /** Every edge kept, as "a|b" with the two keys sorted, and the members on each. */
  const kept = (order: string[], admin?: string) => {
    const edges = new Set<string>();
    for (const me of order) { const peer = keptMeshPeer(order, admin, me)!; expect(peer).toBeDefined(); expect(peer).not.toBe(me); edges.add([me, peer].sort().join("|")); }
    return edges;
  };
  const connected = (order: string[], edges: Set<string>) => {
    const seen = new Set([order[0]]), next = [order[0]];
    while (next.length) {
      const at = next.pop()!;
      for (const edge of edges) {
        const [a, b] = edge.split("|"), other = a === at ? b : b === at ? a : undefined;
        if (other && !seen.has(other)) { seen.add(other); next.push(other); }
      }
    }
    return seen.size === order.length;
  };
  const degrees = (order: string[], edges: Set<string>) => order.map(key => [...edges].filter(edge => edge.split("|").includes(key)).length);
  /** The admin as the creator, as a member in the middle, and as the newest (made admin after it joined). */
  const admins = (order: string[]) => [order[0], order[Math.floor(order.length / 2)], order[order.length - 1]];

  it("makes a tree over the whole roster for 2 to 10 members, whoever the admin is: connected, N - 1 edges, nobody on more than three", () => {
    for (let n = 2; n <= 10; n++) {
      const order = roster(n);
      for (const admin of [...admins(order), undefined]) {
        const edges = kept(order, admin);
        expect(connected(order, edges), `n=${n} admin=${admin}`).toBe(true);
        expect(edges.size, `n=${n} admin=${admin}`).toBe(n - 1);
        expect(Math.max(...degrees(order, edges)), `n=${n} admin=${admin}`).toBeLessThanOrEqual(3);
      }
      // The creator as admin, the common case: two edges each at most, the admin's two as any member's.
      expect(Math.max(...degrees(order, kept(order, order[0])))).toBeLessThanOrEqual(2);
    }
  });

  it("spreads the load: in a group of six every member keeps an edge to another member, and only one of them goes to the admin", () => {
    // Every member used to keep its edge to the admin: an admin with no WebRTC in four groups of six had twenty to answer.
    const order = roster(6), [admin] = order;
    const toAdmin = order.filter(me => keptMeshPeer(order, admin, me) === admin);
    expect(toAdmin).toEqual([order[1], order[5]]);
    expect(meshPeersKeeping(order, admin, admin)).toEqual([order[1], order[5]]);
    expect(keptMeshPeer(order, admin, order[3])).toBe(order[2]);
  });

  it("the admin keeps its edge to the member every later member knows from its welcome, not to the newest, whom nobody knows yet", () => {
    // An admin with one listener for the group: its edge to the second member brings that one the whole roster, and
    // every member knows the second one. An edge to the newest brought nothing: the newest knew it all already.
    for (let n = 2; n <= 10; n++) {
      const order = roster(n);
      expect(keptMeshPeer(order, order[0], order[0])).toBe(order[1]);
      expect(keptMeshPeer(order, order[0], order[1])).toBe(order[0]);
    }
  });

  it("both ends agree: the member at the other end of each kept edge counts it among the edges kept to it, or keeps the same one", () => {
    for (let n = 2; n <= 10; n++) {
      const order = roster(n);
      for (const admin of admins(order)) for (const me of order) {
        const peer = keptMeshPeer(order, admin, me)!;
        expect(meshPeersKeeping(order, admin, peer).includes(me) || keptMeshPeer(order, admin, peer) === me, `n=${n} ${me}->${peer}`).toBe(true);
        for (const keeper of meshPeersKeeping(order, admin, me)) expect(keptMeshPeer(order, admin, keeper)).toBe(me);
      }
    }
  });

  it("each member keeps an edge to one it knows: one admitted before it, the newest the admin's, which admitted it", () => {
    for (let n = 2; n <= 10; n++) {
      const order = roster(n), admin = order[0];
      for (const me of order.slice(1)) {
        const peer = keptMeshPeer(order, admin, me)!;
        expect(order.indexOf(peer) < order.indexOf(me) || me === admin, `n=${n} ${me}`).toBe(true);
      }
      // A member that does not know the members admitted after it yet keeps the same edge, unless it was the newest.
      for (let known = 2; known < n; known++) for (const me of order.slice(1, known - 1)) {
        expect(keptMeshPeer(order.slice(0, known), admin, me)).toBe(keptMeshPeer(order, admin, me));
      }
    }
  });

  it("is stable: a join changes what one member keeps (the newest before it), a leave what two keep at most", () => {
    const moved = (before: string[], after: string[], admin: string) => after.filter(me => before.includes(me) && keptMeshPeer(before, admin, me) !== keptMeshPeer(after, admin, me));
    for (let n = 2; n <= 10; n++) {
      const order = roster(n), [admin] = order;
      const joined = [...order, "newcomer"];
      expect(moved(order, joined, admin), `join n=${n}`).toEqual(n > 2 ? [order[n - 1]] : []);
      expect(keptMeshPeer(joined, admin, "newcomer")).toBe(admin);
      for (const gone of order) {
        const left = order.filter(key => key !== gone);
        if (left.length < 2) continue;
        const nextAdmin = gone === admin ? left[0] : admin;
        expect(moved(order, left, nextAdmin).length, `leave n=${n} ${gone}`).toBeLessThanOrEqual(2);
        expect(connected(left, kept(left, nextAdmin))).toBe(true);
      }
    }
  });

  it("nothing for a member not in the roster, or alone in it", () => {
    expect(keptMeshPeer(["a"], "a", "a")).toBeUndefined();
    expect(keptMeshPeer(["a", "b"], "a", "c")).toBeUndefined();
    expect(keptMeshPeer(["a", "b"], "a", "b")).toBe("a");
    expect(keptMeshPeer(["a", "b"], "a", "a")).toBe("b");
  });
});
