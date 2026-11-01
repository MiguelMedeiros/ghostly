import { describe, expect, it } from "vitest";
import { edgeView, type EdgeLive } from "../src/engine/groupEdges";
// covers: groups.connection, groups.connection.auto-reconnect

/** An edge's link as the engine keeps it, closed and never heard from unless a test says otherwise. */
const live = (patch: Partial<EdgeLive> = {}): EdgeLive => ({
  stored: { id: "edge-1" }, link: { groupsSupport: false }, dataLink: "idle", presence: { lastPacketAt: 0 }, lastSyncAt: 0, ...patch,
});

describe("edgeView: how a group's edge to one member is doing", () => {
  it("open means group frames flow: reachable now, over the transport the pairing chose", () => {
    expect(edgeView(live({ link: { groupsSupport: true }, dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } }), 1_000))
      .toEqual({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: 1_000 });
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
    expect(edgeView(live({ presence: { lastPacketAt: 400 }, lastSyncAt: 300 }))).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 400, reconnecting: true });
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
    expect(edgeView(live({ link, lastSyncAt: 500, pairing: { status: "error", error: "Session receive queue full" } })).reconnecting).toBe(true);
    expect(edgeView(live({ link, lastSyncAt: 500, pairing: { status: "error", error: "Not the member this edge belongs to" } }))).not.toHaveProperty("reconnecting");
  });

  it("a member never reached is not reconnecting: nothing dropped", () => {
    expect(edgeView(live({ link: { groupsSupport: false, dialAttempts: 2 }, presence: { lastPacketAt: 5 } }))).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 5 });
  });

  it("an open edge hides an old discovery error: what matters is that it works", () => {
    const view = edgeView(live({ link: { groupsSupport: true }, dataLink: "open", discoveryError: "Could not publish discovery: x", pairing: { status: "ready", transport: "webrtc/1" } }), 7);
    expect(view).toEqual({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: 7 });
  });
});
