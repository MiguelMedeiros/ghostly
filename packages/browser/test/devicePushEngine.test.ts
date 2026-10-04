import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { generateVapidKeys, newWakeToken, toBase64Url, type PkarrTransport, type WakeTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import type { WakeSubscription } from "../src/shared/types";
import { STORES, transact } from "../src/shared/idb";
import { readWalletHomes } from "../src/devices/walletHomes";
import { closeDevicesDb } from "../src/devices/store";
import { dropDevicesDatabase as dropDevices, putDeviceRecord } from "./helpers/deviceRecord";
// covers: devices.push, devices.handoff.wallets

/*
 * The active device keeps the profile's push target (WISP 06 § Push and the phone), driven through the engine as the
 * device links drive it: a desktop with no subscription of its own gives contacts the phone's, a subscription the phone's
 * browser replaced reaches it, its own subscription wins, and a removed device's goes. The pages are told whose it is.
 */

const transport: PkarrTransport = { publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) };
const nodes: GhostlyNode[] = [];
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); });

const PHONE = "P".repeat(43), DESKTOP = "D".repeat(43);
function subscription(endpoint: string): WakeSubscription {
  return { endpoint, p256dh: toBase64Url(p256.getPublicKey(p256.utils.randomSecretKey(), false)), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), vapid: generateVapidKeys() };
}
const targetOf = (sub: WakeSubscription): WakeTarget => ({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, vapid: sub.vapid, token: newWakeToken() });

interface Inside { ownDeviceKey: string | null; settings: { wake?: WakeSubscription }; deviceWakeReceived(from: string, target: WakeTarget | null): Promise<void>; afterDeviceRemoved(key: string): Promise<void> }

function desktop(): { node: GhostlyNode; inside: Inside } {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  nodes.push(node);
  const inside = node as unknown as Inside;
  // As `startDeviceSet` reads it from the device record.
  inside.ownDeviceKey = DESKTOP;
  return { node, inside };
}

describe("the profile's push target on the active device", () => {
  it("a desktop with none of its own takes the phone's and keeps it; a replaced one follows; none clears it", async () => {
    const { node, inside } = desktop();
    const phone = subscription("https://fcm.googleapis.com/fcm/send/phone");
    await inside.deviceWakeReceived(PHONE, targetOf(phone));
    expect(inside.settings.wake).toEqual({ ...phone, device: PHONE });
    expect(node.getState().wakeOwner).toBe("away");
    const replaced = subscription("https://fcm.googleapis.com/fcm/send/phone-2");
    await inside.deviceWakeReceived(PHONE, targetOf(replaced));
    expect(inside.settings.wake).toEqual({ ...replaced, device: PHONE });
    await inside.deviceWakeReceived(PHONE, null);
    expect(inside.settings.wake).toBeUndefined();
    expect(node.getState().wakeOwner).toBeUndefined();
  });

  it("its own subscription names it and wins over the phone's", async () => {
    const { node, inside } = desktop();
    const own = subscription("https://fcm.googleapis.com/fcm/send/desktop");
    await node.setWakeSubscription({ subscription: { ...own, device: PHONE } as WakeSubscription });
    // Whatever the page said, the engine names the device: this one.
    expect(inside.settings.wake).toEqual({ ...own, device: DESKTOP });
    expect(node.getState().wakeOwner).toBe("here");
    await inside.deviceWakeReceived(PHONE, targetOf(subscription("https://fcm.googleapis.com/fcm/send/phone")));
    expect(inside.settings.wake?.endpoint).toBe(own.endpoint);
  });

  it("back as the active device with a subscription of its own, its own wins over the one another device left the profile", async () => {
    const { node, inside } = desktop();
    const own = subscription("https://fcm.googleapis.com/fcm/send/desktop");
    await putDeviceRecord({
      v: 1, profile: "ghostly", state: "active", saved: 1, turn: 3, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key: DESKTOP, name: "Desktop" }, { key: PHONE, name: "Phone" }], ownSlot: 0, activeSlot: 0,
      push: { own: { e: own.endpoint, p: own.p256dh, a: own.auth, vp: own.vapid.publicKey, vk: own.vapid.privateKey, tokens: {} } },
    });
    await inside.deviceWakeReceived(PHONE, targetOf(subscription("https://fcm.googleapis.com/fcm/send/phone")));
    expect(inside.settings.wake?.device).toBe(PHONE);
    await (inside as unknown as { ownWakeWins(): Promise<void> }).ownWakeWins();
    expect(inside.settings.wake).toEqual({ ...own, device: DESKTOP });
    expect(node.getState().wakeOwner).toBe("here");
    await closeDevicesDb(); await dropDevices();
  });

  it("a subscription made before the profile had a device set names this device once the page finds it is the browser's own", async () => {
    const { node, inside } = desktop();
    const own = subscription("https://fcm.googleapis.com/fcm/send/desktop");
    inside.ownDeviceKey = null;
    await node.setWakeSubscription({ subscription: own });
    expect(inside.settings.wake?.device).toBeUndefined();
    inside.ownDeviceKey = DESKTOP;
    await node.wakeConfirm({ endpoint: "https://fcm.googleapis.com/fcm/send/other" });
    expect(inside.settings.wake?.device).toBeUndefined();
    await node.wakeConfirm({ endpoint: own.endpoint });
    expect(inside.settings.wake?.device).toBe(DESKTOP);
  });

  it("a removed device's subscription goes with it, and so do the home marks of the wallets that stayed on it", async () => {
    const { inside } = desktop();
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ config: { walletId: "b1" }, seed: {}, deviceKey: "k", home: { key: PHONE } }, "barkWallet-mode-testnet"); });
    await inside.deviceWakeReceived(PHONE, targetOf(subscription("https://fcm.googleapis.com/fcm/send/phone")));
    await inside.afterDeviceRemoved("L".repeat(43));
    expect(inside.settings.wake?.device).toBe(PHONE);
    expect(await readWalletHomes()).toEqual({ "bark:testnet": { key: PHONE } });
    await inside.afterDeviceRemoved(PHONE);
    expect(inside.settings.wake).toBeUndefined();
    expect(await readWalletHomes()).toEqual({});
  });
});

