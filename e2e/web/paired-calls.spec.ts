import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Calls in the one chat: every new chat is a paired chat, and it calls over its live session (`calls/1`,
 * WISP 601). The signals travel on the paired session; the media on a WebRTC connection of its own
 * (Chromium's fake camera and microphone here). On the DHT there is no live session, so no call.
 */

const clock = /^\d{1,2}:\d{2}$/;

/** Size of the picture this peer receives from the other side. */
const remoteSize = (peer: Peer) =>
  peer.page.evaluate(() => {
    const video = [...document.querySelectorAll("video")].find((v) => !v.muted);
    return video ? `${video.videoWidth}x${video.videoHeight}` : "none";
  });

/** Turns the chat's DHT-only delivery on or off from the connection panel. */
async function dhtOnly(peer: Peer, on: boolean) {
  if (await peer.page.getByTestId("connection-menu").getAttribute("open") === null) await peer.page.getByTestId("connection-options").click();
  const choice = peer.page.getByRole("switch", { name: "DHT-only delivery" });
  if (await choice.isChecked() !== on) await choice.click();
  await expect.poll(() => choice.isChecked()).toBe(on);
  await peer.page.keyboard.press("Escape");
}

test("a new chat calls over its live session: video, answer, hang up", { tag: ["@feature:calls.paired", "@feature:calls.paired.negotiate", "@feature:calls.signal", "@feature:calls.video"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("paired-call-alice"), peer("paired-call-bob")]);
  await pair(alice, bob);

  // Both apps said `calls/1` on the session: the buttons are on, with no reason to show.
  for (const p of [alice, bob]) {
    await expect(p.page.getByTestId("call-video")).toBeEnabled();
    await expect(p.page.getByTestId("call-video")).toHaveAttribute("title", "Video call");
  }
  await alice.page.getByTestId("call-video").click();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible();
  await bob.page.screenshot({ path: testInfo.outputPath("incoming.png") });
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  // Real media crossed: Bob sees Alice's (fake) camera.
  await expect.poll(() => remoteSize(bob)).toMatch(/^[1-9]\d*x[1-9]\d*$/);
  await alice.page.screenshot({ path: testInfo.outputPath("in-call.png") });

  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(chat(p).getByText("Video call ended")).toBeVisible();
  // Once over, another call can start from either side.
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
});

test("an audio call from the other side, declined, leaves neither on a call", { tag: ["@feature:calls.paired", "@feature:calls.audio", "@feature:calls.decline"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("paired-decline-alice"), peer("paired-decline-bob")]);
  await pair(alice, bob);
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  await bob.page.getByTestId("call-audio").click();
  await expect(alice.page.getByText("Incoming audio call...")).toBeVisible();
  await alice.page.getByTitle("Decline").click();
  for (const p of [alice, bob]) await expect(p.page.getByTitle("End call")).toHaveCount(0);
  await expect(chat(bob).getByText("Audio call declined")).toHaveCount(0);
  await expect(chat(alice).getByText("Audio call declined")).toBeVisible();
});

test("calls need a live connection: on the DHT the buttons are off and say so", { tag: ["@feature:calls.paired.live-only"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("paired-dht-alice"), peer("paired-dht-bob")]);
  await pair(alice, bob);
  await expect(alice.page.getByTestId("call-audio")).toBeEnabled();

  await dhtOnly(alice, true);
  await dhtOnly(bob, true);
  for (const p of [alice, bob]) for (const id of ["call-audio", "call-video"]) {
    await expect(p.page.getByTestId(id)).toBeDisabled();
    await expect(p.page.getByTestId(id)).toHaveAttribute("title", "Calls need a live connection");
  }
  await alice.page.screenshot({ path: testInfo.outputPath("dht-only.png") });

  // Back to live: calls come back by themselves.
  await dhtOnly(alice, false);
  await dhtOnly(bob, false);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-audio")).toBeEnabled({ timeout: 120_000 });
});
