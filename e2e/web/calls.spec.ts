import { chat, connect, expect, linkLegacy, say, test, type Peer } from "../support/fixtures";

const clock = /^\d{1,2}:\d{2}$/;

/** Size of the picture this peer receives from the other side. */
const remoteSize = (peer: Peer) =>
  peer.page.evaluate(() => {
    const video = [...document.querySelectorAll("video")].find((v) => !v.muted);
    return video ? `${video.videoWidth}x${video.videoHeight}` : "none";
  });

/** The browser's own "Stop sharing" (a bar the page cannot reach): the shared track ends and fires `ended`, as it does there. */
const stopFromBrowser = (peer: Peer) =>
  peer.page.evaluate(() => {
    const self = document.querySelector<HTMLVideoElement>('[data-testid="call-self-view"] video');
    const track = (self?.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (!track) throw new Error("no picture of our own to stop");
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });

async function linked(peer: (name: string) => Promise<Peer>): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  // Calls belong to the compatibility profile, not paired-chat/1.
  await linkLegacy(alice, bob);
  await connect(alice, bob);
  return [alice, bob];
}

test("video call: camera, mute, screen share, hang up", { tag: ["@feature:calls.video", "@feature:calls.screen-share"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  // The header starts a voice or a video call; the screen is shared from inside one.
  await expect(alice.page.getByTestId("call-audio")).toBeVisible();
  await expect(alice.page.getByTestId("call-screen")).toHaveCount(0);
  await alice.page.getByTitle("Video call").click();
  await expect(bob.page.getByText("Incoming video call...")).toBeVisible();
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();

  await expect.poll(() => remoteSize(bob)).toMatch(/^[1-9]\d*x[1-9]\d*$/);
  const camera = await remoteSize(bob);

  await alice.page.getByTitle("Mute").click();
  await expect(alice.page.getByTitle("Unmute")).toBeVisible();
  await alice.page.getByTitle("Unmute").click();
  await alice.page.getByTitle("Turn camera off").click();
  await expect(alice.page.getByTitle("Turn camera on")).toBeVisible();
  await alice.page.getByTitle("Turn camera on").click();

  // Screen sharing swaps the track the video sender carries: no new signaling.
  await alice.page.getByTestId("share-screen").click();
  await expect(alice.page.getByTestId("share-screen")).toHaveAttribute("title", "Stop sharing");
  await expect(alice.page.getByTestId("call-sharing")).toHaveText("You're sharing your screen");
  await expect(bob.page.getByTestId("call-sharing")).toHaveText(/is sharing their screen$/);
  await expect.poll(() => remoteSize(bob)).not.toBe(camera);
  // Stopping goes back to the camera it replaced, and the notice goes on both sides.
  await alice.page.getByTestId("share-screen").click();
  await expect.poll(() => remoteSize(bob)).toBe(camera);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-sharing")).toHaveCount(0);
  await expect(alice.page.getByTitle("Turn camera off")).toBeVisible();

  // The browser's own "Stop sharing" does the same.
  await alice.page.getByTestId("share-screen").click();
  await expect.poll(() => remoteSize(bob)).not.toBe(camera);
  await stopFromBrowser(alice);
  await expect.poll(() => remoteSize(bob)).toBe(camera);
  await expect(alice.page.getByTestId("share-screen")).toHaveAttribute("title", "Share screen");

  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

test("your own picture moves, resizes and stays inside the window", { tag: ["@feature:calls.self-view"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Video call").click();
  await bob.page.getByTitle("Accept video call").click();
  await expect(alice.page.getByText(clock).first()).toBeVisible();

  const { width: W, height: H } = alice.page.viewportSize()!;
  const inside = (box: { x: number; y: number; width: number; height: number }) => box.x >= 0 && box.y >= 0 && box.x + box.width <= W && box.y + box.height <= H;
  const mouse = alice.page.mouse;
  const selfView = alice.page.getByTestId("call-self-view");
  const before = (await selfView.boundingBox())!;

  await selfView.hover();
  await mouse.move(before.x + 5, before.y + before.height - 5);
  await mouse.down();
  await mouse.move(before.x - 200, before.y + before.height + 150, { steps: 8 });
  await mouse.up();
  const bigger = (await selfView.boundingBox())!;
  expect(bigger.width, "pulling the bottom left corner makes it bigger").toBeGreaterThan(before.width + 150);
  expect(Math.abs(bigger.x + bigger.width - (before.x + before.width)), "the opposite corner stays put").toBeLessThan(2);
  expect(Math.abs(bigger.width / bigger.height - 4 / 3), "it keeps the shape of the camera picture").toBeLessThan(0.02);

  await mouse.move(bigger.x + bigger.width - 5, bigger.y + bigger.height - 5);
  await mouse.down();
  await mouse.move(2000, 1500, { steps: 8 });
  await mouse.up();
  expect(inside((await selfView.boundingBox())!), "pulled past the edge, it stops at the edge").toBe(true);

  const wide = (await selfView.boundingBox())!;
  await mouse.move(wide.x + wide.width / 2, wide.y + wide.height / 2);
  await mouse.down();
  await mouse.move(-500, 2000, { steps: 8 });
  await mouse.up();
  const placed = (await selfView.boundingBox())!;
  expect(placed.x < wide.x - 100 || placed.y > wide.y + 100, "dragged away, it moves").toBe(true);
  expect(Math.abs(placed.width - wide.width), "and keeps its size").toBeLessThan(2);
  expect(inside(placed)).toBe(true);

  await selfView.dblclick();
  const reset = (await selfView.boundingBox())!;
  expect(Math.round(reset.width), "a double click puts it back").toBe(Math.round(before.width));
});

test("a call in a small window leaves the chat usable", { tag: ["@feature:calls.mini-window"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Video call").click();
  await bob.page.getByTitle("Accept video call").click();
  await expect(alice.page.getByText(clock).first()).toBeVisible();

  await alice.page.getByTestId("call-minimize").click();
  const mini = (await alice.page.getByTestId("call-window").boundingBox())!;
  expect(mini.width).toBeLessThan(500);
  expect(mini.height).toBeLessThan(400);
  await say(alice, "still here, on the call");
  await bob.page.getByTestId("call-minimize").click();
  await expect(chat(bob).getByText("still here, on the call")).toBeVisible();

  await alice.page.mouse.move(mini.x + mini.width / 2, mini.y + mini.height / 2);
  await alice.page.mouse.down();
  await alice.page.mouse.move(200, 200, { steps: 8 });
  await alice.page.mouse.up();
  const moved = (await alice.page.getByTestId("call-window").boundingBox())!;
  expect(Math.abs(moved.x - mini.x) > 50 || Math.abs(moved.y - mini.y) > 50, "the window can be dragged").toBe(true);
  await expect(alice.page.getByText(clock).first()).toBeVisible();

  await alice.page.getByTestId("call-minimize").click();
  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

test("audio call, and a call that is declined", { tag: ["@feature:calls.audio", "@feature:calls.decline"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await bob.page.getByTitle("Audio call").click();
  await expect(alice.page.getByText("Incoming audio call...")).toBeVisible();
  await expect(alice.page.getByTitle("Accept video call")).toHaveCount(0);
  await alice.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await expect(bob.page.getByTestId("remote-video")).toBeHidden();
  await bob.page.getByTitle("End call").click();
  await expect(alice.page.getByTitle("End call")).toHaveCount(0);

  // The other side may still be tearing the last call down.
  await expect(alice.page.getByTitle("Video call")).toBeEnabled();
  await alice.page.getByTitle("Video call").click();
  await bob.page.getByTitle("Decline").click();
  await expect(bob.page.getByText("Incoming video call...")).toHaveCount(0);
  await expect(alice.page.getByTitle("End call")).toHaveCount(0);
});

test("an audio call grows a camera and a screen, without calling again", { tag: ["@feature:calls.upgrade", "@feature:calls.screen-share"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Audio call").click();
  await expect(bob.page.getByText("Incoming audio call...")).toBeVisible();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  // Voice only: neither side is showing the other a picture.
  for (const p of [alice, bob]) await expect(p.page.getByTestId("remote-video")).toBeHidden();

  // The camera goes on the video section this call negotiated empty: no second offer, no ringing.
  await alice.page.getByTitle("Turn camera on").click();
  await expect(alice.page.getByTitle("Turn camera off")).toBeVisible();
  await expect(bob.page.getByTestId("remote-video")).toBeVisible();
  await expect.poll(() => remoteSize(bob)).toMatch(/^[1-9]\d*x[1-9]\d*$/);
  const camera = await remoteSize(bob);
  // It only goes one way until Bob turns his own on.
  await expect(alice.page.getByTestId("remote-video")).toBeHidden();

  // A screen rides the same section, and stopping goes back to the camera it replaced.
  await alice.page.getByTestId("share-screen").click();
  await expect(alice.page.getByTestId("share-screen")).toHaveAttribute("title", "Stop sharing");
  await expect.poll(() => remoteSize(bob)).not.toBe(camera);
  await alice.page.getByTestId("share-screen").click();
  await expect.poll(() => remoteSize(bob)).toBe(camera);

  // The side that answered kept its half of the section open too.
  await bob.page.getByTitle("Turn camera on").click();
  await expect(alice.page.getByTestId("remote-video")).toBeVisible();
  await expect.poll(() => remoteSize(alice)).toMatch(/^[1-9]\d*x[1-9]\d*$/);

  // And back to voice: the picture goes away on the other side as well.
  await alice.page.getByTitle("Turn camera off").click();
  await expect(bob.page.getByTestId("remote-video")).toBeHidden();
  await expect(alice.page.getByTitle("End call").first()).toBeVisible();
  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

test("a voice call shares a screen, from the full window and the small one, and goes back to voice", { tag: ["@feature:calls.screen-share", "@feature:calls.upgrade", "@feature:calls.mini-window"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  for (const p of [alice, bob]) await expect(p.page.getByTestId("remote-video")).toBeHidden();

  // A voice call has the button too, on the video section it negotiated empty.
  const share = alice.page.getByTestId("share-screen");
  await expect(share).toBeEnabled();
  await expect(share).toHaveAttribute("title", "Share screen");
  await alice.page.screenshot({ path: testInfo.outputPath("voice-call-share-button.png") });
  await share.click();
  await expect(share).toHaveAttribute("title", "Stop sharing");
  await expect(alice.page.getByTestId("call-sharing")).toHaveText("You're sharing your screen");
  // The peer sees the screen appear, with no second ring, and is told what it is.
  await expect(bob.page.getByTestId("remote-video")).toBeVisible();
  await expect.poll(() => remoteSize(bob)).toMatch(/^[1-9]\d*x[1-9]\d*$/);
  await expect(bob.page.getByTestId("call-sharing")).toHaveText(/is sharing their screen$/);
  await expect(bob.page.getByText("Incoming video call...")).toHaveCount(0);
  await alice.page.screenshot({ path: testInfo.outputPath("sharing-self.png") });
  await bob.page.screenshot({ path: testInfo.outputPath("sharing-peer.png") });

  // Stopped from the button: back to voice, and the picture goes away on the other side.
  await share.click();
  await expect(bob.page.getByTestId("remote-video")).toBeHidden();
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-sharing")).toHaveCount(0);
  await expect(alice.page.getByTestId("call-self-view")).toHaveCount(0);

  // The small window has the button, and the notice, too.
  await alice.page.getByTestId("call-minimize").click();
  const mini = alice.page.getByTestId("call-window");
  await expect(mini).toHaveAttribute("data-mini", "true");
  await mini.getByTestId("share-screen").click();
  await expect(mini.getByTestId("call-sharing")).toHaveText("You're sharing your screen");
  await expect(bob.page.getByTestId("remote-video")).toBeVisible();
  await alice.page.screenshot({ path: testInfo.outputPath("sharing-mini.png") });
  // Stopped by the browser's own bar this time.
  await stopFromBrowser(alice);
  await expect(bob.page.getByTestId("remote-video")).toBeHidden();
  await expect(mini.getByTestId("share-screen")).toHaveAttribute("title", "Share screen");

  // Hanging up while sharing stops the share with the call.
  await mini.getByTestId("share-screen").click();
  await expect(bob.page.getByTestId("remote-video")).toBeVisible();
  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
  await expect(alice.page.getByTestId("call-window")).toHaveCount(0);
});

test("a call follows you out of the chat and into Settings", { tag: ["@feature:calls.mini-window"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Video call").click();
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await expect.poll(() => remoteSize(bob)).toMatch(/^[1-9]\d*x[1-9]\d*$/);

  // The small window is what leaves the rest of the app reachable.
  await alice.page.getByTitle("Keep the call in a small window").click();
  const callWindow = alice.page.getByTestId("call-window");
  await expect(callWindow).toHaveAttribute("data-mini", "true");

  // Leaving the chat used to hang up on the other person.
  await alice.page.getByTitle("Settings").click();
  await expect(alice.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(callWindow, "the call comes along").toBeVisible();
  await expect(alice.page.getByText(clock).first(), "and is still running").toBeVisible();
  await expect(bob.page.getByTitle("End call"), "the other side is still on the call").toBeVisible();
  await expect.poll(() => remoteSize(bob), "and still has the picture").toMatch(/^[1-9]\d*x[1-9]\d*$/);

  await alice.page.getByTitle("Back to the chat").click();
  await expect(alice.page.getByPlaceholder("Message…")).toBeVisible();
  await say(alice, "back from settings, still on the call");
  await expect(chat(bob).getByText("back from settings, still on the call")).toBeVisible();

  // Another chat is no different: the call comes along, the new chat is its own.
  await alice.page.getByTitle("New Chat").click();
  await expect(alice.page.getByTestId("invite-card")).toBeVisible();
  await expect(callWindow, "the call comes along here too").toBeVisible();
  await expect(alice.page.getByTitle("Back to the chat")).toBeVisible();

  // A hang-up from the other side still reaches a call that is away from its chat.
  await bob.page.getByTitle("End call").click();
  await expect(callWindow).toHaveCount(0);
  await expect(alice.page.getByTestId("invite-card"), "and leaves you where you were").toBeVisible();
});

test("the lock screen covers a call it keeps going", { tag: ["@feature:calls.lock"] }, async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTitle("Video call").click();
  await bob.page.getByTitle("Accept video call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await alice.page.getByTitle("Keep the call in a small window").click();

  await alice.page.getByTitle("Settings").click();
  await alice.page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = alice.page.locator("input[type=password]");
  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spooky");
  await alice.page.getByRole("button", { name: "Set password" }).click();
  await alice.page.getByRole("button", { name: "Lock Now" }).click();
  await expect(alice.page.getByText("Ghostly is locked")).toBeVisible();

  // The call goes on — nobody is hung up on — but nothing of it shows or answers.
  await expect(bob.page.getByTitle("End call")).toBeVisible();
  const call = alice.page.getByTestId("call-window");
  expect(
    await call.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }),
    "the lock is in front of the call window",
  ).toBe(false);
  expect(await call.evaluate((el) => !!el.closest("[inert]")), "and the call is out of reach").toBe(true);

  await alice.page.getByPlaceholder("Password").fill("spooky");
  await alice.page.getByRole("button", { name: "Unlock" }).click();
  await expect(alice.page.getByText("Ghostly is locked")).toHaveCount(0);
  await expect(alice.page.getByText(clock).first(), "and it is still running after").toBeVisible();
  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});
