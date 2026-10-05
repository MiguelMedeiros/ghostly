import { createHash, randomBytes } from "node:crypto";
import { expect, test, chat, connect, link, say, type Peer } from "../support/fixtures";
import { DEVICE_SET_PASSWORD, enrollDevice, profileFileDigests, untilShown } from "../support/devices";
import { pair } from "../support/paired";

/**
 * Moving a profile between devices (WISP 06 § The handoff, part 5). Two browser contexts are the person's two devices
 * and a third is a contact. The active device has a chat with the contact, messages and files; the standby takes the
 * profile with "Use here" and the lock password (a pull), or the active device gives it with "Move to" (a push). The
 * new active device then sends and receives with the contact, the old one shows the standby screen, every file is
 * byte for byte the same, and the contact never heard a goodbye. Every password here is a test value.
 */

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The wrong passwords the active device counted, from its device record. */
const wrongTries = (peer: Peer) => peer.page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly-devices"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const records = await new Promise<{ handoffAttempts?: Record<string, { total: number }> }[]>((resolve, reject) => { const r = db.transaction("devices", "readonly").objectStore("devices").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  db.close();
  return records.reduce((sum, record) => sum + Object.values(record.handoffAttempts ?? {}).reduce((n, a) => n + a.total, 0), 0);
});

/** The contact's own record of its links (`[ghostly:link]` lines), with when each was seen. */
function traceLines(peer: Peer): { t: number; step: string }[] {
  const lines: { t: number; step: string }[] = [];
  peer.page.on("console", (message) => {
    const text = message.text();
    if (!text.startsWith("[ghostly:link] ")) return;
    try { const line = JSON.parse(text.slice(15)) as { t: number; step: string }; lines.push(line); } catch { /* not a trace line */ }
  });
  return lines;
}

const traced = { beforeOpen: async (context: import("@playwright/test").BrowserContext) => { await context.addInitScript(() => { (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true; }); } };

async function sendFile(from: Peer, to: Peer, name: string, bytes: Buffer): Promise<void> {
  await from.page.getByTestId("file-input").setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
  await expect(chat(to).getByText(name)).toBeVisible({ timeout: 120_000 });
}

/** The profile's chat with the contact, open on `peer`. */
async function openTheChat(peer: Peer): Promise<void> {
  await peer.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await expect(peer.page.getByPlaceholder("Message…")).toBeVisible();
}

test("a pull: Use here with the password moves chats and files, the new device talks to the contact, the old one is on standby, and the contact heard no goodbye", { tag: ["@feature:devices.handoff"] }, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const [desktop, phone, contact] = await Promise.all([peer("desktop"), peer("phone"), peer("contact", traced)]);
  const lines = traceLines(contact);

  // The active device's profile: a chat with the contact, messages both ways, a small file and one over 16 MiB.
  await link(desktop, contact);
  await connect(desktop, contact);
  const small = randomBytes(200_000), large = randomBytes(17 * 1024 * 1024 + 5);
  await sendFile(desktop, contact, "notes.bin", small);
  await sendFile(desktop, contact, "video.bin", large);
  const before = await profileFileDigests(desktop.page);
  expect(Object.values(before).map((f) => f.sha256).sort()).toEqual([sha(small), sha(large)].sort());

  await enrollDevice(desktop, phone);

  // Use here, with the lock password.
  const started = Date.now();
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await phone.page.getByTestId("handoff-start").click();
  // Pass 1 while the desktop stays live; then the desktop freezes and reloads into the gate.
  await expect(desktop.page.getByTitle("New Chat")).toBeHidden({ timeout: 240_000 });
  const frozen = Date.now();
  // The phone installs, waits the settle time, and starts as the active device (each reload behind the profile's lock).
  await untilShown(phone.page, phone.page.getByTitle("New Chat"), { timeout: 300_000 });
  const active = Date.now();
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby").and(desktop.page.locator("[data-state=standby]")));

  // The new active device sends and receives with the contact.
  await openTheChat(phone);
  await expect(chat(phone).getByText("hello from desktop")).toBeVisible();
  await say(phone, "hello from the phone");
  await expect(chat(contact).getByText("hello from the phone")).toBeVisible({ timeout: 180_000 });
  const reached = Date.now();
  await say(contact, "hello back");
  await expect(chat(phone).getByText("hello back")).toBeVisible({ timeout: 120_000 });

  // Every file is byte for byte the same.
  const after = await profileFileDigests(phone.page);
  expect(Object.values(after).map((f) => f.sha256).sort()).toEqual(Object.values(before).map((f) => f.sha256).sort());

  // The contact never heard a goodbye: the desktop went quiet, and the phone dialled in as a restarted app does.
  expect(lines.filter((line) => line.t >= started && line.step === "peer-departed")).toEqual([]);
  const ready = lines.find((line) => line.t >= frozen && line.step === "paired-ready");
  test.info().annotations.push({ type: "measure", description: JSON.stringify({ pass1Ms: frozen - started, untilActiveMs: active - frozen, totalMs: active - started, contactGapMs: ready ? ready.t - frozen : null, firstMessageMs: reached - frozen }) });
});

