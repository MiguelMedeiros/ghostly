import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { APP_URL, STORE_URL, serveStore, testStore } from "../support/appStore";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { smallTargets } from "../support/touchTargets";

/**
 * On a phone every control a thumb presses is at least 44 × 44 px where a tap lands, as the chat headers, the bottom
 * tabs and the chat rows are: the main screens at 375 px wide, measured control by control. The chat list's New, its
 * arrow and Join were 40 px tall (the arrow 24 px wide), a file's Accept, Decline, Pause, Resume and Cancel 20-24 px.
 */
test("on a phone every button, link and control on the main screens is a 44 px target", { tag: ["@feature:app.mobile-layout", "@feature:files.large.offer", "@feature:groups.community.create"] }, async ({ peer }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const phone = { width: 375, height: 667 };
  const alice = await peer("alice", { mobile: true, viewport: phone });
  const { page } = alice;
  // Each control once, on the first screen it was seen: a message's ⋮ is on every screen of the chat.
  const small = new Map<string, string>();
  const measure = async (screen: string) => {
    for (const target of await smallTargets(page)) if (!small.has(target.name)) small.set(target.name, `${screen}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
  };

  await measure("chat list, empty");
  const tabs = page.getByTestId("mobile-tabs");
  await tabs.getByRole("button", { name: "Wallets" }).click();
  await expect(page.getByTestId("wallet")).toBeVisible();
  // A new profile's first-run card (no setup runs under test), its inline New with it: measured once it is there.
  await expect(page.getByTestId("wallet-first").getByTestId("wallet-first-new")).toBeVisible();
  await measure("wallet");
  await tabs.getByRole("button", { name: "Apps" }).click();
  await expect(page.getByTestId("apps-page")).toBeVisible();
  await measure("apps");
  await tabs.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await measure("settings");
  await page.goto("/#/tasks");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await measure("tasks");
  await page.goto("/#/");
  await expect(tabs).toBeVisible();

  // A group of one's own: its header and its empty chat.
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Phone targets");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  await expect(page.getByTestId("group-name")).toHaveText("Phone targets");
  await measure("group chat");
  await page.screenshot({ path: testInfo.outputPath("group-chat.png") });
  await page.getByTestId("chat-back").click();

  // A 1:1 chat with a message in it and a file over the 25 MiB a receiver takes without asking, each way.
  const bob = await peer("bob");
  await link(alice, bob);
  await connect(alice, bob);
  await say(bob, "hello on a small screen");
  await expect(chat(alice).getByText("hello on a small screen")).toBeVisible();
  await measure("1:1 chat");

  const offered = testInfo.outputPath("offered.bin");
  writeFileSync(offered, Buffer.alloc(26 * 1024 * 1024, 7));
  await bob.page.getByTestId("file-input").setInputFiles(offered);
  const incoming = page.getByTestId("file-bubble").filter({ hasText: "offered.bin" });
  await expect(incoming.getByTestId("file-accept")).toBeVisible({ timeout: 60_000 });
  await incoming.scrollIntoViewIfNeeded();
  await measure("file offer (Accept, Decline)");
  await page.screenshot({ path: testInfo.outputPath("file-offer.png") });
  await incoming.getByTestId("file-decline").click();

  const sent = testInfo.outputPath("sent.bin");
  writeFileSync(sent, Buffer.alloc(60 * 1024 * 1024, 7));
  await page.getByTestId("file-input").setInputFiles(sent);
  const outgoing = page.getByTestId("file-bubble").filter({ hasText: "sent.bin" });
  await expect(outgoing.getByTestId("file-cancel")).toBeVisible({ timeout: 60_000 });
  await outgoing.scrollIntoViewIfNeeded();
  await measure("file waiting for the contact (Cancel)");
  await bob.page.getByTestId("file-bubble").filter({ hasText: "sent.bin" }).getByTestId("file-accept").click({ timeout: 60_000 });
  await outgoing.getByTestId("file-pause").click({ timeout: 60_000 });
  await expect(outgoing.getByTestId("file-resume")).toBeVisible();
  await outgoing.scrollIntoViewIfNeeded();
  await measure("paused file (Resume, Cancel)");
  await page.screenshot({ path: testInfo.outputPath("paused-file.png") });
  await outgoing.getByTestId("file-cancel").click();

  await page.getByTestId("chat-back").click();
  await expect(tabs).toBeVisible();
  await measure("chat list");
  // With their words still, beside the logo.
  await expect(page.getByTestId("sidebar-new-chat")).toContainText("New");
  await expect(page.getByTestId("sidebar-new-chat").locator(".sidebar-action-label")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-list-375.png") });

  // The narrowest phone: New, its arrow and Join, as tall and as wide, still fit beside the logo.
  await page.setViewportSize({ width: 320, height: 568 });
  await measure("chat list at 320 px");
  await page.screenshot({ path: testInfo.outputPath("chat-list-320.png") });
  const logo = (await page.getByTestId("app-brand").boundingBox())!;
  const actions = (await page.getByTestId("sidebar-chat-actions").boundingBox())!;
  expect(logo.x + logo.width + 8, "8 px between the logo and New").toBeLessThanOrEqual(actions.x);
  expect(actions.x + actions.width, "Join ends inside the screen").toBeLessThanOrEqual(320);

  expect([...small.values()], "controls under 44 × 44 px on a phone").toEqual([]);
});

/** The app in `language` (the setting a reload reads), back on the screen that was open. */
const speak = async ({ page }: Peer, language: string, dir: "ltr" | "rtl") => {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", dir);
};

/**
 * The narrowest phone (320 × 568): the composer's + and smiley were 36 px wide, to leave the message more room, and the
 * chat's Back 36 px, to leave the name more. They are 44 px targets as everywhere else, and the message field is still
 * wide enough to write in, in English and in Arabic.
 */
test("on a 320 px phone the chat's Back and the composer's + and smiley are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.setTimeout(3 * 60_000);
  const [alice, bob] = await Promise.all([peer("narrow-chat-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("narrow-chat-bob")]);
  await pair(alice, bob);
  const { page } = alice;
  await page.setViewportSize({ width: 320, height: 568 });
  const small: string[] = [];
  for (const [language, dir] of [["en", "ltr"], ["ar", "rtl"]] as const) {
    await speak(alice, language, dir);
    const field = page.locator(".composer-textarea");
    await expect(field).toBeVisible();
    // The chat's rows slide in after the reload: measured where they come to rest.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    for (const target of await smallTargets(page)) small.push(`${language}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
    await page.screenshot({ path: testInfo.outputPath(`chat-320-${language}.png`) });
    const width = (await field.boundingBox())!.width;
    testInfo.annotations.push({ type: "message field", description: `${language}: ${width} px wide at 320 px` });
    expect(width, `${language}: the message field keeps room to write in`).toBeGreaterThanOrEqual(150);
  }
  expect(small, "controls under 44 × 44 px on a 320 px phone").toEqual([]);
});

/**
 * A system line long enough to wrap (the contact's "joined the chat", in Japanese at 375 px: "<key> がチャットに参加しました")
 * took the row's whole width, which put its ⋮ against the screen's edge: the edge cut where a tap lands on it to 33 px
 * wide. A system row keeps the room the ⋮'s hit area takes, on both sides: in Arabic the ⋮ is on the left.
 */
test.describe("on a phone a system line that wraps", () => {
  /**
   * The contact's joined line (not mine) wraps, and its ⋮ is inside the screen and a 44 px target where a tap lands. How
   * wide the line is depends on the machine's fonts (GitHub's runner has no Japanese one and draws narrower boxes): the
   * screen narrows 20 px at a time, down to 280, until the line takes two lines.
   */
  const checkJoined = async ({ page }: Peer, mine: string, language: string) => {
    const line = page.getByTestId("join-line").filter({ hasNotText: mine });
    await expect(line).toHaveCount(1, { timeout: 30_000 });
    const row = page.locator("[data-message-row]").filter({ has: line });
    const options = row.getByTestId("message-options");
    const { width: start, height } = page.viewportSize()!;
    let vw = start;
    for (;;) {
      await row.scrollIntoViewIfNeeded();
      // Two lines of text: otherwise the line has room to spare and this proves nothing.
      if ((await line.boundingBox())!.height > 36) break;
      expect(vw - 20, `${language}: the contact's joined line wraps from ${start} down to 280 px`).toBeGreaterThanOrEqual(280);
      vw -= 20;
      await page.setViewportSize({ width: vw, height });
    }
    const label = `${language} at ${vw} px`;
    const box = (await options.boundingBox())!;
    expect(box.x, `${label}: the ⋮ starts inside the screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label}: the ⋮ ends inside the screen`).toBeLessThanOrEqual(vw);
    const small = (await smallTargets(page)).filter((target) => target.name.includes("message-options"));
    expect(small.map((t) => `${t.name} ${t.width}×${t.height} (${t.stops})`), `${label}: a system line's ⋮ under 44 × 44 px`).toEqual([]);
  };

  test("keeps its ⋮ a 44 px target inside the screen, in Japanese and in Arabic", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n", "@feature:chat.paired.join-notice"] }, async ({ peer }, testInfo) => {
    test.setTimeout(3 * 60_000);
    const alice = await peer("alice", { mobile: true, viewport: { width: 375, height: 667 } });
    const bob = await peer("bob");
    await link(alice, bob);
    await connect(alice, bob);

    await speak(alice, "ja", "ltr");
    await checkJoined(alice, "あなたがチャットに参加しました", "ja");
    await alice.page.screenshot({ path: testInfo.outputPath("joined-ja-375.png") });

    // Arabic's line is shorter: it wraps on the narrowest phone, with the ⋮ at the left edge.
    await alice.page.setViewportSize({ width: 320, height: 568 });
    await speak(alice, "ar", "rtl");
    await checkJoined(alice, "انضممت إلى المحادثة", "ar");
    await alice.page.screenshot({ path: testInfo.outputPath("joined-ar-320.png") });

    await speak(alice, "en", "ltr");
    await alice.page.screenshot({ path: testInfo.outputPath("joined-en-320.png") });
  });
});

