import { WakeLimiter, deviceWakeRequest, newWakeToken, parseWakeFrame, relayRequest, type DeviceFrame, type PushRequest, type WakeTarget } from "@ghostly/core";
import type { WakeSubscription } from "../shared/types";
import { MAX_ALLOWED_TOKENS, type DevicePatch, type DevicePush, type DevicePushTarget, type DeviceRecord } from "./state";

/*
 * Push and the phone (WISP 06 § Push and the phone). Three things, all pure here; `links.ts` carries the frame, the
 * engine (`node.ts`) keeps the profile's target, and the push worker (`apps/web/src/sw`) picks what a push shows.
 *
 * - **The profile's push target survives a switch.** Contacts hold one target per chat (`settings.wake`, WISP 401 §
 *   Wake-up push) and learn it only on a live session; a desktop has no subscription of its own. The target moves with
 *   the profile and names the device it belongs to (`WakeSubscription.device`), and the active device keeps it by these
 *   rules (`profileWakeAfter`): its own subscription wins; another device's is kept; that device's new subscription
 *   replaces it, with the chats' tokens unchanged (its push worker knows them); that device's "none" clears it; with no
 *   target at all, a device's own is taken. A removed device's target goes with it (`profileWakeOnRemoval`).
 * - **The device link can wake a device.** Each device with a subscription shares it with each other device in a
 *   `device-wake` frame, under a token it made for that device alone:
 *
 *       {"t":"device-wake","w":{"e":"https://…","p":"<p256dh>","a":"<auth>","vp":"<VAPID public>","vk":"<VAPID private>","k":"<token>"}}
 *       {"t":"device-wake","w":null}                     (no subscription here: forget what I shared)
 *
 *   It is said on every session of the link, as `paired-wake` is on a chat's. A device that asks a handoff of one whose
 *   link is down posts `{"wake":1,"k":"<token>","d":1}` to it (`deviceWakeRequest`); its worker shows "<device> wants to
 *   take over" for a token it gave one of its own devices, and for nothing else.
 * - Everything a standby needs of it is in the device record (`DevicePush`), never in the profile's database.
 */

export const DEVICE_WAKE_FRAME = "device-wake";

/** At most one wake-up per device in this long: a person pressing Use here again is not a new push. */
export const DEVICE_WAKE_INTERVAL_MS = 30_000;

const asTarget = (t: DevicePushTarget, token: string): WakeTarget => ({ endpoint: t.e, p256dh: t.p, auth: t.a, vapid: { publicKey: t.vp, privateKey: t.vk }, token });
const asStored = (t: WakeTarget): DevicePushTarget & { k: string } => ({ e: t.endpoint, p: t.p256dh, a: t.auth, vp: t.vapid.publicKey, vk: t.vapid.privateKey, k: t.token });

/** The frame that shares this device's target with another device (null: it has none). */
export function deviceWakeFrame(target: WakeTarget | null): DeviceFrame {
  return { t: DEVICE_WAKE_FRAME, w: target && { e: target.endpoint, p: target.p256dh, a: target.auth, vp: target.vapid.publicKey, vk: target.vapid.privateKey, k: target.token } };
}

/** What a `device-wake` frame says: a target, null for none, undefined for a frame that says nothing (malformed). */
export function readDeviceWake(frame: DeviceFrame): WakeTarget | null | undefined {
  if (frame.t !== DEVICE_WAKE_FRAME) return undefined;
  return parseWakeFrame(frame);
}

/** A subscription as the record keeps it. */
export function pushTargetOf(subscription: Pick<WakeSubscription, "endpoint" | "p256dh" | "auth" | "vapid">): DevicePushTarget {
  return { e: subscription.endpoint, p: subscription.p256dh, a: subscription.auth, vp: subscription.vapid.publicKey, vk: subscription.vapid.privateKey };
}

/**
 * This device's own subscription in the record (null: none). The tokens it gave the other devices are kept while the
 * subscription only changes its endpoint (the browser replaced it): the other devices are told the new one under the
 * same token. A new VAPID pair is a new subscription, and new tokens.
 */
export function withOwnPush(record: DeviceRecord, subscription: Pick<WakeSubscription, "endpoint" | "p256dh" | "auth" | "vapid"> | null): DevicePatch | null {
  const was = record.push?.own;
  if (!subscription) return was ? { push: pruned({ ...record.push, own: undefined, renew: undefined }) } : null;
  const target = pushTargetOf(subscription);
  const tokens = was && was.vp === target.vp ? was.tokens : {};
  if (was && was.e === target.e && was.p === target.p && was.a === target.a && was.vp === target.vp && was.vk === target.vk) return null;
  // A new endpoint is a new subscription: whoever held the old one reaches nothing now, and a renewal asked is done.
  const { renew: _done, ...rest } = record.push ?? {};
  return { push: { ...rest, own: { ...target, tokens } } };
}

