import { connect, expect, linkLegacy, test, type Peer } from "../support/fixtures";
import { choose, close, optionsOf } from "../support/select";

/*
 * Chromium's fake devices (`--use-fake-device-for-media-stream`, playwright.config.ts): three microphones ("Fake
 * Default Audio Input", "Fake Audio Input 1" and 2), one camera, three speakers, named at once because the fake
 * UI grants the permission. Enough to pick another microphone, in Settings and during a call.
 */

const clock = /^\d{1,2}:\d{2}$/;

/** The id Chromium gave a device, by its name. */
const deviceId = (peer: Peer, kind: MediaDeviceKind, label: string) =>
  peer.page.evaluate(async ([kind, label]) => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === kind && d.label === label)?.deviceId ?? "", [kind, label] as const);

test("Settings → Audio & video lists the devices, keeps the chosen one and tries it", { tag: ["@feature:settings.media"] }, async ({ peer }, testInfo) => {
  const alice = await peer("alice");
  const { page } = alice;
  await page.goto("/#/settings");

  const mic = page.getByTestId("settings-microphone");
  await expect(mic).toHaveAttribute("data-value", "");
  const options = await optionsOf(mic);
  await expect(options).toHaveCount(3);
  await expect(options.first()).toContainText("System default");
  await expect(options.nth(1)).toContainText("Fake Audio Input 1");
  await close(mic);
  // Chromium can send sound to another speaker: the row is there.
  await expect(page.getByTestId("settings-speaker")).toBeVisible();

  const second = await deviceId(alice, "audioinput", "Fake Audio Input 2");
  await choose(mic, second);
  await page.getByTestId("settings-microphone-test").click();
  await expect(page.getByTestId("settings-microphone-level")).toBeVisible();
  await page.getByTestId("settings-camera-preview").click();
  await expect.poll(() => page.getByTestId("settings-camera-video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await page.getByTestId("settings-camera-video").scrollIntoViewIfNeeded();
  await testInfo.attach("settings-audio-video", { body: await page.getByTestId("settings-media").screenshot(), contentType: "image/png" });
  await page.getByTestId("settings-microphone-test").click();
  await page.getByTestId("settings-camera-preview").click();

  // Kept for this profile across a reload. Chromium's fake devices get new ids on each load: the name finds it again.
  await page.reload();
  await expect(page.getByTestId("settings-microphone")).toHaveAttribute("title", "Fake Audio Input 2");
  await expect(page.getByTestId("settings-microphone")).toHaveAttribute("data-value", await deviceId(alice, "audioinput", "Fake Audio Input 2"));
  await expect(page.getByTestId("settings-microphone-missing")).toHaveCount(0);
});

test("a call switches the microphone and the speaker without dropping", { tag: ["@feature:calls.devices"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await linkLegacy(alice, bob);
  await connect(alice, bob);

  await alice.page.getByTitle("Audio call").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();

  const menu = alice.page.getByTestId("call-devices-menu");
  const mics = menu.getByTestId("call-device-audioinput");
  await alice.page.getByTestId("call-devices").click();
  await expect(mics).toHaveCount(3);
  // Nothing chosen: the call took the system's default.
  await expect(mics.first()).toHaveAttribute("aria-checked", "true");

  const first = await deviceId(alice, "audioinput", "Fake Audio Input 1");
  await mics.and(alice.page.locator(`[data-device-id="${first}"]`)).click();
  await expect(menu).toHaveCount(0);

  // The track the call sends now comes from that microphone (the menu reads it off the track), and the call went on.
  await alice.page.getByTestId("call-devices").click();
  await expect(mics.and(alice.page.locator(`[data-device-id="${first}"]`))).toHaveAttribute("aria-checked", "true");
  const speakers = menu.getByTestId("call-device-audiooutput");
  await expect(speakers).toHaveCount(3);
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await testInfo.attach("call-device-menu", { body: await alice.page.screenshot(), contentType: "image/png" });
  const sink = await speakers.nth(1).getAttribute("data-device-id");
  await speakers.nth(1).click();
  await expect.poll(() => alice.page.locator("audio").first().evaluate((a: HTMLAudioElement & { sinkId: string }) => a.sinkId)).toBe(sink);

  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");
  // Still ticking a few seconds later: no hang-up, no second offer ringing on Bob's side.
  const before = await bob.page.getByText(clock).first().textContent();
  await expect.poll(() => bob.page.getByText(clock).first().textContent(), { timeout: 10_000 }).not.toBe(before);
  await expect(bob.page.getByText("Incoming audio call...")).toHaveCount(0);
  // The choice made in the call is the profile's from now on.
  expect(await alice.page.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith("media_devices")).map((k) => localStorage.getItem(k)).join())).toContain(first);

  // The headset goes: Chromium's fake devices cannot be unplugged, so the page stops listing it and says the
  // devices changed. The call falls back to the default microphone and says so, and offers it back once it returns.
  await unplug(alice, first);
  await expect(alice.page.getByTestId("call-device-notice")).toHaveAttribute("data-type", "lost");
  await expect(alice.page.getByTestId("call-device-notice")).toContainText("Fake Audio Input 1 disconnected");
  await alice.page.getByTestId("call-devices").click();
  await expect(mics.first()).toHaveAttribute("aria-checked", "true");
  await alice.page.keyboard.press("Escape");
  await unplug(alice, null);
  await expect(alice.page.getByTestId("call-device-notice")).toHaveAttribute("data-type", "back");
  await testInfo.attach("call-device-back", { body: await alice.page.screenshot(), contentType: "image/png" });
  await alice.page.getByTestId("call-device-switch-back").click();
  await alice.page.getByTestId("call-devices").click();
  await expect(mics.and(alice.page.locator(`[data-device-id="${first}"]`))).toHaveAttribute("aria-checked", "true");
  await alice.page.keyboard.press("Escape");
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  await alice.page.getByTitle("End call").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

/** The page stops (or, with null, starts again) listing this device, and hears that the devices changed. */
const unplug = (peer: Peer, deviceId: string | null) =>
  peer.page.evaluate((deviceId) => {
    const media = navigator.mediaDevices as MediaDevices & { real?: MediaDevices["enumerateDevices"]; hidden?: string | null };
    media.real ??= media.enumerateDevices.bind(media);
    media.hidden = deviceId;
    media.enumerateDevices = async () => (await media.real!()).filter((d) => d.deviceId !== media.hidden);
    media.dispatchEvent(new Event("devicechange"));
  }, deviceId);
