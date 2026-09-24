import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { useWebRTC } from "../src/useWebRTC";

/**
 * Renders `useWebRTC` as a chat does: `receive` is the other side's `_call` record changing, and
 * `published` is every value the hook put in ours, in order (`null` clears it).
 */
export function renderCall() {
  const published: (string | null)[] = [];
  const publishCallSignal = vi.fn((signal: string | null) => { published.push(signal); });
  const setFastPoll = vi.fn();
  const addCallEventMessage = vi.fn();
  const onError = vi.fn();

  const hook = renderHook(
    ({ signal }: { signal: string | null }) =>
      useWebRTC({ incomingCallSignal: signal, publishCallSignal, setFastPoll, addCallEventMessage, onError }),
    { initialProps: { signal: null as string | null } },
  );

  return {
    ...hook,
    published,
    /** The kinds (`o`, `a`, `h`, `v`) of what was published, `null` for a cleared record. */
    publishedKinds: () => published.map((s) => (s === null ? null : (JSON.parse(s) as { t: string }).t)),
    setFastPoll,
    addCallEventMessage,
    onError,
    receive(signal: string) {
      hook.rerender({ signal });
    },
    /** The last value `setFastPoll` was given. */
    fastPoll: () => setFastPoll.mock.lastCall?.[0] as boolean | undefined,
  };
}

/** Lets every pending promise the hook chained settle, inside `act` so its state updates land. */
export async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