/**
 * What this device shares with the device `peer` (null: no subscription here), and the record's patch when a token
 * for that device had to be made first (written before the frame goes, so the worker knows the token it carries).
 */
export function ownTargetFor(record: DeviceRecord, peer: string): { target: WakeTarget | null; patch?: DevicePatch } {
  const own = record.push?.own;
  if (!own) return { target: null };
  const token = own.tokens[peer];
  if (token) return { target: asTarget(own, token) };
  const made = newWakeToken();
  return { target: asTarget(own, made), patch: { push: { ...record.push, own: { ...own, tokens: { ...own.tokens, [peer]: made } } } } };
}

/** The record's patch for what device `from` shared (null: nothing changes). */
export function withOtherPush(record: DeviceRecord, from: string, target: WakeTarget | null): DevicePatch | null {
  const was = record.push?.others?.[from];
  if (!target) {
    if (!was) return null;
    const { [from]: _gone, ...others } = record.push!.others!;
    return { push: pruned({ ...record.push, others }) };
  }
  const next = asStored(target);
  if (was && JSON.stringify(was) === JSON.stringify(next)) return null;
  return { push: { ...record.push, others: { ...record.push?.others, [from]: next } } };
}

/** The target device `key` shared with this one, or null. */
export function otherTarget(record: DeviceRecord | null, key: string): WakeTarget | null {
  const stored = record?.push?.others?.[key];
  return stored ? asTarget(stored, stored.k) : null;
}

/** The devices' targets and tokens this record keeps that the device set no longer lists go (a removed device's). */
export function pushForSet(record: DeviceRecord): DevicePatch | null {
  const listed = new Set(record.deviceSet.flatMap((slot) => (slot ? [slot.key] : [])));
  const push = record.push;
  if (!push) return null;
  const others = push.others && Object.fromEntries(Object.entries(push.others).filter(([key]) => listed.has(key)));
  const own = push.own && { ...push.own, tokens: Object.fromEntries(Object.entries(push.own.tokens).filter(([key]) => listed.has(key))) };
  const dropped = Object.keys(push.others ?? {}).length !== Object.keys(others ?? {}).length || Object.keys(push.own?.tokens ?? {}).length !== Object.keys(own?.tokens ?? {}).length;
  // A device that knew this device's subscription (its key pair included) is out of the set: a new one is made.
  const renew = push.renew || (dropped && !!own);
  const next = pruned({ ...push, ...(own ? { own } : {}), ...(others ? { others } : { others: undefined }), ...(renew ? { renew: true as const } : {}) });
  return JSON.stringify(next) === JSON.stringify(push) ? null : { push: next };
}

/** Which device of the record gave this token to this one: its signing key, or null. What the push worker checks. */
export function deviceOfToken(push: DevicePush | undefined, token: string): string | null {
  for (const [key, value] of Object.entries(push?.own?.tokens ?? {})) if (value === token) return key;
  return null;
}

function pruned(push: DevicePush): DevicePush | undefined {
  const others = push.others && Object.keys(push.others).length ? push.others : undefined;
  const renew = push.renew && push.own ? push.renew : undefined;
  if (!push.own && !others && !push.allowed) return undefined;
  return { ...(push.own ? { own: push.own } : {}), ...(others ? { others } : {}), ...(renew ? { renew } : {}), ...(push.allowed ? { allowed: push.allowed } : {}) };
}

/** The record's patch that asks this device to make a new subscription (null: it has none, or was asked already). */
export function withRenew(record: DeviceRecord): DevicePatch | null {
  if (!record.push?.own || record.push.renew) return null;
  return { push: { ...record.push, renew: true } };
}

/**
 * Asks the device whose subscription the profile hands out to make a new one (`push.ts`, WISP 06 § Push and the phone):
 * a contact that held it was deleted or muted, or a device that knew it was removed. Only from the active device.
 */
export const DEVICE_RENEW_FRAME = "device-renew";

/**
 * The chats' tokens the active device hands out under the profile's subscription, for the push worker of the device
 * the subscription belongs to: `{"t":"device-tokens","k":["<token>", ...]}`. A chat deleted or muted there is not in it.
 */
export const DEVICE_TOKENS_FRAME = "device-tokens";

/** The tokens a `device-tokens` frame lists, or null for a malformed one (it then says nothing). */
export function readDeviceTokens(frame: DeviceFrame): string[] | null {
  if (frame.t !== DEVICE_TOKENS_FRAME || !Array.isArray(frame.k) || frame.k.length > MAX_ALLOWED_TOKENS) return null;
  const tokens = frame.k as unknown[];
  return tokens.every((token) => typeof token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(token)) ? [...new Set(tokens as string[])].sort() : null;
}

