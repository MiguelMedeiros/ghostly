import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine, engineControl } from "./fakeEngine";
import { bootExtension, engine, PEER } from "./extension";

// covers: app.attention.notifications, extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * The peer runs with no Ghostly tab open (docs/BROWSER.md). A message that came then was stored as unread and nothing
 * told the person: only a tab's AttentionFeedback showed a notification. Now the peer says it, through the worker, under
 * the tab's rules; with a tab open, the tab does and the worker shows nothing.
 */

const APP = "chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf/app.html";
const CHAT = "chat-a";

let world: FakeWorld;

/** Settings → Notifications as the profile's pages keep them. */
function notificationsOn(on = true): void {
  world.storage.set("ghostly_app_settings", JSON.stringify({ language: "en", notifications: { soundEnabled: true, systemEnabled: on } }));
}

beforeEach(async () => {
  resetEngine();
  // The chat with PEER, as the pages store it, and the engine's link to it.
  engineControl().links = [{ id: "link-a", peerPubKeyZ32: PEER, peerServices: null }];
  world = await bootExtension();
  world.storage.set(`ghostly_${CHAT}`, JSON.stringify({ id: CHAT, mySeedB64: "seed", peerPubKeyB64: PEER, encKeyB64: "key", createdAt: 1 }));
  world.grantNotifications();
  notificationsOn();
});

let n = 0;
const event = (fields: Partial<AttentionEvent> = {}): AttentionEvent => ({ id: `message:link-a:m${++n}`, type: "message", at: Date.now(), linkId: "link-a", ...fields });

const created = () => world.callsTo("notifications.create") as [string, { message: string; title: string }][];
const asked = () => world.callsTo("runtime.sendMessage").filter(([m]) => (m as { type?: string }).type === "notify");

/** The peer hears an event; `shown`: wait until the worker showed it (the first loads the profile's words). */
async function hear(fields?: Partial<AttentionEvent>, shown = false): Promise<void> {
  const before = created().length;
  engine().attention(event(fields));
  if (shown) await vi.waitFor(() => expect(created().length).toBe(before + 1), { timeout: 4_000 });
  await settle();
}

/**
 * Events that show nothing: each one, then another chat's message that does, after them. Only that one is shown, so
 * none of them was, and none comes late.
 */
async function hearNone(...events: Partial<AttentionEvent>[]): Promise<void> {
  const before = created().length;
  for (const fields of events) await hear(fields);
  await hear({ linkId: "group:control" }, true);
  expect(created().slice(before).map(([id]) => world.session.get(`notice:${id}`))).toEqual(["group:control"]);
}

describe("a message with no Ghostly tab open", () => {
  it("shows the tab's generic notification, from the worker, and a click opens its chat", async () => {
    await hear({}, true);
    expect(created()).toHaveLength(1);
    const [id, options] = created()[0]!;
    expect(options).toMatchObject({ title: "Ghostly", message: "New message", silent: true });
    // The peer asked; the worker, which alone has `chrome.notifications`, showed it.
    expect(asked()).toHaveLength(1);
    expect(world.session.get(`notice:${id}`)).toBe(CHAT);

    fire(world.chrome.notifications.onClicked, id);
    await vi.waitFor(() => expect(world.callsTo("tabs.create").at(-1)).toEqual([`${APP}#/chat/${CHAT}`]), { timeout: 10_000 });
    expect(world.notices.has(id)).toBe(false);
  });

  it("a burst in one chat is one notification, in the profile's language; a reaction says so", async () => {
    world.storage.set("ghostly_app_settings", JSON.stringify({ language: "pt", notifications: { systemEnabled: true } }));
    await hear({}, true);
    await hear({}, true);
    expect(new Set(created().map(([id]) => id)).size).toBe(1);
    expect(world.notices.size).toBe(1);
    expect(created()[0]![1].message).toBe("Nova mensagem");
    await hear({ type: "reaction", linkId: "group:g1" }, true);
    expect(world.notices.size).toBe(2);
    expect(created().at(-1)![1].message).not.toBe("Nova mensagem");
  });

  it("nothing when Settings → Notifications is off", async () => {
    notificationsOn(false);
    await hear();
    notificationsOn();
    await hearNone();
  });

  it("nothing for a muted chat, an event that is no message, or one too old", async () => {
    world.storage.set(`ghostly_mute_${CHAT}`, "forever");
    await hearNone({}, { type: "sent" }, { type: "coin", linkId: undefined }, { at: Date.now() - 60_000, linkId: "group:g1" });
  });

  it("a mention gets through a muted group, as in a tab", async () => {
    world.storage.set("ghostly_mute_group:g1", "forever");
    await hearNone({ linkId: "group:g1" });
    await hear({ linkId: "group:g1", mention: true }, true);
    expect(world.session.get(`notice:${created().at(-1)![0]}`)).toBe("group:g1");
  });

  it("nothing from the worker while a tab is attached: the tab hears it and shows it itself", async () => {
    const port = world.chrome.runtime.connect({ name: "ui" });
    const heard: unknown[] = [];
    port.onMessage.addListener((m: unknown) => void heard.push(m));
    await settle();
    await hear();
    await vi.waitFor(() => expect(heard).toContainEqual({ kind: "attention", event: expect.objectContaining({ type: "message" }) }));

    // The tab closed: the peer tells the next one itself, and only that one was shown.
    port.disconnect();
    await settle();
    await hear({}, true);
    expect(created()).toHaveLength(1);
    expect(asked()).toHaveLength(1);
  });

  it("nothing without the notifications permission", async () => {
    resetEngine();
    world = await bootExtension();
    notificationsOn();
    await hear();
    await vi.waitFor(() => expect(asked()).toHaveLength(1), { timeout: 10_000 });
    await settle();
    expect(world.callsTo("notifications.create")).toEqual([]);
  });
});
