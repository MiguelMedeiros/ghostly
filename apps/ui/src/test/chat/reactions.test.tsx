import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageReaction } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { reactionChips, reactionNoteText } from "../../lib/reactions";
import { attentionOutcome } from "../../lib/chatMute";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.reactions, groups.reactions

const WIRE = "A".repeat(22);
const r = (e: string, n = 1, at = n): MessageReaction => ({ e, n, at });
/** An old message (history: no entry animation) from the contact, unless the patch says otherwise. */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `peer_${WIRE}`, text: "lunch at noon?", sender: "peer", timestamp: 1_700_000_000_000, ...patch });
const names = (by: string) => by === "peer" ? "Alice" : by === "k1" ? "Bo" : by === "k2" ? "Cy" : by;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the quick bar", () => {
  it("a pointer finds a React button beside the message: six emoji and +", async () => {
    const onReact = vi.fn();
    const { user } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReact={onReact} reactionName={names} />);
    await user.click(screen.getByTestId("message-react-action"));
    const bar = screen.getByTestId("reaction-bar");
    expect(within(bar).getAllByTestId("reaction-quick").map(b => b.dataset.emoji)).toEqual(["👍", "❤️", "😂", "😮", "😢", "🙏"]);
    expect(within(bar).getByTestId("reaction-more")).toBeInTheDocument();
    // Pointer only: no Details row under it.
    expect(within(bar).queryByTestId("reaction-bar-details")).not.toBeInTheDocument();
    await user.click(within(bar).getAllByTestId("reaction-quick")[1]);
    expect(onReact).toHaveBeenCalledWith("❤️");
    expect(screen.queryByTestId("reaction-bar")).not.toBeInTheDocument();
  });

  it("the one I chose is marked, and choosing it again takes it back", async () => {
    const onReact = vi.fn();
    const { user } = renderApp(<MessageBubble message={message({ reactions: { me: r("😂") } })} peerPubKey="peer" onReact={onReact} reactionName={names} />);
    await user.click(screen.getByTestId("message-react-action"));
    const laugh = screen.getAllByTestId("reaction-quick").find(b => b.dataset.emoji === "😂")!;
    expect(laugh).toHaveAttribute("aria-pressed", "true");
    await user.click(laugh);
    expect(onReact).toHaveBeenCalledWith("");
  });

  it("+ opens the emoji panel, and any emoji picked there is the reaction", async () => {
    const onReact = vi.fn();
    const { user } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReact={onReact} reactionName={names} />);
    await user.click(screen.getByTestId("message-react-action"));
    await user.click(screen.getByTestId("reaction-more"));
    expect(screen.queryByTestId("reaction-bar")).not.toBeInTheDocument();
    const picker = screen.getByTestId("reaction-picker");
    const cell = within(picker).getAllByRole("button").find(b => b.dataset.emoji === "🎉")!;
    await user.click(cell);
    expect(onReact).toHaveBeenCalledWith("🎉");
    expect(screen.queryByTestId("reaction-picker")).not.toBeInTheDocument();
  });

  it("its ⋮ says React, after Reply", async () => {
    const onReact = vi.fn();
    const { user } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReply={() => {}} onReact={onReact} reactionName={names} />);
    await user.click(screen.getByTestId("message-options"));
    const rows = within(screen.getByTestId("message-menu")).getAllByRole("button").map(b => b.dataset.testid);
    expect(rows.slice(0, 2)).toEqual(["message-reply", "message-react"]);
    await user.click(screen.getByTestId("message-react"));
    expect(screen.getByTestId("reaction-bar")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("reaction-bar")).not.toBeInTheDocument();
    expect(onReact).not.toHaveBeenCalled();
  });

  it("a finger held on the message opens the bar, with the details one tap under it", () => {
    vi.useFakeTimers();
    const { container } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReact={() => {}} reactionName={names} />);
    const row = container.querySelector<HTMLElement>("[data-message-row]")!;
    fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 20, clientY: 20, pointerId: 1 });
    expect(screen.getByTestId("reaction-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reaction-bar-details"));
    expect(screen.queryByTestId("reaction-bar")).not.toBeInTheDocument();
    expect(container.querySelector("[data-details-open]")).not.toBeNull();
  });

  it("a finger held on a text message offers Copy: its text is not selectable on a touch screen", async () => {
    vi.useFakeTimers();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { container } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReact={() => {}} reactionName={names} />);
    const row = container.querySelector<HTMLElement>("[data-message-row]")!;
    fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 20, clientY: 20, pointerId: 1 });
    const rows = within(screen.getByTestId("reaction-bar")).getAllByRole("button").map(b => b.dataset.testid).filter(id => id?.startsWith("reaction-bar-"));
    expect(rows).toEqual(["reaction-bar-copy", "reaction-bar-details"]);
    fireEvent.click(screen.getByTestId("reaction-bar-copy"));
    expect(writeText).toHaveBeenCalledWith("lunch at noon?");
    expect(screen.queryByTestId("reaction-bar")).not.toBeInTheDocument();
  });

  it("the React button's bar (a pointer) has no Copy: the text is selectable there", async () => {
    const { user } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReact={() => {}} reactionName={names} />);
    await user.click(screen.getByTestId("message-react-action"));
    expect(screen.queryByTestId("reaction-bar-copy")).not.toBeInTheDocument();
  });

  it("without onReact (a compatibility chat, a notice) there is none of it", async () => {
    const { user } = renderApp(<MessageBubble message={message({ reactions: { peer: r("👍") } })} peerPubKey="peer" />);
    expect(screen.queryByTestId("message-react-action")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-react")).not.toBeInTheDocument();
    // What came is still shown, but not a toggle.
    expect(screen.getByTestId("reaction-chip")).toBeDisabled();
  });
});