test("a push: Move to on the active device, Use here on the other; and a wrong password is refused and counted", { tag: ["@feature:devices.handoff"] }, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const [desktop, phone, contact] = await Promise.all([peer("desktop"), peer("phone"), peer("contact")]);
  await link(desktop, contact);
  await connect(desktop, contact);
  await enrollDevice(desktop, phone);

  // A wrong password: refused on the standby, noted on the active device with a way to let it try again.
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill("not the password");
  await phone.page.getByTestId("handoff-start").click();
  await expect(phone.page.getByTestId("handoff-progress")).toHaveAttribute("data-failure", "password", { timeout: 60_000 });
  await expect(phone.page.getByTestId("handoff-line")).toHaveText("Wrong password.");
  await desktop.page.goto("/#/profile");
  await expect(desktop.page.getByTestId("handoff-wrong-password")).toContainText("tried to move this profile with a wrong password");
  // Nothing moved: the desktop is still the active device.
  await expect(desktop.page.getByTitle("New Chat")).toBeVisible();

  // Move to Phone, from the active device.
  const row = desktop.page.getByTestId("device-row").filter({ hasText: "Phone" });
  await expect(row.getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 90_000 });
  await row.getByTestId("device-move").click();
  await expect(phone.page.getByTestId("handoff-offer")).toBeVisible({ timeout: 60_000 });
  await expect(phone.page.getByTestId("handoff-offer")).toContainText("Move this profile here from");
  await phone.page.getByTestId("handoff-accept").click();
  await untilShown(phone.page, phone.page.getByTitle("New Chat"), { timeout: 400_000 });
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby").and(desktop.page.locator("[data-state=standby]")));
  await openTheChat(phone);
  await say(phone, "pushed here");
  await expect(chat(contact).getByText("pushed here")).toBeVisible({ timeout: 180_000 });
});

test("moved there and back: the device that has the profile again talks to the contact at once, and keeps its files", { tag: ["@feature:devices.handoff"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [desktop, phone, contact] = await Promise.all([peer("desktop"), peer("phone"), peer("contact", traced)]);
  const lines = traceLines(contact);
  await link(desktop, contact);
  await connect(desktop, contact);
  // A small file (kept whole on its record, as a photo is): the desktop's frozen copy holds it when the profile comes
  // back, so it is copied there from that copy, not sent again. That copy failed, and the move back ended "damaged".
  const photo = randomBytes(200_000);
  await sendFile(desktop, contact, "photo.bin", photo);
  await enrollDevice(desktop, phone);
  /** Move to `to` from the active device `from`, and wait until `to` runs the profile. */
  const move = async (from: Peer, to: Peer) => {
    await from.page.goto("/#/profile");
    const row = from.page.getByTestId("device-row").filter({ hasNotText: "This device" });
    await expect(row.getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 120_000 });
    await row.getByTestId("device-move").click();
    await expect(to.page.getByTestId("handoff-offer")).toBeVisible({ timeout: 60_000 });
    await to.page.getByTestId("handoff-accept").click();
    await untilShown(to.page, to.page.getByTitle("New Chat"), { timeout: 400_000 });
    await untilShown(from.page, from.page.getByTestId("device-standby").and(from.page.locator("[data-state=standby]")));
  };
  await move(desktop, phone);
  await openTheChat(phone);
  await say(phone, "from the phone");
  await expect(chat(contact).getByText("from the phone")).toBeVisible({ timeout: 180_000 });
  // And back: the desktop takes the profile again, and its first message reaches the contact.
  await move(phone, desktop);
  const back = Date.now();
  expect(Object.values(await profileFileDigests(desktop.page)).map((f) => f.sha256)).toEqual([sha(photo)]);
  await desktop.page.goto("/#/");
  await untilShown(desktop.page, desktop.page.getByTestId("sidebar").getByTestId("chat-row").first());
  await openTheChat(desktop);
  await say(desktop, "back on the desktop");
  await expect(chat(contact).getByText("back on the desktop")).toBeVisible({ timeout: 180_000 });
  test.info().annotations.push({ type: "measure", description: JSON.stringify({ firstMessageBackMs: Date.now() - back, contactLines: lines.filter((line) => line.t >= back).map((line) => line.step).slice(0, 60) }) });
});

