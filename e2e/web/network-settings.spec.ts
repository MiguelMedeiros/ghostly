import type { Page } from "@playwright/test";
import { chat, connect, expect, link, test, type Peer } from "../support/fixtures";

const DEFAULT_RELAYS = "https://pkarr.pubky.org\nhttps://pkarr.pubky.app";

/** The network section of Settings: relays, TURN address, username and credential. */
function network(page: Page) {
  return {
    relays: page.getByTestId("network-relays"),
    turnUrl: page.getByPlaceholder("turn:turn.example.org:3478"),
    turnUser: page.getByPlaceholder("Username"),
    turnCredential: page.getByPlaceholder("Credential"),
    save: page.getByTestId("network-save"),
    reset: page.getByRole("button", { name: "Reset to defaults" }),
  };
}

async function save(page: Page): Promise<void> {
  await network(page).save.click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

/** Nothing here may leave the machine: relays typed into the form are answered locally. */
async function keepOffline(peer: Peer): Promise<void> {
  await peer.context.route(/^https?:\/\/relay\.example\.org\//, (route) => route.abort());
}

test("a TURN server is kept across a reload, and removed by clearing its address", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const form = network(page);
  await expect(form.turnUrl).toHaveValue("");
  // The credential is a secret: typed into a password field.
  await expect(form.turnCredential).toHaveAttribute("type", "password");

  await form.turnUrl.fill("  turn:turn.example.org:3478  ");
  await form.turnUser.fill("ghost");
  await form.turnCredential.fill("s3cret-boo");
  await save(page);

  await page.reload();
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");
  await expect(form.turnUser).toHaveValue("ghost");
  await expect(form.turnCredential).toHaveValue("s3cret-boo");
  // Setting a TURN server leaves the relays alone.
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);

  // "Reset to defaults" belongs to the relay list: it restores the relays, not the TURN server.
  await form.relays.fill("https://relay.example.org");
  await form.reset.click();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");
  await save(page);
  await page.reload();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
  await expect(form.turnUrl).toHaveValue("turn:turn.example.org:3478");

  // No address, no TURN server: username and credential go with it.
  await form.turnUrl.fill("");
  await save(page);
  await page.reload();
  await expect(form.turnUrl).toHaveValue("");
  await expect(form.turnUser).toHaveValue("");
  await expect(form.turnCredential).toHaveValue("");
});

test("relays: only http(s) addresses are kept, normalized and without duplicates", async ({ peer }) => {
  const alice = await peer("alice");
  await keepOffline(alice);
  const { page } = alice;
  await page.goto("/#/settings");
  const form = network(page);
  await form.relays.fill(
    [
      "javascript:alert(1)",
      "ftp://relay.example.org",
      "file:///etc/passwd",
      "data:text/plain,relay",
      "https://relay.example.org/pkarr/",
      "https://relay.example.org/pkarr",
      "relay.example.org",
    ].join("\n"),
  );
  await save(page);
  await page.reload();
  await expect(form.relays).toHaveValue("https://relay.example.org/pkarr");

  await form.reset.click();
  await save(page);
  await page.reload();
  await expect(form.relays).toHaveValue(DEFAULT_RELAYS);
});

// A list with nothing usable in it would leave this browser unable to reach anyone: refused.
test("relays: a list with no valid address is refused, and the relays stay", async ({ peer }) => {
  const alice = await peer("alice");
  await keepOffline(alice);
  const { page } = alice;
  await page.goto("/#/settings");
  const form = network(page);
  await form.relays.fill("not a url\njavascript:alert(1)");
  await form.save.click();
  await expect(page.getByTestId("network-error")).toContainText("at least one relay");
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(form.relays).not.toHaveValue("");
});

// A TURN address WebRTC refuses would make every connection of this browser fail: the form says
// why and keeps the old setting.
test("a TURN address WebRTC cannot use is refused, and chats still connect", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await alice.page.goto("/#/settings");
  const form = network(alice.page);
  for (const [urls, user, credential, problem] of [
    ["turn:turn.example.org:3478", "", "", "username and credential"],
    ["turn.example.org:3478", "u", "c", "not a TURN or STUN address"],
    ["https://turn.example.org", "u", "c", "not a TURN or STUN address"],
  ] as const) {
    await form.turnUrl.fill(urls);
    await form.turnUser.fill(user);
    await form.turnCredential.fill(credential);
    await form.save.click();
    await expect(alice.page.getByTestId("network-error"), urls).toContainText(problem);
  }
  await alice.page.reload();
  await expect(form.turnUrl).toHaveValue("");
  await alice.page.goto("/#/");
  await link(alice, bob);
  await connect(alice, bob);
  await expect(chat(bob).getByText("hello from alice")).toBeVisible();
});
