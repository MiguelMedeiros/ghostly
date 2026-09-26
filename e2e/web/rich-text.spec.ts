import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/** The last bubble in the chat that holds `text`. */
const bubble = (peer: Peer, text: string) => chat(peer).locator("[data-message-bubble]").filter({ hasText: text }).last();

/** What the page's Copy buttons write, kept in the page: the machine's own clipboard is never touched. */
async function captureCopies(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { Object.assign(window, { qaCopied: value }); } } });
  });
  return () => page.evaluate(() => (window as unknown as { qaCopied?: string }).qaCopied);
}

test("formatted text is sent as typed and shows formatted on both sides", {
  tag: ["@feature:chat.rich.format", "@feature:chat.rich.spoiler", "@feature:chat.rich.code", "@feature:chat.rich.blob", "@feature:chat.rich.time"],
}, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Formatting, with a link inside it and markers that are part of names.
  await say(alice, "*bold* _italic_ ~~gone~~ `npm test` *see https://ghostly.tools/docs* snake_case_name");
  for (const side of [alice, bob]) {
    const words = bubble(side, "snake_case_name").getByTestId("message-text");
    await expect(words).toHaveText("bold italic gone npm test see https://ghostly.tools/docs snake_case_name");
    await expect(words.locator("strong").first()).toHaveText("bold");
    await expect(words.locator("em")).toHaveText("italic");
    await expect(words.locator("s")).toHaveText("gone");
    await expect(words.locator("code")).toHaveText("npm test");
    await expect(words.locator("strong").nth(1).getByRole("link")).toHaveAttribute("href", "https://ghostly.tools/docs");
  }

  // A spoiler: covered and unreadable until Bob taps it.
  await say(alice, "the ending: ||the ghost was the narrator||");
  const spoiler = bubble(bob, "the ending").getByTestId("rich-spoiler");
  await expect(spoiler).toHaveAttribute("role", "button");
  await expect(spoiler).toHaveAccessibleName("Hidden text. Tap to show it");
  await expect(spoiler).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await spoiler.click();
  await expect(spoiler).toHaveAttribute("data-shown", "");
  await expect(spoiler).toHaveText("the ghost was the narrator");
  // The chat list does not give it away.
  await bob.page.goto("/#/");
  await expect(bob.page.getByText("the ending: ▒▒▒")).toBeVisible();
  await expect(bob.page.getByText("the ghost was the narrator")).toHaveCount(0);
  await bob.page.goBack();

  // A code block: highlighted once the highlighter has loaded, copied as written.
  await say(alice, "try this:\n```ts\nconst answer: number = 42;\n```");
  const block = bubble(bob, "try this").getByTestId("rich-codeblock");
  await expect(block).toHaveAttribute("data-lang", "ts");
  await expect(block).toHaveAttribute("data-highlighted", "");
  await expect(block.locator(".hljs-keyword")).toHaveText("const");
  const copied = await captureCopies(bob.page);
  await block.getByTestId("rich-codeblock-copy").click();
  await expect(block.getByTestId("rich-codeblock-copy")).toHaveText("Copied");
  expect(await copied()).toBe("const answer: number = 42;");

  // A long key: one line until Show all.
  const key = "Zm9vYmFy".repeat(16);
  await say(alice, `my key ${key}`);
  const blob = bubble(bob, "my key").getByTestId("rich-blob");
  const blobText = blob.locator("code");
  const lineHeight = (await blobText.boundingBox())!.height;
  expect(await blobText.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await blob.getByTestId("rich-blob-toggle").click();
  await expect(blob.getByTestId("rich-blob-toggle")).toHaveText("Show less");
  expect((await blobText.boundingBox())!.height).toBeGreaterThan(lineHeight);
  await blob.getByTestId("rich-blob-copy").click();
  expect(await copied()).toBe(key);

  // A time with a zone: Bob's own clock on a tap.
  await say(alice, "standup at 14:00 UTC tomorrow");
  const time = bubble(bob, "standup").getByTestId("rich-time");
  const local = await bob.page.evaluate(() => {
    const now = new Date();
    const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14);
    const sameDay = new Date(at).toDateString() === now.toDateString();
    return new Date(at).toLocaleString([], { ...(sameDay ? {} : { month: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  });
  await expect(time.getByRole("button", { name: "14:00 UTC" })).toHaveAttribute("title", `${local} your time`);
  await time.getByRole("button", { name: "14:00 UTC" }).click();
  await expect(time.getByTestId("rich-time-local")).toHaveText(`(${local} your time)`);

  // A message that is JSON: pretty-printed on arrival.
  await say(alice, '{"amount":21,"memo":"coffee"}');
  const json = bubble(bob, "coffee").getByTestId("rich-codeblock");
  await expect(json).toHaveAttribute("data-lang", "json");
  await expect(json.locator("pre")).toHaveText('{\n  "amount": 21,\n  "memo": "coffee"\n}');

  // Alice's list shows her last message as she wrote it, no markers to strip.
  await alice.page.goto("/#/");
  await expect(alice.page.getByText('{"amount":21,"memo":"coffee"}')).toBeVisible();
});
