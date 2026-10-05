import type { BrowserContext } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { expect, link, openProfilePage, test, type Peer } from "../support/fixtures";

// A private group of three browsers where one member's network lets no direct connection through (a VPN's NAT, a
// firewall): its WebRTC gathers candidates, exchanges them, and nothing connects. Every app here has WebRTC, so the
// group's links ran nothing else and that member stayed unreachable. Now a link whose WebRTC connects nothing goes on
// over Iroh through its relay (WISP 902 § Transports), and everyone reads everyone. The relay is the e2e infra's.
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");

/** A page whose WebRTC candidates lead nowhere, its own and its contacts' (192.0.2.1, TEST-NET-1): no check of either side arrives. */
async function noDirectPath(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const nowhere = (sdp: string) => sdp.replace(/^(a=candidate:\S+ \d+ \S+ \d+ )\S+( \d+ typ)/gm, "$1192.0.2.1$2");
    window.RTCPeerConnection = class extends Native {
      override get localDescription(): RTCSessionDescription | null {
        const d = super.localDescription;
        return d && ({ type: d.type, sdp: nowhere(d.sdp), toJSON: () => ({ type: d.type, sdp: nowhere(d.sdp) }) } as RTCSessionDescription);
      }
      override setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
        return super.setRemoteDescription({ ...d, ...(d.sdp ? { sdp: nowhere(d.sdp) } : {}) });
      }
    };
  });
}

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** The two are contacts, live on whatever transport their networks allow, and back on the chat list. */
async function pair(host: Peer, guest: Peer): Promise<void> {
  await link(host, guest);
  for (const peer of [host, guest]) await expect(peer.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 120_000 });
  for (const peer of [host, guest]) { await peer.page.goto("/#/"); await expect(peer.page.getByTitle("New Chat")).toBeVisible(); }
}

async function invite(admin: Peer, name: string): Promise<void> {
  await admin.page.getByTestId("group-members").click();
  const row = admin.page.getByTestId("group-invite-contact").filter({ hasText: name });
  await expect(row.getByTestId("group-invite")).toBeEnabled({ timeout: 120_000 });
  await row.getByTestId("group-invite").click();
  await expect(row).toContainText("Invited…");
  await admin.page.keyboard.press("Escape");
}

async function accept(peer: Peer, groupName: string): Promise<void> {
  const row = peer.page.getByTestId("group-row").filter({ hasText: groupName });
  await row.getByTestId("group-accept").click({ timeout: 120_000 });
  await expect(row).toContainText(/\d+ members?/, { timeout: 120_000 });
  await row.click();
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
}

async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 120_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

test("a member whose network blocks direct connections is reached by the whole group, over Iroh through a relay", {
  tag: ["@feature:groups.connection", "@feature:groups.send", "@feature:transport.relayed", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob, carol] = await Promise.all([
    peer("alice", { irohRelay: relay }),
    peer("bob", { irohRelay: relay, beforeOpen: noDirectPath }),
    peer("carol", { irohRelay: relay }),
  ]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);
  await pair(alice, bob);
  await pair(alice, carol);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Ghosts");
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  await alice.page.getByTestId("group-share-done").click();
  await invite(alice, "Bob");
  await invite(alice, "Carol");
  await Promise.all([accept(bob, "Ghosts"), accept(carol, "Ghosts")]);

  // Bob's two edges go live although nothing direct reaches him; Alice and Carol keep WebRTC between them.
  for (const member of [alice, bob, carol]) await expect(member.page.getByTestId("group-members")).toContainText("2 of 2 reachable", { timeout: 240_000 });
  await say(bob, "from behind the VPN");
  await say(carol, "hello from carol");
  for (const member of [alice, bob, carol]) for (const text of ["from behind the VPN", "hello from carol"])
    await expect(wallpaper(member).getByText(text, { exact: true })).toBeVisible({ timeout: 120_000 });
});
