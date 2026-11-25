import { chat, connect, expect, link, test } from "../support/fixtures";

const MIB = 1024 * 1024;

/**
 * An offer that fits this device's room only without the files still coming lists them under it after Accept, each by
 * its own name and its chat's, with a Cancel named for it. The list read each chat's stored copy by the link's id, while
 * a chat is stored under its own: every row said "A file" from the contact's fallback name, with nothing to tell which
 * Cancel cancels what. The unit tests stored the chat under the link's id, so only the real app showed it.
 */
test("the files still coming under an offer are listed by their names", { tag: ["@feature:files.large.offer", "@feature:files.storage"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("fc-alice"), peer("fc-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  // Bob's device has 40 MiB of room, whatever it stores: a quota override through DevTools is gone after a reload, and
  // the in-memory storage of a test browser does not count the bytes written.
  const room = (bytes: number) => {
    Object.defineProperty(navigator.storage, "estimate", { configurable: true, value: async () => ({ usage: 1_000_000, quota: 1_000_000 + bytes }) });
  };
  await bob.context.addInitScript(room, 40 * MIB);
  await bob.page.evaluate(room, 40 * MIB);

  // A first file taken, then paused: still coming, it holds its 30 MiB.
  await alice.page.getByTestId("file-input").setInputFiles({ name: "holiday part one.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(30 * MIB, 1) });
  const first = chat(bob).locator("[data-message-row]").filter({ hasText: "holiday part one.bin" }).last();
  await first.getByTestId("file-accept").click({ timeout: 60_000 });
  await first.getByTestId("file-pause").click();
  await expect(first.getByTestId("file-resume")).toBeVisible();

  // A second one fits the room, not beside the first.
  await alice.page.getByTestId("file-input").setInputFiles({ name: "second.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(30 * MIB, 2) });
  const second = chat(bob).locator("[data-message-row]").filter({ hasText: "second.bin" }).last();
  await second.getByTestId("file-accept").click({ timeout: 60_000 });
  const row = second.getByTestId("files-coming-row");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("holiday part one.bin from ");
  await expect(row).not.toContainText("A file");
  await expect(row.getByRole("button", { name: "Cancel holiday part one.bin" })).toBeVisible();
});
