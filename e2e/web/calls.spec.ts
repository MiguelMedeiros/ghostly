import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

const clock = /^\d{1,2}:\d{2}$/;

/** Size of the picture this peer receives from the other side. */
const remoteSize = (peer: Peer) =>
  peer.page.evaluate(() => {
    const video = [...document.querySelectorAll("video")].find((v) => !v.muted);
    return video ? `${video.videoWidth}x${video.videoHeight}` : "none";
  });

async function linked(peer: (name: string) => Promise<Peer>): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  return [alice, bob];
}

test("video call: camera, mute, screen share, hang up", async ({ peer }) => {
  const [alice, bob] = await linked(peer);
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
  await expect(alice.page.getByTitle("Stop sharing your screen")).toBeVisible();
  await expect.poll(() => remoteSize(bob)).not.toBe(camera);
  await alice.page.getByTestId("share-screen").click();
  await expect.poll(() => remoteSize(bob)).toBe(camera);

  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

test("your own picture moves, resizes and stays inside the window", async ({ peer }) => {
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

test("a call in a small window leaves the chat usable", async ({ peer }) => {
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

test("audio call, and a call that is declined", async ({ peer }) => {
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

test("a call can start as a screen share", async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTestId("call-screen").click();
  await bob.page.getByTitle("Accept video call").click();
  await expect(bob.page.getByText(clock).first()).toBeVisible();
  await expect.poll(() => remoteSize(bob)).toMatch(/^[1-9]\d*x[1-9]\d*$/);
  await expect(alice.page.getByTitle("Stop sharing your screen")).toBeVisible();
  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

test("an audio call grows a camera and a screen, without calling again", async ({ peer }) => {
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
  await expect(alice.page.getByTitle("Stop sharing your screen")).toBeVisible();
  await expect.poll(() => remoteSize(bob)).not.toBe(camera);
  await alice.page.getByTitle("Stop sharing your screen").click();
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

test("a screen share that starts as one goes back to voice when it stops", async ({ peer }) => {
  const [alice, bob] = await linked(peer);
  await alice.page.getByTestId("call-screen").click();
  await bob.page.getByTitle("Accept video call").click();
  await expect(bob.page.getByText(clock).first()).toBeVisible();
  await expect(bob.page.getByTestId("remote-video")).toBeVisible();

  await alice.page.getByTitle("Stop sharing your screen").click();
  await expect(alice.page.getByTitle("Share your screen")).toBeVisible();
  await expect(bob.page.getByTestId("remote-video")).toBeHidden();
  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});
