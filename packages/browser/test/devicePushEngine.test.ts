import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { generateVapidKeys, newWakeToken, toBase64Url, type PkarrTransport, type WakeTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import type { WakeSubscription } from "../src/shared/types";
import { STORES, transact } from "../src/shared/idb";
import { readWalletHomes } from "../src/devices/walletHomes";
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
