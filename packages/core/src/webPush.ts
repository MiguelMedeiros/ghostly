import { p256 } from "@noble/curves/nist.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";

/*
 * Web Push, the sending side, with no server: what a Ghostly app needs to wake a contact's closed web app
 * through the contact's own push subscription (WISP 401 § Wake-up push). Two standards:
 * - VAPID (RFC 8292): the request carries a short JWT signed with the key pair the subscription was made
 *   with, so the push service accepts it. The contact shares that key pair's private half with its paired
 *   contacts, so each of them can sign; nothing else can be done with it.
 * - Message encryption (RFC 8291, `aes128gcm`, RFC 8188): the body is encrypted to the subscription's
 *   P-256 key and auth secret. The push service (Google, Apple, Mozilla) sees only ciphertext, and only
 *   the browser that subscribed can read it.
 */

/** A VAPID key pair: the public key as an uncompressed P-256 point, the private one as its 32-byte scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** What a browser's `PushSubscription` gives: where to post, and the keys to encrypt to. */
export interface PushTarget {
  endpoint: string;
  /** The subscription's P-256 public key, uncompressed, base64url (`getKey("p256dh")`). */
  p256dh: string;
  /** Its 16-byte auth secret, base64url (`getKey("auth")`). */
  auth: string;
}

/** An HTTP request, ready for `fetch` or a relay. */
export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export class WebPushError extends Error {}

const RECORD_SIZE = 4096;
/** Push services refuse a token valid for more than 24 hours; 12 leaves room for skewed clocks. */
const TOKEN_SECONDS = 12 * 60 * 60;

export function generateVapidKeys(): VapidKeys {
  const secret = p256.utils.randomSecretKey();
  return { publicKey: toBase64Url(p256.getPublicKey(secret, false)), privateKey: toBase64Url(secret) };
}

function point(value: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try { bytes = fromBase64Url(value); } catch { throw new WebPushError(`${what} is not base64url`); }
  if (bytes.length !== 65 || bytes[0] !== 4) throw new WebPushError(`${what} is not an uncompressed P-256 key`);
  try { p256.Point.fromBytes(bytes); } catch { throw new WebPushError(`${what} is not a point on P-256`); }
  return bytes;
}

/** Whether a VAPID key pair is well formed and its halves belong together. */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const secret = fromBase64Url(keys.privateKey);
    return secret.length === 32 && toBase64Url(p256.getPublicKey(secret, false)) === toBase64Url(point(keys.publicKey, "The VAPID key"));
  } catch {
    return false;
  }
}

/**
 * The push services a browser subscribes with: Google (Chrome, Edge on Android, Brave, Opera), Apple (Safari), Mozilla
 * (Firefox), Microsoft (Edge on Windows). The same list as the push relay's (infra/services/push-relay/relay.mjs).
 */
export const PUSH_SERVICE_HOSTS: readonly RegExp[] = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

/**
 * Only https, on one of the push services' host names and their default port, without credentials. The endpoint came
 * from a contact: it must not turn this app into a way to post to the contact's choice of address, local or not.
 */
export function checkPushEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new WebPushError("The push endpoint is not a URL"); }
  if (url.protocol !== "https:") throw new WebPushError("The push endpoint is not https");
  if (url.username || url.password) throw new WebPushError("The push endpoint carries credentials");
  if (url.port) throw new WebPushError("The push endpoint names a port");
  const host = url.hostname.toLowerCase();
  if (!PUSH_SERVICE_HOSTS.some(pattern => pattern.test(host))) throw new WebPushError("The push endpoint is not a push service");
  if (endpoint.length > 2048) throw new WebPushError("The push endpoint is too long");
  return url;
}

/** `Authorization: vapid t=<JWT>, k=<public key>` for a request to `endpoint` (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const audience = checkPushEndpoint(endpoint).origin;
  const encode = (value: object) => toBase64Url(utf8Encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: audience, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: subject })}`;
  const signature = p256.sign(utf8Encode(unsigned), fromBase64Url(keys.privateKey));
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * `plaintext` encrypted for a subscription (RFC 8291 with RFC 8188 `aes128gcm`, one record). `sender` fixes
 * the sender's ephemeral key and salt, for the RFC's test vector only.
 */
export function encryptPushPayload(plaintext: Uint8Array, target: Pick<PushTarget, "p256dh" | "auth">, sender?: { secret: Uint8Array; salt: Uint8Array }): Uint8Array {
  const receiver = point(target.p256dh, "The subscription key");
  let auth: Uint8Array;
  try { auth = fromBase64Url(target.auth); } catch { throw new WebPushError("The auth secret is not base64url"); }
  if (auth.length !== 16) throw new WebPushError("The auth secret is not 16 bytes");
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new WebPushError("The payload is too long for one record");

  const secret = sender?.secret ?? p256.utils.randomSecretKey();
  const salt = sender?.salt ?? randomBytes(16);
  const senderPublic = p256.getPublicKey(secret, false);
  const shared = p256.getSharedSecret(secret, receiver).subarray(1);

  const keyInfo = concatBytes(utf8Encode("WebPush: info\0"), receiver, senderPublic);
  const ikm = hkdf(sha256, shared, auth, keyInfo, 32);
  const cek = hkdf(sha256, ikm, salt, utf8Encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(sha256, ikm, salt, utf8Encode("Content-Encoding: nonce\0"), 12);
  // The last (and only) record ends with the delimiter 0x02, no padding.
  const ciphertext = gcm(cek, nonce).encrypt(concatBytes(plaintext, Uint8Array.of(2)));

  const header = new Uint8Array(16 + 4 + 1 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  header.set(senderPublic, 21);
  return concatBytes(header, ciphertext);
}

/**
 * The receiving side of `encryptPushPayload`, which a browser does for its service worker. Here for tests and
 * for a push service stand-in; the app itself never decrypts a push.
 */
export function decryptPushPayload(body: Uint8Array, receiverSecret: Uint8Array, authSecret: Uint8Array): Uint8Array {
  if (body.length < 21) throw new WebPushError("Too short");
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const receiverPublic = p256.getPublicKey(receiverSecret, false);
  const shared = p256.getSharedSecret(receiverSecret, senderPublic).subarray(1);
  const keyInfo = concatBytes(utf8Encode("WebPush: info\0"), receiverPublic, senderPublic);
  const ikm = hkdf(sha256, shared, authSecret, keyInfo, 32);
  const cek = hkdf(sha256, ikm, salt, utf8Encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(sha256, ikm, salt, utf8Encode("Content-Encoding: nonce\0"), 12);
  const padded = gcm(cek, nonce).decrypt(body.subarray(21 + idLength));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new WebPushError("No last-record delimiter");
  return padded.subarray(0, end);
}

/**
 * The whole request that wakes a subscription: POST, encrypted body, VAPID authorization, a short time to live
 * (a wake-up an hour late is no use) and high urgency (a phone on battery saver still gets it).
 */
export function pushRequest(target: PushTarget, keys: VapidKeys, payload: Uint8Array, options: { subject: string; ttlSeconds?: number; now?: number }): PushRequest {
  checkPushEndpoint(target.endpoint);
  const body = encryptPushPayload(payload, target);
  return {
    url: target.endpoint,
    headers: {
      Authorization: vapidAuthorization(target.endpoint, keys, options.subject, options.now),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttlSeconds ?? 60 * 60),
      Urgency: "high",
    },
    body,
  };
}
