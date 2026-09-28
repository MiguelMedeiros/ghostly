import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";
import { chat, expect, say, test, type Peer } from "../support/fixtures";

/**
 * Search inside a chat: a long 1:1 history seeded into storage (2,000 messages, one far up with an accent, a file), then
 * a group. Ctrl/Cmd+F or the ⋮ opens it, the count says where it is, and ↑ ↓ (Enter, Shift+Enter) scroll to each match
 * and mark it, even one far above what a long chat draws first.
 */

const COUNT = 2000;
const bar = (page: Page) => page.getByTestId("chat-search");
const field = (page: Page) => page.getByTestId("chat-search-input");
const count = (page: Page) => page.getByTestId("chat-search-count");
const row = (page: Page, id: string) => page.locator(`.chat-wallpaper [data-message-id="${id}"]`);
const rowOf = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();

/** A chat of `COUNT` texts ("Message 0" on), with "Um Café amanhã?" and a file "Relatório Final.pdf" far up, opened. */
async function seedChat(p: Peer) {
  const mine = createLink().mine;
  await p.page.evaluate(({ mine, count }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    const start = Date.now() - 86_400_000 * 3;
    const messages: object[] = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`, sender: i % 2 ? "peer" : "me", timestamp: start + i * 60_000, delivery: i % 2 ? undefined : "delivered", text: `Message ${i}`,
    }));
    messages.splice(100, 0, { id: "cafe", sender: "peer", timestamp: start + 100 * 60_000 - 2, text: "Um Café amanhã?" });
    messages.splice(50, 0, { id: "doc", sender: "peer", timestamp: start + 50 * 60_000 - 1, text: "📎 Relatório Final.pdf",
      file: { id: "doc-file", name: "Relatório Final.pdf", size: 2048, mime: "application/pdf" } });
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    localStorage.setItem(`ghostly_join_${id}`, "true");
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, { mine, count: COUNT });
  await expect(row(p.page, `m${COUNT - 1}`)).toBeInViewport();
}

test("search a long chat: case and accents, a file's name, next and previous land on the message", { tag: ["@feature:chat.search"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const alice = await peer("search-alice");
  const page = alice.page;
  await seedChat(alice);

  // Ctrl/Cmd+F in the chat opens it, its field focused.
  await chat(alice).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(field(page)).toBeFocused();

  // Far above what the chat drew first: found, scrolled to and marked.
  await page.keyboard.type("CAFE");
  await expect(count(page)).toHaveText("1 of 1");
  await expect(row(page, "cafe")).toBeInViewport();
  await expect(row(page, "cafe").locator("[data-search-match]")).toHaveText("Café");

  await field(page).fill("relatorio final");
  await expect(count(page)).toHaveText("1 of 1");
  await expect(row(page, "doc")).toBeInViewport();
  await expect(row(page, "doc").locator("[data-search-match]")).toHaveText("Relatório Final");

  // "Message 19", "Message 190" to "199", "Message 1900" to "1999": the newest first.
  await field(page).fill("message 19");
  await expect(count(page)).toHaveText("1 of 111");
  await expect(rowOf(page, "Message 1999")).toBeInViewport();
  await field(page).press("Enter");
  await expect(count(page)).toHaveText("2 of 111");
  await expect(rowOf(page, "Message 1998")).toBeInViewport();
  await field(page).press("Shift+Enter");
  await field(page).press("Shift+Enter");
  // Newer than the newest: round to the oldest.
  await expect(count(page)).toHaveText("111 of 111");
  await expect(rowOf(page, "Message 19")).toBeInViewport();
  await page.getByTestId("chat-search-newer").click();
  await expect(count(page)).toHaveText("110 of 111");
  await expect(rowOf(page, "Message 190")).toBeInViewport();
  await page.getByTestId("chat-search-older").click();
  await expect(rowOf(page, "Message 19")).toBeInViewport();

  await field(page).fill("nothing like this");
  await expect(count(page)).toHaveText("No results");

  // Escape closes it, and the marks go with it.
  await field(page).press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator("[data-search-match]")).toHaveCount(0);
});

test("search a group from its ⋮", { tag: ["@feature:groups.search"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const alice = await peer("search-group-alice");
  const page = alice.page;
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Search night");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  const group = page.getByTestId("group-chat");
  for (const text of ["Pão de queijo?", "pizza first", "then PÃO again", "done"]) {
    await say(alice, text);
    await expect(rowOf(page, text)).toBeVisible();
  }

  await page.getByTestId("group-options").click();
  await page.getByTestId("chat-search-open").click();
  await field(page).fill("pao");
  await expect(count(page)).toHaveText("1 of 2");
  await expect(rowOf(page, "then PÃO again")).toBeInViewport();
  await expect(rowOf(page, "then PÃO again").locator("[data-search-match]")).toHaveText("PÃO");
  await page.getByTestId("chat-search-older").click();
  await expect(count(page)).toHaveText("2 of 2");
  await expect(rowOf(page, "Pão de queijo?")).toBeInViewport();
  await expect(group.locator("[data-search-match]")).toHaveText(["Pão", "PÃO"]);
});