test("moved to a device with no WebRTC and back: the device that has the profile again talks to the contact at once", { tag: ["@feature:devices.handoff", "@feature:transport.iroh-web"] }, async ({ peer }) => {
  test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs an Iroh relay (npm run e2e:infra:use)");
  test.setTimeout(12 * 60_000);
  const relay = process.env.GHOSTLY_IROH_RELAY_URL!;
  // The second device is as the Desktop on Linux: no WebRTC at all, its chats over Iroh.
  const noWebRtc = async (context: import("@playwright/test").BrowserContext) => {
    await context.addInitScript(() => { for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"]) delete (window as unknown as Record<string, unknown>)[name]; });
  };
  const [desktop, linux, contact] = await Promise.all([peer("desktop", { irohRelay: relay }), peer("linux", { irohRelay: relay, beforeOpen: noWebRtc }), peer("contact", { ...traced, irohRelay: relay })]);
  const lines = traceLines(contact);
  await link(desktop, contact);
  await connect(desktop, contact);
  await enrollDevice(desktop, linux, { name: "Linux" });
  const move = async (from: Peer, to: Peer) => {
    await from.page.goto("/#/profile");
    const row = from.page.getByTestId("device-row").filter({ hasNotText: "This device" });
    await expect(row.getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 120_000 });
    await row.getByTestId("device-move").click();
    await expect(to.page.getByTestId("handoff-offer")).toBeVisible({ timeout: 60_000 });
    await to.page.getByTestId("handoff-accept").click();
    await untilShown(to.page, to.page.getByTitle("New Chat"), { timeout: 400_000 });
    await untilShown(from.page, from.page.getByTestId("device-standby").and(from.page.locator("[data-state=standby]")));
    await to.page.goto("/#/");
    await untilShown(to.page, to.page.getByTestId("sidebar").getByTestId("chat-row").first());
    await openTheChat(to);
  };
  await move(desktop, linux);
  const there = Date.now();
  await say(linux, "from linux");
  await expect(chat(contact).getByText("from linux")).toBeVisible({ timeout: 180_000 });
  const thereMs = Date.now() - there;
  await move(linux, desktop);
  const back = Date.now();
  await say(desktop, "back on the web");
  const reached = await chat(contact).getByText("back on the web").waitFor({ timeout: 180_000 }).then(() => true, () => false);
  test.info().annotations.push({ type: "measure", description: JSON.stringify({ thereMs, backMs: Date.now() - back, contactLines: lines.filter((line) => line.t >= back).map((line) => line.step) }) });
  expect(reached).toBe(true);
});

test("five wrong passwords in an hour lock the standby out", { tag: ["@feature:devices.handoff"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone")]);
  await enrollDevice(desktop, phone);
  for (let i = 0; i < 5; i++) {
    await phone.page.getByTestId("handoff-use-here").click();
    await phone.page.getByTestId("handoff-password").fill(`wrong password ${i}`);
    await phone.page.getByTestId("handoff-start").click();
    // The active device counted it (durably, before it answered).
    await expect.poll(() => wrongTries(desktop), { timeout: 60_000 }).toBe(i + 1);
    await expect(phone.page.getByTestId("handoff-progress")).toHaveAttribute("data-failure", "password");
  }
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await phone.page.getByTestId("handoff-start").click();
  await expect(phone.page.getByTestId("handoff-progress")).toHaveAttribute("data-failure", "locked-out", { timeout: 60_000 });
  await expect(phone.page.getByTestId("handoff-line")).toContainText("Too many tries.");
});

test("a call on the active device keeps the profile there: Use here and Move to wait until it ends, and the call goes on", { tag: ["@feature:devices.handoff", "@feature:calls.paired"] }, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const [desktop, phone, contact] = await Promise.all([peer("desktop"), peer("phone"), peer("contact")]);
  await pair(desktop, contact);
  await enrollDevice(desktop, phone);
  await openTheChat(desktop);

  // The desktop is on a call with the contact.
  await desktop.page.getByTestId("call-audio").click();
  await contact.page.getByTitle("Accept audio call").click();
  for (const p of [desktop, contact]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  // Use here on the phone: the desktop answers that it cannot hand over now, and says why on its own screen.
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await phone.page.getByTestId("handoff-start").click();
  const progress = phone.page.getByTestId("handoff-progress");
  await expect(progress).toHaveAttribute("data-step", "failed", { timeout: 120_000 });
  await expect(progress).toHaveAttribute("data-failure", "busy");
  await desktop.page.evaluate(() => { location.hash = "#/profile"; });
  await expect(desktop.page.getByTestId("handoff-wallet-refusal")).toContainText("A call is on. Try again after it.");
  // Move to, from the desktop: the same.
  const row = desktop.page.getByTestId("device-row").filter({ hasText: "Phone" });
  await row.getByTestId("device-move").click();
  await expect(desktop.page.getByTestId("handoff-move-error")).toHaveText("A call is on. Try again after it.");
  await desktop.page.keyboard.press("Escape");
  // The call was not cut: before, the desktop froze and reloaded, and the contact sat on "Reconnecting..." until it ended.
  for (const p of [desktop, contact]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");
  await expect(desktop.page.getByTitle("New Chat")).toBeVisible();

  // Once the call is over, Use here moves the profile.
  await desktop.page.getByTitle("End call").click();
  await expect(contact.page.getByTitle("End call")).toHaveCount(0);
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await phone.page.getByTestId("handoff-start").click();
  await untilShown(phone.page, phone.page.getByTitle("New Chat"), { timeout: 300_000 });
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby").and(desktop.page.locator("[data-state=standby]")));
  // The call's end line moved with the history.
  await openTheChat(phone);
  await expect(chat(phone).getByText("Audio call ended")).toBeVisible();
});
