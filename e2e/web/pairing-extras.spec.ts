import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * The connection control in a paired chat's header and its panel: how it opens
 * and closes, the optional code comparison, and what it says and offers when
 * one side goes away and comes back.
 */

const trigger = (p: Peer) => p.page.getByTestId("connection-options");
const popover = (p: Peer) => p.page.getByRole("dialog", { name: "Connection options" });

/** Ghostly's own Offline switch, on the Services page: the chat has to go somewhere it can be seen. */
async function setOnline(p: Peer, online: boolean): Promise<void> {
  await p.page.getByTestId("account-services").click();
  const toggle = p.page.getByTestId("online-toggle");
  if ((await toggle.textContent())?.includes(online ? "Offline" : "Online")) await toggle.click();
  await expect(toggle).toHaveText(online ? "Online" : "Offline");
  await p.page.goBack();
  await expect(p.page.getByPlaceholder("Message…")).toBeVisible();
}

async function linked(peer: (name: string) => Promise<Peer>, names: [string, string]): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all(names.map((name) => peer(name)));
  await pair(alice, bob);
  await say(alice, `hi from ${alice.name}`);
  await expect(chat(bob).getByText(`hi from ${alice.name}`)).toBeVisible();
  for (const p of [alice, bob]) await expect(trigger(p)).toHaveAccessibleName("Connection options: Connected · WebRTC");
  return [alice, bob];
}

test("the connection popover opens and closes by click, Escape and a click outside", { tag: ["@feature:chat.paired.status", "@feature:app.popovers"] }, async ({ peer }) => {
  const [alice] = await linked(peer, ["popover-alice", "popover-bob"]);
  const menu = popover(alice);
  await expect(menu).toBeHidden();

  // The trigger toggles it.
  await trigger(alice).click();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Connected · WebRTC");
  await trigger(alice).click();
  await expect(menu).toBeHidden();

  // Escape closes it and hands focus back to what opened it.
  await trigger(alice).click();
  await expect(menu).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger(alice)).toBeFocused();

  // A click inside keeps it open; a click outside closes it.
  await trigger(alice).click();
  await menu.getByText("Details", { exact: true }).click();
  await expect(menu.getByText(/Fallback uses another live method/)).toBeVisible();
  await expect(menu).toBeVisible();
  const box = (await chat(alice).boundingBox())!;
  await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await expect(menu).toBeHidden();

  // Closed, it opens again as before, and the chat never noticed.
  await trigger(alice).click();
  await expect(menu).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(alice.page.getByPlaceholder("Message…")).toBeEnabled();
});

test("the header has one connection control: the dot, the key, the transport in use and its round trip; a tooltip names the state", { tag: ["@feature:chat.paired.status", "@feature:transport.indicator"] }, async ({ peer }) => {
  const [alice] = await linked(peer, ["icon-alice", "icon-bob"]);
  const tip = alice.page.getByRole("tooltip");
  // One control: nothing else in the header speaks of the connection.
  await expect(alice.page.getByTestId("connection-options")).toHaveCount(1);
  await expect(alice.page.getByTestId("transport-chip")).toHaveCount(0);
  await expect(alice.page.getByRole("button", { name: "Connection details", exact: true })).toHaveCount(0);
  await expect(trigger(alice)).toHaveAttribute("data-state", "connected");
  await expect(trigger(alice).getByTestId("contact-status")).toHaveAttribute("aria-label", "Connected");
  await expect(trigger(alice).getByTestId("contact-status")).toBeVisible();
  await expect(trigger(alice).getByTestId("connection-key")).toHaveText(/^\S{6}\.\.\.\S{6}$/);
  await expect(trigger(alice).getByTestId("connection-now")).toHaveText(/^WebRTC(· \d+ ms)?$/);
  // Under the name, left of the calls: the right side has the call buttons and ⋮ only.
  const control = (await trigger(alice).boundingBox())!, call = (await alice.page.getByTestId("call-audio").boundingBox())!;
  expect(control.x + control.width).toBeLessThan(call.x);

  // Hover names the state; nothing is said until then.
  await expect(tip).toBeHidden();
  await trigger(alice).hover();
  await expect(tip).toBeVisible();
  // The state, then what the connection is: round trip, since when, why (#204).
  await expect(tip).toHaveText(/^Connected · WebRTC\s*(\d+ ms · )?live for .+ · the only one here$/);
  await expect(trigger(alice)).toHaveAccessibleDescription(/^Connected · WebRTC/);

  // Opening the popover hides the tooltip; the popover has the full picture.
  await trigger(alice).click();
  await expect(popover(alice)).toBeVisible();
  await expect(tip).toBeHidden();
  await expect(popover(alice).getByTestId("connection-state")).toHaveText("Connected · WebRTC");

  // Reached from the keyboard, the tooltip shows; Escape dismisses it and keeps focus.
  await alice.page.keyboard.press("Escape");
  await expect(popover(alice)).toBeHidden();
  await alice.page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  // The call buttons come right after it.
  await alice.page.getByTestId("call-audio").focus();
  await alice.page.keyboard.press("Shift+Tab");
  await expect(trigger(alice)).toBeFocused();
  await expect(tip).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(trigger(alice)).toBeFocused();
});

