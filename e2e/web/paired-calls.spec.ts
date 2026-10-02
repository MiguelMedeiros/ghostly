import { chat, expect, setDhtOnly, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { watchCalls } from "../support/callTrace";
import { skewClock } from "../support/clock";

/**
 * Calls in the one chat: every new chat is a paired chat, and it calls over its live session (`calls/1`,
 * WISP 601). The signals travel on the paired session; the media on a WebRTC connection of its own
 * (Chromium's fake camera and microphone here). On the DHT there is no live session, so no call.
 */

const clock = /^\d{1,2}:\d{2}$/;

/** Size of the picture this peer receives from the other side. */
const remoteSize = (peer: Peer) =>
  peer.page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-testid=remote-video]");
    return video ? `${video.videoWidth}x${video.videoHeight}` : "none";
  });

/** Which of the call's elements play the other side's sound. */
const remoteSound = (peer: Peer) =>
  peer.page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>("[data-testid=remote-audio]");
    const video = document.querySelector<HTMLVideoElement>("[data-testid=remote-video]");
    const live = (audio?.srcObject as MediaStream | null)?.getAudioTracks().some((track) => track.readyState === "live");
    return { audio: audio && !audio.paused && !audio.muted && live ? "playing" : "silent", video: video?.muted ? "muted" : "sounding" };
  });

/** Turns the chat's DHT-only delivery on or off from the connection panel. */
const dhtOnly = (peer: Peer, on: boolean) => setDhtOnly(peer.page, on);

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
  // And hears her once: the <audio> plays her live microphone, the picture is muted.
  await expect.poll(() => remoteSound(bob)).toEqual({ audio: "playing", video: "muted" });
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
  // Both chats say so: the caller's too, not only "Audio call started".
  for (const p of [alice, bob]) await expect(chat(p).getByText("Audio call declined")).toBeVisible();
});

test("both call at once: one side rings, and answering connects the call", { tag: ["@feature:calls.paired", "@feature:calls.audio"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("paired-glare-alice"), peer("paired-glare-bob")]);
  await pair(alice, bob);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-audio")).toBeEnabled();
  await Promise.all([alice.page.getByTestId("call-audio").click(), bob.page.getByTestId("call-audio").click()]);
  // The earlier offer wins on both sides: exactly one of them rings. Both used to stay on "Calling..." for good.
  const ringing = (p: Peer) => p.page.getByTitle("Accept audio call");
  await expect.poll(async () => (await ringing(alice).count()) + (await ringing(bob).count()), { timeout: 30_000 }).toBe(1);
  const [callee, caller] = (await ringing(alice).count()) ? [alice, bob] : [bob, alice];
  await ringing(callee).click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await caller.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await expect(p.page.getByTitle("End call")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(chat(p).getByText("Audio call ended")).toBeVisible();
  // One call in both chats: the side whose offer lost keeps the incoming call's lines, not a "started" one of its own.
  const lines = (p: Peer) => chat(p).getByText(/^(Audio call started|Incoming audio call)$/).allInnerTexts();
  expect(await lines(caller)).toEqual(["Audio call started"]);
  expect(await lines(callee)).toEqual(["Incoming audio call"]);
});

/** The call's own connection in a page watched with `watchCalls` (the chat's link has no media lanes), as text. */
const callIce = (peer: Peer) =>
  peer.page.evaluate(() => {
    const recorded = (globalThis as unknown as { __callPcs?: { pc: RTCPeerConnection }[] }).__callPcs ?? [];
    const calls = recorded.map((r) => r.pc).filter((pc) => pc.getTransceivers().length > 0);
    const ufrag = (sdp?: string) => /^a=ice-ufrag:(.*)$/m.exec(sdp ?? "")?.[1]?.trim() ?? "";
    const pc = calls[calls.length - 1];
    return {
      connections: calls.length,
      local: ufrag(pc?.localDescription?.sdp),
      remote: ufrag(pc?.remoteDescription?.sdp),
      signaling: pc?.signalingState,
      connection: pc?.connectionState,
    };
  });

