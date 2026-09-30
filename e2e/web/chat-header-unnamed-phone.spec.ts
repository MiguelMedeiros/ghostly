import type { Locator } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * A contact with no name, in a chat's header on the narrowest phone (320px). The header said "Contact · 1kwb54", which
 * the header's buttons cut to "Contac…": neither the word nor the key it names them by was left. The key's start is on
 * the line right under the name, so the header says the word alone, and it fits whole.
 */
/** What the name's line shows against what it holds: cut short with an ellipsis when `shown` < `whole`. */
const room = (name: Locator) => name.evaluate((el) => {
  const line = el.parentElement!;
  return { text: el.textContent, shown: Math.round(line.clientWidth), whole: Math.round(line.scrollWidth) };
});

test("on a 320px phone an unnamed contact's name in the chat header is not cut short", { tag: ["@feature:app.mobile-layout", "@feature:chats.list.unnamed-contact"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: { width: 320, height: 568 } });
  await link(alice, bob);
  await connect(alice, bob);
  const name = bob.page.getByTestId("chat-name");
  await expect(name).toHaveText("Contact");
  const measured = await room(name);
  expect(measured.whole, JSON.stringify(measured)).toBeLessThanOrEqual(measured.shown);
  // The start of their key, which the chat list names them by, is on the line right under it.
  await expect(bob.page.getByTestId("chat-subtitle")).toHaveText(/^\S{6}\.\.\.\S{6}$/);
  // Every header button is whole and on the screen.
  for (const id of ["connection-options", "call-audio", "call-video", "chat-options"]) {
    const box = (await bob.page.getByTestId(id).boundingBox())!;
    expect(box.x + box.width, id).toBeLessThanOrEqual(320);
  }
});