test("verifying shows one code on both sides, and each side confirms for itself", { tag: ["@feature:chat.paired.verify", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer, ["code-alice", "code-bob"]);
  for (const p of [alice, bob]) {
    await trigger(p).click();
    await expect(p.page.getByTestId("pair-trust")).toContainText("Key saved · not verified");
    // No code until someone asks to compare.
    await expect(p.page.getByTestId("pair-code")).toHaveCount(0);
    await p.page.getByTestId("pair-verify").click();
    await expect(p.page.getByTestId("pair-code")).toBeVisible();
  }
  const [mine, theirs] = await Promise.all([alice, bob].map(async (p) => (await p.page.getByTestId("pair-code").textContent())!.trim()));
  expect(mine.length, "a code worth comparing").toBeGreaterThan(3);
  expect(mine, "both sides see the same code").toBe(theirs);

  // Alice's confirmation is hers: Bob has not compared anything yet.
  await alice.page.getByTestId("pair-verify-confirm").click();
  await expect(alice.page.getByTestId("pair-verified")).toContainText("Codes verified");
  await expect(alice.page.getByTestId("pair-code")).toHaveCount(0);
  await expect(bob.page.getByTestId("pair-verified")).toHaveCount(0);
  await expect(bob.page.getByTestId("pair-code")).toHaveText(theirs);

  await bob.page.getByTestId("pair-verify-confirm").click();
  await expect(bob.page.getByTestId("pair-verified")).toContainText("Codes verified");

  // Closed and opened again, it stays verified.
  await bob.page.keyboard.press("Escape");
  await trigger(bob).click();
  await expect(bob.page.getByTestId("pair-verified")).toBeVisible();
  await expect(bob.page.getByTestId("pair-verify")).toHaveCount(0);
  await say(bob, "verified and still talking");
  await expect(chat(alice).getByText("verified and still talking")).toBeVisible();
});

test("offline, the popover says so; the contact is offered Reconnect, and the chat comes back", { tag: ["@feature:app.offline-switch", "@feature:chat.paired.status", "@feature:chat.paired.reconnect", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer, ["offline-alice", "offline-bob"]);

  await setOnline(alice, false);
  await expect(trigger(alice)).toHaveAccessibleName("Connection options: Offline");
  await expect(trigger(alice)).toHaveAttribute("data-state", "offline");
  await expect(trigger(alice).getByTestId("connection-now")).toHaveText("Offline");
  await trigger(alice).hover();
  await expect(alice.page.getByRole("tooltip")).toHaveText("Offline");
  await trigger(alice).click();
  await expect(popover(alice)).toContainText("Offline");
  // Nothing to choose or retry while offline.
  await expect(popover(alice).getByRole("radio", { name: "DHT only", exact: true })).toBeDisabled();
  await expect(popover(alice).getByRole("radio", { name: "WebRTC", exact: true })).toBeDisabled();
  await expect(popover(alice).getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  await expect(alice.page.getByPlaceholder("Message…")).toBeDisabled();
  await alice.page.keyboard.press("Escape");

  // The contact sees the link go, and gets a way to try again.
  await expect(trigger(bob)).not.toHaveAccessibleName(/Connected/);
  await trigger(bob).click();
  const reconnect = popover(bob).getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();
  // Trying while the other side is away does no harm.
  await reconnect.click();
  await expect(popover(bob).getByRole("alert")).toHaveCount(0);

  await setOnline(alice, true);
  for (const p of [alice, bob]) await expect(trigger(p)).toHaveAccessibleName("Connection options: Connected · WebRTC");
  await expect(reconnect).toHaveCount(0);
  await expect(popover(bob)).toContainText("Connected · WebRTC");

  // Messages flow again, both ways.
  await say(bob, "back again?");
  await expect(chat(alice).getByText("back again?")).toBeVisible();
  await say(alice, "back again!");
  await expect(chat(bob).getByText("back again!")).toBeVisible();
});

test("Reconnect after the contact reloads: the link returns and messages flow", { tag: ["@feature:chat.paired.reconnect", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer, ["reload-alice", "reload-bob"]);
  await alice.page.reload();
  await expect(alice.page.getByPlaceholder("Message…")).toBeVisible();

  // Bob's side notices the link went, and offers to bring it back.
  await trigger(bob).click();
  const reconnect = popover(bob).getByRole("button", { name: "Reconnect" });
  await expect(reconnect.or(popover(bob).getByText("Connected · WebRTC")).first()).toBeVisible();
  if (await reconnect.isVisible()) await reconnect.click().catch(() => {});

  for (const p of [alice, bob]) await expect(trigger(p)).toHaveAccessibleName("Connection options: Connected · WebRTC");
  await expect(reconnect).toHaveCount(0);
  await say(alice, "reloaded and back");
  await expect(chat(bob).getByText("reloaded and back")).toBeVisible();
  await say(bob, "welcome back");
  await expect(chat(alice).getByText("welcome back")).toBeVisible();
});