/**
 * Makes the call's connection in this page say its ICE is `state` (or what it really is again, with null), and tells
 * the app. Two pages on one machine talk over loopback, which nothing here can cut: the loss is what the connection
 * reports, and everything after it is real (the restart offer and its answer on the chat session, ICE with new
 * credentials between the two browsers).
 */
const reportIce = (peer: Peer, state: RTCIceConnectionState | null) =>
  peer.page.evaluate((state) => {
    const recorded = (globalThis as unknown as { __callPcs?: { pc: RTCPeerConnection }[] }).__callPcs ?? [];
    const pc = recorded.map((r) => r.pc).filter((pc) => pc.getTransceivers().length > 0).pop();
    if (!pc) throw new Error("no call connection");
    if (state) Object.defineProperty(pc, "iceConnectionState", { configurable: true, get: () => state });
    else delete (pc as unknown as { iceConnectionState?: unknown }).iceConnectionState;
    pc.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
  }, state);

const seconds = (text: string) => { const [m, s] = text.split(":").map(Number); return m * 60 + s; };

test("a call that loses its path says Reconnecting, restarts ICE on the same connection and goes on", { tag: ["@feature:calls.reconnect", "@feature:calls.paired", "@feature:calls.audio"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("reconnect-alice"), peer("reconnect-bob")]);
  await pair(alice, bob);
  for (const p of [alice, bob]) await watchCalls(p.page);
  await expect(alice.page.getByTestId("call-audio")).toBeEnabled();
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  const status = (p: Peer) => p.page.getByTestId("call-status");
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await expect.poll(() => remoteSound(alice)).toEqual({ audio: "playing", video: "muted" });
  // Muted before the loss: it must still be after.
  await alice.page.getByTestId("call-mute").click();
  await expect(alice.page.getByTestId("call-mute")).toHaveAttribute("title", "Unmute");
  const [aliceBefore, bobBefore] = [await callIce(alice), await callIce(bob)];
  expect(aliceBefore).toMatchObject({ connections: 1, remote: bobBefore.local, signaling: "stable" });
  // The clock has run for a few seconds by the time the path goes.
  await expect.poll(async () => seconds((await alice.page.getByText(clock).first().innerText()).trim())).toBeGreaterThanOrEqual(2);
  const ranFor = seconds((await alice.page.getByText(clock).first().innerText()).trim());

  // Alice placed the call: her side restarts ICE. Her connection says its path is gone.
  await reportIce(alice, "disconnected");
  await expect(status(alice)).toHaveAttribute("data-reconnecting", "true");
  await expect(status(alice)).toContainText("Reconnecting...");
  await expect(status(alice)).toHaveAttribute("data-state", "connected");
  await alice.page.screenshot({ path: testInfo.outputPath("reconnecting.png") });

  // After the grace her restart offer goes over the chat session and Bob answers it: both ends have new ICE
  // credentials, each other's, on the connections the call already had.
  await expect.poll(async () => (await callIce(alice)).local, { timeout: 30_000 }).not.toBe(aliceBefore.local);
  await expect.poll(async () => (await callIce(bob)).local, { timeout: 30_000 }).not.toBe(bobBefore.local);
  await expect.poll(async () => {
    const [a, b] = [await callIce(alice), await callIce(bob)];
    return a.signaling === "stable" && b.signaling === "stable" && a.remote === b.local && b.remote === a.local;
  }, { timeout: 30_000 }).toBe(true);

  // The path is back: the call says its clock again, which went on from where it was.
  await reportIce(alice, null);
  await expect(status(alice)).not.toHaveAttribute("data-reconnecting");
  await expect(alice.page.getByText(clock).first()).toBeVisible();
  expect(seconds((await alice.page.getByText(clock).first().innerText()).trim())).toBeGreaterThanOrEqual(ranFor);
  for (const p of [alice, bob]) expect(await callIce(p)).toMatchObject({ connections: 1, connection: "connected" });
  // Still muted, and each still hears the other's (live) microphone track.
  await expect(alice.page.getByTestId("call-mute")).toHaveAttribute("title", "Unmute");
  for (const p of [alice, bob]) await expect.poll(() => remoteSound(p)).toEqual({ audio: "playing", video: "muted" });
  // Bob never lost anything: his window kept its clock.
  await expect(status(bob)).not.toHaveAttribute("data-reconnecting");

  // The call ends as any call: one call in each chat, connected once.
  await bob.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await expect(p.page.getByTitle("End call")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(chat(p).getByText("Audio call ended")).toHaveCount(1);
});

