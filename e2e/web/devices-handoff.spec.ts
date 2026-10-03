import { createHash, randomBytes } from "node:crypto";
import { expect, test, chat, connect, link, say, type Peer } from "../support/fixtures";
import { DEVICE_SET_PASSWORD, enrollDevice, profileFileDigests, untilShown } from "../support/devices";

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
  await expect(desktop.page.getByTitle("New Chat")).toHaveCount(0);

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
