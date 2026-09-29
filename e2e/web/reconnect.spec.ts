import { chat, connect, expect, link, say, test } from "../support/fixtures";

// A contact whose app stops answering (a laptop asleep, an app frozen in the background) while the
// connection still looks open: the other side notices from its pings, and both reconnect on their own
// once the contact is back, without pressing anything.
test("a connection that silently stops answering is noticed, and comes back by itself", { tag: ["@feature:core.liveness", "@feature:chat.paired.reconnect", "@feature:chat.paired.status"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const connected = (p: typeof alice) => expect(p.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 120_000 });
  for (const p of [alice, bob]) await connected(p);

  // Bob's app stops running (paused in the debugger), while its connection stays up: it just never answers.
  // This is seconds after the link opened, before the first ping: Bob's app said in its offer that it
  // answers pings, so they count from the open.
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");
  // Pings every 15 s, three unanswered: about a minute.
  await expect(alice.page.getByTestId("connection-options")).not.toHaveAttribute("aria-label", /Connected/, { timeout: 120_000 });

  await cdp.send("Debugger.resume");
  await cdp.send("Debugger.disable");
  for (const p of [alice, bob]) await connected(p);
  await say(bob, "back again");
  await expect(chat(alice).getByText("back again")).toBeVisible({ timeout: 60_000 });
  await say(alice, "welcome back");
  await expect(chat(bob).getByText("welcome back")).toBeVisible({ timeout: 60_000 });
});
