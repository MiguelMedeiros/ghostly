import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { fromBase64Url, toBase64Url, utf8Decode } from "../src/bytes";
import { KNOWN_SESSION_CAPABILITIES } from "../src/pairedCapabilities";
import {
  WAKE_CAPABILITY, WAKE_INTERVAL_MS, WakeLimiter, newWakeToken, parseWakeFrame, readWakePayload, relayRequest, wakeFrame, wakeRequest, type WakeTarget,
} from "../src/pairedWake";
import { decryptPushPayload, generateVapidKeys } from "../src/webPush";

// covers: push.wake.exchange, push.wake.rate-limit

function subscription() {
  const secret = p256.utils.randomSecretKey();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const target: WakeTarget = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc:def", p256dh: toBase64Url(p256.getPublicKey(secret, false)), auth: toBase64Url(auth),
    vapid: generateVapidKeys(), token: newWakeToken(),
  };
  return { target, secret, auth };
}

describe("sharing a push subscription with a contact", () => {
  it("is a session capability like the others", () => {
    expect(WAKE_CAPABILITY).toBe("wake/1");
    expect(KNOWN_SESSION_CAPABILITIES).toContain("wake/1");
  });

  it("round-trips through the frame", () => {
    const { target } = subscription();
    const frame = JSON.parse(JSON.stringify(wakeFrame(target)));
    expect(frame.t).toBe("paired-wake");
    expect(parseWakeFrame(frame)).toEqual(target);
  });

  it("null says: forget what I shared", () => {
    expect(wakeFrame(null)).toEqual({ t: "paired-wake", w: null });
    expect(parseWakeFrame({ t: "paired-wake", w: null })).toBeNull();
  });

  it("a malformed frame says nothing (undefined), so what was shared before stands", () => {
    const { target } = subscription();
    const good = wakeFrame(target).w!;
    const bad = [
      {},
      { w: "x" },
      { w: { ...good, e: "http://fcm.googleapis.com/x" } },
      { w: { ...good, e: "https://192.168.1.1/push" } },
      { w: { ...good, e: "https://localhost/push" } },
      { w: { ...good, k: "short" } },
      { w: { ...good, vk: generateVapidKeys().privateKey } },
      { w: { ...good, p: "not base64url!" } },
    ];
    for (const frame of bad) expect(parseWakeFrame(frame as Record<string, unknown>)).toBeUndefined();
  });
});

describe("the wake-up itself", () => {
  it("carries only the contact's token for the chat, encrypted to its subscription", () => {
    const { target, secret, auth } = subscription();
    const request = wakeRequest(target);
    expect(request.url).toBe(target.endpoint);
    expect(request.headers.TTL).toBe("3600");
    const text = utf8Decode(decryptPushPayload(request.body, secret, auth));
    expect(JSON.parse(text)).toEqual({ wake: 1, k: target.token });
    expect(readWakePayload(text)).toBe(target.token);
  });

  it("the receiver reads nothing else as a wake-up", () => {
    for (const text of [null, "", "{}", '{"wake":2,"k":"aaaaaaaaaaaaaaaaaaaaaa"}', '{"wake":1,"k":"<script>"}', "not json", "x".repeat(500)]) {
      expect(readWakePayload(text)).toBeNull();
    }
  });

  it("goes through a relay as the finished request", () => {
    const { target } = subscription();
    const request = wakeRequest(target);
    const relayed = relayRequest(request);
    expect(relayed.endpoint).toBe(target.endpoint);
    expect(relayed.headers).toEqual(request.headers);
    expect(fromBase64Url(relayed.body)).toEqual(request.body);
  });
});

describe("at most one wake-up per contact per interval", () => {
  it("a burst of messages is one push; a new one once the interval passed or the contact came back", () => {
    const limiter = new WakeLimiter();
    const t = 1_800_000_000_000;
    expect(limiter.take("ana", t)).toBe(true);
    expect(limiter.take("ana", t + 1000)).toBe(false);
    expect(limiter.take("bo", t + 1000)).toBe(true);
    expect(limiter.take("ana", t + WAKE_INTERVAL_MS - 1)).toBe(false);
    expect(limiter.take("ana", t + WAKE_INTERVAL_MS)).toBe(true);
    limiter.reset("ana");
    expect(limiter.take("ana", t + WAKE_INTERVAL_MS + 1)).toBe(true);
  });
});
