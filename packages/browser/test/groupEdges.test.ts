import { describe, expect, it } from "vitest";
import { edgeView, type EdgeLive } from "../src/engine/groupEdges";
// covers: groups.connection

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
    expect(edgeView(live({ presence: { lastPacketAt: 400 }, lastSyncAt: 300 }))).toEqual({ linkId: "edge-1", state: "waiting", lastSeenAt: 400 });
    expect(edgeView(live({ presence: { lastPacketAt: 100 }, lastSyncAt: 300 })).lastSeenAt).toBe(300);
    expect(edgeView(live()).lastSeenAt).toBe(0);
  });

  it("a failed pairing or discovery says why; no transport is claimed while it is down", () => {
    expect(edgeView(live({ pairing: { status: "error", error: "Not the member this edge belongs to", transport: "webrtc/1" } })))
      .toEqual({ linkId: "edge-1", state: "error", lastSeenAt: 0, error: "Not the member this edge belongs to" });
    expect(edgeView(live({ discoveryError: "Could not read discovery: timeout" }))).toMatchObject({ state: "error", error: "Could not read discovery: timeout" });
  });

  it("an open edge hides an old discovery error: what matters is that it works", () => {
    const view = edgeView(live({ link: { groupsSupport: true }, dataLink: "open", discoveryError: "Could not publish discovery: x", pairing: { status: "ready", transport: "webrtc/1" } }), 7);
    expect(view).toEqual({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: 7 });
  });
});
