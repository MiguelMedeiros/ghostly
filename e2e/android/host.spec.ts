import { setTimeout as sleep } from "node:timers/promises";
import { chat, say } from "../support/fixtures";
import { type Adb, PKG, activityStarts, expect, newChat, pairWithWeb, pending, skipUntilA1, test, webViewPage } from "./support/android";

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
  // A person's message comes once the app is away: the page has heard it went to the background (onStop → hidden).
  await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000, message: "the page sees the app in the background" }).toBe("hidden");
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

test("text shared while the app's process is gone but its task is in Recents opens the Share to… picker", { tag: ["@feature:android.host.share-target", "@gated"] }, async ({ app }) => {
  const { adb, device } = app;
  const takes = adb.shell("cmd package query-activities -a android.intent.action.SEND -t text/plain").includes(PKG);
  skipUntilA1("Sharing into the app", !takes && "the app has no ACTION_SEND filter for text");
  app.background();
  await expect.poll(() => app.page.evaluate(() => document.visibilityState), { timeout: 10_000, message: "the page sees the app in the background" }).toBe("hidden");
  // Android ends the process for memory and keeps the task: `am kill` ends only a process that is safe to end, so it
  // is asked until the app's process is in the background enough for it.
  await expect.poll(() => {
    adb.tryRun("shell", "am", "kill", PKG);
    return adb.pid();
  }, { timeout: 30_000, message: "the app's process ended by am kill" }).toBe("");
  expect(adb.shell("dumpsys activity recents"), "the app's task still in Recents").toContain(PKG);
  const text = `shared-after-kill-${Date.now()}`;
  // The task's activity (singleTask) is made again in a new process and gets the share as a new intent.
  adb.run("shell", "am", "start", "-W", "-a", "android.intent.action.SEND", "-t", "text/plain", "--es", "android.intent.extra.TEXT", text, "-p", PKG);
  let pid = "";
  await expect.poll(() => (pid = adb.pid()), { timeout: 30_000, message: "the app's new process" }).not.toBe("");
  const page = await webViewPage(device, Number(pid));
  await expect(page.getByTestId("share-picker")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("share-text")).toHaveText(text);
});

/** A task of the app whose root intent is a share (`dumpsys activity recents`). */
const shareRooted = /baseIntent=Intent \{ act=android\.intent\.action\.SEND [^\n]*pkg=tools\.ghostly\.app/;

test("a share that started the app is not offered again when Android brings the app back after ending its process", { tag: ["@feature:android.host.share-target", "@gated"] }, async ({ app, relayUrl }) => {
  const { adb, device } = app;
  const takes = adb.shell("cmd package query-activities -a android.intent.action.SEND -t text/plain").includes(PKG);
  skipUntilA1("Sharing into the app", !takes && "the app has no ACTION_SEND filter for text");
  // The app not running and no task of it: the share starts it, and is its task's root intent (the profile and its
  // Network settings stay). A debug e2e start, as the fixture's.
  adb.run("shell", "am", "force-stop", PKG);
  const text = `shared-at-start-${Date.now()}`;
  adb.run("shell", "am", "start", "-W", "-f", "0x10008000", "-a", "android.intent.action.SEND", "-t", "text/plain", "--es", "android.intent.extra.TEXT", text, "-p", PKG, "--ez", "ghostly_e2e", "true", "--es", "GHOSTLY_PKARR_RELAYS", relayUrl);
  expect(adb.shell("dumpsys activity recents"), "the share is the root intent of the app's task").toMatch(shareRooted);
  let pid = "";
  await expect.poll(() => (pid = adb.pid()), { timeout: 30_000, message: "the app's process" }).not.toBe("");
  let page = await webViewPage(device, Number(pid));
  await expect(page.getByTestId("share-text")).toHaveText(text, { timeout: 120_000 });
  await page.getByTestId("share-cancel").click();
  await expect(page.getByTestId("share-picker")).toBeHidden();

  adb.shell("input keyevent KEYCODE_HOME");
  await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000, message: "the page sees the app in the background" }).toBe("hidden");
  await expect.poll(() => {
    adb.tryRun("shell", "am", "kill", PKG);
    return adb.pid();
  }, { timeout: 30_000, message: "the app's process ended by am kill" }).toBe("");
  expect(adb.shell("dumpsys activity recents"), "the app's task, the share's, still in Recents").toMatch(shareRooted);

  // Back from Recents, as a person would: the overview, then its front card (the app's task, the latest one).
  adb.shell("input keyevent KEYCODE_APP_SWITCH");
  await sleep(2_000);
  const [width, height] = (/(\d+)x(\d+)/.exec(adb.shell("wm size")) ?? []).slice(1).map(Number);
  adb.shell(`input tap ${Math.round(width / 2)} ${Math.round(height / 2)}`);
  await expect.poll(() => (pid = adb.pid()), { timeout: 30_000, message: "the app's new process" }).not.toBe("");
  page = await webViewPage(device, Number(pid));
  // The chat list, or the picker over it: the share Rust would hand over comes at the page's start, a few seconds more
  // for it to show, then none.
  await expect(newChat(page).or(page.getByTestId("share-picker")), "the UI rendered").toBeAttached({ timeout: 120_000 });
  await sleep(5_000);
  await expect(page.getByTestId("share-picker")).toHaveCount(0);
});

