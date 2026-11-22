import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ProfileBackups } from "../../components/ProfileBackups";
import { openProfileBackup, restoreOpenedBackup, sameIdentityProfiles } from "../../lib/profileBackup";
import { restoreForTakeover } from "../../lib/restoreGuard";
import type { ProfileEntry } from "../../lib/profiles";
import { renderApp } from "../render";
// covers: backup.profile.same-device, devices.restore-guard, storage.s3

/*
 * Profile › Backups: the button that started the work (S3's Test and save, Take over, Replace or Restore as a copy) is
 * busy while it works, not disabled. A disabled button drops a keyboard's focus to the page, and when the work is
 * refused the focus stays there and the next Tab starts from the top.
 */

const s3Test = vi.hoisted(() => ({ run: (): Promise<void> => Promise.resolve() }));
vi.mock("@ghostly/browser/backup/s3", async (original) => {
  const real = await original<typeof import("@ghostly/browser/backup/s3")>();
  class S3Store extends real.S3Store { test() { return s3Test.run(); } }
  return { ...real, S3Store };
});
vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  openProfileBackup: vi.fn(async () => ({ name: "Work", protection: "passphrase", payload: { profile: { name: "Work" }, storage: {} } })),
  sameIdentityProfiles: vi.fn(async () => []),
  bundleDidSeed: vi.fn(async () => null),
  restoreOpenedBackup: vi.fn(async () => ({ id: "copycopyco", name: "Work", createdAt: 1, restored: true })),
}));
vi.mock("../../lib/restoreGuard", async (original) => ({
  ...(await original<typeof import("../../lib/restoreGuard")>()),
  restoreForTakeover: vi.fn(async () => ({ id: "takentaken", name: "Work", createdAt: 1, restored: true })),
}));
vi.mock("../../lib/profiles", async (original) => ({ ...(await original<typeof import("../../lib/profiles")>()), switchProfile: vi.fn() }));

const KEY = "A".repeat(43);
const bundleDevices = { d: toBase64Url(new Uint8Array(32).fill(5)), set: [{ key: KEY, name: "MacBook" }, null], turn: 500, takeovers: 0 };
/** The profile the backup is a copy of, still on this device. */
const original: ProfileEntry = { id: "abcdefghij", name: "Work", createdAt: 0 };

/** A promise held until the test refuses it. */
function held() {
  let refuse!: (error: Error) => void;
  const promise = new Promise<never>((_, reject) => { refuse = reject; });
  return { promise, refuse };
}

async function pickBackup(devices?: typeof bundleDevices) {
  vi.mocked(openProfileBackup).mockResolvedValue({ name: "Work", protection: "passphrase", payload: { profile: { name: "Work" }, storage: {} }, ...(devices ? { devices } : {}) });
  const view = renderApp(<ProfileBackups canSwitch />);
  await view.user.click(screen.getByTestId("restore-open"));
  await view.user.upload(screen.getByTestId("restore-file"), new File(["sealed"], "work.ghostly-backup", { type: "application/json" }));
  await view.user.type(screen.getByTestId("restore-passphrase"), "a long backup passphrase");
  return view;
}

/**
 * Presses `button` from the keyboard: busy, not disabled, while it works, and takes no second press; once refused the
 * focus is on it. A restore runs under the progress dialog, which holds the focus meanwhile (`progress`) and gives it
 * back when it closes: to the button, which a disabled button could not take.
 */
async function pressHeldThenRefused(user: ReturnType<typeof renderApp>["user"], testId: string, work: ReturnType<typeof held>, calls: () => number, refusal: RegExp, progress = false) {
  const button = screen.getByTestId(testId);
  button.focus();
  await user.keyboard("{Enter}");
  expect(calls()).toBe(1);
  expect(button).toBeEnabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  if (progress) expect(screen.getByTestId("backup-progress")).toContainElement(document.activeElement as HTMLElement);
  else {
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
  }
  fireEvent.click(button);
  expect(calls()).toBe(1);
  await act(async () => { work.refuse(new Error("The storage answered 403")); });
  expect(await screen.findByText(refusal)).toBeInTheDocument();
  expect(button).not.toHaveAttribute("aria-busy");
  await waitFor(() => expect(button).toHaveFocus());
}

describe("Profile › Backups keeps the keyboard focus on the button at work", () => {
  beforeEach(() => { vi.mocked(restoreOpenedBackup).mockClear(); vi.mocked(restoreForTakeover).mockClear(); vi.mocked(sameIdentityProfiles).mockReset(); });

  it("S3's Test and save", async () => {
    const work = held();
    const run = vi.fn(() => work.promise);
    s3Test.run = run;
    const { user } = renderApp(<ProfileBackups canSwitch />);
    await user.click(screen.getByTestId("s3-setup"));
    for (const [field, value] of [["endpoint", "https://s3.example.org"], ["bucket", "ghostly"], ["accessKeyId", "key"], ["secretAccessKey", "secret"], ["region", "auto"]]) {
      await user.type(screen.getByTestId(`s3-${field}`), value);
    }
    await pressHeldThenRefused(user, "s3-save", work, () => run.mock.calls.length, /403/);
  });

  it("Take over", async () => {
    const work = held();
    vi.mocked(restoreForTakeover).mockImplementationOnce(() => work.promise);
    const { user, engine } = await pickBackup(bundleDevices);
    engine.on("deviceTurnPeek", () => ({ result: "other", record: { turn: 501, active: 0, slots: [{ key: KEY, name: "MacBook" }, null, null, null] } }));
    await user.click(screen.getByTestId("restore-go"));
    await screen.findByTestId("restore-take-over");
    await pressHeldThenRefused(user, "restore-take-over", work, () => vi.mocked(restoreForTakeover).mock.calls.length, /403/, true);
  });

  for (const [testId, name] of [["restore-replace", "Replace"], ["restore-copy", "Restore as a copy"]] as const) {
    it(`a profile still on this device: ${name}`, async () => {
      const work = held();
      vi.mocked(restoreOpenedBackup).mockImplementationOnce(() => work.promise);
      vi.mocked(sameIdentityProfiles).mockResolvedValue([original]);
      const { user } = await pickBackup();
      await user.click(screen.getByTestId("restore-go"));
      await screen.findByTestId("restore-same-device");
      await pressHeldThenRefused(user, testId, work, () => vi.mocked(restoreOpenedBackup).mock.calls.length, /403/, true);
      // Only the button pressed is at work: the other one waits, as before.
      const other = screen.getByTestId(testId === "restore-copy" ? "restore-replace" : "restore-copy");
      expect(other).not.toHaveAttribute("aria-busy");
    });
  }
});
