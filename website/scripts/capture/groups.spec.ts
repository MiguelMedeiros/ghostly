// "Bring the whole group": a private group (group-mesh/1) with a picture, made by Boo and joined by
// three friends through its link, everyone talking. Desktop from Boo's side, then Boo's own profile
// reopened on a phone.
import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { LocalRelay } from "../../../e2e/support/relay";
import { CAST, chat, converse, home, newProfile, open, person, sceneImage, shot, toBottom, type Peer } from "./helpers";

const GROUP = "Lake house trip";
const groupChat = (p: Peer) => p.page.getByTestId("group-chat");

async function join(p: Peer, url: string) {
  await p.page.goto(url);
  await expect(groupChat(p)).toBeVisible({ timeout: 30_000 });
  await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}

test("a private group of four, desktop and phone", async ({ browser, baseURL }) => {
  test.setTimeout(20 * 60_000);
  const relay = new LocalRelay();
  const profile = newProfile();
  const boo = await person(browser, relay, baseURL!, CAST.boo, { profile });
  const friends = await Promise.all([CAST.casper, CAST.wendy, CAST.spooky].map((who) => person(browser, relay, baseURL!, who)));
  const [casper, wendy, spooky] = friends;

  // Boo makes the group, gives it a picture, and hands out its link.
  await home(boo);
  await boo.page.getByTestId("sidebar-new-more").click();
  await boo.page.getByTestId("new-group").click();
  await boo.page.getByTestId("new-group-name").fill(GROUP);
  await boo.page.getByTestId("new-group-kind-mesh").click();
  await boo.page.getByTestId("new-group-create").click();
  const url = await boo.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
  await boo.page.getByTestId("group-share-done").click();
  await boo.page.getByTestId("group-members").click();
  await boo.page.getByTestId("group-picture-input").setInputFiles({ name: "lake.jpg", mimeType: "image/jpeg", buffer: await sceneImage(boo) });
  await expect(boo.page.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "set");
  await boo.page.getByTestId("group-members-dialog").getByRole("button", { name: "Close" }).click();

  for (const f of friends) await join(f, url);
  const everyone = [boo, ...friends];
  for (const p of everyone) await expect(p.page.getByTestId("group-connection-options")).toHaveAttribute("data-state", "connected", { timeout: 180_000 });

  await converse([
    [boo, "welcome to the lake house crew 🏡"],
    [casper, "finally a group chat with just us in it"],
    [wendy, "I'll bring the board games 🎲"],
    [spooky, "and I bring the ghost stories 👻"],
    [casper, "car leaves at 6. who's riding with me?"],
    [wendy, "me! saving you the front seat, Boo"],
    [boo, "see you all friday 🌙"],
  ], everyone);
  await boo.page.waitForTimeout(2000);
  await toBottom(boo);
  await shot(boo, "groups.png");
  await boo.page.getByTestId("group-members").click();
  await boo.page.waitForTimeout(600);
  await shot(boo, "x-groups-members.png");
  await boo.page.getByTestId("group-members-dialog").getByRole("button", { name: "Close" }).click();

  // The same Boo on a phone.
  const route = await boo.page.evaluate(() => location.hash);
  await boo.context.close();
  const phone = await open(browser, relay, baseURL!, "mBoo", { mobile: true, profile });
  await phone.page.evaluate((h) => { location.hash = h; }, route);
  await expect(chat(phone).getByText("see you all friday 🌙")).toBeVisible({ timeout: 60_000 });
  await expect(phone.page.getByTestId("group-connection-options")).toHaveAttribute("data-state", "connected", { timeout: 180_000 }).catch(() => console.log("  [mBoo] group not reconnected yet"));
  await phone.page.waitForTimeout(1500);
  await toBottom(phone);
  await shot(phone, "groups-mobile.png");
  await phone.context.close();
  rmSync(profile, { recursive: true, force: true });
  relay.close();
});
