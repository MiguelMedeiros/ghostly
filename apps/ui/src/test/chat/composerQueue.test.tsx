import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { COMPOSITION_END_WINDOW_MS } from "../../hooks/useComposition";
import { getSessionDraft, setStorageProfile as setProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: chat.paired.send

/** Each send waits here until the test lets it finish, as a DHT publication or a group's fan-out does. */
let pending: ((error: string | null) => void)[] = [];
const onSend = vi.fn<(text: string) => Promise<string | null>>();
const finish = async (error: string | null = null) => { await act(async () => { pending.shift()!(error); }); };
const sent = () => onSend.mock.calls.map(([text]) => text);

function composer(extra: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  return renderApp(<LockScreenProvider><MessageInput draftId="queue" onSend={onSend} {...extra} /></LockScreenProvider>);
}
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

beforeEach(() => {
  pending = [];
  onSend.mockReset().mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
});
afterEach(() => { localStorage.clear(); sessionStorage.clear(); setProfile(""); });

describe("one Enter, one message", () => {
  it("b, Enter, c, Enter during one slow send go as two messages, in order", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("a{Enter}");
    expect(field()).toHaveValue("");
    await user.keyboard("b{Enter}c{Enter}");
    // Each left the field when its Enter was pressed, and waits for the one before it.
    expect(field()).toHaveValue("");
    expect(sent()).toEqual(["a"]);
    await finish();
    await waitFor(() => expect(sent()).toEqual(["a", "b"]));
    await finish();
    await waitFor(() => expect(sent()).toEqual(["a", "b", "c"]));
    await finish();
    expect(sent()).toEqual(["a", "b", "c"]);
  });

  it("a send that fails brings its words back, with those that waited behind it and what is typed now", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("a{Enter}b{Enter}c");
    await finish("Not connected");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(field()).toHaveValue("a\nb\nc");
    // The queue stopped at the failure: nothing went out of order.
    expect(sent()).toEqual(["a"]);
  });

  it("the queue keeps going after the chat is left, and a failure then goes to its draft", async () => {
    const { user, unmount } = composer();
    await user.click(field());
    await user.keyboard("a{Enter}b{Enter}");
    unmount();
    await finish();
    await waitFor(() => expect(sent()).toEqual(["a", "b"]));
    await finish("Not connected");
    expect(getSessionDraft("queue")).toBe("b");
  });
});

/** A keydown as the browser sends it, with the time it came at. */
function keyDown(el: HTMLElement, init: KeyboardEventInit & { keyCode?: number }, at?: number) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  if (at !== undefined) Object.defineProperty(event, "timeStamp", { value: at });
  fireEvent(el, event);
}
function compositionEnd(el: HTMLElement, at: number) {
  const event = new CompositionEvent("compositionend", { bubbles: true, data: "日本" });
  Object.defineProperty(event, "timeStamp", { value: at });
  fireEvent(el, event);
}

describe("an input method's Enter (Japanese, Chinese, Korean)", () => {
  it("Enter confirming a candidate does not send (isComposing)", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("nihon");
    keyDown(field(), { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(field()).toHaveValue("nihon");
  });

  it("nor does the keydown WebKit marks as the input method's (keyCode 229)", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("nihon");
    keyDown(field(), { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("nor the Enter WebKit sends right after compositionend", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("nihon");
    compositionEnd(field(), 1_000);
    keyDown(field(), { key: "Enter" }, 1_005);
    expect(onSend).not.toHaveBeenCalled();
    expect(field()).toHaveValue("nihon");
  });

  it("an Enter pressed afterwards sends", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("nihon");
    compositionEnd(field(), 1_000);
    keyDown(field(), { key: "Enter" }, 1_000 + COMPOSITION_END_WINDOW_MS + 400);
    expect(sent()).toEqual(["nihon"]);
    await finish();
  });

  it("the Enter right after a candidate is confirmed, then the next one, sends once", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("nihon");
    compositionEnd(field(), 1_000);
    keyDown(field(), { key: "Enter" }, 1_002);
    keyDown(field(), { key: "Enter" }, 1_900);
    expect(sent()).toEqual(["nihon"]);
    await finish();
  });

  it("Escape while composing leaves the reply alone", async () => {
    const onCancel = vi.fn();
    const { user } = composer({ reply: { key: "m1", snippet: "lunch?", mine: false, onCancel } });
    await user.click(field());
    keyDown(field(), { key: "Escape", isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    keyDown(field(), { key: "Escape" }, 99_999);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
