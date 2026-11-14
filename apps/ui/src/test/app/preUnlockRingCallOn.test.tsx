import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setRingingIn } from "../../../../../packages/react/src/callRegistry";
import { PreUnlockRing } from "../../components/PreUnlockRing";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: devices.handoff

/*
 * Before the password has been entered once only `PreUnlockRing` is drawn, and a call can ring there (on a device a
 * restart left at the lock screen, often unattended). A handoff asked for meanwhile, by a pull from the profile's other
 * device, is refused with "A call is on" as it is unlocked (WISP 06 § States and events): the engine has to be told.
 */

vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({ isLocked: true, hasUnlocked: false, retryAt: null, lock: () => {}, unlock: async () => false, resetTimer: () => {}, ringing: null, offerCall: () => () => {} }),
}));

const call = Symbol("a chat's call");
afterEach(() => { setRingingIn(call, false); fakeEngine.reset(); });

it("tells the engine while a call rings before the first unlock, and once the ring is over", async () => {
  fakeEngine.on("setCallOn", () => undefined);
  renderApp(<PreUnlockRing />);
  act(() => setRingingIn(call, true));
  await waitFor(() => expect(fakeEngine.callsTo("setCallOn")).toContainEqual({ on: true }));
  act(() => setRingingIn(call, false));
  await waitFor(() => expect(fakeEngine.callsTo("setCallOn").slice(-1)).toEqual([{ on: false }]));
});
