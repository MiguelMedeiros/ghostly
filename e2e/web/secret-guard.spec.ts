import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/** BIP39's test vector for entropy 0x7f repeated: a published seed that has never held anything. */
const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";
/** A cashuB token for 8 + 13 sat on http://mint.test (test secrets, no mint behind it). */
const CASHU_21 = "cashuBo2FtcGh0dHA6Ly9taW50LnRlc3RhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIKjYWEIYXNtdGVzdC1zZWNyZXQtYWFjWCECERERERERERERERERERERERERERERERERERERERERERGjYWENYXNtdGVzdC1zZWNyZXQtYmFjWCECIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";

/** Pastes `text` into the composer (text inserted at once, as a paste is) and presses Enter. */
async function pasteAndSend(peer: Peer, text: string) {
  const box = peer.page.getByPlaceholder("Message…");
  await box.click();
  await peer.page.keyboard.insertText(text);
  await box.press("Enter");
}

test("a pasted seed asks first: Cancel keeps the draft, Send anyway sends it, and ordinary text never asks",
  { tag: ["@feature:app.composer.secret-guard", "@feature:chat.paired.send"] }, async ({ peer }, info) => {
    const [alice, bob] = await Promise.all([peer("guard-alice"), peer("guard-bob")]);
    await pair(alice, bob);
    const box = alice.page.getByPlaceholder("Message…");
    const guard = alice.page.getByTestId("secret-guard");

    await pasteAndSend(alice, SEED);
    await expect(guard).toBeVisible();
    await expect(guard).toHaveAttribute("data-kind", "mnemonic");
    await expect(alice.page.getByRole("alertdialog", { name: "Send a wallet seed?" })).toBeVisible();
    // Cancel is the default: it has the focus, so Enter keeps the draft.
    await expect(guard.getByTestId("secret-guard-cancel")).toBeFocused();
    await alice.page.screenshot({ path: info.outputPath("secret-guard-seed.png") });
    await alice.page.keyboard.press("Enter");
    await expect(guard).toHaveCount(0);
    await expect(box).toHaveValue(SEED);
    await expect(box).toBeFocused();

    // Escape is a Cancel too.
    await box.press("Enter");
    await expect(guard).toBeVisible();
    await alice.page.keyboard.press("Escape");
    await expect(guard).toHaveCount(0);
    await expect(box).toHaveValue(SEED);

    // Confirmed, it goes as it was typed.
    await box.press("Enter");
    await guard.getByRole("button", { name: "Send anyway" }).click();
    await expect(box).toHaveValue("");
    await expect(chat(bob).getByText(SEED)).toBeVisible();

    // Ordinary text asks nothing, and the two cancelled sends never went.
    await say(alice, "see you at 7");
    await expect(guard).toHaveCount(0);
    await expect(chat(bob).getByText("see you at 7")).toBeVisible();
    await expect(chat(bob).getByText(SEED)).toHaveCount(1);
  });

test("a Cashu token in the text box asks whether to send its sats to the contact",
  { tag: ["@feature:app.composer.secret-guard"] }, async ({ peer }, info) => {
    const [alice, bob] = await Promise.all([peer("guard-cashu-alice"), peer("guard-cashu-bob")]);
    await pair(alice, bob);
    const guard = alice.page.getByTestId("secret-guard");

    await pasteAndSend(alice, CASHU_21);
    await expect(guard).toHaveAttribute("data-kind", "cashu");
    // The amount is read from the token here; the fake mint is never asked.
    await expect(alice.page.getByRole("alertdialog", { name: /^Send 21 sats to .+\?$/ })).toBeVisible();
    await alice.page.screenshot({ path: info.outputPath("secret-guard-cashu.png") });
    await guard.getByTestId("secret-guard-cancel").click();
    await expect(guard).toHaveCount(0);
    await expect(alice.page.getByPlaceholder("Message…")).toHaveValue(CASHU_21);
  });
