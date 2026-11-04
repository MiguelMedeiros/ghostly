import type { BrowserContext } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

// covers: calls.no-path

/**
 * Two people whose calls find no path to each other, as behind a VPN that blocks UDP or lets only TCP 443 out: their
 * chats stay live, but every address a call's connection learns from the other side leads nowhere (TEST-NET-1), so
 * its ICE never gets a reply. The call rings, is answered, and ends as "couldn't connect"; both sides then say a VPN or
 * firewall may block calls, and point to the TURN server in Settings, Network and to the guide.
 */
async function callsFindNoPath(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type Set = (this: RTCPeerConnection, description: RTCSessionDescriptionInit) => Promise<void>;
    const set = RTCPeerConnection.prototype.setRemoteDescription as Set;
    // Only a call's connections (an audio section): the chat's own data link still connects.
    RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, description: RTCSessionDescriptionInit) {
      const sdp = description?.sdp;
      if (!sdp || !/^m=audio /m.test(sdp)) return set.call(this, description);
      return set.call(this, { ...description, sdp: sdp.replace(/^(a=candidate:\S+ \d+ \S+ \d+ )\S+/gm, "$1192.0.2.1") });
    } as typeof RTCPeerConnection.prototype.setRemoteDescription;
  });
}

test("a call that finds no path says the network may block calls, with Network settings and the guide", { tag: ["@feature:calls.no-path"] }, async ({ peer }, testInfo) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([
    peer("no-path-alice", { beforeOpen: callsFindNoPath }),
    peer("no-path-bob", { beforeOpen: callsFindNoPath }),
  ]);
  await pair(alice, bob);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-audio")).toBeEnabled();

  await alice.page.getByTestId("call-audio").click();
  await expect(bob.page.getByText("Incoming audio call...")).toBeVisible();
  await bob.page.getByTitle("Accept audio call").click();

  // ICE gets no reply: the call ends by itself (ICE failed, or CONNECT_TIMEOUT_MS), on both sides.
  for (const p of [alice, bob]) {
    await expect(p.page.getByTitle("End call")).toHaveCount(0, { timeout: 90_000 });
    await expect(chat(p).getByText("Audio call couldn't connect")).toBeVisible();
    const note = p.page.getByTestId("call-no-path");
    await expect(note).toContainText("The call couldn't connect");
    await expect(note).toContainText("A VPN or firewall, yours or your contact's, may block calls.");
    await expect(note.getByRole("link", { name: "How to fix it" })).toHaveAttribute("href", /docs\/CALLS-BLOCKED\.md$/);
  }
  await alice.page.screenshot({ path: testInfo.outputPath("no-path.png") });

  // Network settings opens where the TURN server is set, and the note goes.
  await alice.page.getByTestId("call-no-path-settings").click();
  await expect(alice.page.getByTestId("network-turn-field")).toBeVisible();
  await expect(alice.page.getByTestId("call-no-path")).toHaveCount(0);
  // Closed by hand on the other side.
  await bob.page.getByTestId("call-no-path-close").click();
  await expect(bob.page.getByTestId("call-no-path")).toHaveCount(0);
});