interface Renewing {
  ownDeviceKey: string | null;
  settings: { wake?: WakeSubscription; wakeRotate?: boolean; wakeRenew?: Record<string, string>; wakeMutedGroups?: string[] };
  deviceLinks: unknown;
  links: Map<string, { stored: { id: string; wakeToken?: string; wakeMuted?: boolean; group?: string } }>;
  rotateWake(): Promise<void>;
  syncDeviceTokens(): void;
  ownWakeWins(): Promise<void>;
  deviceWakeReceived(from: string, target: WakeTarget | null): Promise<void>;
  afterDeviceRemoved(key: string): Promise<void>;
}

/** The device links as the engine uses them for push: the phone's link live, and what was said on it. */
function fakeLinks() {
  return { live: vi.fn(() => true), askRenew: vi.fn(() => true), sendTokens: vi.fn(() => true), views: () => [{ key: PHONE, name: "Phone", status: "live" }] };
}

describe("a subscription someone should no longer reach (WISP 06 § Push and the phone)", () => {
  it("the phone's, handed out by the desktop: the phone is asked over the link, and the desktop keeps asking until a new one comes", async () => {
    const { node } = desktop();
    const inside = node as unknown as Renewing;
    const links = fakeLinks();
    inside.deviceLinks = links;
    const phone = subscription("https://fcm.googleapis.com/fcm/send/phone");
    await inside.deviceWakeReceived(PHONE, targetOf(phone));
    // A contact that held it is deleted or muted here.
    await inside.rotateWake();
    expect(inside.settings.wakeRotate).toBe(true);
    expect(inside.settings.wakeRenew).toEqual({ [PHONE]: phone.endpoint });
    expect(links.askRenew).toHaveBeenCalledWith(PHONE);
    // The phone says the same subscription again: still owed.
    await inside.deviceWakeReceived(PHONE, targetOf(phone));
    expect(inside.settings.wakeRotate).toBe(true);
    // Its new one: the profile hands that out, and nothing is owed any more.
    const renewed = subscription("https://fcm.googleapis.com/fcm/send/phone-renewed");
    await inside.deviceWakeReceived(PHONE, targetOf(renewed));
    expect(inside.settings.wake).toEqual({ ...renewed, device: PHONE });
    expect(inside.settings.wakeRotate).toBeUndefined();
    expect(inside.settings.wakeRenew).toBeUndefined();
  });

  it("the desktop's own wins while the phone still owes a new one: the request is not lost", async () => {
    const { node } = desktop();
    const inside = node as unknown as Renewing;
    inside.deviceLinks = fakeLinks();
    const own = subscription("https://fcm.googleapis.com/fcm/send/desktop");
    await putDeviceRecord({
      v: 1, profile: "ghostly", state: "active", saved: 1, turn: 3, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key: DESKTOP, name: "Desktop" }, { key: PHONE, name: "Phone" }], ownSlot: 0, activeSlot: 0,
      push: { own: { e: own.endpoint, p: own.p256dh, a: own.auth, vp: own.vapid.publicKey, vk: own.vapid.privateKey, tokens: {} } },
    });
    const phone = subscription("https://fcm.googleapis.com/fcm/send/phone");
    await inside.deviceWakeReceived(PHONE, targetOf(phone));
    await inside.rotateWake();
    await inside.ownWakeWins();
    expect(inside.settings.wake?.device).toBe(DESKTOP);
    expect(inside.settings.wakeRotate).toBe(true);
    expect(inside.settings.wakeRenew).toEqual({ [PHONE]: phone.endpoint });
    await closeDevicesDb(); await dropDevices();
  });

  it("a removed device knew the profile's own subscription: it is made again", async () => {
    const { node, inside } = desktop();
    await node.setWakeSubscription({ subscription: subscription("https://fcm.googleapis.com/fcm/send/desktop") });
    await inside.afterDeviceRemoved("L".repeat(43));
    expect((inside as unknown as Renewing).settings.wakeRotate).toBe(true);
  });

  it("the standby learns which chats' tokens the profile hands out: a muted or deleted chat's is not among them", async () => {
    const { node } = desktop();
    const inside = node as unknown as Renewing;
    const links = fakeLinks();
    inside.deviceLinks = links;
    inside.links.set("a", { stored: { id: "a", wakeToken: "b".repeat(22) } });
    inside.links.set("b", { stored: { id: "b", wakeToken: "a".repeat(22) } });
    inside.links.set("c", { stored: { id: "c", wakeToken: "c".repeat(22), wakeMuted: true } });
    inside.links.set("d", { stored: { id: "d" } });
    inside.syncDeviceTokens();
    expect(links.sendTokens).toHaveBeenLastCalledWith(PHONE, ["a".repeat(22), "b".repeat(22)]);
    inside.syncDeviceTokens();
    expect(links.sendTokens).toHaveBeenCalledTimes(1);
    inside.links.delete("a");
    inside.syncDeviceTokens();
    expect(links.sendTokens).toHaveBeenLastCalledWith(PHONE, ["a".repeat(22)]);
    inside.links.clear();
  });

  it("a muted group's tokens are not among them either, even on an edge that still holds one", async () => {
    const { node } = desktop();
    const inside = node as unknown as Renewing;
    const links = fakeLinks();
    inside.deviceLinks = links;
    inside.links.set("chat", { stored: { id: "chat", wakeToken: "a".repeat(22) } });
    inside.links.set("edge-quiet", { stored: { id: "edge-quiet", group: "quiet", wakeToken: "q".repeat(22) } });
    inside.links.set("edge-loud", { stored: { id: "edge-loud", group: "loud", wakeToken: "l".repeat(22) } });
    inside.settings.wakeMutedGroups = ["quiet"];
    inside.syncDeviceTokens();
    expect(links.sendTokens).toHaveBeenLastCalledWith(PHONE, ["a".repeat(22), "l".repeat(22)]);
    // Unmuted: its token is handed out again.
    inside.settings.wakeMutedGroups = undefined;
    inside.syncDeviceTokens();
    expect(links.sendTokens).toHaveBeenLastCalledWith(PHONE, ["a".repeat(22), "l".repeat(22), "q".repeat(22)]);
    inside.links.clear();
  });
});
