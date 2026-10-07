import { chat, say } from "../support/fixtures";
import { type Adb, PKG, activityStarts, expect, newChat, pairWithWeb, pending, skipUntilA1, test } from "./support/android";

/**
 * The Android host (A1): what the system does for the app, read from the system's side over adb. Until the APK under
 * test has that host, each test meets the app's own refusal (support/android.ts `pending`) or a manifest without the
 * permission, filter or scheme it needs, and skips saying so; E2E_ANDROID_A1=1 makes that a failure instead.
 */

const OWN_INVITE = "This is your own invite. Share it with a contact; they join with it.";

/** The emulator's word on intents: logcat's activity starts and `dumpsys activity activities`, as one text. */
const intentsSeen = (adb: Adb, since: number) => [...activityStarts(adb).slice(since), adb.shell("dumpsys activity activities")].join("\n");

test("a link opens in the system: an ACTION_VIEW intent for it", { tag: ["@feature:android.host.opener", "@gated"] }, async ({ app, relayUrl }) => {
  // A page on the test's relay (the emulator's 127.0.0.1, `adb reverse`d): whatever opens it reaches nothing public.
  const url = `${relayUrl}/opened-by-ghostly`;
  const before = activityStarts(app.adb).length;
  // What a tap on a link in a message calls (apps/ui/src/lib/externalLink.ts).
  const refused = await app.invoke("open_web_link", { url }).then(() => null, (error: unknown) => error);
  skipUntilA1("Opening a link", pending(refused));
  expect(refused, "open_web_link").toBeNull();
  const view = /act=android\.intent\.action\.VIEW[^}\n]*dat=http:\/\/127\.0\.0\.1/;
  await expect.poll(() => view.test(intentsSeen(app.adb, before)), { timeout: 20_000, message: "an ACTION_VIEW for the link in logcat or dumpsys activity" }).toBe(true);
  app.foreground();
});

