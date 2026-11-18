import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupEdgeView, GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupConnection } from "../../components/GroupConnection";
import { SAID_QUIET_MS } from "../../hooks/useSaidSettled";
import { groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { LOCALES } from "../i18n/locales";
import { translateWith } from "../../locales/translate";

// covers: groups.connection, transport.indicator

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const edge = (linkId: string, state: GroupEdgeView["state"]): GroupEdgeView => ({ linkId, state, transport: "webrtc/1", lastSeenAt: Date.now() });
const member = (key: string, patch: Partial<GroupMemberView> = {}): GroupMemberView => ({ key, role: "member", me: false, online: true, missing: 0, ...patch });
/** A group of three: Alice always live, Bob's edge open or dropped. */
const group = (bob: GroupEdgeView["state"]): GroupView => groupView({ status: "active", epoch: 1, members: [
  member(ME, { me: true }), member(ALICE, { nick: "Alice", edge: edge("edge-a", "open") }), member(BOB, { nick: "Bob", online: bob === "open", edge: edge("edge-b", bob) }),
] });

/** What a screen reader is told: the group header's polite live region, each time its words change. */
function listen() {
  const said: string[] = [];
  const region = () => screen.getByTestId("group-connection").querySelector(".sr-only[aria-live=polite]");
  let last = region()?.textContent ?? "";
  const observer = new MutationObserver(() => { const now = region()?.textContent ?? ""; if (now !== last) { last = now; said.push(now); } });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { said, stop: () => observer.disconnect() };
}
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); await flush(); });

describe.each(["en", "ar"] as const)("a group member's edge that flaps is said where it settles, once (%s)", language => {
  const t = translateWith(LOCALES[language], language);
  const both = t("group.connection.reachable", { reachable: 2, total: 2 }), one = t("group.connection.reachable", { reachable: 1, total: 2 });

  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function settled() {
    const view = renderApp(<GroupConnection group={group("open")} />, { language });
    act(() => view.engine.update({ groups: [group("open")] }));
    await wait(SAID_QUIET_MS);
    const show = (bob: GroupEdgeView["state"]) => act(() => view.rerender(<GroupConnection group={group(bob)} />));
    return { ...view, show };
  }

  it("five flaps say nothing; a drop that lasts is said once, after the window, and shown at once", async () => {
    const { show } = await settled();
    const ear = listen();
    for (let i = 0; i < 5; i++) {
      show("waiting");
      await wait(2_000);
      show("open");
      await wait(2_000);
    }
    await wait(SAID_QUIET_MS);
    // On dev: ten, every drop and every return.
    expect(ear.said).toEqual([]);
    show("waiting");
    // Shown at once: the icon's state and its name.
    expect(screen.getByTestId("group-connection-options")).toHaveAttribute("data-state", "partial");
    expect(screen.getByTestId("group-connection-options")).toHaveAttribute("aria-label", t("group.connection.labelWith", { state: one }));
    await wait(SAID_QUIET_MS - 1);
    expect(ear.said).toEqual([]);
    await wait(1);
    ear.stop();
    expect(ear.said).toEqual([one]);
  });

  it("says Offline at once, once for a network that flaps, and says nothing for a group closed mid-window", async () => {
    const { engine, unmount } = await settled();
    const ear = listen();
    act(() => engine.update({ settings: { online: false } }));
    // At once: no window passed (a mutation is told at the next microtask).
    await wait(0);
    expect(ear.said).toEqual([t("group.connection.offline")]);
    for (let i = 0; i < 4; i++) {
      act(() => engine.update({ settings: { online: true } }));
      await wait(1_000);
      act(() => engine.update({ settings: { online: false } }));
      await wait(1_000);
    }
    act(() => engine.update({ settings: { online: true } }));
    await wait(SAID_QUIET_MS);
    expect(ear.said).toEqual([t("group.connection.offline"), both]);
    act(() => engine.update({ settings: { online: false } }));
    act(() => engine.update({ settings: { online: true } }));
    await wait(SAID_QUIET_MS / 2);
    ear.stop();
    expect(ear.said).toEqual([t("group.connection.offline"), both, t("group.connection.offline")]);
    const pending = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(pending);
  });
});
