import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { setStorageProfile as setProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: chat.paired.send

/** Each send waits here until the test lets it finish, as a busy engine or a group's fan-out does. */
let pending: ((error: string | null) => void)[] = [];
const onSend = vi.fn<(text: string) => Promise<string | null>>();
const finish = async (error: string | null = null) => { await act(async () => { pending.shift()!(error); }); };

function composer() {
  return renderApp(<LockScreenProvider><MessageInput draftId="send-race" onSend={onSend} /></LockScreenProvider>);
}
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

beforeEach(() => {
  pending = [];
  onSend.mockReset().mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
});
afterEach(() => { localStorage.clear(); setProfile(""); });

describe("Enter while a message is still going", () => {
  it("a double press sends it once", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("see you{Enter}{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await finish();
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("see you");
  });

  it("a double click on Send sends it once", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("see you");
    const send = screen.getByRole("button", { name: "Send message" });
    await user.click(send);
    await user.click(send);
    await finish();
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("words typed meanwhile stay in the field", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("ok{Enter}");
    await user.keyboard("there");
    await finish();
    await waitFor(() => expect(field()).toHaveValue("there"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("ok");
  });

  it("the next message typed and sent meanwhile goes after it, in order", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("a{Enter}");
    await user.clear(field());
    await user.keyboard("b{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await finish();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls.map(([text]) => text)).toEqual(["a", "b"]);
    await finish();
    await waitFor(() => expect(field()).toHaveValue(""));
  });

  it("a send that fails keeps the draft, and the press made meanwhile does not send it again", async () => {
    const { user } = composer();
    await user.click(field());
    await user.keyboard("hello{Enter}{Enter}");
    await finish("Not connected");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(field()).toHaveValue("hello");
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
