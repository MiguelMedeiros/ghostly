import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "../src/bytes";
import {
  WebPushError, checkPushEndpoint, decryptPushPayload, encryptPushPayload, generateVapidKeys, pushRequest, vapidAuthorization, vapidKeysMatch,
} from "../src/webPush";

// covers: push.wake.crypto

describe("message encryption (RFC 8291)", () => {
  // RFC 8291, Appendix A.
  const vector = {
    plaintext: "When I grow up, I want to be a watermelon",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };

  it("gives the RFC's own test vector", () => {
    const body = encryptPushPayload(utf8Encode(vector.plaintext), { p256dh: vector.receiverPublic, auth: vector.auth },
      { secret: fromBase64Url(vector.senderPrivate), salt: fromBase64Url(vector.salt) });
    expect(toBase64Url(body)).toBe(vector.body);
    expect(utf8Decode(decryptPushPayload(body, fromBase64Url(vector.receiverPrivate), fromBase64Url(vector.auth)))).toBe(vector.plaintext);
  });

  it("round-trips with fresh keys, and a new sender key and salt each time", () => {
    const secret = p256.utils.randomSecretKey();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const target = { p256dh: toBase64Url(p256.getPublicKey(secret, false)), auth: toBase64Url(auth) };
    const a = encryptPushPayload(utf8Encode("wake"), target);
    const b = encryptPushPayload(utf8Encode("wake"), target);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
    expect(utf8Decode(decryptPushPayload(a, secret, auth))).toBe("wake");
    expect(() => decryptPushPayload(a, secret, crypto.getRandomValues(new Uint8Array(16)))).toThrow();
  });

  it("refuses keys that are not a subscription's", () => {
    expect(() => encryptPushPayload(utf8Encode("x"), { p256dh: "AAAA", auth: vector.auth })).toThrow(WebPushError);
    expect(() => encryptPushPayload(utf8Encode("x"), { p256dh: vector.receiverPublic, auth: "AAAA" })).toThrow(WebPushError);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a token for the push service's origin with the subscription's key pair", () => {
    const keys = generateVapidKeys();
    expect(vapidKeysMatch(keys)).toBe(true);
    expect(vapidKeysMatch({ ...keys, privateKey: generateVapidKeys().privateKey })).toBe(false);
    const now = 1_800_000_000_000;
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://ghostly.tools", now);
    const [, token, key] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token!.split(".");
    expect(JSON.parse(utf8Decode(fromBase64Url(head!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(utf8Decode(fromBase64Url(claims!)))).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 12 * 3600, sub: "https://ghostly.tools" });
    expect(p256.verify(fromBase64Url(signature!), utf8Encode(`${head}.${claims}`), fromBase64Url(keys.publicKey))).toBe(true);
  });
});

describe("where a push may go", () => {
  it.each(["https://fcm.googleapis.com/fcm/send/x", "https://web.push.apple.com/QAB", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/x"])("%s", (url) => {
    expect(checkPushEndpoint(url).href).toBe(url);
  });
  it.each(["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://router.local/x", "https://intranet/x", "https://u:p@push.example.com/x", "not a url",
    // A public host name that is not a push service may still resolve to anything, a private address among them.
    "https://push.example.com/x", "https://127.0.0.1.nip.io/x", "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x"])("not %s", (url) => {
    expect(() => checkPushEndpoint(url)).toThrow(WebPushError);
  });

  it("the whole request: encrypted body, authorization, short TTL, high urgency", () => {
    const secret = p256.utils.randomSecretKey();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const request = pushRequest({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: toBase64Url(p256.getPublicKey(secret, false)), auth: toBase64Url(auth) },
      generateVapidKeys(), utf8Encode("token"), { subject: "https://ghostly.tools" });
    expect(request.url).toBe("https://fcm.googleapis.com/fcm/send/abc");
    expect(request.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "3600", Urgency: "high" });
    expect(request.headers.Authorization).toMatch(/^vapid t=/);
    expect(utf8Decode(decryptPushPayload(request.body, secret, auth))).toBe("token");
  });
});
