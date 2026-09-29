import { describe, expect, it } from "vitest";
import { applyIdentityEvent, IDENTITY_TIMELINE_MAX, lastSharedWithMe, type IdentityTimelineEntry } from "../src/identityTimeline";
// covers: proofs.timeline

const P = "a".repeat(64), Q = "b".repeat(64);

describe("identity timeline", () => {
  it("settles a share in place and keeps its time", () => {
    let t = applyIdentityEvent([], { type: "shared", side: "theirs", proof: P, provider: "nostr" }, 1_000);
    t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof: P, provider: "nostr" }, 2_000);
    expect(t).toEqual([{ id: `theirs:${P}:0`, proof: P, side: "theirs", kind: "shared", provider: "nostr", state: "verifying", at: 1_000 }]);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: P, provider: "nostr", subject: "npub1x", ok: true }, 3_000);
    expect(t).toEqual([expect.objectContaining({ state: "verified", subject: "npub1x", at: 1_000 })]);
    // Asked again after it was verified (a reconnect, a second share): the entry stays verified until an outcome.
    t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof: P, provider: "nostr" }, 4_000);
    expect(t).toEqual([expect.objectContaining({ state: "verified" })]);
  });

  it("follows a presentation of another proof than the one requested", () => {
    let t = applyIdentityEvent([], { type: "shared", side: "theirs", proof: P, provider: "nostr" }, 1);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: Q, requested: P, provider: "nostr", subject: "npub1x", ok: false, error: "Bad" }, 2);
    expect(t).toEqual([expect.objectContaining({ proof: Q, state: "failed", error: "Bad" })]);
    // A retry after a failure is a new entry; its success clears nothing of the old one.
    t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof: Q, provider: "nostr" }, 3);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: Q, ok: true }, 4);
    expect(t.map(e => e.state)).toEqual(["failed", "verified"]);
    expect(t[1]).not.toHaveProperty("error");
  });

  it("writes a stop once, and an outcome whose start is gone on its own", () => {
    let t = applyIdentityEvent([], { type: "stopped", side: "mine", proof: P, provider: "ssh", subject: "k", reason: "withdrawn" }, 1);
    t = applyIdentityEvent(t, { type: "stopped", side: "mine", proof: P, provider: "ssh", reason: "withdrawn" }, 2);
    expect(t).toHaveLength(1);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: Q, provider: "ssh", subject: "k", ok: true }, 3);
    expect(t[1]).toMatchObject({ side: "theirs", kind: "shared", state: "verified", at: 3 });
    expect(applyIdentityEvent([], { type: "result", side: "mine", proof: Q, ok: true }, 3)).toEqual([]);
  });

  it("keeps the newest entries only, and tells the chat list when the contact last shared", () => {
    let t: IdentityTimelineEntry[] = [];
    for (let i = 0; i < IDENTITY_TIMELINE_MAX + 5; i++) t = applyIdentityEvent(t, { type: "shared", side: i % 2 ? "mine" : "theirs", proof: i.toString(16).padStart(64, "0"), provider: "nostr" }, i);
    expect(t).toHaveLength(IDENTITY_TIMELINE_MAX);
    expect(t[0].at).toBe(5);
    expect(lastSharedWithMe(t)).toBe(IDENTITY_TIMELINE_MAX + 4);
    expect(lastSharedWithMe(undefined)).toBe(0);
  });
});
