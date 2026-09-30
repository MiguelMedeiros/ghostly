import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { forgetChatScroll } from "../../hooks/useChatScroll";
import { OPEN_ROWS, PAGE_ROWS, revealMessage } from "../../hooks/useRowWindow";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.send

/**
 * A long group opens on its newest page, read from the store's index (`messagePage`), and the rest of its history comes
 * in above once the engine has read it all: kept out of the page until the view goes up to it (useRowWindow), and not
 * counted as new.
 */

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const COUNT = 300, PAGE = 50;
const history: StoredMessage[] = Array.from({ length: COUNT }, (_, i) => ({
  linkId: "group:group-1", id: `g${String(i).padStart(4, "0")}`, text: `Message ${i}`, sender: "peer", member: ALICE,
  timestamp: 1_700_000_000_000 + i * 60_000, via: "datalink",
}));
const row = (i: number) => document.querySelector(`[data-message-id="g${String(i).padStart(4, "0")}"]`);

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); forgetChatScroll(); });
afterEach(() => { vi.useRealTimers(); });

describe("a long group", () => {
  it("shows its newest page first, then the rest above it, none of it new", async () => {
    let whole!: (list: StoredMessage[]) => void;
    fakeEngine.on("messagePage", () => ({ messages: history.slice(-PAGE), more: true }))
      .on("groupMessages", () => new Promise<StoredMessage[]>(done => { whole = done; }))
      .on("updateSettings", () => undefined)
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })] })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });

    await screen.findByText(`Message ${COUNT - 1}`);
    expect(row(COUNT - PAGE)).not.toBeNull();
    expect(row(0)).toBeNull();
    expect(fakeEngine.callsTo("messagePage")).toEqual([{ linkId: "group:group-1" }]);

    // From here the clock moves only when this test moves it. Following real time, a slow run drew the steps below while
    // the rest was still coming in, and saw the whole history there at once.
    vi.setTimerTickMode("manual");
    await act(async () => { whole(history); await vi.advanceTimersByTimeAsync(0); });
    // The page's rows stay in the page, with the older ones a chat opens with; the rest stay out, however long the clock
    // runs.
    const older = COUNT - OPEN_ROWS;
    expect(row(COUNT - PAGE)).not.toBeNull();
    expect(row(older)).not.toBeNull();
    expect(row(older - 1)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(row(older - 1)).toBeNull();
    // Asked for (a quote's original), the oldest comes into the page with the rows after it.
    act(() => { expect(revealMessage("g0000")).toBe(true); });
    expect(row(0)).not.toBeNull();
    expect(row(PAGE_ROWS)).not.toBeNull();
    expect(row(COUNT - 1)).toBeNull();
    expect(screen.queryByTestId("jump-latest")?.getAttribute("data-count") ?? "0").toBe("0");
  });
});
