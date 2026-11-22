import { beforeEach, describe, expect, it, vi } from "vitest";
import { RING_MS } from "@ghostly/react";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine, engineControl } from "./fakeEngine";
import { bootExtension, engine, PEER } from "./extension";

// covers: app.attention.notifications, extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * `callRings` as it would read were `MUTE_SILENCES.call` on (a muted chat's calls come in silent): the peer follows the
 * tab's rule, whichever way it is set.
 */
const mute = vi.hoisted(() => ({ silencesCalls: false }));
vi.mock("../../ui/src/lib/chatMute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/src/lib/chatMute")>();
  return { ...actual, callRings: (chat: string, now?: number) => !(mute.silencesCalls && actual.mutedUntil(chat, now) !== undefined) && actual.callRings(chat, now) };
});

/**
 * The peer runs with no Ghostly tab open (docs/BROWSER.md). A contact's call that rang then showed nothing: only a tab
 * rings, and its `useIncomingCallNotice` says "Incoming call" while it is out of sight. Now the peer says it, through
 * the worker, under the tab's rules, and takes it back when the ring ends.
 */

const APP = "chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf/app.html";
const CHAT = "chat-a";
const LINK = "link-a";

let world: FakeWorld;

function notificationsOn(on = true): void {
  world.storage.set("ghostly_app_settings", JSON.stringify({ language: "en", notifications: { soundEnabled: true, systemEnabled: on } }));
}

beforeEach(async () => {
  mute.silencesCalls = false;
  resetEngine();
  engineControl().links = [{ id: LINK, peerPubKeyZ32: PEER, peerServices: null }];
  world = await bootExtension();
  world.storage.set(`ghostly_${CHAT}`, JSON.stringify({ id: CHAT, mySeedB64: "seed", peerPubKeyB64: PEER, encKeyB64: "key", createdAt: 1 }));
  world.grantNotifications();
  notificationsOn();
});

const offer = () => JSON.stringify({ t: "o", ts: Date.now(), u: "abcd", p: "abcdefghijklmnopqrstuv", f: "a".repeat(64), s: "actpass" });
const created = () => world.callsTo("notifications.create") as [string, { message: string; title: string }][];
const cleared = () => world.callsTo("notifications.clear").map(([id]) => id);

/** The contact's call rings with no tab open; `shown`: wait until the worker showed it (the first loads the words). */
async function ring(shown = true): Promise<void> {
  const before = created().length;
  engine().ring(LINK, offer());
  if (shown) await vi.waitFor(() => expect(created().length).toBe(before + 1), { timeout: 4_000 });
  await settle();
}

/**
 * Whether a ring shows nothing: a message of another chat after it is the one notification shown since. `after`: what
 * changes back before that message (Settings → Notifications on again).
 */
async function ringsNothing(after?: () => void): Promise<void> {
  const before = created().length;
  await ring(false);
  after?.();
  engine().attention({ id: "message:group:control:m1", type: "message", at: Date.now(), linkId: "group:control" });
  await vi.waitFor(() => expect(created().length).toBe(before + 1), { timeout: 4_000 });
  await settle();
  expect(created().slice(before).map(([id]) => world.session.get(`notice:${id}`))).toEqual(["group:control"]);
}

describe("a call that rings with no Ghostly tab open", () => {
  it("shows the tab's private \"Incoming call\" notification, which a click opens the chat of", async () => {
    await ring();
    expect(created()).toHaveLength(1);
    const [id, options] = created()[0]!;
    expect(options).toMatchObject({ title: "Ghostly", message: "Incoming call", silent: true });
    expect(world.session.get(`notice:${id}`)).toBe(CHAT);

    fire(world.chrome.notifications.onClicked, id);
    await vi.waitFor(() => expect(world.callsTo("tabs.create").at(-1)).toEqual([`${APP}#/chat/${CHAT}`]), { timeout: 10_000 });
    expect(world.notices.has(id)).toBe(false);
  });

  it("goes when the contact hangs up, also when that comes before it was shown", async () => {
    await ring();
    const [id] = created()[0]!;
    engine().ring(LINK, null);
    await vi.waitFor(() => expect(world.notices.has(id)).toBe(false), { timeout: 4_000 });
    expect(cleared()).toContain(id);
    expect(world.session.has(`notice:${id}`)).toBe(false);

    // A ring and its hang-up at once: whatever was shown goes with it.
    engine().ring(LINK, offer());
    engine().ring(LINK, null);
    await vi.waitFor(() => expect(created()).toHaveLength(2), { timeout: 4_000 });
    await vi.waitFor(() => expect(world.notices.size).toBe(0), { timeout: 4_000 });
  });

  it("goes once the call rang the app's whole ring, and a newer offer keeps the one notification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // `settle` waits on `setTimeout`: here the fake clock moves instead (`vi.waitFor` moves it a little).
      engine().ring(LINK, offer());
      await vi.waitFor(() => expect(created()).toHaveLength(1), { timeout: 4_000 });
      engine().ring(LINK, offer());
      await vi.waitFor(() => expect(created()).toHaveLength(2), { timeout: 4_000 });
      expect(new Set(created().map(([id]) => id)).size).toBe(1);
      const [id] = created()[0]!;
      await vi.advanceTimersByTimeAsync(RING_MS - 2_000);
      expect(world.notices.has(id)).toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(world.notices.has(id)).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps apart from the chat's message notification", async () => {
    await ring();
    const [call] = created()[0]!;
    engine().attention({ id: `message:${LINK}:m1`, type: "message", at: Date.now(), linkId: LINK });
    await vi.waitFor(() => expect(created()).toHaveLength(2), { timeout: 4_000 });
    const [message] = created()[1]!;
    expect(message).not.toBe(call);
    engine().ring(LINK, null);
    await vi.waitFor(() => expect(world.notices.has(call)).toBe(false), { timeout: 4_000 });
    expect(world.notices.has(message)).toBe(true);
  });

  it("nothing when Settings → Notifications is off", async () => {
    notificationsOn(false);
    await ringsNothing(() => notificationsOn());
  });

  it("a muted chat still rings, as in a tab (`callRings`), unless its mute silences calls", async () => {
    world.storage.set(`ghostly_mute_${CHAT}`, "forever");
    await ring();
    expect(created()[0]![1].message).toBe("Incoming call");
    engine().ring(LINK, null);
    await settle();

    mute.silencesCalls = true;
    await ringsNothing();
  });
});
