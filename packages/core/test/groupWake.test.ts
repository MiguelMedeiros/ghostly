import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { toBase64Url } from "../src/bytes";
import { createIdentity } from "../src/identity";
import {
  GROUP_WAKE_GROUP_LIMIT, GROUP_WAKE_GROUP_WINDOW_MS, GROUP_WAKE_MEMBER_INTERVAL_MS, GroupWakeLimiter, groupWakeFrame, groupWakes, mentionedMembers, parseGroupWakeFrame,
} from "../src/groupWake";
import { newWakeToken, type WakeTarget } from "../src/pairedWake";
import { generateVapidKeys } from "../src/webPush";

// covers: push.wake.group

const key = () => createIdentity().pubKeyZ32;
function target(): WakeTarget {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: toBase64Url(p256.getPublicKey(p256.utils.randomSecretKey(), false)),
    auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), vapid: generateVapidKeys(), token: newWakeToken(),
  };
}
/** "@Name " for each key, and the mentions that place them. */
function mentioning(...keys: string[]) {
  let text = "";
  const mentions = keys.map(k => { const o = Array.from(text).length; text += "@Name "; return { k, o, l: 5 }; });
  return { text: `${text}are you in?`, mentions };
}

describe("group-wake: a member shares its subscription on an edge", () => {
  it("round-trips for its own group, and says to forget it with null", () => {
    const shared = target();
    const frame = JSON.parse(JSON.stringify(groupWakeFrame("g1", shared)));
    expect(frame).toMatchObject({ t: "group-wake", g: "g1" });
    expect(parseGroupWakeFrame(frame, "g1")).toEqual(shared);
    expect(parseGroupWakeFrame(groupWakeFrame("g1", null), "g1")).toBeNull();
  });

  it("says nothing (undefined) for another group, another frame or a malformed target", () => {
    const frame = groupWakeFrame("g1", target());
    expect(parseGroupWakeFrame(frame, "g2")).toBeUndefined();
    expect(parseGroupWakeFrame({ ...frame, t: "paired-wake" }, "g1")).toBeUndefined();
    expect(parseGroupWakeFrame({ ...frame, w: { ...frame.w!, e: "http://fcm.googleapis.com/x" } }, "g1")).toBeUndefined();
    expect(parseGroupWakeFrame({ ...frame, w: { ...frame.w!, vk: generateVapidKeys().privateKey } }, "g1")).toBeUndefined();
  });
});

describe("whom a message wakes", () => {
  it("the members it names by key, once each; never everyone, nor a place that does not hold", () => {
    const [a, b] = [key(), key()];
    const { text, mentions } = mentioning(a, b, a, "*");
    expect(mentionedMembers(mentions, text)).toEqual([a, b]);
    expect(mentionedMembers([], "hello")).toEqual([]);
    expect(mentionedMembers(undefined, "hello")).toEqual([]);
    expect(mentionedMembers([{ k: a, o: 3, l: 5 }], "no mention here")).toEqual([]);
    // Offsets count the trimmed text, as the author's session sends it.
    expect(mentionedMembers([{ k: a, o: 0, l: 5 }], "  @Name hi")).toEqual([a]);
  });

  it("a mention wakes a member that shared how and is away; no mention, no target or a live member wakes nobody", () => {
    const [away, live, silent, other] = [key(), key(), key(), key()];
    const targets = new Map([[away, "edge-away"], [live, "edge-live"], [other, "edge-other"]]);
    const run = (text: string, mentions: { k: string; o: number; l: number }[], limiter = new GroupWakeLimiter()) => groupWakes({
      group: "g", text, mentions, limiter, now: 1_000, target: m => targets.get(m), reachable: m => m === live,
    });
    const named = mentioning(away, live, silent);
    expect(run(named.text, named.mentions)).toEqual([{ member: away, target: "edge-away" }]);
    expect(run("hello everyone", [])).toEqual([]);
    const all = mentioning("*");
    expect(run(all.text, all.mentions)).toEqual([]);
  });

  it("one per member every 5 minutes, whatever group; four per group a minute; back live, at once", () => {
    const limiter = new GroupWakeLimiter();
    const [a, b] = [key(), key()];
    expect(limiter.take("g1", a, 0)).toBe(true);
    expect(limiter.take("g1", a, 1_000)).toBe(false);
    expect(limiter.take("g2", a, 2_000)).toBe(false);
    expect(limiter.take("g1", a, GROUP_WAKE_MEMBER_INTERVAL_MS)).toBe(true);
    limiter.reset(a);
    expect(limiter.take("g2", a, GROUP_WAKE_MEMBER_INTERVAL_MS + 1)).toBe(true);
    expect(limiter.take("g2", b, GROUP_WAKE_MEMBER_INTERVAL_MS + 2)).toBe(true);

    const storm = new GroupWakeLimiter();
    const members = Array.from({ length: 16 }, key);
    const named = mentioning(...members);
    const first = groupWakes({ group: "g", ...named, limiter: storm, now: 0, target: m => m, reachable: () => false });
    expect(first).toHaveLength(GROUP_WAKE_GROUP_LIMIT);
    expect(groupWakes({ group: "g", ...named, limiter: storm, now: 1_000, target: m => m, reachable: () => false })).toHaveLength(0);
    // Another group is counted apart; this one has room again a minute later, for members not woken yet.
    expect(groupWakes({ group: "h", ...named, limiter: storm, now: 1_000, target: m => m, reachable: () => false })).toHaveLength(GROUP_WAKE_GROUP_LIMIT);
    const later = groupWakes({ group: "g", ...named, limiter: storm, now: GROUP_WAKE_GROUP_WINDOW_MS, target: m => m, reachable: () => false });
    expect(later).toHaveLength(GROUP_WAKE_GROUP_LIMIT);
    expect(later.some(w => first.some(f => f.member === w.member))).toBe(false);
  });
});
