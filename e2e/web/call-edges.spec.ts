import { chat, connect, expect, linkLegacy, test, type Peer } from "../support/fixtures";

/**
 * The edges of a call: the ones that end before anybody talks. Each must leave
 * both sides with no call on screen, the call buttons back, and nothing still
 * holding the camera.
 */

const clock = /^\d{1,2}:\d{2}$/;

async function linked(peer: (name: string) => Promise<Peer>): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  // Calls belong to the compatibility profile, not paired-chat/1.
  await linkLegacy(alice, bob);
  await connect(alice, bob);
  return [alice, bob];
}

/** No ringing, no call window, and the call buttons usable again. */
async function noCall(p: Peer): Promise<void> {
  await expect(p.page.getByText(/^Incoming (audio|video) call\.\.\.$/)).toHaveCount(0);
  await expect(p.page.getByTestId("call-window")).toHaveCount(0);
  await expect(p.page.getByTitle("End call")).toHaveCount(0);
}

async function callButtonsBack(p: Peer): Promise<void> {
  await expect(p.page.getByTitle("Video call")).toBeEnabled();
  await expect(p.page.getByTitle("Audio call")).toBeEnabled();
}

/** Keeps every camera and microphone stream this page asks for, to see whether it lets them go. */
async function trackMedia(p: Peer): Promise<void> {
  await p.page.evaluate(() => {
    const streams: MediaStream[] = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints);
        streams.push(stream);
        return stream;
      },
    });
    Object.assign(window, { qaStreams: streams });
  });
}

const mediaState = (p: Peer) =>
  p.page.evaluate(() => {
    const streams = (window as unknown as { qaStreams: MediaStream[] }).qaStreams;
    const tracks = streams.flatMap((s) => s.getTracks());
    return { taken: tracks.length, live: tracks.filter((t) => t.readyState === "live").length };
  });

test("the caller hangs up while it rings: the ringing stops and no call starts", { tag: ["@feature:calls.cancel", "@feature:calls.audio"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Video call").click();
  await expect(alice.page.getByText("Calling...")).toBeVisible();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible();

  await alice.page.getByTitle("End call").click();
  await noCall(alice);
  // The hang-up reaches the side that was ringing, without anybody touching it.
  await noCall(bob);
  for (const p of [alice, bob]) await callButtonsBack(p);
  // Nothing was connected, so nothing says a call ended.
  for (const p of [alice, bob]) await expect(chat(p).getByText(/(Video|Audio) call (ended|connected)/)).toHaveCount(0);

  // Nor does the offer it left behind ring again a little later.
  await bob.page.waitForTimeout(3_000);
  await noCall(bob);

  // And the next call is an ordinary one.
  await alice.page.getByTitle("Audio call").click();
  await expect(bob.page.getByText("Incoming audio call...")).toBeVisible();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await bob.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await noCall(p);
});

/**
 * A chat is loaded only while it is on screen or on a call; a call offer for another chat loads it off
 * screen, and its ring is drawn over whatever page is open.
 */
test("a call rings while you are in Settings, and answering takes you to it", { tag: ["@feature:calls.ring-elsewhere"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await bob.page.getByTitle("Settings").click();
  await expect(bob.page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await alice.page.getByTitle("Video call").click();
  await expect(alice.page.getByText("Calling...")).toBeVisible();
  await expect(bob.page.getByText("Incoming video call..."), "the call reaches you away from its chat").toBeVisible({ timeout: 30_000 });
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await expect(bob.page.getByTestId("call-window")).toBeVisible();

  await bob.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await noCall(p);
});

test("a call placed while you are in Settings rings once you are back in the chat", { tag: ["@feature:calls.ring-elsewhere", "@feature:calls.mini-window"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await bob.page.getByTitle("Settings").click();
  await expect(bob.page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await alice.page.getByTitle("Video call").click();
  await expect(alice.page.getByText("Calling...")).toBeVisible();

  await bob.page.goBack();
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible();
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();

  // Once on the call, Settings is no longer a place the call is lost.
  await bob.page.getByTitle("Keep the call in a small window").click();
  await bob.page.getByTitle("Settings").click();
  await expect(bob.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(bob.page.getByTestId("call-window")).toBeVisible();
  await alice.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await noCall(p);
});

test("declining leaves neither side on a call", { tag: ["@feature:calls.decline"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Video call").click();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible();
  await bob.page.getByTitle("Decline").click();

  for (const p of [alice, bob]) await noCall(p);
  for (const p of [alice, bob]) await callButtonsBack(p);
  await expect(chat(bob).getByText("Video call declined")).toBeVisible();
  for (const p of [alice, bob]) await expect(chat(p).getByText(/(Video|Audio) call connected/)).toHaveCount(0);

  // Declined is not blocked: the same two can talk right after.
  await alice.page.getByTitle("Audio call").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await alice.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await noCall(p);
});

test("a call nobody answers can be cancelled, and lets go of the camera", { tag: ["@feature:calls.cancel"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await trackMedia(alice);
  // Nobody is there to answer.
  await bob.context.close();

  await alice.page.getByTitle("Video call").click();
  await expect(alice.page.getByText("Calling...")).toBeVisible();
  await expect.poll(async () => (await mediaState(alice)).live, "the call took the camera").toBeGreaterThan(0);
  // It keeps calling; nothing on this side pretends it was answered.
  await alice.page.waitForTimeout(5_000);
  await expect(alice.page.getByText("Calling...")).toBeVisible();
  await expect(alice.page.getByText(clock)).toHaveCount(0);

  await alice.page.getByTitle("End call").click();
  await noCall(alice);
  await callButtonsBack(alice);
  await expect.poll(async () => (await mediaState(alice)).live, "and gave it back").toBe(0);
  await expect(chat(alice).getByText(/(Video|Audio) call (ended|connected)/)).toHaveCount(0);

  // Calling again works the same way, and cancels the same way.
  await alice.page.getByTitle("Audio call").click();
  await expect(alice.page.getByText("Calling...")).toBeVisible();
  await alice.page.getByTitle("End call").click();
  await noCall(alice);
  await callButtonsBack(alice);
  await expect.poll(async () => (await mediaState(alice)).live).toBe(0);
});
