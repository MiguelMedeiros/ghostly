import { writeFileSync } from "node:fs";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";
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

/**
 * A system line long enough to wrap (the contact's "joined the chat", in Japanese at 375 px: "<key> がチャットに参加しました")
 * took the row's whole width, which put its ⋮ against the screen's edge: the edge cut where a tap lands on it to 33 px
 * wide. A system row keeps the room the ⋮'s hit area takes, on both sides: in Arabic the ⋮ is on the left.
 */
test.describe("on a phone a system line that wraps", () => {
  /** The app in `language` (the setting a reload reads), back on the chat that was open. */
  const speak = async ({ page }: Peer, language: string, dir: "ltr" | "rtl") => {
    await page.evaluate((language) => {
      const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
    }, language);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
  };

  /** The contact's joined line (not mine) wraps, and its ⋮ is inside the screen and a 44 px target where a tap lands. */
  const checkJoined = async ({ page }: Peer, mine: string, label: string) => {
    const line = page.getByTestId("join-line").filter({ hasNotText: mine });
    await expect(line).toHaveCount(1, { timeout: 30_000 });
    const row = page.locator("[data-message-row]").filter({ has: line });
    const options = row.getByTestId("message-options");
    await row.scrollIntoViewIfNeeded();
    // Two lines of text: otherwise the line has room to spare and this proves nothing.
    expect((await line.boundingBox())!.height, `${label}: the contact's joined line wraps`).toBeGreaterThan(36);
    const vw = page.viewportSize()!.width;
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
    await checkJoined(alice, "あなたがチャットに参加しました", "ja at 375 px");
    await alice.page.screenshot({ path: testInfo.outputPath("joined-ja-375.png") });

    // Arabic's line is shorter: it wraps on the narrowest phone, with the ⋮ at the left edge.
    await alice.page.setViewportSize({ width: 320, height: 568 });
    await speak(alice, "ar", "rtl");
    await checkJoined(alice, "انضممت إلى المحادثة", "ar at 320 px");
    await alice.page.screenshot({ path: testInfo.outputPath("joined-ar-320.png") });

    await speak(alice, "en", "ltr");
    await alice.page.screenshot({ path: testInfo.outputPath("joined-en-320.png") });
  });
});