describe("chips under the bubble", () => {
  it("one per emoji, the most chosen first, mine marked; taken-back ones are not shown", () => {
    const chips = reactionChips({ me: r("❤️", 3, 3), peer: r("👍", 1, 1), k1: r("❤️", 2, 2), k2: r("", 9, 9) }, names, "You");
    expect(chips.map(c => [c.emoji, c.count, c.mine, c.who])).toEqual([["❤️", 2, true, ["You", "Bo"]], ["👍", 1, false, ["Alice"]]]);
    renderApp(<MessageBubble message={message({ reactions: { me: r("❤️", 3), peer: r("👍", 1), k1: r("❤️", 2), k2: r("", 9) } })} peerPubKey="peer" onReact={() => {}} reactionName={names} />);
    const shown = screen.getAllByTestId("reaction-chip");
    expect(shown.map(c => c.dataset.emoji)).toEqual(["❤️", "👍"]);
    expect(shown[0]).toHaveAttribute("aria-pressed", "true");
    expect(within(shown[0]).getByTestId("reaction-count")).toHaveTextContent("2");
    expect(within(shown[1]).queryByTestId("reaction-count")).not.toBeInTheDocument();
    expect(shown[0]).toHaveAccessibleName("❤️: You, Bo");
  });

  it("a click on mine takes it back; on another's emoji, reacts with the same", async () => {
    const onReact = vi.fn();
    const { user } = renderApp(<MessageBubble message={message({ reactions: { me: r("❤️"), peer: r("👍") } })} peerPubKey="peer" onReact={onReact} reactionName={names} />);
    const [mine, theirs] = screen.getAllByTestId("reaction-chip");
    await user.click(mine);
    expect(onReact).toHaveBeenLastCalledWith("");
    await user.click(theirs);
    expect(onReact).toHaveBeenLastCalledWith("👍");
  });

  it("who reacted shows on hover, and on a long press, which is then no toggle", () => {
    vi.useFakeTimers();
    const onReact = vi.fn();
    renderApp(<MessageBubble message={message({ reactions: { peer: r("👍"), k1: r("👍", 2) } })} peerPubKey="peer" onReact={onReact} reactionName={names} />);
    const chip = screen.getByTestId("reaction-chip");
    fireEvent.pointerEnter(chip, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(350); });
    expect(screen.getByTestId("reaction-who")).toHaveTextContent("Alice, Bo");
    fireEvent.pointerLeave(chip, { pointerType: "mouse" });
    expect(screen.queryByTestId("reaction-who")).not.toBeInTheDocument();
    fireEvent.pointerDown(chip, { pointerType: "touch", pointerId: 2 });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(chip, { pointerType: "touch", pointerId: 2 });
    fireEvent.click(chip);
    expect(screen.getByTestId("reaction-who")).toHaveTextContent("Alice, Bo");
    expect(onReact).not.toHaveBeenCalled();
    // A short tap is the toggle.
    fireEvent.pointerDown(chip, { pointerType: "touch", pointerId: 3 });
    fireEvent.pointerUp(chip, { pointerType: "touch", pointerId: 3 });
    fireEvent.click(chip);
    expect(onReact).toHaveBeenCalledWith("👍");
  });
});

describe("the chat list and notices", () => {
  it("says who reacted to what", () => {
    const t = (key: string, vars?: Record<string, string>) => `${key}:${JSON.stringify(vars)}`;
    expect(reactionNoteText({ at: 1, by: "peer", emoji: "❤️", snippet: "hi", mine: true }, "Ana", t as never)).toBe('chat.reactions.note:{"name":"Ana","emoji":"❤️","snippet":"hi"}');
    expect(reactionNoteText({ at: 1, by: "me", emoji: "👍", snippet: "hi", mine: false }, "Ana", t as never)).toContain("chat.reactions.noteMine");
  });

  it("a reaction to my message never plays a sound, and gives a quiet notice only away and unmuted", () => {
    const on = { soundEnabled: true, systemEnabled: true } as Parameters<typeof attentionOutcome>[2];
    expect(attentionOutcome("reaction", false, on, true)).toEqual({ sound: false, notice: true });
    expect(attentionOutcome("reaction", false, on, false)).toEqual({ sound: false, notice: false });
    expect(attentionOutcome("reaction", true, on, true)).toEqual({ sound: false, notice: false });
  });
});