test.describe("the voice recorder on a phone", () => {
  /**
   * The hands-free recorder's bar shows only while it records, so the screens above never reach it: its bin, Pause /
   * Resume and the preview's Play were 36 × 36 px, the Discard question's Keep and Discard 34 px tall. Chromium's fake
   * microphone (the web project's launch flags) records; the mic is started from the keyboard, which always records
   * hands-free (a tap of a finger on it only shows how it works).
   */
  test("its bin, Pause, Resume, the preview's Play and the Discard question's Keep and Discard are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:files.voice.record"] }, async ({ peer }, testInfo) => {
    test.setTimeout(3 * 60_000);
    const [alice, bob] = await Promise.all([peer("voice-phone-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("voice-phone-bob")]);
    await pair(alice, bob);
    const { page } = alice;
    const bar = page.getByTestId("voice-bar");
    const small = new Map<string, string>();
    const measure = async (screen: string) => {
      for (const target of await smallTargets(page)) if (!small.has(target.name)) small.set(target.name, `${screen}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
    };

    const mic = page.getByTestId("voice-record");
    await expect(mic).not.toHaveAttribute("aria-disabled");
    await mic.focus();
    await page.keyboard.press("Enter");
    await expect(bar).toHaveAttribute("data-mode", "locked");
    await expect(bar).toHaveAttribute("data-phase", "recording");
    await expect(page.getByTestId("voice-delete")).toBeVisible();
    // Past the 3 s after which Esc asks before it throws the recording away.
    await page.waitForTimeout(4_000);
    await measure("recording (bin, Pause)");
    await page.screenshot({ path: testInfo.outputPath("voice-recording.png") });

    await page.getByTestId("voice-pause").click();
    await expect(bar).toHaveAttribute("data-phase", "paused");
    await expect(page.getByTestId("voice-preview")).toBeVisible();
    await measure("paused (bin, preview Play, Resume)");
    await page.screenshot({ path: testInfo.outputPath("voice-paused.png") });

    await page.getByTestId("voice-pause").click();
    await expect(bar).toHaveAttribute("data-phase", "recording");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("voice-confirm")).toBeVisible();
    await measure("Discard? (Keep, Discard)");
    await page.screenshot({ path: testInfo.outputPath("voice-discard-question.png") });
    for (const id of ["voice-confirm-keep", "voice-confirm-discard"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id} drawn as before, inside the bar`).toBeLessThan(44);
    }
    await page.getByTestId("voice-confirm-discard").click();
    await expect(bar).toHaveCount(0);

    expect([...small.values()], "controls under 44 × 44 px on a phone").toEqual([]);
  });
});

test.describe("a voice message on a phone", () => {
  /** Ghostly's own Offline switch, on the Services page, then back to the chat (large-files.spec.ts). */
  const setOnline = async ({ page }: Peer, online: boolean) => {
    await page.getByTestId("account-services").click();
    const toggle = page.getByTestId("online-toggle");
    if ((await toggle.getAttribute("aria-checked")) !== String(online)) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", String(online));
    await page.goBack();
    await expect(page.getByPlaceholder("Message…")).toBeVisible();
  };

  /** Drops what a page sends its contacts over WebRTC, until it restarts (large-files.spec.ts holds them instead). */
  const dropSends = ({ page }: Peer) => page.evaluate(() => {
    RTCDataChannel.prototype.send = () => {};
  });

  /**
   * The speed pill shows only while a note plays or waits mid-way, and a sent note's round Resend only once it stopped
   * on its way, so the screens above reach neither: the pill took taps on 42 × 26 px, the Resend on 37 × 36. Bob's note
   * is played and paused. Alice's is offered while nothing she sends reaches Bob, Bob goes offline and her app restarts
   * with it unsent: stuck since the start, it offers Send again.
   */
  test("the speed pill and a sent note's Resend are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:files.voice.play", "@feature:files.large.resend"] }, async ({ peer }, testInfo) => {
    test.setTimeout(4 * 60_000);
    const [alice, bob] = await Promise.all([peer("voice-note-phone-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("voice-note-phone-bob")]);
    await pair(alice, bob);
    const { page } = alice;
    const small = new Map<string, string>();
    const measure = async (screen: string) => {
      for (const target of await smallTargets(page)) if (!small.has(target.name)) small.set(target.name, `${screen}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
    };
    /** Hands-free from the keyboard (the recorder's test above), sent after `ms`. */
    const record = async (who: Peer, ms: number) => {
      const mic = who.page.getByTestId("voice-record");
      await expect(mic).not.toHaveAttribute("aria-disabled");
      await mic.focus();
      await who.page.keyboard.press("Enter");
      await expect(who.page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
      await who.page.waitForTimeout(ms);
      await who.page.getByTestId("voice-send").click();
      await expect(who.page.getByTestId("voice-bar")).toHaveCount(0);
    };

    await record(bob, 4_000);
    const received = chat(alice).getByTestId("voice-bubble").last();
    await expect(received.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
    await received.getByTestId("voice-play").click();
    await expect(received).toHaveAttribute("data-state", "playing");
    await received.getByTestId("voice-play").click();
    await expect(received).toHaveAttribute("data-state", "paused");
    await expect(received.getByTestId("voice-speed")).toBeVisible();
    await received.scrollIntoViewIfNeeded();
    await measure("a received note paused mid-way (Play, speed)");
    await page.screenshot({ path: testInfo.outputPath("voice-note-paused.png") });

    await dropSends(alice);
    await record(alice, 2_000);
    const sent = chat(alice).getByTestId("voice-bubble").last();
    await expect(sent).toHaveAttribute("data-voice-sender", "me");
    await setOnline(bob, false);
    await page.reload();
    const resend = sent.locator("[data-testid=voice-resend], [data-testid=voice-retry]");
    await expect(resend).toBeVisible({ timeout: 30_000 });
    await sent.scrollIntoViewIfNeeded();
    await measure("a sent note stuck on its way (Resend)");
    await page.screenshot({ path: testInfo.outputPath("voice-note-resend.png") });

    expect([...small.values()], "controls under 44 × 44 px on a phone").toEqual([]);
  });
});

/**
 * An audio file (not a voice note) in the chat, which none of the screens above shows: its Play took taps on 36 × 36 px
 * and its Save on 32 × 32, beside a voice note's Play on 44. Bob's file is played and paused, so the speed pill shows too.
 */
test("on a phone a received audio file's Play, speed pill and Save are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:files.audio.play"] }, async ({ peer }, testInfo) => {
  test.setTimeout(3 * 60_000);
  const [alice, bob] = await Promise.all([peer("audio-phone-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("audio-phone-bob")]);
  await pair(alice, bob);
  const { page } = alice;

  await bob.page.getByTestId("file-input").setInputFiles(fileURLToPath(new URL("../support/audio-fixtures/ghost-tune.mp3", import.meta.url)));
  const received = chat(alice).getByTestId("audio-bubble").last();
  await expect(received.getByTestId("audio-play")).toBeEnabled({ timeout: 30_000 });
  await received.getByTestId("audio-play").click();
  await expect(received).toHaveAttribute("data-state", "playing");
  await received.getByTestId("audio-play").click();
  await expect(received).toHaveAttribute("data-state", "paused");
  await expect(received.getByTestId("voice-speed")).toBeVisible();
  await expect(received.getByTestId("audio-save")).toBeVisible();
  await received.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("audio-file-paused.png") });

  const small = (await smallTargets(page)).filter((target) => /audio-|voice-speed/.test(target.name)).map((target) => `${target.name} ${target.width}×${target.height} (${target.stops})`);
  expect(small, "an audio file's controls under 44 × 44 px on a phone").toEqual([]);
});

/**
 * Settings' on/off switches, in every section and on the Profile page, on a phone: 48 × 24 px drawn, and a tap landed on
 * 64 × 40 px of it, short of the 44 the rest of the app gives a thumb.
 */
test("on a phone every on/off switch in Settings and Profile is a 44 px target", { tag: ["@feature:app.mobile-layout", "@feature:settings.sections"] }, async ({ peer }) => {
  const { page } = await peer("switches", { mobile: true, viewport: { width: 375, height: 667 } });
  const small: string[] = [];
  let switches = 0;
  for (const place of ["settings/profile", "settings/appearance", "settings/notifications", "settings/media", "settings/privacy", "settings/network", "settings/storage", "settings/about", "profile"]) {
    await page.goto(`/#/${place}`);
    await expect(page.locator("header.page-header").first()).toBeVisible();
    // Each switch in view in turn: where a tap lands is measured on screen only.
    for (const toggle of await page.getByRole("switch").all()) {
      if (!(await toggle.isVisible())) continue;
      await toggle.scrollIntoViewIfNeeded();
      await toggle.evaluate((el) => el.setAttribute("data-measured", ""));
      for (const target of await smallTargets(page, 44, "[data-measured]")) small.push(`${place}: ${target.name} ${target.width}×${target.height}`);
      await toggle.evaluate((el) => el.removeAttribute("data-measured"));
      switches++;
    }
  }
  expect(switches, "switches seen").toBeGreaterThan(10);
  expect(small, "switches under 44 × 44 px on a phone").toEqual([]);
});

/**
 * Send files (files pasted, dropped or shared into a chat) only opens on a paste, so the walk above never reaches it:
 * each file's × was 28 × 28 px and Cancel / Send 40 px tall. A picture and three files pasted into a chat, measured
 * upright and on its side; the × of two tiles side by side must not reach over each other either.
 */
test.describe("on a phone, Send files", () => {
  /** A picture and `others` more files, pasted into the message field at once. */
  const pasteFiles = (page: Page, others: number) => page.evaluate(async (others) => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    canvas.getContext("2d")!.fillRect(0, 0, 900, 1200);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "IMG_0042.png", { type: "image/png" }));
    for (let i = 1; i <= others; i++) data.items.add(new File([new Uint8Array(100 * i)], `notes-${i}.txt`, { type: "text/plain" }));
    document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, others);

  /** Where a tap lands on each × of the sheet, as a box 44 px wide grown around it would be: their overlaps, in px². */
  const removersOverlap = (page: Page) => page.getByTestId("attachment-list").evaluate((list) => {
    const boxes = [...list.querySelectorAll<HTMLElement>("button[aria-label^='Remove ']")].map((button) => {
      const box = button.getBoundingClientRect(), [cx, cy] = [box.left + box.width / 2, box.top + box.height / 2];
      return { left: cx - 22, right: cx + 22, top: cy - 22, bottom: cy + 22 };
    });
    let worst = 0;
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
      worst = Math.max(worst, Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)));
    }
    return Math.round(worst);
  });

  for (const screen of [{ name: "upright", width: 375, height: 667 }, { name: "on its side", width: 667, height: 375 }]) {
    test(`${screen.name} (${screen.width} × ${screen.height}): each file's ×, Cancel and Send are 44 px targets`, { tag: ["@feature:app.mobile-layout", "@feature:app.composer.paste-files"] }, async ({ peer }, testInfo) => {
      const { page } = await peer("send-files-targets", { mobile: true, viewport: { width: screen.width, height: screen.height } });
      await page.getByTestId("sidebar-new-chat").filter({ visible: true }).first().click();
      await expect(page.locator("textarea")).toBeVisible();
      await pasteFiles(page, 3);
      const sheet = page.getByTestId("attachment-sheet");
      await expect(sheet.getByTestId("attachment-item")).toHaveCount(4);
      await expect(sheet.getByRole("img", { name: "IMG_0042.png" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`send-files-${screen.width}x${screen.height}.png`) });

      // Each one brought into view (the list scrolls on a short screen), a tap at its centre reaching it, then measured.
      const small: string[] = [];
      const controls = [...await sheet.getByRole("button", { name: /^Remove / }).all(), sheet.getByTestId("attachment-cancel"), sheet.getByTestId("attachment-send")];
      expect(controls).toHaveLength(6);
      for (const control of controls) {
        await control.scrollIntoViewIfNeeded();
        const name = await control.evaluate((el) => `${el.tagName.toLowerCase()} "${el.dataset.testid ?? el.getAttribute("aria-label")}"`);
        const reached = await control.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !!hit && (hit === el || el.contains(hit));
        });
        expect(reached, `a tap at the centre of ${name} reaches it`).toBe(true);
        for (const target of await smallTargets(page)) if (target.name === name) small.push(`${target.name} ${target.width}×${target.height} (${target.stops})`);
      }
      expect(await removersOverlap(page), "where a tap lands on one × reaches over another's (px²)").toBe(0);
      await sheet.getByTestId("attachment-list").evaluate((list) => list.scrollTo({ top: 0 }));
      await page.screenshot({ path: testInfo.outputPath(`send-files-${screen.width}x${screen.height}-measured.png`) });
      expect(small, `Send files' controls under 44 × 44 px, ${screen.name}`).toEqual([]);

      await sheet.getByTestId("attachment-cancel").click();
      await expect(sheet).toHaveCount(0);
    });
  }
});

