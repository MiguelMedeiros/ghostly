import { expect, test, chat, connect, link, say, type Peer } from "../support/fixtures";
import { DEVICE_SET_PASSWORD, enrollDevice, untilShown } from "../support/devices";

/**
 * How long a handoff takes (WISP 06 § The handoff), measured: a profile holding 50 MB of files, and one holding 1 GB,
 * moved by a pull between two browser contexts on this machine. Pass 1 (files, while the active device stays live)
 * and what follows it (pass 2, the install and the settle wait) are timed apart, and so is the gap a contact sees.
 *
 * Measurements only, never in the suite: run with HANDOFF_MEASURE=1. The files are written straight into the active
 * device's storage (random bytes made in the page, with their digests), as files a person sent would be, so the test
 * moves no gigabyte through Playwright.
 */
test.skip(!process.env.HANDOFF_MEASURE, "measurements only: HANDOFF_MEASURE=1");

/** Files of `megabytes` in total written into the running profile's storage, 64 MB at most each, under the chat `linkId`. */
async function addFiles(peer: Peer, megabytes: number): Promise<void> {
  await peer.page.evaluate(async (total) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const links = await new Promise<{ id: string }[]>((resolve, reject) => { const r = db.transaction("links", "readonly").objectStore("links").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const linkId = links[0].id;
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files", { create: true });
    const space = await root.getDirectoryHandle("ghostly", { create: true });
    const b64 = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    let left = total * 1024 * 1024, n = 0;
    while (left > 0) {
      const size = Math.min(left, 64 * 1024 * 1024);
      const bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += 65_536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65_536)));
      const id = `${linkId}-out-measure${n}`;
      const writable = await (await space.getFileHandle(id, { create: true })).createWritable();
      await writable.write(bytes);
      await writable.close();
      const digest = b64(await crypto.subtle.digest("SHA-256", bytes));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put({ id, linkId, bytes: "opfs", createdAt: Date.now(), direction: "out", digest, metadata: { name: `measure-${n}.bin`, size, mime: "application/octet-stream", timestamp: Date.now() } });
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
      });
      left -= size; n += 1;
    }
    db.close();
  }, megabytes);
}

for (const megabytes of [50, 1024]) {
  test(`a pull of a profile with ${megabytes} MB of files`, { tag: ["@feature:devices.handoff"] }, async ({ peer }) => {
    test.setTimeout(60 * 60_000);
    // On disk, as a person's browser keeps it: an in-memory context holds far less than a gigabyte.
    const [desktop, phone, contact] = await Promise.all([peer("desktop", { persistent: true }), peer("phone", { persistent: true }), peer("contact")]);
    await link(desktop, contact);
    await connect(desktop, contact);
    await addFiles(desktop, megabytes);
    await enrollDevice(desktop, phone);
    const started = Date.now();
    await phone.page.getByTestId("handoff-use-here").click();
    await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
    await phone.page.getByTestId("handoff-start").click();
    await expect(desktop.page.getByTitle("New Chat")).toBeHidden({ timeout: 50 * 60_000 });
    const frozen = Date.now();
    await untilShown(phone.page, phone.page.getByTitle("New Chat"), { timeout: 20 * 60_000 });
    const active = Date.now();
    await phone.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
    await say(phone, "from the phone");
    await expect(chat(contact).getByText("from the phone")).toBeVisible({ timeout: 300_000 });
    const reached = Date.now();
    const result = { megabytes, pass1Ms: frozen - started, pass2InstallSettleMs: active - frozen, totalMs: active - started, contactGapMs: reached - frozen };
    console.log(`[handoff-measure] ${JSON.stringify(result)}`);
    test.info().annotations.push({ type: "measure", description: JSON.stringify(result) });
  });
}
