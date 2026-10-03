import { expect, type Locator, type Page } from "@playwright/test";
import { pasteInvite } from "./clipboard";
import type { Peer } from "./fixtures";

/*
 * One profile on several devices (WISP 06), as the specs drive it: adding a device from the active one, and reading
 * what a device holds of the profile's files.
 */

/** A test value for the lock password a device set needs. */
export const DEVICE_SET_PASSWORD = "a long lock password";

/**
 * Adds `joiner` (a new device, its profile fresh) to the profile of `active`, as Profile, Devices, Add a device does,
 * and leaves the joiner on the standby screen with a live device link to the active device.
 */
export async function enrollDevice(active: Peer, joiner: Peer, options: { name?: string; password?: string } = {}): Promise<void> {
  const password = options.password ?? DEVICE_SET_PASSWORD;
  await active.page.goto("/#/profile");
  await active.page.getByTestId("device-add-open").click();
  const add = active.page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(password);
  if (await add.getByTestId("device-add-password-again").isVisible()) await add.getByTestId("device-add-password-again").fill(password);
  await add.getByTestId("device-add-next").click();
  const shown = add.getByTestId("device-add-code");
  await expect(shown).toBeVisible();
  const code = (await shown.getAttribute("data-code"))!;
  await joiner.page.getByTestId("home-already").click();
  await joiner.page.getByTestId("device-join-add").click();
  await joiner.page.getByTestId("device-join-name").fill(options.name ?? "Phone");
  await joiner.page.getByTestId("device-join-next").click();
  await pasteInvite(joiner.page, code);
  await expect(add.getByTestId("device-add-digits")).toBeVisible();
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toBeVisible();
  await expect(joiner.page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
  await joiner.page.getByTestId("device-join-continue").click();
  await expect(joiner.page.getByTestId("device-standby")).toHaveAttribute("data-state", "standby");
  await expect(joiner.page.getByTestId("device-standby-link")).toHaveAttribute("data-status", "live", { timeout: 90_000 });
  await add.getByRole("button", { name: "Done" }).click();
}

/**
 * Waits until `target` shows on `page`, typing the lock password whenever the lock screen stands in front: a device
 * that a handoff reloads (into the gate, or into the profile it took) starts again behind the profile's lock.
 */
export async function untilShown(page: Page, target: Locator, options: { password?: string; timeout?: number } = {}): Promise<void> {
  const password = options.password ?? DEVICE_SET_PASSWORD;
  await expect.poll(async () => {
    if (await target.isVisible().catch(() => false)) return true;
    const field = page.getByPlaceholder("Password");
    if (await page.getByText("Ghostly is locked").isVisible().catch(() => false) && await field.isVisible().catch(() => false)) {
      await field.fill(password).catch(() => {});
      await page.getByRole("button", { name: "Unlock" }).click().catch(() => {});
    }
    return false;
  }, { timeout: options.timeout ?? 120_000, intervals: [500] }).toBe(true);
}

/** Every file of the profile this page runs whose bytes are here, by id: its size and SHA-256 (hex), read from storage. */
export async function profileFileDigests(page: Page): Promise<Record<string, { size: number; sha256: string }>> {
  return page.evaluate(async () => {
    const registry = JSON.parse(localStorage.getItem("ghostly_profiles") ?? "null") as { active?: string; profiles?: { id: string; space?: string }[] } | null;
    const active = registry?.active ?? "";
    const entry = registry?.profiles?.find((p) => p.id === active);
    const ns = entry?.space ?? active;
    const name = ns ? `ghostly_${ns}` : "ghostly";
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const all = <T,>(store: string) => new Promise<T[]>((resolve, reject) => { const r = db.transaction(store, "readonly").objectStore(store).getAll(); r.onsuccess = () => resolve(r.result as T[]); r.onerror = () => reject(r.error); });
    const rows = await all<{ id: string; blob?: Blob; bytes?: string }>("files");
    const states = new Map((await all<{ id: string; bytes?: string }>("fileState")).map((s) => [s.id, s]));
    const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
    const out: Record<string, { size: number; sha256: string }> = {};
    for (const row of rows) {
      const file = { ...row, ...states.get(row.id) };
      let bytes: ArrayBuffer | null = null;
      if (file.blob) bytes = await file.blob.arrayBuffer();
      else if (file.bytes === "opfs") {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files");
        bytes = await (await (await (await root.getDirectoryHandle(name)).getFileHandle(row.id)).getFile()).arrayBuffer();
      }
      if (bytes) out[row.id] = { size: bytes.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) };
    }
    db.close();
    return out;
  });
}