test("copy and paste go through the system clipboard", { tag: ["@feature:android.host.clipboard", "@gated"] }, async ({ app }) => {
  const { page } = app;
  const refused = await app.invoke("read_clipboard_text").then(() => null, (error: unknown) => error);
  skipUntilA1("The clipboard", pending(refused));
  await newChat(page).click();
  await expect(page.getByTestId("invite-link")).toHaveAttribute("title", /^https:\/\/ghostly\.tools\/#ghostly1/, { timeout: 120_000 });
  await page.getByTestId("invite-card").getByRole("button", { name: /^(Copy invite|Copied!)$/ }).click();
  await page.evaluate(() => { location.hash = "#/"; });
  // Join reads it back from the system clipboard: its own invite, so the app says so (WISP 801 Q9).
  await page.getByRole("button", { name: "Join chat", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Paste from clipboard", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(OWN_INVITE);
});

/** The app's notifications as the system holds them (`dumpsys notification --noredact`), one record each. */
function notificationsOf(adb: Adb): string[] {
  return adb.shell("dumpsys notification --noredact").split(/(?=NotificationRecord\()/).filter((record) => record.startsWith("NotificationRecord(") && record.includes(`pkg=${PKG}`));
}

test("a message in the background posts a private system notification", { tag: ["@feature:android.host.notifications", "@gated"] }, async ({ app, webPeer }) => {
  const { page, adb } = app;
  const asks = adb.shell(`dumpsys package ${PKG}`).includes("android.permission.POST_NOTIFICATIONS");
  skipUntilA1("Notifications", !asks && "the app does not ask for POST_NOTIFICATIONS");
  // Granted as a person would on the system's prompt (`pm clear` took any earlier answer away).
  adb.run("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
  await page.evaluate(() => { location.hash = "#/settings/notifications"; });
  const notices = page.getByRole("switch", { name: "System notifications", exact: true });
  await notices.click();
  const on = await expect(notices).toBeChecked({ timeout: 10_000 }).then(() => true, () => false);
  skipUntilA1("Notifications", !on && "Settings could not turn system notifications on");
  await page.evaluate(() => { location.hash = "#/"; });

  const web = await webPeer("web-notices");
  await pairWithWeb(app, web);
  const before = notificationsOf(adb).length;
  app.background();
  await say(web, "private android payload");
  await expect.poll(() => notificationsOf(adb).length, { timeout: 60_000, message: "a notification of the app in dumpsys notification" }).toBeGreaterThan(before);
  // Private: the system holds "New message", never the text (app.attention.notifications).
  expect(notificationsOf(adb).join("\n")).not.toContain("private android payload");
  app.foreground();
  await expect(chat(app.peer).getByText("private android payload")).toBeVisible();
});

test("Share opens the system's share sheet: an ACTION_SEND through the chooser", { tag: ["@feature:android.host.share", "@gated"] }, async ({ app }) => {
  const before = activityStarts(app.adb).length;
  // What the invite's Share calls on a native host (apps/ui/src/lib/shareLink.ts).
  const answer = await app.invoke<boolean>("share_text", { text: "https://ghostly.tools/#android-e2e", anchor: null }).then((shown) => ({ shown }), (error: unknown) => ({ error }));
  skipUntilA1("The share sheet", "error" in answer && pending(answer.error));
  expect(answer).toEqual({ shown: true });
  await expect.poll(() => /act=android\.intent\.action\.(CHOOSER|SEND)\b/.test(intentsSeen(app.adb, before)), { timeout: 20_000, message: "the chooser or ACTION_SEND in logcat or dumpsys activity" }).toBe(true);
  app.adb.shell("input keyevent KEYCODE_BACK");
});

test("text shared from another app opens the Share to… picker", { tag: ["@feature:android.host.share-target", "@gated"] }, async ({ app }) => {
  const takes = app.adb.shell("cmd package query-activities -a android.intent.action.SEND -t text/plain").includes(PKG);
  skipUntilA1("Sharing into the app", !takes && "the app has no ACTION_SEND filter for text");
  const text = `shared-from-android-${Date.now()}`;
  app.adb.run("shell", "am", "start", "-a", "android.intent.action.SEND", "-t", "text/plain", "--es", "android.intent.extra.TEXT", text, "-p", PKG);
  await expect(app.page.getByTestId("share-picker")).toBeVisible();
  await expect(app.page.getByTestId("share-text")).toHaveText(text);
});

/**
 * The link schemes the app declares (`dumpsys package`'s resolver table, Schemes), other than the web's. The sign-in's
 * redirect is one of them unless E2E_ANDROID_OIDC_REDIRECT names it.
 */
function ownSchemes(adb: Adb): string[] {
  const dump = adb.shell(`dumpsys package ${PKG}`);
  const block = dump.match(/\n\s*Schemes:\n([\s\S]*?)(?=\n\s{0,4}\S[^\n]*:\n|\n\n)/)?.[1] ?? "";
  return [...block.matchAll(/^\s+([a-z][a-z0-9+.-]*):\s*$/gm)].map((m) => m[1]).filter((scheme) => !["http", "https"].includes(scheme));
}

test("a sign-in's deep link comes back to the running app and reaches the page", { tag: ["@feature:android.host.oidc-deep-link", "@gated"] }, async ({ app }) => {
  const { page, adb } = app;
  const redirect = process.env.E2E_ANDROID_OIDC_REDIRECT || (ownSchemes(adb)[0] ? `${ownSchemes(adb)[0]}://oidc-callback` : null);
  skipUntilA1("The sign-in deep link", !redirect && "the app declares no link scheme of its own");
  // How the page hears it: Tauri's deep-link event unless E2E_ANDROID_DEEP_LINK_EVENT names another, or its own address.
  const event = process.env.E2E_ANDROID_DEEP_LINK_EVENT || "deep-link://new-url";
  await page.evaluate((event) => {
    const w = window as unknown as { __a9: string; __a9Seen: string[]; __TAURI_INTERNALS__: { transformCallback(f: (e: { payload: unknown }) => void): number; invoke(c: string, a: unknown): Promise<unknown> } };
    w.__a9 = "the same page";
    w.__a9Seen = [];
    const handler = w.__TAURI_INTERNALS__.transformCallback((e) => w.__a9Seen.push(JSON.stringify(e.payload)));
    void w.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler }).catch(() => {});
    addEventListener("hashchange", () => w.__a9Seen.push(location.href));
  }, event);
  const state = `a9state${Date.now()}`;
  const url = `${redirect}#id_token=header.payload.signature&state=${state}`;
  // Quoted for the device's shell: `#` and `&` are its own otherwise.
  const started = adb.run("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${url}'`);
  expect(started, "the link resolves to the app, not a chooser").toMatch(new RegExp(`(Activity: ${PKG.replaceAll(".", "\\.")}/|delivered to currently running top-most instance)`));
  // The running app took it: the same process and page, not a new start.
  expect(adb.pid()).toBe(app.pid);
  expect(await page.evaluate(() => (window as unknown as { __a9: string }).__a9)).toBe("the same page");
  await expect.poll(() => page.evaluate((state) => (window as unknown as { __a9Seen: string[] }).__a9Seen.some((seen) => seen.includes(state)) || location.href.includes(state), state), { timeout: 15_000, message: `the page heard ${event} or its address changed` }).toBe(true);
});
