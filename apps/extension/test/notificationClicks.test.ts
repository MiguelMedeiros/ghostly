import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { bootExtension, restartServiceWorker, useProfile } from "./extension";

// covers: app.attention.notifications, profiles.switch, app.clear-data

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * A click on one of Ghostly's notifications in the system's list. The page that showed it may be gone by then (its
 * tab closed or reloaded), and Chrome keeps the notification: the worker is what is left to hear the click.
 */

const APP = "chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf/app.html";
type Lib = typeof import("../../ui/src/lib/notifications");

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
  world.grantNotifications();
  // The extension's app page is a window; here only what notifications.ts touches of one.
  vi.stubGlobal("window", Object.assign(globalThis, { focus: () => {} }));
});

/** An app page in a tab: the real notifications library, loaded fresh in the page's context. */
async function openPage(): Promise<{ lib: Lib; tabId: number; opened: string[] }> {
  const tab = await world.chrome.tabs.create({ url: APP });
  vi.resetModules();
  const lib = await world.load("page", () => import("../../ui/src/lib/notifications"));
  const opened: string[] = [];
  world.load("page", async () => lib.onNotificationOpen((chat) => opened.push(chat)));
  return { lib, tabId: tab.id!, opened };
}

/** The page shows a chat's notification, as AttentionFeedback does; returns the system's id for it. */
async function notify(lib: Lib, event: string, chat?: string): Promise<string> {
  const before = world.callsTo("notifications.create").length;
  await world.load("page", () => lib.showPrivateNotification(event, "New message", chat, true));
  const created = world.callsTo("notifications.create").slice(before);
  expect(created).toHaveLength(1);
  return created[0]![0] as string;
}

/** The page's tab closes or reloads: its listeners and memory go, the notification stays in the system's list. */
async function closePage(tabId: number, reload = false): Promise<void> {
  for (const e of world.events) e.dropContext("page");
  if (!reload) await world.chrome.tabs.remove(tabId);
}

/** Clicks it, and waits until the worker is done: it took the notification away and moved a tab, or a page answered. */
async function click(id: string, done?: () => boolean): Promise<void> {
  const moves = () => world.callsTo("tabs.create").length + world.callsTo("tabs.update").length;
  const before = moves();
  fire(world.chrome.notifications.onClicked, id);
  // The worker may start the peer first, as the toolbar button does: the first start loads it, which takes a while.
  await vi.waitFor(() => expect((done ? done() : moves() > before) && !world.notices.has(id)).toBe(true), { timeout: 10_000 });
  await settle();
}

describe("a click on a notification whose page is gone", () => {
  it("every tab closed: clears it and opens the app on its chat", async () => {
    const page = await openPage();
    const id = await notify(page.lib, "message:link-a:m1", "chat-a");
    await closePage(page.tabId);
    expect(Object.keys(await world.chrome.notifications.getAll())).toEqual([id]);

    await click(id);
    expect(world.callsTo("tabs.create").at(-1)).toEqual([`${APP}#/chat/chat-a`]);
    expect(world.notices.has(id)).toBe(false);
    // What the page kept for it goes with it.
    expect([...world.session.keys()].filter((key) => key.startsWith("notice:"))).toEqual([]);
  });

  it("its tab closed, another app tab open: that tab comes forward on the chat, a group's on the group", async () => {
    const a = await openPage();
    const id = await notify(a.lib, "message:group:g1:m1", "group:g1");
    await closePage(a.tabId);
    // B listens to its own only: it opens nothing itself.
    const b = await openPage();

    await click(id);
    expect(b.opened).toEqual([]);
    expect(world.callsTo("tabs.update")).toContainEqual([b.tabId, { active: true, url: `${APP}#/group/g1` }]);
    expect(world.callsTo("windows.update")).toContainEqual([1, { focused: true }]);
    expect(world.notices.has(id)).toBe(false);
  });

  it("its tab reloaded: the new page does not know it, and the tab still opens on the chat", async () => {
    const page = await openPage();
    const id = await notify(page.lib, "message:link-a:m1", "chat a/1");
    await closePage(page.tabId, true);
    vi.resetModules();
    await world.load("page", () => import("../../ui/src/lib/notifications")).then((lib) => world.load("page", async () => lib.onNotificationOpen(() => {})));

    await click(id);
    expect(world.callsTo("tabs.update")).toContainEqual([page.tabId, { active: true, url: `${APP}#/chat/chat%20a%2F1` }]);
    expect(world.notices.has(id)).toBe(false);
  });

  it("one without a chat, or another profile's: clears it and shows the app as it is", async () => {
    const page = await openPage();
    const call = await notify(page.lib, "call:1");
    const peek = await notify(page.lib, "peek-work-1", "profile:work");
    await closePage(page.tabId);

    await click(call);
    expect(world.callsTo("tabs.create").at(-1)).toEqual([APP]);
    await click(peek);
    expect(world.callsTo("tabs.update").at(-1)).toEqual([expect.any(Number), { active: true }]);
    expect(world.notices.size).toBe(0);
  });

  it("after the worker restarted, and when the permission came after it started", async () => {
    world = await bootExtension();
    const page = await openPage();
    world.grantNotifications();
    const id = await notify(page.lib, "message:link-a:m1", "chat-a");
    await closePage(page.tabId);
    await restartServiceWorker(world);
    await restartServiceWorker(world);
    expect((world.chrome.notifications.onClicked as unknown as { listeners: { context: string }[] }).listeners.filter((l) => l.context === "background")).toHaveLength(1);

    await click(id);
    expect(world.callsTo("tabs.create").at(-1)).toEqual([`${APP}#/chat/chat-a`]);
  });
});

