import { chat, expect, say, test } from "../support/fixtures";
import { pair, verifyContact } from "../support/paired";

/**
 * Automatic first use, end to end and with no mint: two fresh peers reach a
 * working chat without anyone comparing a code, and the optional comparison is
 * there afterwards for whoever wants it.
 */
test("a first connection needs no comparison, and says so", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("tofu-alice"), peer("tofu-bob")]);
  await pair(alice, bob);

  await say(alice, "no codes were compared");
  await expect(chat(bob).getByText("no codes were compared")).toBeVisible();
  await expect(alice.page.getByTitle("Audio calls are not supported in this chat")).toBeDisabled();
  await expect(alice.page.getByTitle("Video calls are not supported in this chat")).toBeDisabled();

  // The panel must not imply a comparison that never happened.
  await alice.page.getByTestId("connection-options").click();
  await expect(alice.page.getByTestId("pair-trust")).toContainText("Key saved · not verified");
  await expect(alice.page.getByTestId("pair-verify")).toBeVisible();
  await expect(alice.page.getByTestId("pair-verified")).toHaveCount(0);
});

test("comparing afterwards is optional, shows one code and is remembered", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("verify-alice"), peer("verify-bob")]);
  await pair(alice, bob);
  await verifyContact(alice, bob);

  await expect(alice.page.getByTestId("pair-verified")).toContainText("Codes verified");

  await say(bob, "still the same contact");
  await expect(chat(alice).getByText("still the same contact")).toBeVisible();

  // It survives a reload: the verification is durable, not a flag in this tab.
  // Read from the pin, so this does not wait on the peer reconnecting — that
  // wait is a 60s poll interval and has nothing to do with what is asserted.
  await alice.page.reload();
  await alice.page.getByTestId("connection-options").click();
  await expect(alice.page.getByTestId("pair-verified")).toBeVisible();
  await expect(alice.page.getByTestId("pair-verify")).toHaveCount(0);
});
