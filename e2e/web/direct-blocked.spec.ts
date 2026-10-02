import type { BrowserContext } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { expect, link, test, type Peer } from "../support/fixtures";

// A person on a network that lets no direct connection through (a VPN that blocks WebRTC, a firewall that drops UDP):
// their browser gathers no WebRTC candidate at all, as Chromium does under `disable_non_proxied_udp`. Their chats
// still go live, through the Iroh relay, and their app says why they are slower, where the connection is shown and in
// Settings, Network. Their contacts, on open networks, are told nothing. The relay is the e2e infra's `iroh-relay`.
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

const HINT = "Direct connections are blocked on this network (a VPN or firewall?). Chats still work through relays, but connect more slowly.";

/** A page whose WebRTC finds no candidate: relay candidates only, and no TURN server to give one. */
async function noDirectUdp(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) { super({ ...config, iceTransportPolicy: "relay" }); }
    };
  });
}

async function relayed(peer: Peer): Promise<void> {
  const icon = peer.page.getByTestId("connection-options");
  await expect(icon).toHaveAttribute("data-transport", "iroh/1", { timeout: 120_000 });
  await expect(icon).toHaveAttribute("aria-label", "Connection options: Connected · Iroh (relayed)");
}

async function home(peer: Peer): Promise<void> {
  await peer.page.goto("/#/");
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("behind a network that blocks direct connections, chats go live through a relay and the app says why they are slower", {
  tag: ["@feature:transport.direct-blocked", "@feature:transport.relayed", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob, carol] = await Promise.all([
    peer("alice", { irohRelay: relay, beforeOpen: noDirectUdp }),
    peer("bob", { irohRelay: relay }),
    peer("carol", { irohRelay: relay }),
  ]);

  // The first chat goes live through the relay. One contact says nothing yet about whose network it is.
  await link(alice, bob);
  await relayed(alice);
  await relayed(bob);
  await home(alice);
  // The second too: now it is this device, and the note is there.
  await link(carol, alice);
  await relayed(alice);
  await relayed(carol);

  await alice.page.getByTestId("connection-options").click();
  const note = alice.page.getByTestId("connection-direct-blocked");
  await expect(note).toContainText(HINT, { timeout: 30_000 });
  await note.getByTestId("connection-direct-blocked-info").click();
  await expect(note.getByTestId("connection-direct-blocked-text")).toContainText("the app cannot tell which");
  await alice.page.keyboard.press("Escape");

  // Their contacts are on open networks: nothing is said there.
  for (const contact of [bob, carol]) {
    await contact.page.getByTestId("connection-options").click();
    await expect(contact.page.getByTestId("connection-state")).toBeVisible();
    await expect(contact.page.getByTestId("connection-direct-blocked")).toHaveCount(0);
    await contact.page.keyboard.press("Escape");
  }

  // Settings, Network says the same, and the note goes by itself when the network changes.
  await alice.page.goto("/#/settings/advanced");
  const row = alice.page.getByTestId("network-direct-blocked");
  await expect(row).toContainText(HINT);
  await alice.page.evaluate(() => { window.dispatchEvent(new Event("online")); });
  await expect(row).toHaveCount(0);
});
