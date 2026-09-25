import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

// The chat's connection story, as two people chatting in browsers see it: a row in each timeline for the first
// live connection, with the details a tap away, and nothing for a contact's app that goes away and comes back at
// once (that is in the connection panel's history), while messages keep flowing. A browser speaks WebRTC only, so
// its connection panel lists the native transports off and says why. A switch between transports mid-chat (Desktop's Iroh and
// HyperDHT) is proven in-process in packages/browser/test/transportSwitchLive.test.ts and
// transportTimelineNode.test.ts: Linux WebKitGTK, the only
// Desktop the e2e harness drives, cannot go live (no RTCPeerConnection for the first pairing).
const lines = (peer: Peer) => chat(peer).getByTestId("transport-line");
const lineText = (peer: Peer, text: string | RegExp) => lines(peer).getByTestId("transport-line-text").filter({ hasText: text });

test("each timeline says when the chat went live, a quick reconnect stays in the history, and the panel offers what a browser can", {
  tag: ["@feature:transport.timeline", "@feature:transport.chat-switch", "@feature:transport.indicator", "@feature:chat.paired.reconnect"],
}, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Both sides tell the same story: live over WebRTC.
  for (const p of [alice, bob]) await expect(lineText(p, "Connected over WebRTC")).toHaveCount(1, { timeout: 60_000 });
  // A line is not a message: it sits between them, centred, and opens to its details.
  const first = lines(alice).filter({ hasText: "Connected over WebRTC" });
  await first.getByRole("button").click();
  const details = first.getByTestId("transport-line-details");
  await expect(details).toContainText("Transport");
  await expect(details).toContainText("WebRTC");
  await expect(details).toContainText("A first pairing always uses WebRTC.");

  // The header's connection icon shows the transport by its own mark; hovering it says what it is, clicking it says
  // why.
  const icon = alice.page.getByTestId("connection-options");
  await expect(icon).toHaveAttribute("data-transport", "webrtc/1");
  await expect(icon.locator("[data-transport-icon]")).toHaveAttribute("data-transport-icon", "webrtc/1");
  await icon.hover();
  await expect(alice.page.getByTestId("connection-tooltip-detail")).toHaveText(/^(\d+ ms · )?live for .+ · the only one here$/);
  await icon.click();
  const panel = alice.page.getByRole("dialog", { name: "Connection options" });
  await expect(panel.getByTestId("connection-state")).toHaveText(/^Connected · WebRTC( · \d+ ms)?$/);
  // Every choice is there, one line each: WebRTC, chosen and in use; the native ones off, and why (in their
  // tooltip); DHT only, which every app can choose.
  await expect(panel.getByRole("radio")).toHaveCount(4);
  await expect(panel.getByRole("radio", { name: "WebRTC", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("radio", { name: "WebRTC", exact: true })).toHaveAttribute("data-in-use", "");
  await expect(panel.getByRole("radio", { name: "WebRTC", exact: true })).toHaveText(/^WebRTCIn use( · \d+ ms)?$/);
  await expect(panel.getByRole("radio", { name: "Iroh", exact: true })).toBeDisabled();
  await expect(panel.getByRole("radio", { name: "Iroh", exact: true })).toHaveAttribute("title", "Iroh: Iroh needs Ghostly Desktop");
  await expect(panel.getByRole("radio", { name: "HyperDHT", exact: true })).toHaveAttribute("title", "HyperDHT: HyperDHT needs Ghostly Desktop, or a HyperDHT relay in Settings");
  await expect(panel.getByRole("radio", { name: "DHT only", exact: true })).toHaveAttribute("aria-checked", "false");
  // Why this transport is under Details.
  await panel.getByTestId("connection-details-summary").click();
  await expect(panel.getByTestId("connection-summary")).toContainText("WebRTC is the only transport this app runs.");
  await alice.page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // The ⋮ has no Connection row: the header's control is the one way in.
  await alice.page.getByTestId("chat-options").click();
  await expect(alice.page.getByTestId("chat-options-menu")).toBeVisible();
  await expect(alice.page.getByTestId("chat-connection-open")).toHaveCount(0);
  await alice.page.keyboard.press("Escape");

  // Bob's app goes away and comes back at once (a reload): no row in either timeline. Alice's connection panel
  // has the drop and the reconnect in its history.
  await bob.page.reload();
  await icon.click();
  // The history is under Details.
  const more = alice.page.getByTestId("connection-details");
  if ((await more.getAttribute("open")) === null) await alice.page.getByTestId("connection-details-summary").click();
  const history = alice.page.getByTestId("connection-history");
  await history.getByText(/^Connection history/).click();
  await expect(history.locator('[data-kind="down"]').first()).toBeVisible({ timeout: 90_000 });
  const latest = history.getByTestId("connection-history-event").first();
  await expect(latest).toHaveAttribute("data-kind", "live", { timeout: 120_000 });
  await expect(latest).toContainText(/Live over WebRTC · after \d+ (s|min) down/);
  await alice.page.keyboard.press("Escape");
  for (const p of [alice, bob]) await expect(lineText(p, "Connected over WebRTC")).toHaveCount(1);
  await expect(lines(alice)).toHaveCount(1);
  await expect(lines(bob)).toHaveCount(1);

  // Messages keep flowing, and the lines stay out of the way of the conversation.
  await say(bob, "still here after the reload");
  await expect(chat(alice).getByText("still here after the reload")).toBeVisible({ timeout: 60_000 });
  await say(alice, "welcome back");
  await expect(chat(bob).getByText("welcome back")).toBeVisible({ timeout: 60_000 });
  await expect(lines(alice).filter({ hasText: "welcome back" })).toHaveCount(0);
});

test("DHT only from the connection panel: both timelines say who chose it, texts still go, and both come back live", {
  tag: ["@feature:transport.timeline", "@feature:transport.chat-switch", "@feature:invite.delivery-mode"],
}, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await expect(lineText(p, "Connected over WebRTC")).toHaveCount(1, { timeout: 60_000 });

  // Alice chooses DHT only; it travels in her DHT envelope, and Bob's app keeps off the live link too.
  await alice.page.getByTestId("connection-options").click();
  await alice.page.getByTestId("connection-option-dht").click();
  await alice.page.keyboard.press("Escape");
  await expect(lineText(alice, "You switched to DHT only")).toHaveCount(1, { timeout: 60_000 });
  await expect(lineText(bob, /^(?!You ).+ switched to DHT only$/)).toHaveCount(1, { timeout: 120_000 });
  await expect(alice.page.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: DHT only · chosen by you");
  await say(bob, "over the DHT");
  await expect(chat(alice).getByText("over the DHT")).toBeVisible({ timeout: 120_000 });

  // Back to Automatic: both timelines say the chat is live again, in one row that also stands for leaving DHT only.
  await alice.page.getByTestId("connection-options").click();
  const panel = alice.page.getByRole("dialog", { name: "Connection options" });
  await expect(panel.getByTestId("connection-state")).toHaveText("DHT only · chosen by you");
  await expect(panel.getByTestId("connection-option-dht")).toHaveAttribute("aria-checked", "true");
  await panel.getByTestId("connection-option-webrtc").click();
  await alice.page.keyboard.press("Escape");
  for (const p of [alice, bob]) {
    await expect(lineText(p, "Back live over WebRTC")).toHaveCount(1, { timeout: 120_000 });
    const back = lines(p).filter({ hasText: "Back live over WebRTC" });
    await back.getByRole("button").click();
    await expect(back.getByTestId("transport-line-earlier")).toContainText("Left DHT only · connecting live");
  }
  await say(alice, "live again");
  await expect(chat(bob).getByText("live again")).toBeVisible({ timeout: 60_000 });
});