/** The app's view of `id` in its activity's view hierarchy (`dumpsys activity`), as shown (V), or null when there is none. */
function shownView(adb: Adb, id: string): boolean | null {
  const line = adb.shell(`dumpsys activity ${PKG}/.MainActivity`).split("\n").find((entry) => entry.trimEnd().endsWith(`app:id/${id}}`));
  return line ? /\{[0-9a-f]+ V/.test(line) : null;
}

test("with the lock screen on, the app switcher shows the app's cover: its mark and one line", { tag: ["@feature:android.host.switcher-cover", "@gated"] }, async ({ app }) => {
  const { page, adb } = app;
  await page.evaluate(() => { location.hash = "#/settings/privacy"; });
  await page.getByTestId("settings-lock").click();
  const passwords = page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill("switcher-cover");
  await passwords.nth(1).fill("switcher-cover");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByTestId("settings-lock-now")).toBeVisible();
  adb.shell("input keyevent KEYCODE_APP_SWITCH");
  // The switcher shows the app's live window: the cover is over the page there, with the app's mark and its line.
  await expect.poll(() => shownView(adb, "lock_cover"), { timeout: 20_000, message: "the cover shown in the switcher" }).toBe(true);
  expect(shownView(adb, "lock_cover_mark"), "the app's mark on the cover").toBe(true);
  expect(shownView(adb, "lock_cover_line"), "the cover's line").toBe(true);
  app.foreground();
  await expect.poll(() => shownView(adb, "lock_cover"), { timeout: 20_000, message: "the cover gone once the app is back" }).toBe(false);
});

/**
 * Sign-in on Android (A1, apps/desktop/src/oidc.rs): there is no loopback listener on a phone, so
 * `oidc_loopback_start` answers port 0 and `oidc_loopback_wait` opens the provider in the browser and waits for the
 * answer to come back as a deep link, `ghostly://oidc?…#…` (the web app's callback page sends it). Rust takes only the
 * answer whose `state` is the one it is waiting for (an `a.`-prefixed one); any other is dropped and the wait goes on.
 * E2E_ANDROID_OIDC_REDIRECT names another link prefix (an App Link later, A2).
 */
const OIDC_LINK = process.env.E2E_ANDROID_OIDC_REDIRECT || "ghostly://oidc";

test("a sign-in's deep link comes back to the running app and answers the sign-in that waits for it", { tag: ["@feature:android.host.oidc-deep-link", "@gated"] }, async ({ app }) => {
  const { page, adb } = app;
  let port: unknown;
  try { port = await app.invoke("oidc_loopback_start"); } catch (error) { skipUntilA1("The sign-in deep link", pending(error) ?? false); throw error; }
  expect(port, "on Android the sign-in waits for a deep link, not on a loopback port").toBe(0);
  const state = `a.${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  await page.evaluate(([port, state]) => {
    const w = window as unknown as { __a9: string; __a9SignIn: Promise<{ answer?: unknown; error?: string }>; __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } };
    w.__a9 = "the same page";
    w.__a9SignIn = w.__TAURI_INTERNALS__.invoke("oidc_loopback_wait", { port, url: "https://example.com/authorize?client_id=a9&redirect_uri=https%3A%2F%2Fapp.ghostly.tools%2Foidc-callback.html", expectedState: state })
      .then((answer) => ({ answer }), (error) => ({ error: String(error) }));
  }, [port, state] as const);
  // The browser opened on the provider's page (no network needed: the page is never read).
  await expect.poll(() => adb.shell("dumpsys activity activities").match(/topResumedActivity=\S+ \S+ (\S+)/)?.[1] ?? "", { timeout: 15_000, message: "the provider's page in the system browser" }).not.toContain("tools.ghostly.app");

  // Another sign-in's answer first: dropped, the wait goes on. Quoted for the device's shell (`#`, `&`).
  adb.run("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${OIDC_LINK}?code=other&state=a.${"B".repeat(43)}'`);
  await new Promise((done) => setTimeout(done, 1_500));
  expect(await page.evaluate(() => Promise.race([(window as unknown as { __a9SignIn: Promise<unknown> }).__a9SignIn, new Promise((done) => setTimeout(() => done("waiting"), 200))]))).toBe("waiting");

  // Its own answer: back to the running app (the same process and page), and the waiting sign-in gets it.
  const started = adb.run("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${OIDC_LINK}?code=a9&state=${state}'`);
  expect(started, "the link resolves to the app, not a chooser").toMatch(new RegExp(`(Activity: ${PKG.replaceAll(".", "\\.")}/|delivered to currently running top-most instance|brought to the front)`));
  expect(adb.pid()).toBe(app.pid);
  const result = await page.evaluate(() => Promise.race([(window as unknown as { __a9SignIn: Promise<unknown> }).__a9SignIn, new Promise((done) => setTimeout(() => done({ error: "no answer in 15 s" }), 15_000))]));
  expect(result).toEqual({ answer: `?code=a9&state=${state}` });
  expect(await page.evaluate(() => (window as unknown as { __a9: string }).__a9)).toBe("the same page");
});