for (const [how, offset] of [["behind", -125_000], ["ahead", 125_000]] as const) {
  test(`a contact whose clock is two minutes ${how}: calls ring and connect, whoever calls`, { tag: ["@feature:calls.paired", "@feature:calls.signal", "@feature:calls.audio"] }, async ({ peer }) => {
    // Reported 2026-10-01. A call signal more than two minutes from this clock never rang, and the answer of a callee
    // whose clock is behind was dated before the caller's offer and dropped: the call rang on until it gave up.
    const [alice, bob] = await Promise.all([peer(`skew-${how}-alice`), peer(`skew-${how}-bob`, { beforeOpen: (context) => skewClock(context, 0) })]);
    await pair(alice, bob);
    for (const p of [alice, bob]) await expect(p.page.getByTestId("call-audio")).toBeEnabled();
    // Paired and live: from here Bob's clock is off. (A first pairing between such clocks is another change.)
    await bob.page.evaluate((ms) => { (globalThis as { clockOffset?: number }).clockOffset = ms; }, offset);
    expect(Math.abs(await bob.page.evaluate(() => Date.now()) - await alice.page.evaluate(() => Date.now()))).toBeGreaterThan(120_000);

    for (const [caller, callee] of [[alice, bob], [bob, alice]]) {
      await caller.page.getByTestId("call-audio").click();
      await expect(callee.page.getByTitle("Accept audio call")).toBeVisible();
      await callee.page.getByTitle("Accept audio call").click();
      for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
      await caller.page.getByTitle("End call").click();
      for (const p of [alice, bob]) await expect(p.page.getByTitle("End call")).toHaveCount(0);
      for (const p of [alice, bob]) await expect(p.page.getByTestId("call-audio")).toBeEnabled();
    }
    for (const p of [alice, bob]) await expect(chat(p).getByText("Audio call ended")).toHaveCount(2);
  });
}

test("the contact's tab closes mid-call: the call ends here with its line", { tag: ["@feature:calls.paired", "@feature:calls.video"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("paired-gone-alice"), peer("paired-gone-bob")]);
  await pair(alice, bob);
  await alice.page.getByTestId("call-video").click();
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await bob.page.close();
  // No hang-up comes: the media connection fails (about 15 s in Chromium) and the call ends as a hang-up ends it.
  await expect(alice.page.getByTitle("End call")).toHaveCount(0, { timeout: 60_000 });
  await expect(chat(alice).getByText("Video call ended")).toBeVisible();
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

test("the app reopened while a call rings rings again, with one incoming line", { tag: ["@feature:calls.paired", "@feature:calls.video"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("reopen-alice"), peer("reopen-bob")]);
  await pair(alice, bob);
  await expect(alice.page.getByTestId("call-video")).toBeEnabled();
  await alice.page.getByTestId("call-video").click();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible();

  // The caller's same offer reaches the reopened app: it rings again, and the chat keeps one line for the call.
  await bob.page.reload();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible({ timeout: 45_000 });
  await expect(chat(bob).getByText("Incoming video call", { exact: true })).toHaveCount(1);

  await alice.page.getByTitle("End call").click();
  await expect(chat(bob).getByText("Missed video call")).toBeVisible();
  await expect(chat(bob).getByText("Incoming video call", { exact: true })).toHaveCount(1);
});

