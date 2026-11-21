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
    // The contact's retry after a failure takes its failed entry over, at its time; a success leaves no error.
    t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof: Q, provider: "nostr" }, 3);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: Q, ok: true }, 4);
    expect(t).toEqual([expect.objectContaining({ proof: Q, state: "verified", at: 1 })]);
    expect(t[0]).not.toHaveProperty("error");
    // This side's retry after a failure is a new entry; its success clears nothing of the old one.
    let m = applyIdentityEvent([], { type: "shared", side: "mine", proof: P, provider: "nostr" }, 1);
    m = applyIdentityEvent(m, { type: "result", side: "mine", proof: P, ok: false, error: "Bad" }, 2);
    m = applyIdentityEvent(m, { type: "shared", side: "mine", proof: P, provider: "nostr" }, 3);
    m = applyIdentityEvent(m, { type: "result", side: "mine", proof: P, ok: true }, 4);
    expect(m.map(e => e.state)).toEqual(["failed", "verified"]);
  });

  it("keeps one unverified line of the contact's per kind, so its attempts never push out the others", () => {
    let t = applyIdentityEvent([], { type: "shared", side: "theirs", proof: P, provider: "nostr" }, 1);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: P, provider: "nostr", subject: "npub1x", ok: true }, 2);
    t = applyIdentityEvent(t, { type: "stopped", side: "mine", proof: Q, provider: "ssh", subject: "k", reason: "revoked" }, 3);
    const kept = [...t];
    for (let i = 0; i < IDENTITY_TIMELINE_MAX * 2; i++) {
      const proof = (i + 1).toString(16).padStart(64, "0"), presented = "c".repeat(63) + (i % 10);
      t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof, provider: "nostr" }, 10 + i);
      // Every other one presented and failed, under another proof than the one requested, or one whose start is gone.
      if (i % 2) t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: presented, requested: i % 4 === 1 ? proof : undefined, provider: "nostr", subject: "fake", ok: false, error: "Bad" }, 10 + i);
    }
    expect(t.slice(0, 2)).toEqual(kept);
    expect(t.slice(2)).toEqual([{ id: `theirs:${"0".repeat(63)}1:0`, proof: "c".repeat(63) + "9", side: "theirs", kind: "shared", provider: "nostr", state: "failed", subject: "fake", error: "Bad", at: 10 }]);
    // Another kind has a line of its own; a verified outcome whose start is gone is a line of its own, as before.
    t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof: Q, provider: "ssh" }, 500);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: "d".repeat(64), provider: "nostr", subject: "npub1y", ok: true }, 501);
    expect(t.slice(2).map(e => `${e.provider}:${e.state}`)).toEqual(["nostr:failed", "ssh:verifying", "nostr:verified"]);
  });

  it("writes a stop once, and an outcome whose start is gone on its own", () => {
    let t = applyIdentityEvent([], { type: "stopped", side: "mine", proof: P, provider: "ssh", subject: "k", reason: "withdrawn" }, 1);
    t = applyIdentityEvent(t, { type: "stopped", side: "mine", proof: P, provider: "ssh", reason: "withdrawn" }, 2);
    expect(t).toHaveLength(1);
    t = applyIdentityEvent(t, { type: "result", side: "theirs", proof: Q, provider: "ssh", subject: "k", ok: true }, 3);
    expect(t[1]).toMatchObject({ side: "theirs", kind: "shared", state: "verified", at: 3 });
    expect(applyIdentityEvent([], { type: "result", side: "mine", proof: Q, ok: true }, 3)).toEqual([]);
  });

  it("a withdrawal later found revoked (a removal) turns into a revocation, in place and at its time; never back", () => {
    let t = applyIdentityEvent([], { type: "shared", side: "theirs", proof: P, provider: "nostr", subject: "npub1x" }, 1);
    t = applyIdentityEvent(t, { type: "stopped", side: "theirs", proof: P, provider: "nostr", reason: "withdrawn" }, 2);
    t = applyIdentityEvent(t, { type: "stopped", side: "theirs", proof: P, provider: "nostr", reason: "revoked" }, 3);
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ kind: "stopped", reason: "revoked", subject: "npub1x", at: 2 });
    t = applyIdentityEvent(t, { type: "stopped", side: "theirs", proof: P, provider: "nostr", reason: "withdrawn" }, 4);
    expect(t[1]).toMatchObject({ reason: "revoked" });
  });

  it("keeps the newest entries only, and tells the chat list when the contact last shared", () => {
    let t: IdentityTimelineEntry[] = [];
    for (let i = 0; i < IDENTITY_TIMELINE_MAX + 5; i++) {
      const side = i % 2 ? "mine" : "theirs", proof = i.toString(16).padStart(64, "0");
      t = applyIdentityEvent(t, { type: "shared", side, proof, provider: "nostr" }, i);
      // The contact's shares verified (one not verified would take over its earlier one).
      if (side === "theirs") t = applyIdentityEvent(t, { type: "result", side, proof, ok: true }, i);
    }
    expect(t).toHaveLength(IDENTITY_TIMELINE_MAX);
    expect(t[0].at).toBe(5);
    expect(lastSharedWithMe(t)).toBe(IDENTITY_TIMELINE_MAX + 4);
    expect(lastSharedWithMe(undefined)).toBe(0);
  });

  it("never gives a new entry the id of one still kept, once the bound cut a proof's first entry", () => {
    let t = applyIdentityEvent([], { type: "shared", side: "mine", proof: P, provider: "nostr" }, 0);
    t = applyIdentityEvent(t, { type: "result", side: "mine", proof: P, ok: true }, 1);
    t = applyIdentityEvent(t, { type: "stopped", side: "mine", proof: P, provider: "nostr", reason: "withdrawn" }, 2);
    t = applyIdentityEvent(t, { type: "shared", side: "mine", proof: P, provider: "nostr" }, 3);
    for (let i = 0; i < IDENTITY_TIMELINE_MAX - 2; i++) {
      const proof = i.toString(16).padStart(64, "0");
      t = applyIdentityEvent(t, { type: "shared", side: "theirs", proof, provider: "nostr" }, 4 + i);
      t = applyIdentityEvent(t, { type: "result", side: "theirs", proof, ok: true }, 4 + i);
    }
    t = applyIdentityEvent(t, { type: "stopped", side: "mine", proof: P, provider: "nostr", reason: "withdrawn" }, 200);
    expect(t).toHaveLength(IDENTITY_TIMELINE_MAX);
    expect(new Set(t.map(e => e.id)).size).toBe(t.length);
    expect(t.filter(e => e.proof === P).map(e => e.id)).toEqual([`mine:${P}:2`, `mine:${P}:3`]);
  });
});
