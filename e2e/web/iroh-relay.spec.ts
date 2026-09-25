import { endpoints } from "../infra/env.mjs";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

// Two people in browsers whose networks let no WebRTC through (symmetric NATs, UDP blocked): their chat goes
// over Iroh, through an Iroh relay (WISP 102, relay only), and says so. The first pairing still happens over
// WebRTC here, which is where the apps learn each other's Iroh address; then WebRTC is blocked in both pages
// and the reconnect lands on the relayed Iroh instead of the DHT. The relay is the e2e infra's `iroh-relay`.
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

/** A page whose WebRTC cannot even start, as behind a network that lets none through. */
async function blockWebRtc(peer: Peer): Promise<void> {
  await peer.context.addInitScript(() => {
    window.RTCPeerConnection = class {
      constructor() { throw new DOMException("WebRTC is blocked on this network", "NotAllowedError"); }
    } as unknown as typeof RTCPeerConnection;
  });
}

test("with WebRTC blocked, two browsers keep chatting over Iroh through a relay, and the chat says it is relayed", {
  tag: ["@feature:transport.iroh-web", "@feature:transport.relayed", "@feature:settings.network.iroh-relays", "@feature:transport.indicator"],
}, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob] = await Promise.all([peer("alice", { irohRelay: relay }), peer("bob", { irohRelay: relay })]);
  // The setting stuck: after a reload, Network shows the relay the peer now uses.
  await alice.page.goto("/#/settings");
  await alice.page.reload();
  await expect(alice.page.getByTestId("network-iroh-relays")).toHaveValue(relay);
  await alice.page.goto("/#/");

  await link(alice, bob);
  await connect(alice, bob);
  // Both apps run Iroh now (the wasm loaded, the relay answered) and told each other: it can be chosen.
  for (const p of [alice, bob]) {
    await p.page.getByTestId("connection-options").click();
    await expect(p.page.getByTestId("connection-option-iroh")).toBeEnabled({ timeout: 60_000 });
    await p.page.keyboard.press("Escape");
    // Direct WebRTC works, so it stays: a relayed Iroh never beats it.
    await expect(p.page.getByTestId("connection-options")).toHaveAttribute("data-transport", "webrtc/1");
  }

  // Now neither network lets WebRTC through.
  for (const p of [alice, bob]) await blockWebRtc(p);
  await Promise.all([alice, bob].map(p => p.page.reload()));
  for (const p of [alice, bob]) {
    const icon = p.page.getByTestId("connection-options");
    await expect(icon).toHaveAttribute("data-transport", "iroh/1", { timeout: 120_000 });
    await expect(icon).toHaveAttribute("data-relayed", "");
    await expect(icon).toHaveAttribute("aria-label", "Connection options: Connected · Iroh (relayed)");
  }

  await say(alice, "through the relay");
  await expect(chat(bob).getByText("through the relay")).toBeVisible({ timeout: 60_000 });
  await say(bob, "and back");
  await expect(chat(alice).getByText("and back")).toBeVisible({ timeout: 60_000 });

  // The panel says the path is relayed, and through which relay.
  await alice.page.getByTestId("connection-options").click();
  await expect(alice.page.getByTestId("connection-relayed")).toHaveText(`Relayed via ${new URL(relay).host}`);
  await expect(alice.page.getByTestId("connection-summary")).toContainText("sees which devices talk and when, never what they say");
  await alice.page.keyboard.press("Escape");
  await alice.page.getByTestId("connection-options").hover();
  await expect(alice.page.getByTestId("connection-tooltip-detail")).toHaveText(/^relayed · /);
});

test("an Iroh relay address the app cannot use is refused in Settings", {
  tag: ["@feature:settings.network.iroh-relays"],
}, async ({ peer }) => {
  const alice = await peer("alice", { irohRelay: endpoints.irohRelay });
  await alice.page.goto("/#/settings");
  const field = alice.page.getByTestId("network-iroh-relays");
  await field.fill("http://relay.example.org/");
  await alice.page.getByTestId("network-save").click();
  await expect(alice.page.getByTestId("network-error")).toHaveText("Use an https:// relay address: http://relay.example.org/");
  // Reset puts back n0's public relays, the ones the desktop app uses.
  await alice.page.getByRole("button", { name: "Reset Iroh relays to defaults" }).click();
  await expect(field).toHaveValue(/^https:\/\/use1-1\.relay\.n0\.iroh\.link\/\n/);
});
