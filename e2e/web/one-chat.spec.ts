import { chat, chooseDhtOnly, expect, link, say, setDhtOnly, test, type Peer } from "../support/fixtures";

/**
 * The one chat of WISP 400 in the real app: first contact runs on the DHT and on a stream at once. With
 * WebRTC blocked the pairing does not fail: the chat opens On DHT, texts go there, and when WebRTC works
 * again the chat goes live by itself (the background retry, 20 s doubling to 3 min). DHT only chosen on one
 * side keeps both on the DHT.
 */

/** Before the app starts: peer connections made while `__qaRtcBlocked` is on never learn a remote candidate, so ICE fails. */
function blockableRtc() {
  const Original = window.RTCPeerConnection;
  const blocked = () => (window as unknown as { __qaRtcBlocked?: boolean }).__qaRtcBlocked === true;
  window.RTCPeerConnection = new Proxy(Original, {
    construct(target, args) {
      const pc = Reflect.construct(target, args) as RTCPeerConnection;
      const setRemote = pc.setRemoteDescription.bind(pc), addCandidate = pc.addIceCandidate.bind(pc);
      pc.setRemoteDescription = (description?: RTCSessionDescriptionInit) => setRemote(blocked() && description?.sdp
        ? { type: description.type, sdp: description.sdp.split("\r\n").filter(line => !line.startsWith("a=candidate")).join("\r\n") }
        : description as RTCSessionDescriptionInit);
      pc.addIceCandidate = ((candidate?: RTCIceCandidateInit) => blocked() ? Promise.resolve() : addCandidate(candidate)) as RTCPeerConnection["addIceCandidate"];
      return pc;
    },
  });
}
async function rtcBlocked(peer: Peer, on: boolean): Promise<void> {
  await peer.page.evaluate(value => { (window as unknown as { __qaRtcBlocked?: boolean }).__qaRtcBlocked = value; }, on);
}
const chip = (peer: Peer) => peer.page.getByTestId("connection-options");

test("with WebRTC blocked a first pairing opens On DHT, chats there, and goes live by itself once it works",
  { tag: ["@feature:chat.one-chat", "@feature:chat.paired.progress", "@feature:chat.dht.fallback"] }, async ({ peer }) => {
    test.setTimeout(6 * 60_000);
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    for (const p of [alice, bob]) { await p.page.addInitScript(blockableRtc); await p.page.reload(); await rtcBlocked(p, true); }
    await link(alice, bob);
    // Pinned over the DHT: not a failure, the chat is open.
    for (const p of [alice, bob]) {
      await expect(chip(p)).toHaveAccessibleName(/On DHT · retrying live/, { timeout: 90_000 });
      await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
      await expect(p.page.getByTestId("pairing-failure")).toHaveCount(0);
    }
    await expect(alice.page.getByTestId("pairing-indicator")).toHaveAttribute("data-stage", "on-dht");
    await say(bob, "hello over the DHT");
    await expect(chat(alice).getByText("hello over the DHT")).toBeVisible({ timeout: 60_000 });
    await expect(chat(bob).locator(".group").filter({ hasText: "hello over the DHT" }).getByText("Received by peer")).toBeVisible({ timeout: 60_000 });

    // WebRTC works again: nobody does anything, and the chat goes live.
    for (const p of [alice, bob]) await rtcBlocked(p, false);
    for (const p of [alice, bob]) await expect(chip(p)).toHaveAccessibleName(/Connected · WebRTC/, { timeout: 4 * 60_000 });
    await say(alice, "now live");
    await expect(chat(bob).getByText("now live")).toBeVisible();
    // Once each, on both sides.
    for (const p of [alice, bob]) for (const text of ["hello over the DHT", "now live"]) await expect(chat(p).getByText(text)).toHaveCount(1);
  });

test("DHT only on one side keeps both on the DHT; leaving it goes live",
  { tag: ["@feature:chat.one-chat", "@feature:invite.delivery-mode", "@feature:chat.dht.send"] }, async ({ peer }) => {
    test.setTimeout(4 * 60_000);
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    for (const p of [alice, bob]) await expect(chip(p)).toHaveAccessibleName(/Connected · WebRTC/, { timeout: 90_000 });
    await chooseDhtOnly(bob.page);
    await expect(chip(bob)).toHaveAccessibleName(/DHT only · chosen by you/);
    await expect(chip(alice)).toHaveAccessibleName(/DHT only · chosen by your contact/, { timeout: 60_000 });
    await say(alice, "short, over the DHT");
    await expect(chat(bob).getByText("short, over the DHT")).toBeVisible({ timeout: 60_000 });
    // Bob leaves DHT only: nothing blocks the live link any more.
    await setDhtOnly(bob.page, false);
    for (const p of [alice, bob]) await expect(chip(p)).toHaveAccessibleName(/Connected · WebRTC/, { timeout: 90_000 });
    await expect(chat(bob).getByText("short, over the DHT")).toHaveCount(1);
  });
