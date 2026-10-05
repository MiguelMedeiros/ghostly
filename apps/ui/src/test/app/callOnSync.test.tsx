import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setCallOn } from "../../../../../packages/react/src/callRegistry";
import { useCallOnSync } from "../../hooks/useCallOnSync";
import { fakeEngine } from "../fakeEngine";
// covers: devices.handoff

/*
 * A handoff waits while a call is on (WISP 06 § States and events). The calls live in the page (`callRegistry`), the
 * handoff in the engine: the app tells the engine each time a call starts being on and once it is over.
 */

const call = Symbol("a chat's call");
afterEach(() => { setCallOn(call, null); fakeEngine.reset(); });

it("tells the engine when a call is on and when it is over", async () => {
  fakeEngine.on("setCallOn", () => undefined);
  renderHook(() => useCallOnSync());
  await waitFor(() => expect(fakeEngine.callsTo("setCallOn")).toEqual([{ on: false }]));
  act(() => setCallOn(call, () => {}));
  await waitFor(() => expect(fakeEngine.callsTo("setCallOn")).toEqual([{ on: false }, { on: true }]));
  act(() => setCallOn(call, null));
  await waitFor(() => expect(fakeEngine.callsTo("setCallOn")).toEqual([{ on: false }, { on: true }, { on: false }]));
});
