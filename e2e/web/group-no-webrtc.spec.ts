import { endpoints } from "../infra/env.mjs";
import { expect, openProfilePage, test, type Peer, type PeerOptions } from "../support/fixtures";
import { pair } from "../support/paired";

// A group of three where one member's app has no WebRTC at all, as Ghostly Desktop on Linux (WebKitGTK has none): its
// page runs without `RTCPeerConnection`, and Iroh through the e2e infra's relay. Group links (entry sessions, edges) go
// over Iroh with it, told in each link's own packet (`_tr`, WISP 902 § Transports), and over WebRTC between the other
// two, as before. It makes a community, lets people in, joins one, and everyone reads everyone.
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 120_000 });

/** A page with no WebRTC at all: `RTCPeerConnection` is not there, as in WebKitGTK. */
async function noWebRtc(peer: Peer["context"]): Promise<void> {
  await peer.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"])
      delete (window as unknown as Record<string, unknown>)[name];
  });
}

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 120_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

async function create(peer: Peer, name: string): Promise<string> {
  await peer.page.getByTestId("sidebar-new-more").click();
  await peer.page.getByTestId("new-group").click();
  await peer.page.getByTestId("new-group-name").fill(name);
  // Nothing says groups cannot connect from here: they can.
  await expect(peer.page.getByTestId("new-group-no-webrtc")).toHaveCount(0);
  await peer.page.getByTestId("new-group-create").click();
  const dialog = peer.page.getByTestId("group-share-dialog");
  const url = await dialog.getByTestId("group-link-url").inputValue();
  await dialog.getByTestId("group-share-done").click();
  return url;
}

async function join(peer: Peer, url: string): Promise<void> {
  await peer.page.goto(url);
  await expect(groupChat(peer)).toBeVisible({ timeout: 30_000 });
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}


/** `GROUP_TRACE=1`: every page's link and join trace lines, for a failure to say what each app dialled and why. */
async function trace(peer: Peer): Promise<void> {
  if (!process.env.GROUP_TRACE) return;
  await peer.page.evaluate(() => { Object.assign(globalThis, { __ghostlyLinkTrace: true, __ghostlyJoinTrace: true }); });
  peer.page.on("console", message => { if (/\[ghostly:(link|join)/.test(message.text())) console.log(`  [${peer.name}] ${message.text()}`); });
}

async function people(peer: (name: string, options?: PeerOptions) => Promise<Peer>): Promise<{ linux: Peer; bob: Peer; carol: Peer }> {
  const relay = endpoints.irohRelay;
  const [linux, bob, carol] = await Promise.all([
    peer("linux", { irohRelay: relay, beforeOpen: noWebRtc }),
    peer("bob", { irohRelay: relay }),
    peer("carol", { irohRelay: relay }),
  ]);
  // The page really has no WebRTC: the engine says so.
  expect(await linux.page.evaluate(() => typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection)).toBe("undefined");
  await Promise.all([setName(linux, "Linux"), setName(bob, "Bob"), setName(carol, "Carol")]);
  for (const p of [linux, bob, carol]) await trace(p);
  return { linux, bob, carol };
}

/** Everyone says something, and everyone reads everyone. */
async function everyoneReadsEveryone(members: Peer[]): Promise<void> {
  for (const p of members) await say(p, `hello from ${p.name}`);
  for (const p of members) for (const q of members) await sees(p, `hello from ${q.name}`);
}

test("a member with no WebRTC makes a community, lets two people in, and all three read each other", {
  tag: ["@feature:groups.native-links", "@feature:groups.community.create", "@feature:groups.community.join", "@feature:groups.community.send", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const { linux, bob, carol } = await people(peer);
  const url = await create(linux, "Penguins");
  // The entry session between the Linux app and Bob's goes over Iroh.
  await join(bob, url);
  await expect(bob.page.getByTestId("group-name")).toHaveText("Penguins");
  await join(carol, url);
  for (const p of [linux, bob, carol]) await expect(p.page.getByTestId("group-members")).toContainText("3 members", { timeout: 180_000 });
  // The Linux app reaches the members it has links with over Iroh (in a community, members reach each other through hubs).
  await expect(linux.page.getByTestId("group-connection-options")).toHaveAttribute("data-transport", "iroh/1", { timeout: 120_000 });
  await everyoneReadsEveryone([linux, bob, carol]);
});

test("a member with no WebRTC joins a community by its link, and all three read each other", {
  tag: ["@feature:groups.native-links", "@feature:groups.community.join", "@feature:groups.community.send"],
}, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const { linux, bob, carol } = await people(peer);
  const url = await create(bob, "Puffins");
  await join(carol, url);
  // Nothing says it cannot get in: Bob's or Carol's app lets it in over Iroh.
  await linux.page.goto(url);
  await expect(groupChat(linux)).toBeVisible({ timeout: 30_000 });
  await expect(groupChat(linux)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  for (const p of [linux, bob, carol]) await expect(p.page.getByTestId("group-members")).toContainText("3 members", { timeout: 180_000 });
  await expect(linux.page.getByTestId("group-connection-options")).toHaveAttribute("data-transport", "iroh/1", { timeout: 120_000 });
  await everyoneReadsEveryone([linux, bob, carol]);
});

test("a member with no WebRTC makes a private group of its contacts, and all three read each other", {
  tag: ["@feature:groups.native-links", "@feature:groups.create", "@feature:groups.invite", "@feature:groups.send"],
}, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const { linux, bob, carol } = await people(peer);
  // Its 1:1 chats go live over Iroh from the capability record, as a Linux Desktop's do.
  await pair(linux, bob);
  await pair(linux, carol);
  await linux.page.getByTestId("sidebar-new-more").click();
  await linux.page.getByTestId("new-group").click();
  await linux.page.getByTestId("new-group-name").fill("Ghosts");
  await linux.page.getByTestId("new-group-kind-mesh").click();
  await expect(linux.page.getByTestId("new-group-no-webrtc")).toHaveCount(0);
  await linux.page.getByTestId("new-group-create").click();
  await linux.page.getByTestId("group-share-done").click();
  for (const name of ["Bob", "Carol"]) {
    await linux.page.getByTestId("group-members").click();
    const row = linux.page.getByTestId("group-invite-contact").filter({ hasText: name });
    await expect(row.getByTestId("group-invite")).toBeEnabled({ timeout: 60_000 });
    await row.getByTestId("group-invite").click();
    await expect(row).toContainText("Invited…");
    await linux.page.keyboard.press("Escape");
  }
  for (const p of [bob, carol]) {
    const row = p.page.getByTestId("group-row").filter({ hasText: "Ghosts" });
    await row.getByTestId("group-accept").click();
    await expect(row).toContainText(/\d+ members?/, { timeout: 60_000 });
    await row.click();
    await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
  }
  // A private group is a full mesh: every member reaches every other, the Linux app over Iroh, Bob and Carol over WebRTC.
  for (const p of [linux, bob, carol]) await expect(p.page.getByTestId("group-members")).toContainText("2 of 2 reachable", { timeout: 180_000 });
  await expect(linux.page.getByTestId("group-connection-options")).toHaveAttribute("data-transport", "iroh/1", { timeout: 120_000 });
  await everyoneReadsEveryone([linux, bob, carol]);
});