/**
 * A chat's search bar on a phone: its ⓘ, ↑, ↓ and ✕ took taps on 40 × 40 px. On the narrowest phone, and in Arabic
 * (right to left, the buttons on the left), they are 44 px targets and the field keeps room for a word.
 */
test("on a phone the chat's search bar takes taps on 44 px and keeps room for the words", { tag: ["@feature:app.mobile-layout", "@feature:chat.search", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.setTimeout(3 * 60_000);
  const [alice, bob] = await Promise.all([peer("search-phone-alice", { mobile: true, viewport: { width: 375, height: 667 } }), peer("search-phone-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await say(bob, "find this word");
  await expect(chat(alice).getByText("find this word")).toBeVisible();
  const { page } = alice;
  for (const [language, dir, width] of [["en", "ltr", 375], ["en", "ltr", 320], ["ar", "rtl", 320]] as const) {
    if (language === "ar") {
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
        localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "ar" }));
      });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
    }
    await page.setViewportSize({ width, height: 667 });
    await page.getByTestId("chat-options").click();
    await page.getByTestId("chat-search-open").click();
    await page.getByTestId("chat-search-input").fill("word");
    await expect(page.getByTestId("chat-search-older")).toBeEnabled();
    const label = `${language} at ${width} px`;
    const small = await smallTargets(page, 44, "[data-testid=chat-search] button");
    expect(small.map((t) => `${t.name} ${t.width}×${t.height} (${t.stops})`), `${label}: search bar controls under 44 × 44 px`).toEqual([]);
    expect((await page.getByTestId("chat-search-input").boundingBox())!.width, `${label}: the search field's width`).toBeGreaterThanOrEqual(64);
    await page.screenshot({ path: testInfo.outputPath(`chat-search-${language}-${width}.png`) });
    await page.getByTestId("chat-search-close").click();
    await expect(page.getByTestId("chat-search")).toHaveCount(0);
  }
});

