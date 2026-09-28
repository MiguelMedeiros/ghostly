import type { BrowserContext, CDPSession, Page, Request } from "@playwright/test";
import { p256 } from "@noble/curves/nist.js";
import { decryptPushPayload, fromBase64Url, readWakePayload, toBase64Url, utf8Decode, utf8Encode } from "@ghostly/core";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * Wake-up push (WISP 401 § Wake-up push): Bo's closed web app is woken by a push Ana's own app sends, through the
 * subscription Bo shared over their chat. Everything but the browser's push service is real: Bo's push worker,
 * the table it reads, the encryption and the VAPID signature Ana's app makes. The push service is stood in for
 * twice: `PushManager.subscribe` answers a subscription whose keys the test holds (a headless Chromium has no push
 * service), and Ana's post to it is routed here, decrypted as the service's browser would, and handed to Bo's
 * worker with the DevTools protocol, as the real service would deliver it.
 */
const deployed = !!process.env.E2E_WEB_URL;
// Chromium's headless shell refuses notifications outright; the full browser in its headless mode shows them.
test.use({ channel: "chromium" });
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/bo";

/** Bo's browser subscription: the test keeps its private halves, to read what arrives. */
function subscriptionKeys() {
  const secret = p256.utils.randomSecretKey();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { secret, auth, p256dh: toBase64Url(p256.getPublicKey(secret, false)), authB64: toBase64Url(auth) };
}

/** A `PushManager` that subscribes to the stand-in: the rest of the Push API is the browser's own. */
async function standInPushManager(context: BrowserContext, keys: { p256dh: string; auth: string }): Promise<void> {
  await context.addInitScript(({ endpoint, p256dh, auth }) => {
    const bytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
    const KEY = "qa-push-subscribed";
    const subscription = () => ({
      endpoint, expirationTime: null, options: { userVisibleOnly: true },
      getKey: (name: string) => (name === "p256dh" ? bytes(p256dh) : name === "auth" ? bytes(auth) : null),
      unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
      toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
    });
    PushManager.prototype.subscribe = async function () { localStorage.setItem(KEY, "1"); return subscription() as unknown as PushSubscription; };
    PushManager.prototype.getSubscription = async function () { return (localStorage.getItem(KEY) ? subscription() : null) as unknown as PushSubscription; };
  }, { endpoint: ENDPOINT, ...keys });
}

/** Posts to the stand-in push service, as Ana's app made them. */
async function pushService(context: BrowserContext): Promise<Request[]> {
  const posts: Request[] = [];
  await context.route(`${ENDPOINT}**`, async (route) => {
    if (route.request().method() === "POST") posts.push(route.request());
    await route.fulfill({ status: 201, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" }, body: "" });
  });
  return posts;
}

/** The wake-up's text, read as Bo's browser reads it, after checking the VAPID signature Ana's app put on it. */
function readPush(request: Request, keys: { secret: Uint8Array; auth: Uint8Array }): string {
  const headers = request.headers();
  const [, token, key] = headers.authorization!.match(/^vapid t=([^,]+), k=(.+)$/)!;
  const [head, claims, signature] = token!.split(".");
  expect(p256.verify(fromBase64Url(signature!), utf8Encode(`${head}.${claims}`), fromBase64Url(key!))).toBe(true);
  expect(JSON.parse(utf8Decode(fromBase64Url(claims!))).aud).toBe("https://fcm.googleapis.com");
  expect(headers["content-encoding"]).toBe("aes128gcm");
  return utf8Decode(decryptPushPayload(new Uint8Array(request.postDataBuffer()!), keys.secret, keys.auth));
}

/** A page of Bo's origin that is not the app (the app on screen would show nothing): to deliver pushes and look at notifications. */
async function workerConsole(context: BrowserContext): Promise<{ page: Page; deliver(text: string): Promise<void>; shown(): Promise<{ body: string; tag: string; path: string }[]> }> {
  const page = await context.newPage();
  await page.goto("/manifest.json");
  const cdp: CDPSession = await context.newCDPSession(page);
  const registrations = new Map<string, string>();
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: list }) => {
    for (const r of list as { registrationId: string; scopeURL: string; isDeleted: boolean }[]) if (!r.isDeleted) registrations.set(r.scopeURL, r.registrationId);
  });
  await cdp.send("ServiceWorker.enable");
  const origin = new URL(page.url()).origin;
  return {
    page,
    async deliver(text) {
      await expect.poll(() => registrations.get(`${origin}/push/default/`)).toBeTruthy();
      await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId: registrations.get(`${origin}/push/default/`)!, data: text });
    },
    shown: () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/push/default/");
      return (await registration!.getNotifications()).map((n) => ({ body: n.body, tag: n.tag, path: (n.data as { path: string }).path }));
    }),
  };
}

