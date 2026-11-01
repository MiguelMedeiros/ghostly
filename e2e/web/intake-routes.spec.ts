import { copyInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";

/**
 * Opening an invite link, a web+ghostly: link or a group's link goes through an address the app takes out of the
 * history at once. Each one also made react-router warn "No routes matched location" in the console.
 */
test("invite and group links open without a routing warning", { tag: ["@feature:invite.link", "@feature:groups.link.join"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("intake-alice"), peer("intake-bob"), peer("intake-carol")]);
  const warnings: string[] = [];
  for (const p of [bob, carol]) p.page.on("console", (m) => { if (m.text().includes("No routes matched")) warnings.push(m.text().replace(/[A-Za-z0-9_-]{30,}/g, "…")); });

  await alice.page.getByTitle("New Chat").click();
  const invite = await copyInvite(alice.page);
  await bob.page.goto(invite.replace("https://ghostly.tools/", "/"));
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  // The same invite again, as a web+ghostly: link: already joined, and said so.
  await bob.page.goto(`/#web+ghostly:${invite.split("#")[1]}`);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();

  await alice.page.goto("/#/");
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Intake");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await carol.page.goto(url);
  await expect(carol.page.getByTestId("group-chat")).toBeVisible({ timeout: 120_000 });

  expect(warnings).toEqual([]);
});

test("an address with no page goes home, on a phone too, and Back never finds the empty screen", { tag: ["@feature:invite.link"] }, async ({ peer }) => {
  const bob = await peer("no-page", { mobile: true });
  for (const address of ["/#/wallets", "/#/join", "/#/join/", "/#/wallet/x", "/#/settings/a/b"]) {
    await bob.page.goto(address);
    await expect(bob.page.getByTestId("sidebar"), address).toBeVisible();
    await expect.poll(() => bob.page.evaluate(() => location.hash), address).toBe("#/");
  }
  await bob.page.goBack();
  await expect(bob.page.getByTestId("sidebar")).toBeVisible();

  // The pages stay as they were, a section of Settings too.
  await bob.page.goto("/#/settings/advanced");
  await expect.poll(() => bob.page.evaluate(() => location.hash)).toBe("#/settings/advanced");
});