/**
 * A chat's search bar on a 320 px phone once its count shows: "Nenhum resultado" beside the field and the four 44 px
 * buttons left the field 12 px wide in Portuguese (it 18, fr 27, es 28, en 50). The count goes on a line of its own under
 * the field, in every language, and the buttons keep their 44 px.
 */
test("on a 320 px phone the chat's search field keeps room for the words once the count shows, in every language", { tag: ["@feature:app.mobile-layout", "@feature:chat.search", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("search-count-alice", { mobile: true, viewport: { width: 320, height: 640 } }), peer("search-count-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await say(bob, "find this word");
  await expect(chat(alice).getByText("find this word")).toBeVisible();
  const { page } = alice;
  const field = page.getByTestId("chat-search-input"), count = page.getByTestId("chat-search-count");
  for (const language of ["en", "pt", "es", "fr", "it", "ar", "ja", "zh"] as const) {
    await page.evaluate((language) => {
      const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
    }, language);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
    await page.getByTestId("chat-options").click();
    await page.getByTestId("chat-search-open").click();
    await field.fill("zzqx nothing here");
    await expect(count).toHaveText(/\S/);
    await expect(page.getByTestId("chat-search-older")).toBeDisabled();
    // The field as drawn: Chromium 158's clientWidth of a search input leaves its padding out (116 for the same 128 px).
    const fieldBox = (await field.boundingBox())!, countBox = (await count.boundingBox())!;
    expect(fieldBox.width, `${language}: the search field's width`).toBeGreaterThanOrEqual(120);
    expect(countBox.y, `${language}: the count is under the field`).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
    const small = await smallTargets(page, 44, "[data-testid=chat-search] button");
    expect(small.map((t) => `${t.name} ${t.width}×${t.height} (${t.stops})`), `${language}: search bar controls under 44 × 44 px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${language}: nothing wider than the screen`).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath(`chat-search-count-${language}-320.png`) });
    await page.getByTestId("chat-search-close").click();
    await expect(page.getByTestId("chat-search")).toHaveCount(0);
  }
});

