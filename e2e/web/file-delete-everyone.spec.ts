import { chat, connect, expect, link, test, type Peer } from "../support/fixtures";

/**
 * Delete for everyone on a file sent from this page (WISP 400 § Delete for everyone). The page makes a sent file's row
 * itself, with no `ref`, and the menu read only `ref`: a text offered Delete for everyone, a file sent here never did,
 * before a reload or after it. A file that arrived goes from the contact's chat; one the contact has not answered yet
 * goes too, instead of staying there as "Cancelled".
 */
const MIB = 1024 * 1024;
const bubble = (p: Peer, name: string) => chat(p).getByTestId("file-bubble").filter({ hasText: name });

async function deleteForEveryone(p: Peer, name: string): Promise<void> {
  const row = chat(p).locator("[data-message-row]").filter({ hasText: name }).last();
  await row.hover();
  await row.getByTestId("message-options").click();
  await p.page.getByTestId("message-delete-everyone").click();
  await p.page.getByTestId("message-delete-confirm").click();
  await expect(bubble(p, name)).toHaveCount(0);
}

test("a file sent from this page is deleted for everyone: one that arrived, and one still waiting for an answer", { tag: ["@feature:chat.paired.delete-message", "@feature:files.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("fde-alice"), peer("fde-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await alice.page.getByTestId("file-input").setInputFiles({ name: "wrong notes.txt", mimeType: "text/plain", buffer: Buffer.alloc(3000, 65) });
  await expect(bubble(bob, "wrong notes.txt").getByTestId("file-save")).toBeVisible({ timeout: 60_000 });
  await deleteForEveryone(alice, "wrong notes.txt");
  await expect(bubble(bob, "wrong notes.txt")).toHaveCount(0, { timeout: 30_000 });

  // Over the 25 MiB a contact takes without asking: Bob's chat shows the offer, and Alice takes it back.
  await alice.page.getByTestId("file-input").setInputFiles({ name: "wrong archive.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(26 * MIB, 7) });
  await expect(bubble(bob, "wrong archive.bin").getByTestId("file-accept")).toBeVisible({ timeout: 60_000 });
  await deleteForEveryone(alice, "wrong archive.bin");
  await expect(bubble(bob, "wrong archive.bin")).toHaveCount(0, { timeout: 30_000 });

  // After a reload the row is the stored one, still with no `ref`: a file sent before it offers the same.
  await alice.page.getByTestId("file-input").setInputFiles({ name: "old notes.txt", mimeType: "text/plain", buffer: Buffer.alloc(3000, 66) });
  await expect(bubble(bob, "old notes.txt").getByTestId("file-save")).toBeVisible({ timeout: 60_000 });
  await alice.page.reload();
  await expect(bubble(alice, "old notes.txt")).toBeVisible({ timeout: 60_000 });
  await deleteForEveryone(alice, "old notes.txt");
  await expect(bubble(bob, "old notes.txt")).toHaveCount(0, { timeout: 60_000 });
});
