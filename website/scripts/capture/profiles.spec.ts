// "Your space": the Profile page of Boo's Personal profile, with chats, a funded test wallet, and two
// more profiles (Work, Club) beside it, the names the section's chips use. Backups sit between them.
import { test, expect } from "@playwright/test";
import { LocalRelay } from "../../../e2e/support/relay";
import { CAST, converse, dress, home, open, pair, person, shot, type Peer } from "./helpers";
import { fund } from "./wallet";

async function newProfile(p: Peer, name: string) {
  await p.page.goto("/#/profile");
  await p.page.getByTestId("profile-new").click();
  await p.page.getByTestId("profile-new-name").fill(name);
  await p.page.getByTestId("profile-create").click();
  await expect(p.page.getByTestId("profile-name")).toHaveValue(name, { timeout: 30_000 });
}

test("desktop: the Profile page with three profiles", async ({ browser, baseURL }) => {
  test.setTimeout(10 * 60_000);
  const relay = new LocalRelay();
  const boo = await open(browser, relay, baseURL!, CAST.boo.name);
  await dress(boo, CAST.boo, "Personal");
  for (const [who, lines] of [
    [CAST.casper, ["the cabin is booked for friday 🏡", "you're the best"]],
    [CAST.wendy, ["did you get home ok?", "yes, thanks for the ride 🧹"]],
  ] as const) {
    const friend = await person(browser, relay, baseURL!, who);
    await pair(friend, boo);
    await converse([[friend, lines[0]], [boo, lines[1]]], [boo, friend]);
    await friend.context.close();
  }
  await fund(boo, { cashu: 42_000 });

  // Two more profiles; creating one switches to it (the app restarts), then back to Personal.
  await newProfile(boo, "Work");
  await dress(boo, { name: "Boo", colors: ["#0ea5e9", "#1e293b"], glyph: "💼" }, "Work");
  await newProfile(boo, "Club");
  await dress(boo, { name: "Boo", colors: ["#f59e0b", "#ef4444"], glyph: "🎸" }, "Club");
  await boo.page.goto("/#/profile");
  await boo.page.getByTestId("profile-row").filter({ hasText: "Personal" }).getByTestId("profile-switch").click();
  await expect(boo.page.getByTestId("profile-name")).toHaveValue("Personal", { timeout: 30_000 });
  await expect(boo.page.getByTestId("profile-row")).toHaveCount(3);
  await home(boo);
  await boo.page.goto("/#/profile");
  await expect(boo.page.getByTestId("profile-links")).toContainText("2 chats");
  await boo.page.waitForTimeout(800);
  await shot(boo, "x-profiles-top.png");
  await boo.page.getByTestId("profile-list").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await boo.page.waitForTimeout(600);
  await shot(boo, "profiles.png");
  await boo.page.getByTestId("account-profile").click();
  await boo.page.waitForTimeout(600);
  await shot(boo, "x-profile-switcher.png");
  relay.close();
});