/**
 * The screens a first visit opens, on a phone, control by control: every Settings section, the Profile and Services
 * pages, and the New wallet, Add identity and Join dialogs. A row's ⓘ took taps on 41 × 40 px, a dialog's Close on
 * 40 × 41, the colour swatches 32 × 32, Light / Dark / Auto and Compact / Comfortable were 32 px tall, the sound
 * previews and Network's Reset 32 × 32, Generate random name 40 × 40, About's GitHub 40 px tall, Services' Online 37.
 */
test("on a phone every control in Settings, Profile, Services and the first dialogs is a 44 px target", { tag: ["@feature:app.mobile-layout", "@feature:settings.sections"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const { page } = await peer("first-visit", { mobile: true, viewport: { width: 375, height: 667 } });
  const small: string[] = [];
  let seen = 0;
  // Each control in the middle of the screen in turn (a sheet scrolls; one cut by the screen's edge or under the tab bar
  // would read short): measured on screen.
  const measure = async (place: string, root: Locator) => {
    for (const control of await root.locator("button, a[href], [role=button]").all()) {
      if (!(await control.isVisible())) continue;
      await control.evaluate((el) => { el.scrollIntoView({ block: "center", inline: "center" }); el.setAttribute("data-measured", ""); });
      for (const target of await smallTargets(page, 44, "[data-measured]")) small.push(`${place}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
      await control.evaluate((el) => el.removeAttribute("data-measured"));
      seen++;
    }
  };

  for (const place of ["settings/profile", "settings/appearance", "settings/notifications", "settings/media", "settings/privacy", "settings/network", "settings/storage", "settings/about", "profile", "services"]) {
    await page.goto(`/#/${place}`);
    await expect(page.locator("header.page-header").first()).toBeVisible();
    await measure(place, page.locator("body"));
  }

  await page.goto("/#/wallet");
  await page.getByTestId("wallet-add").click();
  await measure("new wallet", page.getByTestId("new-wallet"));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-wallet")).toHaveCount(0);

  await page.goto("/#/identities");
  await page.getByTestId("identities-new").click();
  await measure("add identity", page.getByTestId("add-identity"));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("add-identity")).toHaveCount(0);

  await page.goto("/#/");
  await page.getByRole("button", { name: "Join chat", exact: true }).click();
  const join = page.locator("dialog[open]");
  await expect(join).toBeVisible();
  await measure("join", join);

  expect(seen, "controls seen").toBeGreaterThan(80);
  expect(small, "controls under 44 × 44 px on a phone").toEqual([]);
});

/**
 * Share to… (something another app shared, waiting for a chat) opens only from a share, so no walk above reaches it:
 * its Cancel took taps on 76 × 40 px (56 × 40 in Arabic) in the Android app. A text and a file shared into the installed
 * web app on a phone, its picker's controls measured each in view.
 */
test("on a phone the Share to… picker's chats and Cancel are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:app.pwa.share-target"] }, async ({ peer }) => {
  test.skip(!!process.env.E2E_WEB_URL, "posts a form to the share target, which the deployed CSP refuses");
  const { page } = await peer("share-targets", { mobile: true, viewport: { width: 375, height: 667 }, serviceWorkers: "allow" });
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Shared here");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  await page.goto("/#/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "")).toMatch(/\/sw\.js$/);
  // What the system does when a person shares into the installed app: a navigation that posts the manifest's form.
  await page.evaluate(() => {
    const form = Object.assign(document.createElement("form"), { method: "post", enctype: "multipart/form-data", action: "/share-target" });
    form.append(Object.assign(document.createElement("input"), { type: "hidden", name: "text", value: "Look at this" }));
    const files = Object.assign(document.createElement("input"), { type: "file", name: "files", multiple: true });
    const transfer = new DataTransfer();
    transfer.items.add(new File(["boo"], "ghost.txt", { type: "text/plain" }));
    files.files = transfer.files;
    form.append(files);
    document.body.append(form);
    form.submit();
  });
  const picker = page.getByTestId("share-picker");
  await expect(picker.getByTestId("share-files")).toHaveText("ghost.txt");
  await expect(picker.getByTestId("share-group")).toBeVisible();

  const small: string[] = [];
  const controls = await picker.locator("button, a[href], [role=button]").all();
  for (const control of controls) {
    if (!(await control.isVisible())) continue;
    await control.evaluate((el) => { el.scrollIntoView({ block: "center" }); el.setAttribute("data-measured", ""); });
    // Only a control a tap reaches is measured: the page's fade-in over it first gone.
    await expect.poll(() => control.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
    for (const target of await smallTargets(page, 44, "[data-measured]")) small.push(`${target.name} ${target.width}×${target.height} (${target.stops})`);
    await control.evaluate((el) => el.removeAttribute("data-measured"));
  }
  expect(controls.length, "the picker's controls").toBeGreaterThanOrEqual(2);
  expect(small, "the Share to… picker's controls under 44 × 44 px on a phone").toEqual([]);
});

/**
 * The banner that offers a new version shows only once the server serves one, so the screens above never reach it: its
 * Later (×) took taps on 11 × 20 px and Reload on 29 px of height. At 375 and 320 px, in English and in Arabic.
 */
test("on a phone the new version banner's Reload and Later are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:app.updates.web"] }, async ({ peer }, testInfo) => {
  const alice = await peer("update-banner-targets", { mobile: true, viewport: { width: 375, height: 667 } });
  const { page } = alice;
  await page.route("**/version.json", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "9.9.9", build: "newer" }) }));
  const banner = page.getByTestId("update-banner");
  const small: string[] = [];
  for (const [language, dir] of [["en", "ltr"], ["ar", "rtl"]] as const) {
    await speak(alice, language, dir);
    await expect(banner).toBeVisible();
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 667 });
      await expect(banner.getByRole("button")).toHaveCount(2);
      for (const target of await smallTargets(page, 44, "[data-testid=update-banner] button")) small.push(`${language} at ${width} px: ${target.name} ${target.width}×${target.height} (${target.stops})`);
      await page.screenshot({ path: testInfo.outputPath(`update-banner-${language}-${width}.png`) });
    }
  }
  expect(small, "the new version banner's controls under 44 × 44 px on a phone").toEqual([]);
});