describe("a new peer: the chats of the one before are not this one's", () => {
  const ensure = () => world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" });
  const noticeKeys = () => [...world.session.keys()].filter((key) => key.startsWith("notice:"));

  it("a profile switch takes the notifications of the profile before away, with the chats kept for them", async () => {
    expect(await ensure()).toEqual({ ok: true });
    const page = await openPage();
    const message = await notify(page.lib, "message:link-a:m1", "chat-a");
    const group = await notify(page.lib, "message:group:g1:m1", "group:g1");
    // About a third profile: it did not stop, and its notice still means what it says.
    const peek = await notify(page.lib, "peek-other-1", "profile:other00000");
    await closePage(page.tabId, true);

    useProfile(world, "work000000", ["other00000"]);
    expect(await ensure()).toEqual({ ok: true });
    await settle();
    expect([...world.notices.keys()]).toEqual([peek]);
    expect(noticeKeys()).toEqual([`notice:${peek}`]);
    expect(world.notices.has(message) || world.notices.has(group)).toBe(false);
  });

  it("a switch to a profile takes its own \"New messages in\" notifications away; another profile's stay", async () => {
    expect(await ensure()).toEqual({ ok: true });
    const page = await openPage();
    const message = await notify(page.lib, "message:link-a:m1", "chat-a");
    // Two looks at Work while Personal ran, one at a third profile.
    const work = [await notify(page.lib, "peek-work-1", "profile:work000000"), await notify(page.lib, "peek-work-2", "profile:work000000")];
    const other = await notify(page.lib, "peek-other-1", "profile:other00000");
    await closePage(page.tabId, true);

    useProfile(world, "work000000", ["other00000"]);
    expect(await ensure()).toEqual({ ok: true });
    await settle();
    // Work is the one in use now: nothing new is waiting in it, and a click on one would only show the app.
    expect(work.filter((id) => world.notices.has(id))).toEqual([]);
    expect([...world.notices.keys()]).toEqual([other]);
    expect(noticeKeys()).toEqual([`notice:${other}`]);
    expect(world.notices.has(message)).toBe(false);

    // Back to the first profile (id ""): its own notices go the same way, Work's new one stays.
    const back = await openPage();
    const personal = await notify(back.lib, "peek-default-1", "profile:");
    const workAgain = await notify(back.lib, "peek-work-3", "profile:work000000");
    await closePage(back.tabId, true);
    useProfile(world, "", ["work000000", "other00000"]);
    expect(await ensure()).toEqual({ ok: true });
    await settle();
    expect([...world.notices.keys()].sort()).toEqual([other, workAgain].sort());
    expect(world.notices.has(personal)).toBe(false);
  });

  it("Clear all data: the cleared chats' notifications go with them", async () => {
    const page = await openPage();
    const id = await notify(page.lib, "message:link-a:m1", "chat-a");
    expect(await world.chrome.runtime.sendMessage({ target: "background", type: "restart-engine" })).toEqual({ ok: true });
    await settle();
    expect(world.notices.has(id)).toBe(false);
    expect(noticeKeys()).toEqual([]);
  });

  it("the same peer started again keeps them: a click still opens the chat", async () => {
    expect(await ensure()).toEqual({ ok: true });
    const page = await openPage();
    const id = await notify(page.lib, "message:link-a:m1", "chat-a");
    await closePage(page.tabId);
    await restartServiceWorker(world);
    expect(await ensure()).toEqual({ ok: true });

    await click(id);
    expect(world.callsTo("tabs.create").at(-1)).toEqual([`${APP}#/chat/chat-a`]);
  });
});

describe("a click on a notification whose page is open", () => {
  it("that page opens its chat; the worker moves no tab", async () => {
    const page = await openPage();
    const id = await notify(page.lib, "message:link-a:m1", "chat-a");
    const before = world.callsTo("tabs.update").length;

    await click(id, () => page.opened.length > 0);
    expect(page.opened).toEqual(["chat-a"]);
    expect(world.callsTo("tabs.update").slice(before).every(([, props]) => !(props as { url?: string }).url)).toBe(true);
    expect(world.callsTo("tabs.create")).toHaveLength(1);
    expect(world.notices.has(id)).toBe(false);
  });
});
