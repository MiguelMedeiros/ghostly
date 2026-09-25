import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

// HyperDHT in the browser (WISP 103, browser profile): each app reaches the HyperDHT through a relay
// (native-transports/hyperdht-relay, run by e2e/infra on a HyperDHT network of its own). The relay moves
// handshake messages and ciphertext; the keys, the Noise handshake and the encrypted stream stay in the page.
// A first pairing still takes WebRTC (the contact's HyperDHT key travels inside an authenticated session), so the
// two people pair, set the relay, and then lose WebRTC: their chat comes back live over HyperDHT, relayed.
const relay = process.env.GHOSTLY_HYPERDHT_RELAY_URL ?? "";

/** Back to the one chat, from wherever the page is (a chat is not in the address). */
async function openTheChat(peer: Peer): Promise<void> {
  await peer.page.goto("/");
  await peer.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await expect(chat(peer)).toBeVisible();
}

async function setRelay(peer: Peer, url: string): Promise<void> {
  await peer.page.goto("/#/settings");
  const field = peer.page.getByTestId("network-hyperdht-relay");
  await expect(field).toHaveValue("");
  await field.fill(url);
  await peer.page.getByTestId("network-save").click();
  await expect(peer.page.getByTestId("network-saved")).toBeVisible();
  await openTheChat(peer);
}

/** From the next load on, this page has no WebRTC at all, as a browser with it disabled. */
async function withoutWebRtc(peer: Peer): Promise<void> {
  await peer.page.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) Reflect.deleteProperty(window, name);
  });
  await peer.page.reload();
  expect(await peer.page.evaluate(() => typeof RTCPeerConnection)).toBe("undefined");
  await openTheChat(peer);
}

test("with WebRTC gone, two browsers keep chatting over HyperDHT through a relay, and both say it is relayed", {
  tag: ["@gated", "@feature:transport.hyperdht-relay", "@feature:transport.relayed", "@feature:settings.network.hyperdht-relay"],
}, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_HYPERDHT_RELAY !== "1" || !relay, "Requires the HyperDHT relay of e2e/infra (GHOSTLY_HYPERDHT_RELAY)");
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // A relay address other than wss:// (or ws:// to this machine) is refused before anything is saved.
  await alice.page.goto("/#/settings");
  await alice.page.getByTestId("network-hyperdht-relay").fill("ws://relay.example.org");
  await alice.page.getByTestId("network-save").click();
  await expect(alice.page.getByTestId("network-error")).toHaveText("Use a wss:// relay address");
  await alice.page.getByTestId("network-hyperdht-relay").fill("");

  for (const p of [alice, bob]) await setRelay(p, relay);
  // Both apps now run HyperDHT too, through the relay: offered, marked relayed, and WebRTC stays in use (direct first).
  for (const p of [alice, bob]) {
    await p.page.getByTestId("connection-options").click();
    const option = p.page.getByTestId("connection-option-hyperdht");
    await expect(option).toBeEnabled({ timeout: 60_000 });
    await expect(option).toHaveAttribute("title", "HyperDHT: Through a relay · used when nothing direct connects");
    await expect(p.page.getByTestId("connection-option-webrtc")).toContainText("In use");
    await p.page.keyboard.press("Escape");
  }
  // The setting is kept across a reload.
  await bob.page.goto("/#/settings");
  await bob.page.reload();
  await expect(bob.page.getByTestId("network-hyperdht-relay")).toHaveValue(relay);
  await openTheChat(bob);

  // WebRTC is gone from both browsers: the chat comes back over HyperDHT, through the relay.
  for (const p of [alice, bob]) await withoutWebRtc(p);
  for (const p of [alice, bob]) {
    await expect(p.page.getByTestId("connection-options")).toHaveAttribute("data-transport", "hyperdht/1", { timeout: 150_000 });
  }
  await say(alice, "over a relayed HyperDHT");
  await expect(chat(bob).getByText("over a relayed HyperDHT")).toBeVisible();
  await say(bob, "and back again");
  await expect(chat(alice).getByText("and back again")).toBeVisible();

  // Every place that describes the connection says it goes through a relay.
  await alice.page.getByTestId("connection-options").click();
  await alice.page.getByTestId("connection-details-summary").click();
  await expect(alice.page.getByTestId("connection-relayed")).toHaveText(`Relayed via ${new URL(relay).host}`);
  await expect(alice.page.getByTestId("connection-summary")).toContainText("never what they say");
  await alice.page.keyboard.press("Escape");
  await expect(chat(bob).getByTestId("transport-line-text").filter({ hasText: /over HyperDHT|to HyperDHT/ }).first()).toBeVisible();
});