/**
 * The composer's emoji panel, a sheet on a phone: its category icons took taps on 45 × 40 px (38 × 40 at 320 px), the
 * skin tone on 36 × 36, Emoji and GIF on 57 × 32, and at 320 px each emoji on 43 × 40. In English and in Arabic, at 375
 * and 320 px, each in turn brought into view and measured; the grid still never scrolls sideways, seven emoji to a row
 * at 320 px, and the category row keeps the one underlined in view as the grid scrolls.
 */
test("on a phone the emoji panel's categories, skin tone, Emoji / GIF switch and emoji are 44 px targets", { tag: ["@feature:app.mobile-layout", "@feature:app.emoji-picker", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.setTimeout(3 * 60_000);
  const alice = await peer("emoji-targets", { mobile: true, viewport: { width: 375, height: 667 } });
  const { page } = alice;
  const small: string[] = [];
  const panel = page.getByTestId("expression-panel");
  const grid = panel.getByTestId("emoji-grid");
  const measure = async (place: string, controls: Locator[]) => {
    for (const control of controls) {
      await control.evaluate((el) => { el.scrollIntoView({ block: "nearest", inline: "center" }); el.setAttribute("data-measured", ""); });
      for (const target of await smallTargets(page, 44, "[data-measured]")) small.push(`${place}: ${target.name} ${target.width}×${target.height} (${target.stops})`);
      await control.evaluate((el) => el.removeAttribute("data-measured"));
    }
  };

  const field = page.locator("textarea");
  for (const [language, dir] of [["en", "ltr"], ["ar", "rtl"]] as const) {
    // A new chat, the first time; after that the reload comes back to it.
    await speak(alice, language, dir);
    const newChat = page.getByTestId("sidebar-new-chat").filter({ visible: true }).first();
    await expect(field.or(newChat)).toBeVisible();
    if (!(await field.isVisible())) await newChat.click();
    await expect(field).toBeVisible();
    for (const [width, height] of [[375, 667], [320, 568]]) {
      const place = `${language} at ${width} px`;
      await page.setViewportSize({ width, height });
      await page.getByTestId("composer-expressions").click();
      await expect(grid.locator("[data-emoji]").first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`emoji-${language}-${width}.png`) });

      const categories = await panel.locator("[data-testid^='emoji-category-']").all();
      expect(categories.length, place).toBeGreaterThanOrEqual(8);
      // The first two rows of emoji, whole in the grid's view.
      const cells = (await grid.getByTestId("emoji-section-people").locator("[data-emoji]").all()).slice(0, 14);
      await measure(place, [...categories, panel.getByTestId("emoji-skin"), panel.getByTestId("expression-tab-emoji"), panel.getByTestId("expression-tab-gif"), ...cells]);

      const layout = await grid.evaluate((box) => ({
        sideways: box.scrollWidth - box.clientWidth,
        columns: getComputedStyle(box.querySelector(".emoji-grid")!).gridTemplateColumns.split(" ").length,
      }));
      expect(layout.sideways, `${place}: the grid scrolls sideways by`).toBe(0);
      if (width === 320) expect(layout.columns, `${place}: emoji to a row`).toBe(7);

      // The last category, reached by scrolling the grid: its icon is underlined and whole in the row.
      await grid.evaluate((box) => { box.scrollTop = box.scrollHeight; });
      const last = categories[categories.length - 1];
      await expect(last).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => last.evaluate((icon) => {
        const row = icon.parentElement!.getBoundingClientRect(), box = icon.getBoundingClientRect();
        return box.left >= row.left - 0.5 && box.right <= row.right + 0.5;
      }), `${place}: the underlined category is in view`).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`emoji-${language}-${width}-last.png`) });

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
    }
  }

  expect(small, "the emoji panel's controls under 44 × 44 px on a phone").toEqual([]);
});