test("a second call while on one: declining it leaves the first call going, wherever you are", { tag: ["@feature:calls.paired", "@feature:calls.route-keep", "@feature:calls.decline", "@feature:calls.end-and-answer"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("busy-alice"), peer("busy-bob"), peer("busy-carol")]);
  await pair(alice, carol);
  await pair(alice, bob);
  await expect(alice.page.getByTestId("call-audio")).toBeEnabled();
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();

  // The call follows Alice out of its chat.
  await alice.page.getByTitle("Keep the call in a small window").click();
  await alice.page.getByTitle("Settings", { exact: true }).click();
  await expect(alice.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const callWindow = alice.page.getByTestId("call-window");
  await expect(callWindow).toBeVisible();

  // Carol calls: it rings over the call, and the call with Bob goes on while it does.
  await expect(carol.page.getByTestId("call-audio")).toBeEnabled();
  await carol.page.getByTestId("call-audio").click();
  await expect(alice.page.getByText("Incoming audio call...")).toBeVisible({ timeout: 30_000 });
  await expect(callWindow, "the call with Bob is still here while Carol rings").toBeVisible();
  // On a call already: End and answer or Decline, never a plain Accept that would open a second call.
  await expect(alice.page.getByRole("button", { name: "End and answer" })).toBeVisible();
  await expect(alice.page.getByTitle("Accept audio call")).toHaveCount(0);

  await alice.page.getByTitle("Decline").click();
  await expect(alice.page.getByText("Incoming audio call...")).toHaveCount(0);
  await expect(chat(carol).getByText("Audio call declined")).toBeVisible();

  // Declining Carol ended nothing else: the call with Bob is on, on both sides, a while later too.
  await alice.page.waitForTimeout(3_000);
  await expect(callWindow, "the call with Bob survives the second call").toBeVisible();
  await expect(alice.page.getByText(clock).first()).toBeVisible();
  await expect(bob.page.getByTitle("End call")).toBeVisible();

  await bob.page.getByTitle("End call").click();
  await expect(callWindow).toHaveCount(0);
  await expect(chat(bob).getByText("Audio call ended")).toBeVisible();
});

/** Counts the live microphones this page captured from now on (the app asks `navigator.mediaDevices` each time). */
async function watchMicrophones(peer: Peer) {
  await peer.page.evaluate(() => {
    const tracks: MediaStreamTrack[] = [];
    (window as unknown as { __microphones: MediaStreamTrack[] }).__microphones = tracks;
    const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await ask(constraints);
      tracks.push(...stream.getAudioTracks());
      return stream;
    };
  });
  return () => peer.page.evaluate(() => (window as unknown as { __microphones: MediaStreamTrack[] }).__microphones.filter((t) => t.readyState === "live").length);
}

test("a second call while on one: End and answer ends the first on both sides and answers, one microphone", { tag: ["@feature:calls.paired", "@feature:calls.end-and-answer", "@feature:calls.ring-elsewhere"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("swap-alice"), peer("swap-bob"), peer("swap-carol")]);
  await pair(alice, carol);
  await pair(alice, bob);
  const microphones = await watchMicrophones(alice);
  await expect(alice.page.getByTestId("call-audio")).toBeEnabled();
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  expect(await microphones()).toBe(1);

  // Carol calls: it rings over the call with two choices only, and says what answering does.
  await expect(carol.page.getByTestId("call-audio")).toBeEnabled();
  await carol.page.getByTestId("call-audio").click();
  const ring = alice.page.getByRole("alertdialog");
  await expect(ring).toBeVisible({ timeout: 30_000 });
  await expect(ring).toHaveAccessibleDescription("Incoming audio call... Answering ends your current call");
  await expect(ring.getByRole("button")).toHaveCount(2);
  await expect(ring.getByRole("button", { name: "Decline" })).toBeVisible();
  await expect(ring.getByRole("button", { name: /^Accept/ })).toHaveCount(0);

  await ring.getByRole("button", { name: "End and answer" }).click();

  // The call with Bob ended on both sides, with its line: Bob is not on a call any more.
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
  await expect(chat(bob).getByText("Audio call ended")).toBeVisible();
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  // Alice and Carol are on the call: one call, one microphone.
  for (const p of [alice, carol]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await expect(alice.page.getByTitle("End call")).toHaveCount(1);
  await expect(alice.page.getByTestId("incoming-call")).toHaveCount(0);
  await expect.poll(microphones).toBe(1);

  await carol.page.getByTitle("End call").click();
  await expect(alice.page.getByTitle("End call")).toHaveCount(0);
  await expect(chat(carol).getByText("Audio call ended")).toBeVisible();
  await expect.poll(microphones).toBe(0);
});