/** The record's patch for the tokens the active device listed (null: the same list). */
export function withAllowed(record: DeviceRecord, tokens: string[]): DevicePatch | null {
  if (JSON.stringify(record.push?.allowed ?? null) === JSON.stringify(tokens)) return null;
  return { push: { ...record.push, allowed: tokens } };
}

const sameSubscription = (a: Pick<WakeSubscription, "endpoint" | "p256dh" | "auth" | "vapid">, b: WakeTarget) =>
  a.endpoint === b.endpoint && a.p256dh === b.p256dh && a.auth === b.auth && a.vapid.publicKey === b.vapid.publicKey && a.vapid.privateKey === b.vapid.privateKey;

/**
 * The profile's push target after device `from` shared its own (`target`, null for none), on the active device whose
 * signing key is `self`. `changed` false: keep what is there.
 *
 * - The active device's own subscription is never replaced by another device's.
 * - A target of `from` replaces one of `from` (its browser replaced the subscription), and stands in for none at all.
 * - A target of a device nobody named (made before this WISP) is taken as `from`'s when it is the same subscription.
 * - `from` has none any more: a target of `from` goes.
 */
export function profileWakeAfter(current: WakeSubscription | undefined, from: string, target: WakeTarget | null, self: string): { next: WakeSubscription | undefined; changed: boolean } {
  if (from === self || current?.device === self) return { next: current, changed: false };
  if (!target) return current?.device === from ? { next: undefined, changed: true } : { next: current, changed: false };
  const theirs: WakeSubscription = { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth, vapid: target.vapid, device: from };
  if (!current) return { next: theirs, changed: true };
  if (current.device === undefined) return sameSubscription(current, target) ? { next: theirs, changed: true } : { next: current, changed: false };
  if (current.device !== from || sameSubscription(current, target)) return { next: current, changed: false };
  return { next: theirs, changed: true };
}

/** The profile's push target once device `removed` is out of the set: its subscription goes with it. */
export function profileWakeOnRemoval(current: WakeSubscription | undefined, removed: string): { next: WakeSubscription | undefined; changed: boolean } {
  return current?.device === removed ? { next: undefined, changed: true } : { next: current, changed: false };
}

/** Whose the profile's target is, for the pages (`EngineState.wakeOwner`). */
export function wakeOwnerOf(current: WakeSubscription | undefined, self: string | null): "here" | "away" | undefined {
  if (!current?.device || !self) return undefined;
  return current.device === self ? "here" : "away";
}

/**
 * Posts a push: the host's way (Desktop and the CLI post it themselves), or `fetch`, then the person's push relay when
 * a page may not post it (the push services answer without CORS). Answers the push service's HTTP status.
 */
export async function postPush(request: PushRequest, options: { pushSend?: (request: PushRequest) => Promise<number>; relay?: string }): Promise<number> {
  if (options.pushSend) return options.pushSend(request);
  const quiet = { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" } as const;
  try {
    const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body as BodyInit, signal: AbortSignal.timeout(10_000), ...quiet });
    return response.status;
  } catch (error) {
    if (!options.relay) throw error;
    const response = await fetch(options.relay, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(relayRequest(request)), signal: AbortSignal.timeout(15_000), ...quiet,
    });
    const answer = await response.json().catch(() => null) as { status?: unknown } | null;
    return typeof answer?.status === "number" ? answer.status : response.status;
  }
}

/** One device wake-up per device per `DEVICE_WAKE_INTERVAL_MS`. */
export class DeviceWaker {
  private readonly limiter = new WakeLimiter(DEVICE_WAKE_INTERVAL_MS);
  constructor(private readonly post: (request: PushRequest) => Promise<number>, private readonly now: () => number = Date.now) {}

  /**
   * Wakes device `key` through `target`. `sent`: the push service took it; `gone`: the subscription no longer exists
   * (404, 410), and the target is to be forgotten; `skipped`: one went to it moments ago, or the target cannot be used.
   */
  async wake(key: string, target: WakeTarget): Promise<"sent" | "gone" | "skipped" | "failed"> {
    let request: PushRequest;
    try { request = deviceWakeRequest(target, this.now()); } catch { return "skipped"; }
    if (!this.limiter.take(key, this.now())) return "skipped";
    try {
      const status = await this.post(request);
      if (status === 404 || status === 410) return "gone";
      return status >= 200 && status < 300 ? "sent" : "failed";
    } catch { this.limiter.reset(key); return "failed"; }
  }
}
