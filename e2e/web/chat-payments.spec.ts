import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

// Each chat chooses its own ways of paying. A way works only when both sides allow it,
// and the contact's app learns the choice from the next handshake.
test("each chat allows its own ways of paying", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const button = (p: Peer) => p.page.getByTestId("payment-button");
  const card = (p: Peer, id: string) => p.page.getByTestId(`payment-card-${id}`);
  const choose = async (p: Peer, methods: Record<string, boolean>) => {
    await p.page.getByTitle("Options").click();
    await p.page.getByTestId("chat-payments-open").click();
    const dialog = p.page.getByTestId("chat-payments");
    for (const [id, on] of Object.entries(methods)) {
      const toggle = dialog.getByTestId(`chat-payments-${id}`);
      if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
    }
    await dialog.getByTestId("chat-payments-save").click();
    await expect(dialog).toHaveCount(0);
  };
  for (const p of [alice, bob]) await expect(button(p)).toBeEnabled({ timeout: 60000 });

  // Alice does not take Cashu or USDT from Bob; Lightning and Ark stay.
  await choose(alice, { cashu: false, usdt: false });
  await expect(button(bob)).toBeEnabled({ timeout: 90000 });
  await bob.page.getByTestId("payment-button").click();
  await expect(card(bob, "cashu")).toBeDisabled({ timeout: 90000 });
  await expect(card(bob, "cashu")).toHaveAttribute("title", /does not accept Cashu/);
  await expect(card(bob, "usdt")).toBeDisabled();
  await expect(card(bob, "lightning")).toBeEnabled();
  await expect(card(bob, "arkade")).toBeEnabled({ timeout: 60000 });
  await bob.page.keyboard.press("Escape");
  await button(alice).click();
  await expect(card(alice, "cashu")).toHaveAttribute("title", /off in this chat/);
  await alice.page.keyboard.press("Escape");

  // The dialog shows both sides' choices.
  await bob.page.getByTitle("Options").click();
  await bob.page.getByTestId("chat-payments-open").click();
  await expect(bob.page.getByTestId("chat-payments-cashu-contact")).toContainText("has it off");
  await expect(bob.page.getByTestId("chat-payments-lightning-contact")).toContainText("allows it");
  await bob.page.getByRole("button", { name: "Cancel" }).click();

  // Everything off for this chat: no ⚡ on either side, and the chat itself keeps working.
  await choose(alice, { lightning: false, arkade: false, bark: false, bitcoin: false });
  await expect(button(alice)).toBeDisabled();
  await expect(button(bob)).toBeDisabled({ timeout: 90000 });
  await say(bob, "still talking");
  await expect(chat(alice).getByText("still talking")).toBeVisible({ timeout: 60000 });

  await choose(alice, { cashu: true, lightning: true, arkade: true, usdt: true, bark: true, bitcoin: true });
  await expect(button(bob)).toBeEnabled({ timeout: 90000 });
  await bob.page.getByTestId("payment-button").click();
  await expect(card(bob, "cashu")).toBeEnabled({ timeout: 90000 });
});
