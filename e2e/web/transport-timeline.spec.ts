import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

// The chat's connection story, as two people chatting in browsers see it: a line in each timeline for the first
// live connection, one when the link drops and one when it comes back, with the details a tap away, while messages
// keep flowing. A browser speaks WebRTC only, so its Connection menu offers that alone and says why. A switch
// between transports mid-chat (Desktop's Iroh and HyperDHT) is proven in-process in
// packages/browser/test/transportSwitchLive.test.ts and transportTimelineNode.test.ts: Linux WebKitGTK, the only
// Desktop the e2e harness drives, cannot go live (no RTCPeerConnection for the first pairing).
const lines = (peer: Peer) => chat(peer).getByTestId("transport-line");
const lineText = (peer: Peer, text: string | RegExp) => lines(peer).getByTestId("transport-line-text").filter({ hasText: text });

test("each timeline says when the chat went live, dropped and came back, and the menu offers what a browser can", {
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

  // The connection icon shows the transport by its own mark; hovering it says what it is, clicking it says why.
  const icon = alice.page.getByTestId("connection-options");
  await expect(icon).toHaveAttribute("data-transport", "webrtc/1");
  await expect(icon.locator("[data-transport-icon]")).toHaveAttribute("data-transport-icon", "webrtc/1");
  await icon.hover();
  await expect(alice.page.getByTestId("connection-tooltip-detail")).toHaveText(/^(\d+ ms · )?live for .+ · the only one here$/);
  await icon.click();
  const summary = alice.page.getByTestId("connection-summary");
  await expect(summary).toContainText("Transport");
  await expect(summary).toContainText("WebRTC is the only transport this app runs.");
  await expect(alice.page.getByTestId("connection-menu").getByRole("radio", { name: "WebRTC" })).toHaveAttribute("aria-checked", "true");
  await alice.page.keyboard.press("Escape");

  // The header names the live transport, and the chat's Connection menu (chip or ⋮) offers WebRTC alone here.
  await expect(alice.page.getByTestId("transport-chip")).toHaveAttribute("data-transport", "webrtc/1");
  await alice.page.getByTitle("Options").click();
  await expect(alice.page.getByTestId("chat-connection-open")).toContainText(/Connection…WebRTC · (\d+ ms · )?the only one here/);
  await alice.page.getByTestId("chat-connection-open").click();
  const menu = alice.page.getByTestId("transport-menu");
  await expect(menu.getByRole("radio")).toHaveCount(1);
  await expect(menu.getByRole("radio", { name: /WebRTC/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByTestId("transport-menu-note")).toHaveText("This app connects over WebRTC only. Iroh and HyperDHT need Ghostly Desktop on both sides.");
  await alice.page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // Bob's app goes away and comes back (a reload): Alice's timeline says the link was lost and came back.
  await bob.page.reload();
  await expect(lineText(alice, "Live connection lost")).toHaveCount(1, { timeout: 90_000 });
  await expect(lineText(alice, /Back live over WebRTC|Reconnected \d+ times? in/)).toHaveCount(1, { timeout: 120_000 });
  // Bob's app started again: its own line says it connected, after the one from before.
  await expect(lineText(bob, "Connected over WebRTC")).toHaveCount(2, { timeout: 120_000 });

  // Messages keep flowing, and the lines stay out of the way of the conversation.
  await say(bob, "still here after the reload");
  await expect(chat(alice).getByText("still here after the reload")).toBeVisible({ timeout: 60_000 });
  await say(alice, "welcome back");
  await expect(chat(bob).getByText("welcome back")).toBeVisible({ timeout: 60_000 });
  await expect(lines(alice).filter({ hasText: "welcome back" })).toHaveCount(0);
});