/** Bo's worker table, as the app wrote it: a token's chat and its mute. */
const wakeTable = (page: Page) => page.evaluate(() => new Promise<{ token: string; path: string; mutedUntil?: unknown }[]>((resolve, reject) => {
  const open = indexedDB.open("ghostly-wake");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const all = open.result.transaction("tokens").objectStore("tokens").getAll();
    all.onsuccess = () => { resolve(all.result); open.result.close(); };
  };
}));

/** Ana's app has what Bo shared (its engine keeps it on the chat's row). */
const anaHasTarget = (page: Page) => page.evaluate(() => new Promise<boolean>((resolve) => {
  const open = indexedDB.open("ghostly");
  open.onsuccess = () => {
    const all = open.result.transaction("links").objectStore("links").getAll();
    all.onsuccess = () => { resolve((all.result as { peerWake?: { endpoint: string } }[]).some((l) => l.peerWake?.endpoint === "https://fcm.googleapis.com/fcm/send/bo")); open.result.close(); };
  };
  open.onerror = () => resolve(false);
}));

const connected = (p: Peer) => expect(p.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 120_000 });
const away = (p: Peer) => expect(p.page.getByTestId("connection-options")).not.toHaveAttribute("aria-label", /Connected/, { timeout: 120_000 });

async function reopen(bo: Peer, hash = "#/"): Promise<void> {
  bo.page = await bo.context.newPage();
  await bo.page.goto(`/${hash}`);
  await expect(bo.page.getByTitle("New Chat")).toBeVisible();
}

test("a message to a closed web app wakes it with a push its contact's app sends; a muted chat stays quiet", { tag: ["@feature:push.wake.send", "@feature:push.wake.notify", "@feature:push.wake.mute"] }, async ({ peer }) => {
  test.skip(deployed, "the push service stand-in routes the sender's own post");
  test.setTimeout(8 * 60_000);
  const keys = subscriptionKeys();
  const [ana, bo] = await Promise.all([peer("ana"), peer("bo", { serviceWorkers: "allow" })]);
  await bo.context.grantPermissions(["notifications"], { origin: new URL(bo.page.url()).origin });
  await standInPushManager(bo.context, { p256dh: keys.p256dh, auth: keys.authB64 });
  const posts = await pushService(ana.context);
  await bo.page.reload();
  await expect(bo.page.getByTitle("New Chat")).toBeVisible();

  await link(ana, bo);
  await connect(ana, bo);
  for (const p of [ana, bo]) await connected(p);
  const chatUrl = bo.page.url();

  // Bo turns it on: Ana's app learns where and how to wake Bo's, on the live session.
  await bo.page.goto("/#/settings");
  await bo.page.getByTestId("settings-wake").click();
  await expect(bo.page.getByTestId("settings-wake")).toBeChecked();
  await expect.poll(() => anaHasTarget(ana.page), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await wakeTable(bo.page)).length).toBe(1);
  const [row] = await wakeTable(bo.page);
  expect(chatUrl).toContain(row!.path);

  // Muted: Ana's app is told to forget Bo's subscription (the worker checks the mute too), so nothing is posted.
  await bo.page.evaluate((path) => {
    const id = decodeURIComponent(path.replace("/chat/", ""));
    localStorage.setItem(`ghostly_mute_${id}`, "forever");
    window.dispatchEvent(new Event("chat-mute-updated"));
  }, row!.path);
  await expect.poll(() => anaHasTarget(ana.page), { timeout: 60_000 }).toBe(false);
  await bo.page.close();
  await away(ana);
  await say(ana, "are you awake?");
  await ana.page.waitForTimeout(3000);
  expect(posts).toHaveLength(0);

  // Unmuted, and away again: one push, which says only the chat's token and shows "New message".
  await reopen(bo, new URL(chatUrl).hash);
  await bo.page.evaluate((path) => {
    localStorage.removeItem(`ghostly_mute_${decodeURIComponent(path.replace("/chat/", ""))}`);
    window.dispatchEvent(new Event("chat-mute-updated"));
  }, row!.path);
  await expect(chat(bo).getByText("are you awake?")).toBeVisible({ timeout: 150_000 });
  await expect.poll(() => anaHasTarget(ana.page), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await wakeTable(bo.page)).filter((r) => r.mutedUntil === undefined).length).toBe(1);
  const [unmuted] = await wakeTable(bo.page);
  expect(unmuted!.token).not.toBe(row!.token);
  await connected(ana);
  await bo.page.close();
  await away(ana);
  await say(ana, "wake up");
  await expect.poll(() => posts.length, { timeout: 60_000 }).toBe(1);
  const pushed = readPush(posts[0]!, keys);
  expect(readWakePayload(pushed)).toBe(unmuted!.token);
  expect(pushed).not.toContain("wake up");
  // A burst is one push: a second message right after sends none.
  await say(ana, "hello?");
  await ana.page.waitForTimeout(1500);
  expect(posts).toHaveLength(1);
  const worker = await workerConsole(bo.context);
  await worker.deliver(pushed);
  await expect.poll(() => worker.shown()).toEqual([{ body: "New message", tag: expect.stringContaining(row!.path), path: row!.path }]);

  // A push naming a token Bo no longer uses (the one from before the mute) shows nothing.
  await worker.deliver(JSON.stringify({ wake: 1, k: row!.token }));
  await worker.page.waitForTimeout(1500);
  expect(await worker.shown()).toHaveLength(1);

  // The tap: the app's window comes to that chat (a new window opens only from a real tap, which a test cannot make).
  await reopen(bo);
  const [notice] = await worker.shown();
  await worker.page.evaluate(async (tag) => {
    const registration = await navigator.serviceWorker.getRegistration("/push/default/");
    registration!.active!.postMessage({ type: "open-notification", tag });
  }, notice!.tag);
  await expect(bo.page).toHaveURL(new RegExp(`#${row!.path}$`));
  await expect(chat(bo).getByText("wake up")).toBeVisible({ timeout: 150_000 });
  await expect(chat(bo).getByText("hello?")).toBeVisible({ timeout: 150_000 });
  expect(await worker.shown()).toEqual([]);
});