/**
 * An app's or a store's own description, a few lines high until Show all, shows only when it is longer than that, so
 * no walk above reaches it: its Show all took taps on 46 × 16 px. A store and an app with a twelve-line description,
 * checked on Add, at 375 px in English and 320 px in Arabic.
 */
test("on a phone Show all under an app's or a store's description is a 44 px target", { tag: ["@feature:app.mobile-layout", "@feature:apps.page", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  const description = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a description that says what this is for.`).join("\n");
  const alice = await peer("description-targets", { mobile: true, viewport: { width: 375, height: 667 } });
  const { page } = alice;
  await serveStore(alice.context, await testStore({ description }));
  const small: string[] = [];
  for (const [language, dir, width] of [["en", "ltr", 375], ["ar", "rtl", 320]] as const) {
    await page.setViewportSize({ width, height: 667 });
    await page.goto("/#/apps");
    await speak(alice, language, dir);
    for (const [url, more] of [[STORE_URL, "apps-add-store-description-more"], [APP_URL, "app-description-more"]]) {
      await page.getByTestId("apps-add").click();
      await page.getByTestId("apps-add-url").fill(url);
      await page.getByTestId("apps-add-check").click();
      const button = page.getByTestId(more);
      await expect(button).toBeVisible();
      await button.evaluate((el) => { el.scrollIntoView({ block: "center" }); el.setAttribute("data-measured", ""); });
      for (const target of await smallTargets(page, 44, "[data-measured]")) small.push(`${language} at ${width} px: ${target.name} ${target.width}×${target.height} (${target.stops})`);
      await page.screenshot({ path: testInfo.outputPath(`${more}-${language}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(button).toHaveCount(0);
    }
  }
  expect(small, "Show all under a description under 44 × 44 px on a phone").toEqual([]);
});
