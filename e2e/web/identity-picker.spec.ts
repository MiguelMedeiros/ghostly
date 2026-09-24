import { expect, test } from "../support/fixtures";

/**
 * Profile → Identities → Add: each kind of identity is a card to recognize at a glance (its own mark, the
 * name, the category, one line). What it proves and what it does not is a click away: "About" on the card,
 * without starting, and at the top of the panel the card opens. A caveat never depends on hover.
 */
test("a kind of identity is recognized at a glance, and its caveats are one click away", async ({ peer }) => {
  const alice = await peer("idpk-alice");
  await alice.page.evaluate(() => { location.hash = "#/profile"; });
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");

  // Every card has its own mark, not one shared glyph.
  const cards = await add.getByRole("listitem").all();
  const marks = await Promise.all(cards.map(card => card.locator("[data-icon]").first().getAttribute("data-icon")));
  expect(new Set(marks).size).toBe(cards.length);
  expect(marks).toEqual(expect.arrayContaining(["nostr", "domain", "openpgp", "bitcoin", "ssh", "ssh-github", "ssh-gitlab"]));

  // The card: name, category, one short line; the explanation is not on it.
  const bitcoin = add.getByTestId("add-identity-card-bitcoin");
  await expect(bitcoin.getByTestId("add-identity-bitcoin")).toContainText("Bitcoin address");
  await expect(bitcoin).toContainText("Your own key");
  await expect(bitcoin).toContainText("Sign a message in your own wallet");
  await expect(bitcoin).not.toContainText("does not prove");
  for (const id of ["nostr", "ssh-github"]) {
    const line = await add.getByTestId(`add-identity-${id}`).getByTestId("add-identity-summary").textContent();
    expect(line!.length, `${id}: "${line}"`).toBeLessThanOrEqual(40);
  }

  // "About": the caveat, read without starting.
  const about = bitcoin.getByRole("button", { name: "About Bitcoin address" });
  await expect(about).toHaveAttribute("aria-expanded", "false");
  await about.click();
  await expect(about).toHaveAttribute("aria-expanded", "true");
  await expect(bitcoin.getByTestId("identity-about-limits")).toContainText("does not prove a balance, a past payment, or that you would pay");
  await expect(bitcoin.getByTestId("identity-about")).toContainText("Only the holder of this key can make this proof.");
  await expect(add.getByTestId("add-identity-start")).toHaveCount(0);
  await about.click();
  await expect(bitcoin.getByTestId("identity-about")).toHaveCount(0);

  // The click that starts adding opens the panel with the same explanation at the top.
  await bitcoin.getByTestId("add-identity-bitcoin").click();
  await expect(add.getByTestId("add-identity-start")).toBeVisible();
  await expect(add.getByTestId("add-identity-about")).toContainText("Proves you can sign with the key behind a Bitcoin address");
  await expect(add.getByTestId("add-identity-about").getByTestId("identity-about-limits")).toContainText("does not prove a balance");
  await add.getByRole("button", { name: "Back" }).click();

  // A GitHub key's limit is there too, and the picker is back.
  await add.getByRole("button", { name: "About GitHub (SSH key)" }).click();
  await expect(add.getByTestId("add-identity-card-ssh-github").getByTestId("identity-about-limits")).toContainText("Does not prove a GitHub login");
});

test("the picker holds together on a phone: the category goes under the name, the targets stay big", async ({ peer }) => {
  const alice = await peer("idpk-phone", { mobile: true });
  await alice.page.evaluate(() => { location.hash = "#/profile"; });
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  const card = add.getByTestId("add-identity-card-ssh-gitlab");
  await expect(card).toBeVisible();
  // Under the name, not wrapped beside it: the same for every card at this width.
  for (const id of ["nostr", "ssh-gitlab"]) {
    const name = (await add.getByTestId(`add-identity-${id}`).getByText(id === "nostr" ? "Nostr" : "GitLab (SSH key)", { exact: true }).boundingBox())!;
    const pill = (await add.getByTestId(`add-identity-card-${id}`).getByText("Your own key").boundingBox())!;
    expect(pill.y, `${id}: the category under the name`).toBeGreaterThanOrEqual(name.y + name.height - 1);
  }
  for (const button of await add.getByRole("listitem").getByRole("button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.height, "a touch target").toBeGreaterThanOrEqual(44);
    expect(box.width, "a touch target").toBeGreaterThanOrEqual(44);
  }
  const dialog = (await add.boundingBox())!;
  for (const item of await add.getByRole("listitem").all()) {
    const box = (await item.boundingBox())!;
    expect(box.x + box.width, "a card past the dialog's edge").toBeLessThanOrEqual(dialog.x + dialog.width + 1);
  }
});