test("turning it off tells the contact, and stops the wake-ups", { tag: ["@feature:push.wake.exchange"] }, async ({ peer }) => {
  test.skip(deployed, "the push service stand-in routes the sender's own post");
  test.setTimeout(5 * 60_000);
  const keys = subscriptionKeys();
  const [ana, bo] = await Promise.all([peer("ana"), peer("bo", { serviceWorkers: "allow" })]);
  await bo.context.grantPermissions(["notifications"], { origin: new URL(bo.page.url()).origin });
  await standInPushManager(bo.context, { p256dh: keys.p256dh, auth: keys.authB64 });
  await bo.page.reload();
  await expect(bo.page.getByTitle("New Chat")).toBeVisible();
  await link(ana, bo);
  await connect(ana, bo);
  await bo.page.goto("/#/settings");
  await bo.page.getByTestId("settings-wake").click();
  await expect.poll(() => anaHasTarget(ana.page), { timeout: 60_000 }).toBe(true);
  await bo.page.getByTestId("settings-wake").click();
  await expect(bo.page.getByTestId("settings-wake")).not.toBeChecked();
  await expect.poll(() => anaHasTarget(ana.page), { timeout: 60_000 }).toBe(false);
  await expect.poll(async () => (await wakeTable(bo.page)).length).toBe(0);
});

test("a call to a closed web app wakes it with \"Incoming call\", and rings once the app is open", { tag: ["@feature:push.wake.call"] }, async ({ peer }) => {
  test.skip(deployed, "the push service stand-in routes the sender's own post");
  test.setTimeout(6 * 60_000);
  const keys = subscriptionKeys();
  const [ana, bo] = await Promise.all([peer("ana"), peer("bo", { serviceWorkers: "allow" })]);
  await bo.context.grantPermissions(["notifications"], { origin: new URL(bo.page.url()).origin });
  await standInPushManager(bo.context, { p256dh: keys.p256dh, auth: keys.authB64 });
  const posts = await pushService(ana.context);
  await bo.page.reload();
  await expect(bo.page.getByTitle("New Chat")).toBeVisible();
  await link(ana, bo);
  await connect(ana, bo);
  for (const p of [ana, bo]) await connected(p);
  const chatUrl = bo.page.url();
  await bo.page.goto("/#/settings");
  await bo.page.getByTestId("settings-wake").click();
  await expect.poll(() => anaHasTarget(ana.page), { timeout: 60_000 }).toBe(true);
  const [row] = await wakeTable(bo.page);
  await bo.page.close();
  await away(ana);

  // Away, and the call buttons still work: Ana's app wakes Bo's and waits.
  await ana.page.getByTestId("call-audio").click();
  await expect(ana.page.getByTestId("wake-call")).toHaveAttribute("data-state", "waking");
  await expect.poll(() => posts.length, { timeout: 60_000 }).toBe(1);
  const pushed = readPush(posts[0]!, keys);
  expect(JSON.parse(pushed)).toEqual({ wake: 1, k: row!.token, c: 1 });
  const worker = await workerConsole(bo.context);
  await worker.deliver(pushed);
  await expect.poll(() => worker.shown(), { intervals: [200] }).toEqual([{ body: "Incoming call", tag: expect.stringContaining("wake-call"), path: row!.path }]);

  // Bo opens the app (the tap): the chat goes live, Ana's call goes out, and Bo's app rings.
  await reopen(bo, new URL(chatUrl).hash);
  await expect(bo.page.getByTitle("Accept audio call")).toBeVisible({ timeout: 120_000 });
  await expect(ana.page.getByTestId("wake-call")).toHaveCount(0);
});
